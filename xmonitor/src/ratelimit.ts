import type { LaunchStore } from "./store.js";

export interface RateLimitConfig {
  /** Hard cap on search requests in any rolling 60-minute window. */
  maxSearchesPerHour: number;
  /** Hard cap on search requests in any rolling 24-hour window. */
  maxSearchesPerDay: number;
  /** Minimum enforced gap between consecutive searches (jittered upward). */
  queryGapSeconds: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  maxSearchesPerHour: 10,
  maxSearchesPerDay: 40,
  queryGapSeconds: 25,
};

export type AcquireResult =
  | { ok: true; waitMs: number }
  | { ok: false; reason: "hourly-budget" | "daily-budget"; retryAfterMs: number };

/**
 * Strict, persisted rate limiting. Budgets live in SQLite, so separate
 * invocations (`poll`, `watch`, cron jobs) share one budget — ad-hoc runs
 * cannot exceed what the daemon could have done.
 *
 * A request consumes budget when it is *sent*, regardless of outcome.
 */
export class RateLimiter {
  constructor(
    private readonly store: LaunchStore,
    private readonly cfg: RateLimitConfig,
  ) {}

  acquire(nowMs = Date.now()): AcquireResult {
    if (this.store.searchCountSince(3600) >= this.cfg.maxSearchesPerHour) {
      return { ok: false, reason: "hourly-budget", retryAfterMs: this.untilHourlySlot(nowMs) };
    }
    if (this.store.searchCountSince(86_400) >= this.cfg.maxSearchesPerDay) {
      return { ok: false, reason: "daily-budget", retryAfterMs: this.msUntilDailySlot(nowMs) };
    }

    let waitMs = 0;
    const last = this.store.lastRequestAt();
    if (last !== null) {
      const required = jitteredGap(this.cfg.queryGapSeconds);
      const since = nowMs - last * 1000;
      if (since < required) waitMs = required - since;
    }
    return { ok: true, waitMs };
  }

  record(atSec = Math.floor(Date.now() / 1000)): void {
    this.store.recordRequest(atSec);
  }

  usage(): { lastHour: number; last24h: number; maxPerHour: number; maxPerDay: number } {
    return {
      ...this.store.budgetUsage(),
      maxPerHour: this.cfg.maxSearchesPerHour,
      maxPerDay: this.cfg.maxSearchesPerDay,
    };
  }

  /** When the oldest request inside the hourly window ages out of it. */
  untilHourlySlot(nowMs = Date.now()): number {
    const oldest = this.store.oldestRequestWithin(3600);
    if (oldest === null) return 60_000;
    return Math.max(60_000, oldest * 1000 + 3600_000 - nowMs);
  }

  private msUntilDailySlot(nowMs: number): number {
    const oldest = this.store.oldestRequestWithin(86_400);
    if (oldest === null) return 300_000;
    return Math.max(300_000, oldest * 1000 + 86_400_000 - nowMs);
  }
}

/** gap + up to 50% jitter — never below the configured floor. */
function jitteredGap(seconds: number): number {
  return seconds * 1000 * (1 + Math.random() * 0.5);
}
