import { randomUUID } from 'node:crypto';

import { buildBallot, type BallotOptions } from './ballot.js';
import { CooldownManager } from './cooldown.js';
import { createLogger, type Logger } from './logger.js';
import type { EventResult, GameMessage, VoteOptionView } from './protocol.js';
import { EventRegistry, type EventManifest } from './registry.js';
import type { Transport, TransportStatus } from './transport/transport.js';
import { Vote, VotingManager, type VoteOption, type VoteResult } from './voting.js';

export interface ChaosEngineOptions {
  transport: Transport;
  /** Optional presentation/balance overrides for the connected game's events. */
  manifest?: EventManifest | null;
  logger?: Logger;
  /** Minimum gap between any two events, in seconds. */
  globalCooldownSeconds?: number;
  /** How long to wait for the game to answer a command. */
  requestTimeoutMs?: number;
  /** How often to re-ask the game which events are currently available. */
  refreshIntervalMs?: number;
  /** How many past ballots to keep events off the next one. 0 disables it. */
  avoidRepeatsFor?: number;
}

export interface VoteCompletion {
  result: VoteResult;
  /** The execution of the winning event, if it was attempted. */
  execution: EventResult | null;
}

type Pending = {
  resolve: (value: GameMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * The reusable host-side engine.
 *
 * It owns the registry, cooldowns and voting, and speaks the protocol to
 * whatever game is on the other end of the transport. It contains no
 * game-specific logic and no frontend-specific logic; Discord, a CLI or a web
 * dashboard are all just callers.
 */
export class ChaosEngine {
  readonly registry = new EventRegistry();
  readonly cooldowns: CooldownManager;
  readonly voting = new VotingManager();

  private readonly transport: Transport;
  private readonly log: Logger;
  private readonly requestTimeoutMs: number;
  private readonly refreshIntervalMs: number;

  private pending = new Map<string, Pending>();
  private recentBallots: string[][] = [];
  private readonly avoidRepeatsFor: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private unsubscribe: Array<() => void> = [];
  private started = false;

  private eventsListeners = new Set<() => void>();
  private statusListeners = new Set<(s: TransportStatus) => void>();
  private voteEndListeners = new Set<(c: VoteCompletion) => void>();

  constructor(opts: ChaosEngineOptions) {
    this.transport = opts.transport;
    this.log = (opts.logger ?? createLogger('engine')).child('engine');
    // A paused game answers nothing until it is unpaused; 5s was short enough
    // that alt-tabbing turned a perfectly good command into a reported failure.
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 30_000;
    this.avoidRepeatsFor = opts.avoidRepeatsFor ?? 2;
    this.cooldowns = new CooldownManager(opts.globalCooldownSeconds ?? 0);
    this.registry.applyManifest(opts.manifest ?? null);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.unsubscribe.push(this.transport.onMessage((m) => this.handle(m)));
    this.unsubscribe.push(
      this.transport.onStatus((s) => {
        this.log.info(`game ${s.connected ? 'connected' : 'disconnected'} (${s.endpoint})`);
        for (const cb of this.statusListeners) cb(s);
      }),
    );

    // Mirror vote state into the game HUD.
    this.unsubscribe.push(this.voting.onTick((vote) => void this.pushVoteState(vote)));
    this.unsubscribe.push(this.voting.onEnd((result) => void this.onVoteEnd(result)));

    await this.transport.start();

    // A game that was already running when we started has no reason to send a
    // fresh `hello`, so ask it to describe itself. Best effort: if nothing is
    // running this just times out quietly.
    void this.refresh();

    this.refreshTimer = setInterval(() => {
      if (this.transport.status().connected) void this.refresh();
    }, this.refreshIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.voting.cancel();
    for (const un of this.unsubscribe) un();
    this.unsubscribe = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('engine stopped'));
    }
    this.pending.clear();
    await this.transport.stop();
  }

  get connected(): boolean {
    return this.transport.status().connected;
  }

  status(): TransportStatus {
    return this.transport.status();
  }

  onEventsChanged(cb: () => void): () => void {
    this.eventsListeners.add(cb);
    return () => this.eventsListeners.delete(cb);
  }

  onStatusChanged(cb: (s: TransportStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onVoteCompleted(cb: (c: VoteCompletion) => void): () => void {
    this.voteEndListeners.add(cb);
    return () => this.voteEndListeners.delete(cb);
  }

  // -------------------------------------------------------------------------
  // commands
  // -------------------------------------------------------------------------

  /** Ask the game for its current event list and refresh the registry. */
  async refresh(): Promise<void> {
    const request_id = randomUUID();
    try {
      const reply = await this.request({ type: 'describe', request_id }, request_id);
      if (reply.type === 'events') {
        this.registry.replaceAll(reply.events);
        for (const cb of this.eventsListeners) cb();
      }
    } catch (err) {
      // Not being able to reach a game that was never there is not a problem
      // worth shouting about; losing one that was is.
      if (this.transport.status().connected) {
        this.log.warn(`refresh failed: ${String(err)}`);
      } else {
        this.log.debug(`no game answered describe: ${String(err)}`);
      }
    }
  }

  async ping(): Promise<boolean> {
    const request_id = randomUUID();
    try {
      await this.request({ type: 'ping', request_id }, request_id);
      return true;
    } catch {
      return false;
    }
  }

  /** Run one event by id. Parameters are merged over the manifest defaults. */
  async execute(
    id: string,
    parameters?: Record<string, number | string | boolean>,
  ): Promise<EventResult> {
    const entry = this.registry.get(id);
    if (!entry) {
      return { id, success: false, error: 'unknown_event' };
    }
    const request_id = randomUUID();
    const merged = { ...entry.defaultParameters, ...(parameters ?? {}) };

    let reply: GameMessage;
    try {
      reply = await this.request(
        { type: 'event', request_id, id, parameters: merged },
        request_id,
      );
    } catch {
      this.log.warn(`event ${id} timed out`);
      return { id, success: false, error: 'timeout' };
    }

    if (reply.type !== 'event_result') {
      return { id, success: false, error: 'bad_request' };
    }

    if (reply.success) {
      this.cooldowns.arm(id, entry.cooldown);
      this.log.info(`event ${id} executed`);
    } else {
      if (reply.error === 'on_cooldown' && typeof reply.cooldown_remaining === 'number') {
        this.cooldowns.adopt(id, reply.cooldown_remaining);
      }
      this.log.warn(`event ${id} failed: ${reply.error ?? 'unknown'} ${reply.message ?? ''}`);
    }
    return reply;
  }

  async notify(text: string, seconds?: number): Promise<void> {
    await this.transport.send({ type: 'notify', text, ...(seconds ? { seconds } : {}) });
  }

  async reset(): Promise<void> {
    const request_id = randomUUID();
    try {
      await this.request({ type: 'reset', request_id }, request_id);
    } catch {
      this.log.warn('reset not acknowledged');
    }
    this.cooldowns.clear();
  }

  // -------------------------------------------------------------------------
  // voting
  // -------------------------------------------------------------------------

  /**
   * Pick the choices for the next vote without starting it.
   *
   * Remembers the last few ballots and keeps those events off the next one, so
   * the same two names do not come round every vote.
   */
  ballot(opts?: BallotOptions): VoteOption[] {
    const avoid = new Set(this.recentBallots.flat());
    const options = buildBallot(this.registry, this.cooldowns, { avoid, ...opts });

    this.recentBallots.push(options.map((o) => o.id));
    while (this.recentBallots.length > this.avoidRepeatsFor) {
      this.recentBallots.shift();
    }
    return options;
  }

  /**
   * Start a vote and mirror it into the game HUD. The winner is executed
   * automatically when the timer expires; subscribe with onVoteCompleted().
   */
  startVote(options: VoteOption[], durationSeconds: number): Vote {
    const vote = this.voting.start(options, durationSeconds);
    void this.transport.send({
      type: 'vote_start',
      options: toViews(vote),
      duration: durationSeconds,
    });
    return vote;
  }

  private async pushVoteState(vote: Vote): Promise<void> {
    await this.transport.send({
      type: 'vote_update',
      options: toViews(vote),
      seconds_left: vote.secondsLeft(),
    });
  }

  private async onVoteEnd(result: VoteResult): Promise<void> {
    await this.transport.send({
      type: 'vote_end',
      winner: { id: result.winner.id, label: result.winner.label },
    });

    let execution: EventResult | null = null;
    if (this.registry.has(result.winner.id)) {
      execution = await this.execute(result.winner.id, result.winner.parameters);
    } else {
      this.log.warn(`winner ${result.winner.id} is not a known event, skipping execution`);
    }

    for (const cb of this.voteEndListeners) cb({ result, execution });
  }

  // -------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------

  private async request(
    msg: Parameters<Transport['send']>[0],
    request_id: string,
  ): Promise<GameMessage> {
    const promise = new Promise<GameMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`request ${request_id} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
    });
    await this.transport.send(msg);
    return promise;
  }

  private handle(msg: GameMessage): void {
    const requestId = 'request_id' in msg ? msg.request_id : undefined;
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.resolve(msg);
        return;
      }
    }

    switch (msg.type) {
      case 'hello':
        this.log.info(`game "${msg.game}" said hello with ${msg.events.length} events`);
        this.registry.replaceAll(msg.events);
        this.cooldowns.clear();
        for (const cb of this.eventsListeners) cb();
        break;
      case 'events':
        // A late answer to a describe whose request already timed out -- which
        // happens whenever the game was paused when we asked. The information
        // is still good, and dropping it is how the registry went stale.
        this.registry.replaceAll(msg.events);
        for (const cb of this.eventsListeners) cb();
        break;
      case 'heartbeat':
        break;
      case 'goodbye':
        this.log.info('game said goodbye');
        break;
      case 'error':
        this.log.warn(`game reported an error: ${msg.error}`);
        break;
      default:
        this.log.debug(`unhandled message ${msg.type}`);
    }
  }
}

function toViews(vote: Vote): VoteOptionView[] {
  return vote.tally().map((row) => ({ label: row.option.label, percent: row.percent }));
}
