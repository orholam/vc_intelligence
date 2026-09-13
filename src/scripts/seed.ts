import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { gdeltQueries, sources } from "../db/schema.js";
import { opaqueId } from "../lib/ulid.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Seeds the source registry (FR-1: >=150 feeds) + default GDELT topic queries
 * (FR-3). Idempotent on feed_url.
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 1 });

  const seedPath =
    process.env.FEEDS_SEED_FILE ??
    path.resolve(new URL(import.meta.url, "file://").pathname, "../../../config/feeds.seed.json");
  const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as {
    feeds: Array<{
      name: string;
      publisher: string;
      feed_url: string;
      tier: 1 | 2 | 3;
      country: string | null;
      default_language: string;
      topics: string[];
      active?: boolean;
    }>;
  };

  let inserted = 0;
  for (const f of parsed.feeds) {
    const res = await db
      .insert(sources)
      .values({
        id: opaqueId("src"),
        name: f.name,
        publisher: f.publisher,
        feedUrl: f.feed_url,
        tier: f.tier,
        country: f.country,
        defaultLanguage: f.default_language ?? "en",
        topics: f.topics ?? [],
        // Honor seed deactivations: robots-blocked redirector feeds stay dark
        // even after a purge+re-import cycle.
        active: f.active ?? true,
        nextPollAt: new Date(),
      })
      .onConflictDoNothing({ target: sources.feedUrl })
      .returning({ id: sources.id });
    inserted += res.length;
  }

  const topicSeeds = [
    '"series a" OR "series b" funding',
    'startup funding round',
    '"mergers and acquisitions"',
    '"files for bankruptcy" OR "chapter 11"',
    '"appoints new CEO" OR "named CEO"',
    // deal-flow verticals (added during archive broadening)
    'robotics startup funding',
    'semiconductor fab investment',
    'biotech acquisition',
    'climate tech raise',
  ];
  const existing = new Set(
    (await db.select({ q: gdeltQueries.query }).from(gdeltQueries)).map((r) => r.q),
  );
  let topicsAdded = 0;
  for (const q of topicSeeds) {
    if (existing.has(q)) continue;
    await db.insert(gdeltQueries).values({ id: opaqueId("gdq"), query: q });
    topicsAdded++;
  }
  const total = await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM sources`);
  console.error(JSON.stringify({
    ok: true,
    inserted,
    topicsAdded,
    totalSources: Number(total[0]?.n ?? 0),
    requirementMin: 150,
  }));
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("seed failed:", err.message);
  process.exit(1);
});
