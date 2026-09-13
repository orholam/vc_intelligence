import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { makeLogger } from "./log.js";
import { LaunchStore, type OkaraLaunch } from "./store.js";
import { fetchLaunches } from "./okara.js";
import { syncLaunches } from "./syncdb.js";
import { isSyncable } from "./mapping.js";

const usage = `launchmonitor — Okara Launch Library -> intelligence

Usage:
  lm import <file.json>      Load an Okara launch JSON export into the local store
  lm fetch [--pages N]       Live-fetch launches from okara.ai (bot-protected; see README)
  lm sync [--dry-run]        Push stored launches into the intelligence Postgres DB
  lm digest [--limit N]      Markdown digest of stored launches by views
  lm stats                   Store + recent sync summary
`;

function parseArgs(argv: string[]): { args: Record<string, string | boolean>; positional: string[] } {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--dry-run") args["dry-run"] = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else positional.push(a);
  }
  return { args, positional };
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(usage);
    process.exit(0);
  }
  const cfg = loadConfig();
  const log = makeLogger(cfg.LOG_LEVEL);
  const { args, positional } = parseArgs(rest);
  const store = new LaunchStore(cfg.LM_DB_PATH);

  try {
    switch (cmd) {
      case "import": {
        const file = positional[0];
        if (!file) throw new Error("usage: import <file.json>");
        const parsed = JSON.parse(readFileSync(file, "utf8")) as
          | OkaraLaunch[]
          | { launches: OkaraLaunch[] };
        const launches = Array.isArray(parsed) ? parsed : parsed.launches;
        let inserted = 0;
        let updated = 0;
        for (const l of launches) {
          if (store.upsertLaunch(l) === "inserted") inserted++;
          else updated++;
        }
        console.log(`imported ${inserted} new, refreshed ${updated} (store total ${store.count()})`);
        break;
      }

      case "fetch": {
        const res = await fetchLaunches({
          baseUrl: cfg.LM_LIBRARY_BASE_URL,
          maxPages: Number(args["pages"] ?? cfg.LM_MAX_PAGES),
          gapMs: cfg.LM_PAGE_GAP_MS,
          onPage: (batch) => {
            for (const l of batch) store.upsertLaunch(l);
            log.info({ n: batch.length }, "page captured");
          },
        });
        console.log(JSON.stringify(res));
        console.log(`store total: ${store.count()}`);
        if (res.blocked) {
          console.error(
            "\nokara.ai blocked the request (403 Automated access denied).\n" +
              "Capture the API JSON with a real browser session and use `lm import <file>` instead.\n" +
              "Repeated automated retries risk IP blacklisting — not attempted.",
          );
          process.exitCode = 3;
        }
        break;
      }

      case "sync": {
        const launches = store.allLaunches().filter(isSyncable);
        console.log(`syncing ${launches.length} launches -> ${cfg.LM_DATABASE_URL}${args["dry-run"] ? " (dry-run)" : ""}`);
        const counts = await syncLaunches(launches, {
          databaseUrl: cfg.LM_DATABASE_URL,
          dryRun: Boolean(args["dry-run"]),
          onProgress: (m) => console.log(m),
        });
        console.log(JSON.stringify(counts));
        store.recordSync({
          total: counts.source,
          entitiesCreated: counts.entitiesCreated,
          entitiesMatched: counts.entitiesMatched,
          articlesInserted: counts.articlesInserted,
          articlesExisting: counts.articlesExisting,
          linksCreated: counts.linksCreated,
        });
        break;
      }

      case "digest": {
        const limit = Number(args["limit"] ?? 25);
        const launches = store.allLaunches()
          .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
          .slice(0, limit);
        console.log(`# Launch Library digest (${launches.length} of ${store.count()})\n`);
        for (const l of launches) {
          const views = l.views != null ? `${Math.round(l.views / 1e5) / 10}M` : "?";
          console.log(`- **${l.company_name ?? l.slug}** — ${l.tagline ?? ""} _(${views} views, ${l.launched_at ?? "?"})_`);
          if (l.launch_url) console.log(`  ${l.launch_url}`);
        }
        break;
      }

      case "stats": {
        console.log(`launches: ${store.count()}`);
        const syncs = store.recentSyncs(5) as Array<Record<string, unknown>>;
        for (const s of syncs) console.log("sync:", JSON.stringify(s));
        break;
      }

      default:
        console.error(`unknown command: ${cmd}\n${usage}`);
        process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}

main().catch((e: Error) => {
  console.error("launchmonitor failed:", e.message);
  process.exit(1);
});
