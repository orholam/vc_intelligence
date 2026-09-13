/**
 * Scrub junk resolutions from a bad harness/mock brain run.
 * Unlinks bad primary entities, re-queues affected articles, deletes junk mints.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/scrub-harness-junk.ts [--hours=4]
 */
import { sql, inArray } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import { entityNameRejectionReason } from "../lib/quality.js";

const hours = Number(process.argv.find((a) => a.startsWith("--hours="))?.split("=")[1] ?? 4);

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const candidateRows = rowsOf<{
    id: string;
    canonical_name: string;
    created_by: string | null;
    link_count: number;
  }>(await db.execute(sql`
    SELECT e.id, e.canonical_name, e.created_by,
           (SELECT count(*)::int FROM article_entities ae WHERE ae.entity_id = e.id) AS link_count
    FROM entities e
    WHERE e.merged_into IS NULL
      AND (e.created_at >= ${since.toISOString()} OR e.id IN (
        SELECT DISTINCT ae.entity_id FROM article_entities ae
        JOIN articles a ON a.id = ae.article_id
        WHERE ae.role = 'primary' AND a.updated_at >= ${since.toISOString()}
      ))
  `));

  const junkIds: string[] = [];
  for (const r of candidateRows) {
    const reason = entityNameRejectionReason(String(r.canonical_name));
    const autocreate = r.created_by === "autocreate";
    if (reason && (autocreate || Number(r.link_count) <= 3)) {
      junkIds.push(String(r.id));
      console.log(`junk  ${r.id}  ${r.canonical_name}  (${reason})`);
    }
  }

  if (!junkIds.length) {
    console.log("no junk entities found");
    await db.$client.end();
    return;
  }

  const affectedArticles = await db
    .select({ articleId: articleEntities.articleId })
    .from(articleEntities)
    .where(inArray(articleEntities.entityId, junkIds));
  const articleIds = [...new Set(affectedArticles.map((a) => a.articleId))];

  await db.delete(articleEntities).where(inArray(articleEntities.entityId, junkIds));
  await db.delete(aliases).where(inArray(aliases.entityId, junkIds));
  await db.delete(entities).where(inArray(entities.id, junkIds));

  if (articleIds.length) {
    await db
      .update(articles)
      .set({
        noiseStage: "waiting",
        resolvedAt: null,
        discardReason: "scrub:bad_resolution",
        updatedAt: new Date(),
      })
      .where(inArray(articles.id, articleIds));
  }

  console.log(`deleted ${junkIds.length} junk entities; re-queued ${articleIds.length} articles`);
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
