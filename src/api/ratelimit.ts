import { Errors } from "../lib/errors.js";

/**
 * NFR-6 per-key rate limiting (default 60 req/min). In-memory sliding window
 * — correct for the single-VPS deployment target (NFR-1); resets on restart.
 */
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function checkRateLimit(keyId: string, limitPerMin: number): void {
  sweepIfNeeded();
  const now = Date.now();
  const windowStart = now - 60_000;
  let hits = buckets.get(keyId);
  if (!hits) {
    hits = [];
    buckets.set(keyId, hits);
  }
  while (hits.length && hits[0]! < windowStart) hits.shift();
  if (hits.length >= limitPerMin) {
    throw Errors.rateLimited(`rate limit of ${limitPerMin}/min exceeded`);
  }
  hits.push(now);
}

function sweepIfNeeded(): void {
  const now = Date.now();
  if (now - lastSweep < 300_000) return;
  lastSweep = now;
  const cutoff = now - 120_000;
  for (const [k, hits] of buckets) {
    const alive = hits.filter((h) => h >= cutoff);
    if (!alive.length) buckets.delete(k);
    else buckets.set(k, alive);
  }
}
