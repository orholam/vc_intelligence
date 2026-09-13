import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb, type Db } from "../db/index.js";
import { sources } from "../db/schema.js";

/**
 * Realignment (c-plan): sync tier changes from config/feeds.seed.json into the
 * live source registry. importFromRecords() is insert-only by design, so
 * re-tiering needs this update pass keyed on feed_url.
 *
 * Activation semantics (RSS inflow round 08-25): the seed can only DEACTIVATE
 * (`"active": false`). It never re-activates a row an operator pruned via
 * source_events — re-running backfill/seed used to resurrect robots-blocked
 * Google News redirector feeds and mint permanently unfetchable pending items.
 * Reactivation stays an explicit admin action (sources admin API).
 *
 *   pnpm sync-source-tiers
 */

export async function syncSourceTiers(db: Db, seedPath: string): Promise<{
  updatedTier: number; deactivated: number; reactivationsSkipped: number; missingInDb: number; totalSeed: number;
}> {
  const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as {
    feeds: Array<{ name: string; publisher: string; feed_url: string; tier: 1 | 2 | 3; active?: boolean }>;
  };
  const inDb = await db.select().from(sources);
  const byUrl = new Map(inDb.map((s) => [s.feedUrl, s]));

  let updatedTier = 0;
  let deactivated = 0;
  let reactivationsSkipped = 0;
  let missingInDb = 0;

  for (const f of parsed.feeds) {
    const row = byUrl.get(f.feed_url);
    if (!row) {
      missingInDb++;
      continue;
    }
    const patch: Partial<typeof sources.$inferInsert> = { updatedAt: new Date() };
    if (row.tier !== f.tier) patch.tier = f.tier;
    if (f.active === false && row.active) patch.active = false;
    if (f.active !== false && !row.active) reactivationsSkipped++;
    if (patch.tier !== undefined || patch.active !== undefined) {
      // nextPollAt re-arms immediately so the per-tier cadence applies now
      patch.nextPollAt = new Date();
      await db.update(sources).set(patch).where(eq(sources.id, row.id));
      if (patch.tier !== undefined) updatedTier++;
      if (patch.active !== undefined) deactivated++;
    }
  }
  return { updatedTier, deactivated, reactivationsSkipped, missingInDb, totalSeed: parsed.feeds.length };
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const seedPath = process.env.FEEDS_SEED_FILE
    ? path.resolve(process.env.FEEDS_SEED_FILE)
    : path.resolve(new URL(import.meta.url, "file://").pathname, "../../../config/feeds.seed.json");
  const db = createDb(cfg.DATABASE_URL, { max: 1 });
  const res = await syncSourceTiers(db, seedPath);
  console.log("[sync-source-tiers]", JSON.stringify(res));
  process.exit(0);
}

// Run as CLI only (function is imported by backfill for its phase 1.5).
if (process.argv[1]?.includes("sync-source-tiers")) {
  main().catch((err: Error) => {
    console.error("sync-source-tiers failed:", err.message);
    process.exit(1);
  });
}
