# xmonitor

X (Twitter) launch watcher: polls authenticated X search for serious product
launches — announcement posts ("Introducing…", "just launched…") paired with a
native video — dedupes them to SQLite, and emits ranked digests.

Part of the intelligence service, but self-contained: own DB (SQLite via
`node:sqlite`), no Postgres dependency.

## Why search instead of a watchlist

One authenticated query covers *all* accounts on X, so discovery scales without
maintaining a list. The default queries are:

```
<introducing|we're launching|just launched|proud to announce|launching today|now live>
  filter:native_video -filter:replies -filter:retweets lang:en
```

A classifier then scores each hit: leading announcement phrase + native video +
own-domain link = high score; webinar/hiring/giveaway noise is demoted.

## Session setup (required)

X search requires a logged-in session; anonymous access cannot search. Use a
**dedicated aged account** — never your personal one. Automated access violates
the X ToS and accounts can be suspended at any time.

Get your session in via the CLI:

```sh
pnpm --filter @copyr/xmonitor auth --firefox   # reads cookies.sqlite (Firefox/Zen/Floorp), auto-detects newest profile
pnpm --filter @copyr/xmonitor auth --profile   # Chrome/Chromium profile (browser must be fully closed)
pnpm --filter @copyr/xmonitor auth --paste     # paste "name=value; name2=value2" from DevTools -> Cookies
pnpm --filter @copyr/xmonitor auth --file cookies.txt   # raw header file or Cookie-Editor JSON export
```

Cookies are validated with one live request before being saved to
`XM_SESSION_FILE` (0600). On a blocked network use `--force` to save without
validation. Then:

```sh
pnpm --filter @copyr/xmonitor session:check    # confirm the stored session loads
```

The `--browser` path needs Playwright (optional):
`pnpm --filter @copyr/xmonitor add -D playwright && pnpm --filter @copyr/xmonitor exec playwright install chromium`

Refreshed cookies are re-persisted on every successful run, so you only redo
auth when X invalidates the session (typically weeks).

If polls fail with `Unable to resolve the X ondemand chunk URL`, X is serving
bot-wall HTML to Node's homepage fetch (TLS fingerprinting). Set
`XM_DISABLE_TXHEADERS=1` — authenticated searches work without the generated
headers.

## Usage

```sh
pnpm --filter @copyr/xmonitor watch          # continuous poll loop (default every ~10m)
pnpm --filter @copyr/xmonitor poll           # on demand: one cycle, then exit
pnpm --filter @copyr/xmonitor poll --max-queries 2   # on demand, only top 2 queries
pnpm --filter @copyr/xmonitor digest         # last 24h launches, markdown
pnpm --filter @copyr/xmonitor stats          # totals + remaining budget
```

Digest filters: `--hours N --limit N --min-score 0..1 --min-views N --format md|text`.

## Strict rate limits

All invocations share one persisted budget (stored in SQLite), so ad-hoc runs,
the daemon, and cron jobs cannot collectively exceed it:

| Limit | Default | Env var |
|---|---|---|
| Searches per rolling hour | 10 | `XM_MAX_SEARCHES_PER_HOUR` |
| Searches per rolling day | 40 | `XM_MAX_SEARCHES_PER_DAY` |
| Minimum gap between searches | 25s (jittered up to +50%) | `XM_QUERY_GAP_SECONDS` |
| Tweets fetched per query | 60 | `XM_MAX_TWEETS_PER_POLL` |

A request consumes budget when it is *sent*, success or not. When the budget is
exhausted, remaining queries are skipped (`skipped:budget` in the polls table)
and the watch loop sleeps until the hourly window frees up. `stats` shows
current usage; `poll` prints it after each run.

Run from your normal residential IP, not a datacenter host — X blocks
datacenter ranges aggressively and behavioral scoring (not fingerprinting) is
what gets fresh/automation-heavy accounts suspended.

## Operational notes

- Cadence: 6 queries per cycle ≈ well under observed account rate limits.
  Failures back off exponentially up to 60 minutes.
- Breakage: X rotates its internals regularly; this package pins
  `@the-convocation/twitter-scraper` (actively maintained, handles
  `x-client-transaction-id` / `xpff` headers). Bump the version if auth or
  search starts failing after an X change.
- Escalation path if accounts keep dying or volume grows: managed unofficial
  APIs (e.g. twitterapi.io, ~$0.15/1K tweets, free credits) behind the same
  interface, or the official X API pay-per-use tier ($0.005/read).

## Layout

- `src/queries.ts` – search-query construction (pure)
- `src/classify.ts` – scoring/noise heuristics (pure)
- `src/store.ts` – SQLite store (`node:sqlite`)
- `src/session.ts` – cookie parsing/persistence + scraper factory
- `src/watcher.ts` – poll loop with jitter/backoff
- `src/digest.ts` – digest rendering
- `src/cli.ts` – commands

## Legal

Reading public posts through an authenticated session breaches the X Terms of
Service (civil contract matter) even though the data itself is public. Do not
resell raw scraped content. This tool is for internal monitoring.
