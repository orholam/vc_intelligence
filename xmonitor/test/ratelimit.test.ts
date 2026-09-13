import { describe, expect, it } from "vitest";
import { RateLimiter, type RateLimitConfig } from "../src/ratelimit.js";
import { LaunchStore } from "../src/store.js";

const cfg: RateLimitConfig = {
  maxSearchesPerHour: 3,
  maxSearchesPerDay: 5,
  queryGapSeconds: 0,
};

describe("RateLimiter", () => {
  it("allows requests under budget and records them", () => {
    const store = new LaunchStore(":memory:");
    const limiter = new RateLimiter(store, cfg);
    for (let i = 0; i < 3; i++) {
      const d = limiter.acquire();
      expect(d.ok).toBe(true);
      limiter.record();
    }
    expect(store.searchCountSince(3600)).toBe(3);
    store.close();
  });

  it("blocks on the hourly cap and reports retry time", () => {
    const store = new LaunchStore(":memory:");
    const limiter = new RateLimiter(store, cfg);
    for (let i = 0; i < 3; i++) limiter.record();

    const d = limiter.acquire();
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("hourly-budget");
      expect(d.retryAfterMs).toBeGreaterThan(0);
    }
    store.close();
  });

  it("blocks on the daily cap once hourly would allow", () => {
    const store = new LaunchStore(":memory:");
    // hour cap 4 > day cap 2: daily must trigger first after 2 requests
    const limiter = new RateLimiter(store, { ...cfg, maxSearchesPerHour: 4, maxSearchesPerDay: 2 });
    limiter.record();
    limiter.record();
    const d = limiter.acquire();
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("daily-budget");
    store.close();
  });

  it("enforces the inter-query gap via waitMs", () => {
    const store = new LaunchStore(":memory:");
    const limiter = new RateLimiter(store, { ...cfg, queryGapSeconds: 60 });
    const now = Date.now();
    limiter.record(Math.floor(now / 1000));
    const d = limiter.acquire(now + 10_000); // only ~10s since last request
    expect(d.ok).toBe(true);
    if (d.ok) {
      // gap is 60-90s (jittered); minus ~10s elapsed and <=1s second-flooring
      expect(d.waitMs).toBeGreaterThan(45_000);
      expect(d.waitMs).toBeLessThan(90_000);
    }
    store.close();
  });

  it("recovers when old requests age out of the window", () => {
    const store = new LaunchStore(":memory:");
    const limiter = new RateLimiter(store, { ...cfg, queryGapSeconds: 0 });
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    for (let i = 0; i < 3; i++) limiter.record(twoHoursAgo);

    const d = limiter.acquire();
    expect(d.ok).toBe(true);
    store.close();
  });

  it("reports usage", () => {
    const store = new LaunchStore(":memory:");
    const limiter = new RateLimiter(store, cfg);
    limiter.record();
    const u = limiter.usage();
    expect(u.lastHour).toBe(1);
    expect(u.maxPerHour).toBe(3);
    store.close();
  });
});
