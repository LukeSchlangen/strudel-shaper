/** Sliding one-minute window for a personal API key. Every upstream call counts, retries included. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a call and returns true if it fits in the window; returns false (and records nothing) if not. */
  take(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.perMinute) return false;
    this.stamps.push(t);
    return true;
  }

  /** Seconds until the oldest call leaves the window. */
  retryAfter(): number {
    const oldest = this.stamps[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((60_000 - (this.now() - oldest)) / 1000));
  }
}
