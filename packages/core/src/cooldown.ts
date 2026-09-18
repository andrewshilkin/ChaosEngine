/**
 * Host-side mirror of the game's cooldowns.
 *
 * The game enforces cooldowns authoritatively; this copy exists so a ballot is
 * never built out of events that would be refused, and so the bot can show
 * remaining time without a round trip.
 */
export class CooldownManager {
  private until = new Map<string, number>();
  private globalUntil = 0;

  constructor(
    /** Minimum gap between any two events, in seconds. */
    public globalCooldownSeconds = 0,
    private now: () => number = Date.now,
  ) {}

  /** Arm the cooldown for an event that just ran. */
  arm(id: string, cooldownSeconds: number): void {
    if (cooldownSeconds > 0) {
      this.until.set(id, this.now() + cooldownSeconds * 1000);
    }
    if (this.globalCooldownSeconds > 0) {
      this.globalUntil = this.now() + this.globalCooldownSeconds * 1000;
    }
  }

  /** Adopt a remaining time the game reported, e.g. after a refused execution. */
  adopt(id: string, remainingSeconds: number): void {
    if (remainingSeconds > 0) {
      this.until.set(id, this.now() + remainingSeconds * 1000);
    } else {
      this.until.delete(id);
    }
  }

  remaining(id: string): number {
    const at = this.until.get(id);
    if (at === undefined) return 0;
    const left = at - this.now();
    if (left <= 0) {
      this.until.delete(id);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  globalRemaining(): number {
    const left = this.globalUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  ready(id: string): boolean {
    return this.remaining(id) === 0 && this.globalRemaining() === 0;
  }

  clear(): void {
    this.until.clear();
    this.globalUntil = 0;
  }
}
