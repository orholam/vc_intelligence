/**
 * One-shot cleanup for Title/counterparty pollution and off-topic kept rows (2026-08-28).
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/fix-latest-quality.ts [--dry-run]
 */
import { sql, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const dryRun = process.argv.includes("--dry-run");

const JUNK_NAMES = new Set(["Title", "Adding", "Apple TV", "Talks"]);

const DROP_ARTICLES: Array<{ id: string; reason: string }> = [
  { id: "art_01M0ZCQY85RKVYAGF8WJCNZAK7", reason: "scrub:offtopic_product_rumor" },
  { id: "art_01M0ZNNYVYYA33KTCQR7X661S6", reason: "scrub:retail_promo" },
  { id: "art_01M0ZCRBVP004TJDVS0J00M00E", reason: "scrub:markets_commentary" },
  { id: "art_01M0ZHS7F2TDX9CX3WBPK510Y7", reason: "scrub:markets_commentary" },
];

const MANUAL_PRIMARIES: Array<{ articleId: string; name: string }> = [
  { articleId: "art_01M0ZD1FJG1TKBFXQ4RSEMX2RB", name: "DeepSeek" },
  { articleId: "art_01M0ZHK5ND5S6G0PR0GBVDXNZH", name: "SiFly Aviation" },
  { articleId: "art_01M0ZM6V05EJDJ75W3QHYM12H8", name: "Deep Cogito" },
  { articleId: "art_01M0ZN5EKJKT8N5FZN6PE3J9Y0", name: "Lambda" },
  { articleId: "art_01M0ZSF2YY8AC92028DF5PEFM4", name: "RaceTrac" },
];

const SECONDARY_ACQUIRE: Array<{ articleId: string; name: string; role?: string }> = [
  { articleId: "art_01M0ZAY1F6TP9HAAQPBBJDR3HD", name: "DuckLabs", role: "acquired" },
  { articleId: "art_01M0ZNC65W20P5GTT0WNB4S3AP", name: "DuckLabs", role: "acquired" },
  { articleId: "art_01M0Z36FE9AD78JXHKQ7HXDYJR", name: "DuckLabs", role: "acquired" },
];

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

async function findEntityId(db: ReturnType<typeof createDb>, name: string): Promise<string | null> {
  const norm = normalizeName(name);
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND (canonical_name ILIKE ${name} OR ${norm} = ANY(aliases))
      LIMIT 1
    `),
  );
  return hit[0]?.id ?? null;
}

async function ensureEntity(db: ReturnType<typeof createDb>, name: string): Promise<string> {
  const existing = await findEntityId(db, name);
  if (existing) return existing;
  const id = opaqueId("ent");
  if (!dryRun) {
    await db.insert(entities).values({
      id,
      canonicalName: name,
      aliases: [normalizeName(name)],
      confidence: 0.55,
      createdBy: "scrub:fix-latest-quality",
      sourceRefs: ["scrub:fix-latest-quality"],
    });
    await db.insert(aliases).values({
      id: opaqueId("als"),
      entityId: id,
      alias: name,
      aliasNormalized: normalizeName(name),
      kind: "name",
      weight: 0.9,
      source: "scrub",
    });
  }
  console.log(`mint  ${id}  ${name}`);
  return id;
}

async function linkEntity(
  db: ReturnType<typeof createDb>,
  articleId: string,
  entityId: string,
  role: "primary" | "secondary",
  confidence = 0.85,
): Promise<void> {
  const existing = rowsOf<{ article_id: string }>(
    await db.execute(sql`
      SELECT article_id FROM article_entities
      WHERE article_id = ${articleId} AND entity_id = ${entityId}
      LIMIT 1
    `),
  );
  if (existing.length) {
    if (!dryRun) {
      await db.execute(sql`
        UPDATE article_entities SET role = ${role}, confidence = GREATEST(confidence, ${confidence})
        WHERE article_id = ${articleId} AND entity_id = ${entityId}
      `);
    }
    return;
  }
  if (!dryRun) {
    await db.insert(articleEntities).values({
      articleId,
      entityId,
      role,
      confidence,
    });
  }
  console.log(`link  ${articleId}  ${entityId}  ${role}`);
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  console.log(dryRun ? "DRY RUN" : "LIVE");

  const junkRows = await db
    .select({ id: entities.id, canonicalName: entities.canonicalName })
    .from(entities)
    .where(
      sql`${entities.mergedInto} IS NULL AND ${entities.canonicalName} IN (${sql.join(
        [...JUNK_NAMES].map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );

  const junkIds = junkRows.map((r) => r.id);
  console.log(`junk entities: ${junkRows.map((r) => r.canonicalName).join(", ")} (${junkIds.length})`);

  if (junkIds.length && !dryRun) {
    await db.delete(articleEntities).where(inArray(articleEntities.entityId, junkIds));
    await db.delete(aliases).where(inArray(aliases.entityId, junkIds));
    await db.delete(entities).where(inArray(entities.id, junkIds));
  } else if (junkIds.length) {
    console.log(`would delete ${junkIds.length} junk entities and their links`);
  }

  for (const drop of DROP_ARTICLES) {
    console.log(`drop  ${drop.id}  ${drop.reason}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({ noiseStage: "llm_filter", discardReason: drop.reason, updatedAt: new Date() })
        .where(eq(articles.id, drop.id));
    }
  }

  // Groww: primary only; Ribbit is investor-side noise on this story.
  const growwId = await findEntityId(db, "Groww");
  if (growwId) {
    await linkEntity(db, "art_01M0ZCG17M5X6DNWVBHC3ZB2F8", growwId, "primary", 0.9);
    if (!dryRun) {
      await db.execute(sql`
        DELETE FROM article_entities ae
        USING entities e
        WHERE ae.entity_id = e.id AND ae.article_id = 'art_01M0ZCG17M5X6DNWVBHC3ZB2F8'
          AND e.canonical_name ILIKE 'Ribbit Capital'
      `);
    }
  }

  for (const sec of SECONDARY_ACQUIRE) {
    const eid = await ensureEntity(db, sec.name);
    await linkEntity(db, sec.articleId, eid, "secondary", 0.75);
  }

  for (const fix of MANUAL_PRIMARIES) {
    const eid = await ensureEntity(db, fix.name);
    await linkEntity(db, fix.articleId, eid, "primary", 0.9);
    if (!dryRun) {
      await db
        .update(articles)
        .set({ noiseStage: "kept", discardReason: null, updatedAt: new Date() })
        .where(eq(articles.id, fix.articleId));
    }
    console.log(`restore kept  ${fix.articleId}  ${fix.name}`);
  }

  const orphanKept = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT a.id FROM articles a
      WHERE a.noise_stage = 'kept'
        AND NOT EXISTS (SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id)
    `),
  );
  for (const row of orphanKept) {
    console.log(`requeue (no entities)  ${row.id}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({ noiseStage: "waiting", resolvedAt: null, discardReason: "scrub:no_entities", updatedAt: new Date() })
        .where(eq(articles.id, row.id));
    }
  }

  const titleLeft = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM article_entities ae
      JOIN entities e ON e.id = ae.entity_id
      WHERE e.canonical_name = 'Title'
    `),
  );
  console.log(`Title links remaining: ${titleLeft[0]?.n ?? 0}`);
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
