import { sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { LlmRouter, makeProvider } from "../llm/router.js";
import { clusterArticle } from "../clustering/cluster.js";

/**
 * Rebuild story clusters over a recent window with the CURRENT clustering
 * config (thresholds / gates). Wipes story assignments for the affected
 * articles and re-runs clusterArticle chronologically so pairs that were
 * missed under an older, stricter threshold collapse into one story.
 *
 * Dry-run by default; pass --apply to write.
 *
 * Usage:
 *   pnpm tsx --env-file-if-exists=.env.local src/scripts/recluster-stories.ts -- --days=4 [--apply]
 */

function arg(name: string, def: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const v = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

async function main(): Promise<void> {
  const days = arg("days", 4);
  const apply = process.argv.includes("--apply");
  resetConfigCache();
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 4 });
  const router = new LlmRouter(db, makeProvider());

  const windowStart = new Date(Date.now() - days * 24 * 3600_000);

  // Seed set: kept articles inside the window (with or without embeddings).
  const seed = await db.execute<{ id: string }>(sql`
    SELECT id FROM articles
    WHERE noise_stage = 'kept' AND published_at >= ${windowStart.toISOString()}
  `);
  const seedIds = seed.map((r) => r.id);
  console.log(`[recluster] window=${windowStart.toISOString()}..now seed_articles=${seedIds.length}`);
  if (!seedIds.length) return;

  // Expand one hop: any kept article sharing a story with a seed article joins
  // the rebuild so story rows we drop lose no remaining members.
  const expanded = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT a.id FROM articles a
    WHERE a.noise_stage = 'kept' AND a.story_cluster_id IN (
      SELECT DISTINCT story_cluster_id FROM articles
      WHERE noise_stage = 'kept' AND story_cluster_id IS NOT NULL
        AND id IN (${sql.join(seedIds.map((id) => sql`${id}`), sql`, `)})
    )
  `);
  const ids = new Set(expanded.map((r) => r.id));
  for (const id of seedIds) ids.add(id);
  const idList = [...ids];

  const before = await db.execute<{ n: number }>(sql`
    SELECT COUNT(DISTINCT story_cluster_id)::int AS n FROM articles
    WHERE noise_stage = 'kept' AND story_cluster_id IS NOT NULL
      AND id IN (${sql.join(idList.map((id) => sql`${id}`), sql`, `)})
  `);
  console.log(`[recluster] rebuild_set=${idList.length} stories_before=${before[0]?.n ?? 0}${apply ? "" : " (dry run)"}`);

  if (!apply) {
    const preview = await db.execute<{ title: string; sid: string | null }>(sql`
      SELECT title, story_cluster_id AS sid FROM articles
      WHERE noise_stage = 'kept' AND id IN (${sql.join(idList.map((id) => sql`${id}`), sql`, `)})
      ORDER BY published_at DESC LIMIT 15
    `);
    for (const r of preview) console.log(`  preview [${(r.sid ?? "none").slice(-8)}] ${r.title.slice(0, 80)}`);
    console.log("[recluster] pass --apply to execute");
    return;
  }

  await db.execute(sql`
    UPDATE articles SET story_cluster_id = NULL, is_cluster_representative = FALSE,
      clustered_at = NULL, updated_at = now()
    WHERE id IN (${sql.join(idList.map((id) => sql`${id}`), sql`, `)})
  `);
  await db.execute(sql`
    DELETE FROM stories s WHERE NOT EXISTS (
      SELECT 1 FROM articles a WHERE a.story_cluster_id = s.id
    )
  `);

  let created = 0;
  let joined = 0;
  let failed = 0;
  const ordered = await db.execute<{ id: string; title: string }>(sql`
    SELECT id, title FROM articles
    WHERE noise_stage = 'kept' AND id IN (${sql.join(idList.map((id) => sql`${id}`), sql`, `)})
    ORDER BY published_at ASC
  `);
  for (const art of ordered) {
    try {
      const res = await clusterArticle(db, router, art.id);
      if (res.created) created += 1;
      else joined += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[recluster] failed ${art.id}: ${(e as Error).message}`);
    }
  }

  const after = await db.execute<{ n: number }>(sql`
    SELECT COUNT(DISTINCT story_cluster_id)::int AS n FROM articles
    WHERE noise_stage = 'kept' AND story_cluster_id IS NOT NULL
      AND id IN (${sql.join(idList.map((id) => sql`${id}`), sql`, `)})
  `);
  console.log(
    `[recluster] done articles=${ordered.length} created=${created} joined=${joined} failed=${failed} ` +
      `stories_before=${before[0]?.n ?? 0} stories_after=${after[0]?.n ?? 0}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
