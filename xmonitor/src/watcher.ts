import { SearchMode, type Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { extractExternalDomain, scoreLaunch } from "./classify.js";
import type { XMonitorConfig } from "./config.js";
import type { Logger } from "./log.js";
import { mergeQueries, type LaunchQuery } from "./queries.js";
import { RateLimiter } from "./ratelimit.js";
import type { LaunchRow, LaunchStore, NewLaunch } from "./store.js";

export interface PollResult {
  queryId: string;
  fetched: number;
  newLaunches: number;
  /** The launches newly captured by this query. */
  items: LaunchRow[];
  error?: string;
}

export interface PollOptions {
  /** Hard cap on queries executed this run; remaining ones are skipped. */
  maxQueries?: number;
}

function tweetToLaunch(t: Tweet, q: LaunchQuery): NewLaunch | null {
  if (!t.id) return null;
  if (t.isRetweet || t.isReply) return null;

  const domain = extractExternalDomain(t.urls ?? []);
  const { score } = scoreLaunch({
    text: t.text ?? "",
    videoCount: t.videos?.length ?? 0,
    views: t.views ?? 0,
    likes: t.likes ?? 0,
    externalDomain: domain,
  });

  const postedAtSec = t.timestamp ?? (t.timeParsed ? Math.floor(t.timeParsed.getTime() / 1000) : null);

  return {
    tweetId: t.id,
    authorHandle: (t.username ?? "unknown").replace(/^@/, ""),
    authorName: t.name,
    text: t.text ?? "",
    url: t.permanentUrl ?? `https://x.com/${t.username ?? ""}/status/${t.id}`,
    linkedDomain: domain,
    videoCount: t.videos?.length ?? 0,
    views: t.views ?? 0,
    likes: t.likes ?? 0,
    retweets: t.retweets ?? 0,
    replies: t.replies ?? 0,
    score,
    queryId: q.id,
    postedAtSec,
  };
}

/**
 * Run one poll across all queries. Never throws; per-query failures and
 * budget skips are recorded. Every search passes through the strict,
 * persisted rate limiter.
 */
export async function pollOnce(
  scraper: Scraper,
  store: LaunchStore,
  cfg: XMonitorConfig,
  log: Logger,
  opts: PollOptions = {},
): Promise<PollResult[]> {
  const limiter = new RateLimiter(store, {
    maxSearchesPerHour: cfg.maxSearchesPerHour,
    maxSearchesPerDay: cfg.maxSearchesPerDay,
    queryGapSeconds: cfg.queryGapSeconds,
  });

  const allQueries = mergeQueries(cfg.extraQueries, { minFaves: cfg.queryMinFaves });
  const queries = typeof opts.maxQueries === "number" ? allQueries.slice(0, Math.max(0, opts.maxQueries)) : allQueries;
  const results: PollResult[] = [];
  let budgetExhausted = false;

  for (const q of queries) {
    if (budgetExhausted) {
      results.push({ queryId: q.id, fetched: 0, newLaunches: 0, items: [], error: "skipped:budget" });
      continue;
    }

    const decision = limiter.acquire();
    if (!decision.ok) {
      log.warn({ queryId: q.id, reason: decision.reason }, "budget exhausted, skipping");
      store.recordPoll({ queryId: q.id, fetched: 0, newLaunches: 0, error: `skipped:${decision.reason}` });
      results.push({ queryId: q.id, fetched: 0, newLaunches: 0, items: [], error: `skipped:${decision.reason}` });
      budgetExhausted = true;
      continue;
    }
    if (decision.waitMs > 0) {
      log.debug({ waitMs: decision.waitMs }, "rate-limit gap");
      await sleep(decision.waitMs);
    }

    let fetched = 0;
    let inserted = 0;
    const items: LaunchRow[] = [];
    try {
      limiter.record(); // consume budget when the request is sent
      for await (const tweet of scraper.searchTweets(q.text, cfg.maxTweetsPerPoll, SearchMode.Latest)) {
        fetched++;
        const launch = tweetToLaunch(tweet, q);
        if (!launch) continue;
        if (launch.authorHandle === "unknown") continue;
        if (store.insertLaunch(launch)) {
          inserted++;
          items.push({ ...launch, firstSeenAtSec: Math.floor(Date.now() / 1000) });
        }
      }
      store.recordPoll({ queryId: q.id, fetched, newLaunches: inserted });
      log.info({ queryId: q.id, fetched, newLaunches: inserted }, "poll ok");
      results.push({ queryId: q.id, fetched, newLaunches: inserted, items });
    } catch (err) {
      const message = (err as Error).message;
      store.recordPoll({ queryId: q.id, fetched, newLaunches: inserted, error: message.slice(0, 300) });
      log.error({ queryId: q.id, err: message }, "poll failed");
      results.push({ queryId: q.id, fetched, newLaunches: inserted, items, error: message });
    }
  }

  return results;
}

/**
 * Long-running loop with jittered cadence and exponential backoff on failure.
 * When a cycle is cut short by the persisted budget, sleeps until the
 * hourly window frees up instead of hammering.
 */
export async function watch(scraper: Scraper, store: LaunchStore, cfg: XMonitorConfig, log: Logger): Promise<void> {
  const limiter = new RateLimiter(store, {
    maxSearchesPerHour: cfg.maxSearchesPerHour,
    maxSearchesPerDay: cfg.maxSearchesPerDay,
    queryGapSeconds: cfg.queryGapSeconds,
  });
  let consecutiveFailures = 0;

  while (true) {
    const started = Date.now();
    const results = await pollOnce(scraper, store, cfg, log);
    const executed = results.filter((r) => r.error === undefined);
    const anyError = executed.some((r) => r.fetched === 0 && r.newLaunches === 0);
    const allSkipped = executed.length === 0 && results.length > 0;

    consecutiveFailures = anyError ? consecutiveFailures + 1 : 0;

    let waitMs: number;
    if (allSkipped) {
      const retryAfter = limiter.untilHourlySlot(Date.now());
      waitMs = jitter(retryAfter, retryAfter * 1.2);
    } else {
      const backoffMinutes = Math.min(cfg.pollMinutes * 2 ** consecutiveFailures, 60);
      waitMs = jitter(backoffMinutes * 60_000 * 0.9, backoffMinutes * 60_000 * 1.1);
    }

    log.info(
      { elapsedMs: Date.now() - started, nextInMin: Math.round(waitMs / 60_000), consecutiveFailures },
      "cycle complete",
    );
    await sleep(waitMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
}
