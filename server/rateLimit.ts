export interface RateLimitResult {
  ok: boolean;
  reason?: 'global' | 'ip';
  retryAfter: number;
}

/** Sliding one-minute window for a personal API key. Every upstream call counts, retries included. */
export class RateLimiter {
  private stamps: number[] = [];
  private ipStamps = new Map<string, number[]>();

  constructor(
    readonly perMinute: number,
    readonly perIpPerMinute: number = Math.max(2, Math.min(10, Math.floor(perMinute / 2))),
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a call and returns true if it fits in both global and per-IP windows. */
  take(ip?: string): boolean {
    return this.check(ip).ok;
  }

  check(ip?: string): RateLimitResult {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.perMinute) {
      return { ok: false, reason: 'global', retryAfter: this.retryAfterGlobal() };
    }

    if (ip) {
      const existing = (this.ipStamps.get(ip) ?? []).filter((s) => t - s < 60_000);
      if (existing.length >= this.perIpPerMinute) {
        const oldestIp = existing[0];
        const wait = oldestIp === undefined ? 1 : Math.max(1, Math.ceil((60_000 - (t - oldestIp)) / 1000));
        return { ok: false, reason: 'ip', retryAfter: wait };
      }
      existing.push(t);
      this.ipStamps.set(ip, existing);

      // Periodic cleanup of stale IPs to prevent memory leaks
      if (this.ipStamps.size > 2000) {
        for (const [key, times] of this.ipStamps.entries()) {
          const fresh = times.filter((s) => t - s < 60_000);
          if (fresh.length === 0) this.ipStamps.delete(key);
          else this.ipStamps.set(key, fresh);
        }
      }
    }

    this.stamps.push(t);
    return { ok: true, retryAfter: 0 };
  }

  private retryAfterGlobal(): number {
    const oldest = this.stamps[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((60_000 - (this.now() - oldest)) / 1000));
  }

  /** Seconds until the oldest call leaves the window. */
  retryAfter(): number {
    return this.retryAfterGlobal();
  }
}
