#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { formatDigest } from "./digest.js";
import { makeLogger } from "./log.js";
import { RateLimiter } from "./ratelimit.js";
import { createScraper, SessionError } from "./session.js";
import { LaunchStore, type LaunchRow } from "./store.js";
import { pollOnce, type PollResult, watch } from "./watcher.js";

/** Persist a cycle's captures as a markdown artifact. Returns the file path. */
function saveRunDigest(results: PollResult[], dbPath: string): string {
  const items: LaunchRow[] = results.flatMap((r) => r.items);
  const dir = join(dbPath, "..", "digests");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(dir, `run-${stamp}.md`);
  const header =
    `# Run ${new Date().toISOString()} — ${results.length} queries, ` +
    `${items.length} new launches\n\n` +
    results.map((r) => `- ${r.queryId}: fetched ${r.fetched}, new ${r.newLaunches}${r.error ? `, ${r.error}` : ""}`).join("\n") +
    "\n\n---\n\n";
  writeFileSync(path, header + formatDigest(items, { minViews: 0, format: "md" }), "utf8");
  return path;
}

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]?.startsWith("--")) {
        flags[a.slice(2)] = argv[i + 1] as string;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function num(flags: Args["flags"], name: string): number | undefined {
  const raw = flags[name];
  if (typeof raw !== "string") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.positional[0] ?? "watch";
  const cfg = loadConfig();
  const log = makeLogger(cfg.logLevel);

  switch (cmd) {
    case "watch":
    case "poll": {
      const onDemand = cmd === "poll" || args.flags.once !== undefined;
      const maxQueries = num(args.flags, "max-queries");
      const store = new LaunchStore(cfg.dbPath);
      const limiter = new RateLimiter(store, cfg);
      try {
        const scraper = await createScraper(cfg, log);
        if (onDemand) {
          console.log("[poll] single cycle (on demand)");
          const results = await pollOnce(scraper, store, cfg, log, { maxQueries });
          const fresh = results.reduce((n, r) => n + r.newLaunches, 0);
          const skipped = results.filter((r) => r.error?.startsWith("skipped:")).length;
          for (const r of results) {
            console.log(`  ${r.queryId.padEnd(20)} fetched ${String(r.fetched).padStart(3)}  new ${String(r.newLaunches).padStart(3)}${r.error ? `  [${r.error}]` : ""}`);
          }
          console.log(`[poll] ${results.length} queries, ${fresh} new launches${skipped ? `, ${skipped} skipped (budget)` : ""}`);
          if (fresh > 0) {
            const path = saveRunDigest(results, cfg.dbPath);
            console.log(`[digest] run captures saved to ${path}`);
          }
          const usage = limiter.usage();
          console.log(`[budget] ${usage.lastHour}/${usage.maxPerHour} per hour · ${usage.last24h}/${usage.maxPerDay} per day`);
        } else {
          console.log(
            `[watch] polling every ~${cfg.pollMinutes}m — strict limits: ${cfg.maxSearchesPerHour}/h, ${cfg.maxSearchesPerDay}/d, ≥${cfg.queryGapSeconds}s between searches. Ctrl+C to stop`,
          );
          const stop = () => {
            console.log("\n[watch] shutting down");
            store.close();
            process.exit(0);
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          await watch(scraper, store, cfg, log);
        }
      } finally {
        store.close();
      }
      break;
    }

    case "digest": {
      const store = new LaunchStore(cfg.dbPath);
      const hours = num(args.flags, "hours") ?? cfg.digestHours;
      const limit = num(args.flags, "limit") ?? 25;
      const minScore = num(args.flags, "min-score") ?? cfg.minScore;
      const minViews = num(args.flags, "min-views") ?? cfg.minViews;
      const minLikes = num(args.flags, "min-likes") ?? cfg.minLikes;
      const maxLikes = num(args.flags, "max-likes") ?? cfg.maxLikes;
      const format = args.flags.format === "text" || args.flags.format === "md"
        ? (args.flags.format as "text" | "md")
        : "md";
      const launches = store.recentLaunches({ sinceHours: hours, limit, minScore, minViews, minLikes, maxLikes });
      console.log(formatDigest(launches, { minViews, format }));
      store.close();
      break;
    }

    case "runs": {
      const store = new LaunchStore(cfg.dbPath);
      const rows = store.recentPolls(num(args.flags, "limit") ?? 30);
      if (!rows.length) {
        console.log("No polls recorded yet.");
        break;
      }
      // Group rows into runs: a gap > 15 min starts a new run.
      const groups: Array<typeof rows> = [[]];
      for (const [i, row] of rows.entries()) {
        const prev = rows[i - 1];
        if (prev && prev.ranAtSec - row.ranAtSec > 900) groups.push([]);
        groups[groups.length - 1]?.push(row);
      }
      for (const g of groups) {
        const start = g[g.length - 1];
        if (!start) continue;
        const fetched = g.reduce((n, r) => n + r.fetched, 0);
        const fresh = g.reduce((n, r) => n + r.newLaunches, 0);
        const errors = g.filter((r) => r.error).length;
        const when = new Date(start.ranAtSec * 1000).toISOString().slice(0, 16).replace("T", " ");
        console.log(`${when}  ${g.length} queries · fetched ${fetched} · new ${fresh}${errors ? ` · ${errors} errors` : ""}`);
        for (const r of [...g].reverse()) {
          const t = new Date(r.ranAtSec * 1000).toISOString().slice(11, 19);
          console.log(`   ${t}  ${r.queryId.padEnd(20)} fetched ${String(r.fetched).padStart(3)}  new ${String(r.newLaunches).padStart(3)}${r.error ? `  [${r.error.slice(0, 60)}]` : ""}`);
        }
      }
      store.close();
      break;
    }

    case "list": {
      const store = new LaunchStore(cfg.dbPath);
      const limit = num(args.flags, "limit") ?? 20;
      const rows = store.listLaunches(limit);
      if (!rows.length) {
        console.log("Nothing captured yet.");
        break;
      }
      for (const l of rows.reverse()) {
        const when = new Date((l.postedAtSec ?? l.firstSeenAtSec) * 1000).toISOString().slice(5, 16).replace("T", " ");
        console.log(`${when}  @${l.authorHandle.padEnd(18)} ❤${String(l.likes).padStart(6)} 👁${String(l.views).padStart(8)}  s${l.score.toFixed(2)}  ${l.linkedDomain ?? "-"}`);
        console.log(`            ${l.text.replace(/\s+/g, " ").slice(0, 140)}`);
      }
      store.close();
      break;
    }

    case "stats": {
      const store = new LaunchStore(cfg.dbPath);
      const limiter = new RateLimiter(store, cfg);
      const s = store.stats();
      console.log(`launches total=${s.totalLaunches} last24h=${s.last24h}`);
      if (s.lastPollAt !== null) {
        console.log(`last poll at ${new Date(s.lastPollAt * 1000).toISOString()} (${Math.floor((Date.now() - s.lastPollAt * 1000) / 60_000)}m ago)`);
      }
      const u = limiter.usage();
      console.log(`budget searches: ${u.lastHour}/${u.maxPerHour} per hour · ${u.last24h}/${u.maxPerDay} per day`);
      store.close();
      break;
    }

    case "auth": {
      const result = await runAuth(
        {
          file: typeof args.flags.file === "string" ? args.flags.file : undefined,
          paste: args.flags.paste === true,
          browser: args.flags.browser === true,
          profile: args.flags.profile === true
            ? true
            : typeof args.flags.profile === "string"
              ? args.flags.profile
              : undefined,
          firefox: args.flags.firefox === true
            ? true
            : typeof args.flags.firefox === "string"
              ? args.flags.firefox
              : undefined,
          force: args.flags.force === true,
          timeoutSec: num(args.flags, "timeout"),
        },
        cfg,
        log,
      );
      console.log(
        result.validated
          ? `[auth] OK — ${result.cookieCount} cookies validated and saved to ${result.sessionFile}`
          : `[auth] saved ${result.cookieCount} cookies (unvalidated) to ${result.sessionFile}`,
      );
      console.log("[auth] next: `pnpm --filter @copyr/xmonitor session:check`, then `watch` or `poll`");
      break;
    }

    case "session-check": {
      const scraper = await createScraper(cfg, log);
      const ok = await scraper.isLoggedIn();
      console.log(ok ? "session OK" : "session INVALID");
      if (!ok) process.exitCode = 1;
      break;
    }

    default:
      console.error(
        `Unknown command "${cmd}". Commands:
  auth      --firefox | --profile [path] | --paste | --file <path> | --browser [--force] [--timeout SEC]
  watch     continuous monitor
  poll      on-demand single cycle [--max-queries N]
  digest    [--hours N] [--limit N] [--min-score X] [--min-views N] [--min-likes N] [--max-likes N] [--format md|text]
  runs      recent poll history (per-query fetched/new/errors)
  list      raw capture feed, newest first [--limit N]
  stats     totals + budget usage
  session-check  validate stored cookies`,
      );
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof SessionError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
