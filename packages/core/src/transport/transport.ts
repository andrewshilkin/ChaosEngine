import type { GameMessage, HostMessage } from '../protocol.js';

export interface TransportStatus {
  /** True while the game has been heard from recently. */
  connected: boolean;
  /** Epoch ms of the last message received from the game, or null. */
  lastSeen: number | null;
  /** Human-readable description of where this transport is pointed. */
  endpoint: string;
}

export type MessageListener = (msg: GameMessage) => void;
export type StatusListener = (status: TransportStatus) => void;

/**
 * A transport moves protocol messages between the host and one game instance.
 *
 * Implementations must be game-agnostic. Adding a new game means writing a new
 * game-side adapter, not a new transport -- unless the game genuinely cannot
 * speak any of the existing ones.
 */
export interface Transport {
  readonly endpoint: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: HostMessage): Promise<void>;
  onMessage(cb: MessageListener): () => void;
  onStatus(cb: StatusListener): () => void;
  status(): TransportStatus;
}

/** Shared listener bookkeeping for transport implementations. */
export abstract class BaseTransport implements Transport {
  abstract readonly endpoint: string;

  protected messageListeners = new Set<MessageListener>();
  protected statusListeners = new Set<StatusListener>();
  protected lastSeen: number | null = null;
  protected connectedFlag = false;

  /**
   * How long without a message before the game counts as disconnected.
   *
   * Generous on purpose. A game adapter's clock is usually the *game* clock,
   * which stops while the game is paused -- and a player alt-tabbing to the
   * voting frontend is exactly when that happens. A short window makes the
   * connection appear to drop every time someone looks at Discord.
   */
  protected staleAfterMs = 60_000;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(msg: HostMessage): Promise<void>;

  onMessage(cb: MessageListener): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  status(): TransportStatus {
    return { connected: this.connectedFlag, lastSeen: this.lastSeen, endpoint: this.endpoint };
  }

  protected emitMessage(msg: GameMessage): void {
    this.lastSeen = Date.now();
    this.setConnected(true);
    for (const cb of this.messageListeners) cb(msg);
  }

  protected setConnected(connected: boolean): void {
    if (this.connectedFlag === connected) return;
    this.connectedFlag = connected;
    const snapshot = this.status();
    for (const cb of this.statusListeners) cb(snapshot);
  }

  /** Call periodically to expire the connection when the game goes quiet. */
  protected checkStale(): void {
    if (!this.connectedFlag) return;
    if (this.lastSeen === null || Date.now() - this.lastSeen > this.staleAfterMs) {
      this.setConnected(false);
    }
  }
}
