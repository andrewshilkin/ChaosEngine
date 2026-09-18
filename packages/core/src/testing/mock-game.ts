import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import { PROTOCOL_VERSION, type GameEventDescriptor } from '../protocol.js';

export interface MockGameOptions {
  dir: string;
  game?: string;
  events?: GameEventDescriptor[];
  pollIntervalMs?: number;
  heartbeatMs?: number;
}

export interface ExecutedEvent {
  id: string;
  parameters: Record<string, unknown>;
  at: number;
}

export const DEMO_EVENTS: GameEventDescriptor[] = [
  {
    id: 'spawn_bloodsucker',
    name: 'Bloodsuckers',
    category: 'mutants',
    duration: 0,
    cooldown: 180,
    weight: 0.5,
    params: { count: { type: 'number', min: 1, max: 8, default: 3 } },
    available: true,
  },
  {
    id: 'spawn_zombies',
    name: 'Zombie Horde',
    category: 'mutants',
    duration: 0,
    cooldown: 120,
    weight: 1,
    params: { count: { type: 'number', min: 1, max: 20, default: 8 } },
    available: true,
  },
  {
    id: 'give_random_weapon',
    name: 'Random Weapon',
    category: 'player',
    duration: 0,
    cooldown: 90,
    weight: 1,
    params: {},
    available: true,
  },
  {
    id: 'heal_player',
    name: 'Full Heal',
    category: 'player',
    duration: 0,
    cooldown: 120,
    weight: 1,
    params: {},
    available: true,
  },
  {
    id: 'emission',
    name: 'Emission',
    category: 'world',
    duration: 0,
    cooldown: 1800,
    weight: 0.1,
    params: {},
    available: true,
  },
];

/**
 * A stand-in for a game adapter, implementing the same spool protocol as
 * chaos_rt_ipc.script.
 *
 * It exists so the whole host pipeline -- engine, ballots, voting, Discord --
 * can be developed and tested without launching a game, and so a new game
 * adapter has something to be compared against.
 */
export class MockGame {
  private readonly dir: string;
  private readonly inPath: string;
  private readonly outPath: string;
  private readonly gameId: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;

  private events: GameEventDescriptor[];
  private offset = 0;
  private carry = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private cooldowns = new Map<string, number>();

  /** Everything this mock was asked to run, for assertions. */
  readonly executed: ExecutedEvent[] = [];
  /** Non-event commands received, e.g. vote_start, for assertions. */
  readonly received: string[] = [];
  readonly commands: Array<Record<string, unknown>> = [];

  constructor(opts: MockGameOptions) {
    this.dir = path.resolve(opts.dir);
    this.inPath = path.join(this.dir, 'chaos_in.jsonl');
    this.outPath = path.join(this.dir, 'chaos_out.jsonl');
    this.gameId = opts.game ?? 'mock-game';
    this.events = opts.events ?? DEMO_EVENTS;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.outPath, '');

    // Skip anything written before this session, exactly like the Lua adapter.
    try {
      this.offset = (await fs.stat(this.inPath)).size;
    } catch {
      this.offset = 0;
    }

    await this.send({ type: 'hello', events: this.describe(), ui: true });
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.beatTimer = setInterval(() => {
      void this.send({ type: 'heartbeat', active: [], online: true });
    }, this.heartbeatMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.pollTimer = null;
    this.beatTimer = null;
  }

  /** Make an event report itself as unavailable, to exercise ballot filtering. */
  setAvailable(id: string, available: boolean): void {
    this.events = this.events.map((e) => (e.id === id ? { ...e, available } : e));
  }

  private describe(): GameEventDescriptor[] {
    return this.events.map((e) => ({ ...e, available: e.available && this.ready(e.id) }));
  }

  private ready(id: string): boolean {
    const until = this.cooldowns.get(id);
    return until === undefined || until <= Date.now();
  }

  private async send(msg: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ protocol: PROTOCOL_VERSION, game: this.gameId, ...msg });
    await fs.appendFile(this.outPath, line + '\n', 'utf8');
  }

  private async poll(): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(this.inPath)).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.carry = '';
    }
    if (size === this.offset) return;

    const chunk = await readRange(this.inPath, this.offset, size);
    this.offset = size;
    const lines = (this.carry + chunk).split('\n');
    this.carry = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      await this.handle(msg);
    }
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg['type']);
    this.received.push(type);
    this.commands.push(msg);
    const request_id = msg['request_id'] as string | undefined;

    switch (type) {
      case 'ping':
        await this.send({ type: 'pong', request_id });
        break;

      case 'describe':
        await this.send({ type: 'events', request_id, events: this.describe() });
        break;

      case 'reset':
        this.cooldowns.clear();
        await this.send({ type: 'ack', request_id });
        break;

      case 'event': {
        const id = String(msg['id']);
        const def = this.events.find((e) => e.id === id);
        if (!def) {
          await this.send({ type: 'event_result', request_id, id, success: false, error: 'unknown_event' });
          return;
        }
        if (!def.available) {
          await this.send({ type: 'event_result', request_id, id, success: false, error: 'unavailable' });
          return;
        }
        if (!this.ready(id)) {
          const remaining = Math.ceil(((this.cooldowns.get(id) ?? 0) - Date.now()) / 1000);
          await this.send({
            type: 'event_result',
            request_id,
            id,
            success: false,
            error: 'on_cooldown',
            cooldown_remaining: remaining,
          });
          return;
        }
        this.cooldowns.set(id, Date.now() + def.cooldown * 1000);
        this.executed.push({
          id,
          parameters: (msg['parameters'] as Record<string, unknown>) ?? {},
          at: Date.now(),
        });
        await this.send({
          type: 'event_result',
          request_id,
          id,
          success: true,
          name: def.name,
          duration: def.duration,
          instance_id: null,
        });
        break;
      }

      default:
        // vote_start / vote_update / vote_end / notify are display-only.
        break;
    }
  }
}

function readRange(file: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(file, { start, end: end - 1 })
      .on('data', (c) => chunks.push(c as Buffer))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
