/**
 * Fix entity mis-identifications from the 2026-08-28 afternoon harness batch.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/fix-batch2-quality.ts
 */
import { sql, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import { entityNameRejectionReason } from "../lib/quality.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const JUNK_NAMES = [
  "Slashdot",
  "M Pre-Series C",
  "M Series B",
  "M Series D",
  "Funding",
  "Funding Nekkyo Co.",
  "Bitcoin",
  "India",
  "IPO OpenAI",
];

const FIXES: Array<{
  articleId: string;
  primary: string;
  secondaries?: string[];
}> = [
  {
    articleId: "art_01M14D2DMQYM6YA42RWPG0GXRP",
    primary: "Nvidia",
    secondaries: ["Hugging Face"],
  },
  { articleId: "art_01M14CMT7NFNRN3GZ9DH8KC5FJ", primary: "OneDome" },
  { articleId: "art_01M14CMP3RPZ6VK818ER1HN74M", primary: "Levanta" },
  { articleId: "art_01M14CMJ9NASJ67SM6HWGT1EZJ", primary: "Nekkyo Co." },
  { articleId: "art_01M14CME9ZD2C48FKMEJ3CVJZ9", primary: "Flash" },
  { articleId: "art_01M14D2W14HRMMAWJ7XNKWPZ7Y", primary: "Capital B" },
  { articleId: "art_01M14D77ZGACKGC1Z1EEGPD0PV", primary: "OpenAI" },
  {
    articleId: "art_01M14C5DGKWAZ34A0G4XT2VXSZ",
    primary: "Ballard Power Systems",
    secondaries: ["GeoPura"],
  },
];

async function findEntityId(
  db: ReturnType<typeof createDb>,
  name: string,
): Promise<string | null> {
  const norm = normalizeName(name);
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM entities
    WHERE merged_into IS NULL
      AND (canonical_name ILIKE ${name} OR ${norm} = ANY(aliases))
    ORDER BY CASE WHEN canonical_name ILIKE ${name} THEN 0 ELSE 1 END, confidence DESC
    LIMIT 1
  `);
  return (rows as { id: string }[])[0]?.id ?? null;
}

async function ensureEntity(db: ReturnType<typeof createDb>, name: string): Promise<string> {
  const existing = await findEntityId(db, name);
  if (existing) return existing;
  const id = opaqueId("ent");
  await db.insert(entities).values({
    id,
    canonicalName: name,
    aliases: [normalizeName(name)],
    confidence: 0.55,
    createdBy: "scrub:fix-batch2",
    sourceRefs: ["scrub:fix-batch2"],
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
  console.log(`mint  ${name}`);
  return id;
}

async function relinkArticle(
  db: ReturnType<typeof createDb>,
  articleId: string,
  primary: string,
  secondaries: string[] = [],
): Promise<void> {
  await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
  const primaryId = await ensureEntity(db, primary);
  await db.insert(articleEntities).values({
    articleId,
    entityId: primaryId,
    role: "primary",
    confidence: 0.9,
  });
  for (const sec of secondaries) {
    const secId = await ensureEntity(db, sec);
    await db.insert(articleEntities).values({
      articleId,
      entityId: secId,
      role: "secondary",
      confidence: 0.75,
    });
  }
  await db
    .update(articles)
    .set({ noiseStage: "kept", discardReason: null, updatedAt: new Date() })
    .where(eq(articles.id, articleId));
  console.log(`fixed  ${articleId}  ${primary}${secondaries.length ? ` + ${secondaries.join(", ")}` : ""}`);
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);

  const junkRows = await db
    .select({ id: entities.id, canonicalName: entities.canonicalName })
    .from(entities)
    .where(
      sql`${entities.mergedInto} IS NULL AND ${entities.canonicalName} IN (${sql.join(
        JUNK_NAMES.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );

  const junkIds = junkRows.map((r) => r.id);
  if (junkIds.length) {
    await db.delete(articleEntities).where(inArray(articleEntities.entityId, junkIds));
    await db.delete(aliases).where(inArray(aliases.entityId, junkIds));
    await db.delete(entities).where(inArray(entities.id, junkIds));
    console.log(`deleted junk: ${junkRows.map((r) => r.canonicalName).join(", ")}`);
  }

  // Scrub other autocreate junk from this batch via rejection rules
  const batchJunk = await db.execute<{ id: string; canonical_name: string }>(sql`
    SELECT id, canonical_name FROM entities
    WHERE merged_into IS NULL
      AND created_by = 'autocreate'
      AND created_at >= '2026-08-28 14:00:00+00'
  `);
  const extraJunk: string[] = [];
  for (const row of batchJunk as { id: string; canonical_name: string }[]) {
    if (entityNameRejectionReason(row.canonical_name)) {
      extraJunk.push(row.id);
      console.log(`junk  ${row.canonical_name}`);
    }
  }
  if (extraJunk.length) {
    await db.delete(articleEntities).where(inArray(articleEntities.entityId, extraJunk));
    await db.delete(aliases).where(inArray(aliases.entityId, extraJunk));
    await db.delete(entities).where(inArray(entities.id, extraJunk));
  }

  for (const fix of FIXES) {
    await relinkArticle(db, fix.articleId, fix.primary, fix.secondaries ?? []);
  }

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
