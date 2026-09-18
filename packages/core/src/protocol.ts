/**
 * Wire protocol between the Chaos Engine host and a game adapter.
 *
 * The protocol is deliberately small and game-agnostic: it carries event *ids*
 * and validated parameters, never code. A game adapter is free to implement it
 * over any transport; see `transport/` for the ones shipped here.
 *
 * The Lua side of the STALKER adapter implements the same shapes in
 * adapters/stalker-anomaly/game-mod/gamedata/scripts/chaos_rt_ipc.script.
 */

export const PROTOCOL_VERSION = 1;

/** Declared shape of one event parameter. */
export interface EventParamSpec {
  type: 'number' | 'string' | 'boolean';
  min?: number;
  max?: number;
  default?: number | string | boolean;
}

/** One event the game says it can perform. */
export interface GameEventDescriptor {
  id: string;
  name: string;
  category: string;
  /** Seconds the event stays active. 0 means instant. */
  duration: number;
  /** Seconds before the event may run again. */
  cooldown: number;
  /** Rarity weight used when building a ballot. Higher is more likely. */
  weight: number;
  params: Record<string, EventParamSpec>;
  /** Whether the game considered it runnable at the moment it was described. */
  available: boolean;
}

export interface ActiveEvent {
  instance_id: number;
  id: string;
  name: string;
  /** Seconds left before cleanup. */
  remaining: number;
}

/** A single row of the in-game vote board. */
export interface VoteOptionView {
  label: string;
  percent: number;
}

// ---------------------------------------------------------------------------
// host -> game
// ---------------------------------------------------------------------------

export type HostMessage =
  | { type: 'ping'; request_id?: string }
  | { type: 'describe'; request_id?: string }
  | {
      type: 'event';
      request_id?: string;
      id: string;
      parameters?: Record<string, number | string | boolean>;
    }
  | { type: 'vote_start'; options: VoteOptionView[]; duration: number }
  | { type: 'vote_update'; options: VoteOptionView[]; seconds_left: number }
  | { type: 'vote_end'; winner?: { id: string; label: string } }
  | { type: 'notify'; text: string; seconds?: number }
  | { type: 'reset'; request_id?: string };

// ---------------------------------------------------------------------------
// game -> host
// ---------------------------------------------------------------------------

interface GameMessageBase {
  protocol: number;
  /** Adapter id, e.g. "stalker-anomaly". */
  game: string;
}

export type EventResultError =
  | 'unknown_event'
  | 'on_cooldown'
  | 'global_cooldown'
  | 'unavailable'
  | 'bad_parameters'
  | 'bad_request'
  | 'refused'
  | 'exception'
  | 'timeout';

export interface EventResult {
  id: string;
  success: boolean;
  error?: EventResultError;
  message?: string;
  name?: string;
  instance_id?: number | null;
  duration?: number;
  cooldown_remaining?: number;
}

export type GameMessage =
  | (GameMessageBase & { type: 'hello'; events: GameEventDescriptor[]; ui?: boolean })
  | (GameMessageBase & { type: 'heartbeat'; active: ActiveEvent[]; online: boolean })
  | (GameMessageBase & { type: 'events'; request_id?: string; events: GameEventDescriptor[] })
  | (GameMessageBase & { type: 'event_result'; request_id?: string } & EventResult)
  | (GameMessageBase & { type: 'pong'; request_id?: string })
  | (GameMessageBase & { type: 'ack'; request_id?: string })
  | (GameMessageBase & { type: 'error'; request_id?: string; error: string })
  | (GameMessageBase & { type: 'goodbye' });

/**
 * Narrow an untrusted parsed JSON value to a GameMessage.
 * Returns null (rather than throwing) so one corrupt line cannot kill the host.
 */
export function parseGameMessage(value: unknown): GameMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const msg = value as Record<string, unknown>;
  if (typeof msg['type'] !== 'string') return null;
  if (typeof msg['game'] !== 'string') return null;
  if (typeof msg['protocol'] !== 'number') return null;
  return msg as unknown as GameMessage;
}
