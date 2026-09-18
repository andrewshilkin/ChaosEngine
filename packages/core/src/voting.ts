/**
 * Generic voting. No Discord, no game: options in, a winner out.
 *
 * Rules (from the development plan):
 *   - one vote per voter
 *   - voters may change their vote until the timer expires
 *   - the vote closes automatically
 *   - ties are broken deterministically
 */

export interface VoteOption {
  /** Event id this option maps to. */
  id: string;
  label: string;
  /** Parameters to send with the event if this option wins. */
  parameters?: Record<string, number | string | boolean>;
}

export interface VoteTallyRow {
  option: VoteOption;
  votes: number;
  percent: number;
}

export interface VoteResult {
  winner: VoteOption;
  tally: VoteTallyRow[];
  totalVotes: number;
  /** True when nobody voted and the winner was chosen by the tie rule. */
  unvoted: boolean;
}

export class Vote {
  readonly options: VoteOption[];
  readonly durationMs: number;
  readonly startedAt: number;

  /** voterId -> option index */
  private ballots = new Map<string, number>();
  /** option index -> epoch ms of the first vote it received */
  private firstVoteAt = new Map<number, number>();
  private closed = false;

  constructor(
    options: VoteOption[],
    durationSeconds: number,
    private now: () => number = Date.now,
  ) {
    if (options.length < 2) {
      throw new Error('a vote needs at least two options');
    }
    this.options = options;
    this.durationMs = durationSeconds * 1000;
    this.startedAt = this.now();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get voterCount(): number {
    return this.ballots.size;
  }

  secondsLeft(): number {
    const left = this.startedAt + this.durationMs - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /**
   * Record or change a vote.
   * @returns 'added' | 'changed' | 'unchanged' | 'rejected'
   */
  cast(voterId: string, optionId: string): 'added' | 'changed' | 'unchanged' | 'rejected' {
    if (this.closed) return 'rejected';
    const index = this.options.findIndex((o) => o.id === optionId);
    if (index < 0) return 'rejected';

    const previous = this.ballots.get(voterId);
    if (previous === index) return 'unchanged';

    this.ballots.set(voterId, index);
    if (!this.firstVoteAt.has(index)) this.firstVoteAt.set(index, this.now());
    return previous === undefined ? 'added' : 'changed';
  }

  counts(): number[] {
    const counts = new Array(this.options.length).fill(0) as number[];
    for (const index of this.ballots.values()) {
      counts[index] = (counts[index] ?? 0) + 1;
    }
    return counts;
  }

  tally(): VoteTallyRow[] {
    const counts = this.counts();
    const total = this.ballots.size;
    return this.options.map((option, i) => {
      const votes = counts[i] ?? 0;
      return {
        option,
        votes,
        percent: total === 0 ? 0 : Math.round((votes / total) * 100),
      };
    });
  }

  close(): VoteResult {
    this.closed = true;
    const counts = this.counts();
    const total = this.ballots.size;

    // Deterministic tie rule: most votes wins; on a tie the option that reached
    // that count first wins; if still tied (nobody voted) the first option wins.
    let best = 0;
    for (let i = 1; i < this.options.length; i++) {
      const a = counts[i] ?? 0;
      const b = counts[best] ?? 0;
      if (a > b) {
        best = i;
      } else if (a === b && a > 0) {
        const ta = this.firstVoteAt.get(i) ?? Infinity;
        const tb = this.firstVoteAt.get(best) ?? Infinity;
        if (ta < tb) best = i;
      }
    }

    return {
      winner: this.options[best]!,
      tally: this.tally(),
      totalVotes: total,
      unvoted: total === 0,
    };
  }
}

export type VoteTickListener = (vote: Vote) => void;
export type VoteEndListener = (result: VoteResult, vote: Vote) => void;

/**
 * Owns the single active vote and its timers. A frontend (Discord, a web page,
 * a CLI) drives it; nothing in here knows what a frontend is.
 */
export class VotingManager {
  private vote: Vote | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private tickListeners = new Set<VoteTickListener>();
  private endListeners = new Set<VoteEndListener>();

  get active(): Vote | null {
    return this.vote && !this.vote.isClosed ? this.vote : null;
  }

  onTick(cb: VoteTickListener): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onEnd(cb: VoteEndListener): () => void {
    this.endListeners.add(cb);
    return () => this.endListeners.delete(cb);
  }

  start(options: VoteOption[], durationSeconds: number): Vote {
    if (this.active) throw new Error('a vote is already running');
    const vote = new Vote(options, durationSeconds);
    this.vote = vote;

    this.tickTimer = setInterval(() => {
      if (this.vote !== vote || vote.isClosed) return;
      for (const cb of this.tickListeners) cb(vote);
      if (vote.secondsLeft() <= 0) this.finish();
    }, 1000);

    for (const cb of this.tickListeners) cb(vote);
    return vote;
  }

  cast(voterId: string, optionId: string): 'added' | 'changed' | 'unchanged' | 'rejected' {
    const vote = this.active;
    if (!vote) return 'rejected';
    return vote.cast(voterId, optionId);
  }

  /** Close the current vote early or on time. */
  finish(): VoteResult | null {
    const vote = this.vote;
    if (!vote || vote.isClosed) return null;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const result = vote.close();
    for (const cb of this.endListeners) cb(result, vote);
    return result;
  }

  /** Abandon the current vote without declaring a winner. */
  cancel(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.vote = null;
  }
}
