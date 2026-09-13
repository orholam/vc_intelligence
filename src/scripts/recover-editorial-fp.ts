/**
 * One-shot recovery for editorial false-negative discards (requeue:editorial_fp).
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/recover-editorial-fp.ts [--dry-run]
 */
import { sql, eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const dryRun = process.argv.includes("--dry-run");

type Publish = {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  primaryTag?: string;
};

const PUBLISH: Publish[] = [
  { id: "art_01M164NF40AANVSVS84DMVMZWY", name: "Nanolope", domain: "nanolope.de", industry: "energy_transition", primaryTag: "funding.seed" },
  { id: "art_01M164N7ARJTVTKRCSS2FR3601", name: "Ponda", domain: "ponda.bio", industry: "biotech_pharma", primaryTag: "funding.seed" },
  { id: "art_01M15TSH26VZ0TRGBC6T460QZB", name: "BitGo", domain: "bitgo.com", industry: "crypto_web3", primaryTag: "mna.acquisition_announced" },
  { id: "art_01M0YMKQ2VG9Z5T7YJVX6X559H", name: "os.energy", domain: "os.energy", industry: "energy_transition", primaryTag: "funding.seed" },
  { id: "art_01M14SPBBVM6Q7T2GKS9K5Y5G7", name: "Swvl", domain: "swvl.com", industry: "mobility_ev", primaryTag: "funding.unknown_round" },
  { id: "art_01M164NB7MM5EHGYJHR3K4BN4B", name: "Revier Therapeutics", domain: "revier.bio", industry: "biotech_pharma", primaryTag: "funding.seed" },
  { id: "art_01M164NK18S0ZE7J6H6S10G2NV", name: "Lupin Dental", domain: "lupindental.com", industry: "medtech_devices", primaryTag: "funding.series_a" },
  { id: "art_01M0Z2954ZKWM4H50RS6MZRPWN", name: "Oro", domain: "oro.inc", industry: "fintech_payments", primaryTag: "funding.seed" },
  { id: "art_01M16GTPGKGSWT7WRDFG8FCPJE", name: "Quaise Energy", domain: "quaise.energy", industry: "energy_transition", primaryTag: "funding.late_stage" },
  { id: "art_01M164PYCAQR501NT2D8W7AW8E", name: "Raise", domain: "raise.com", industry: "insurance_insurtech", primaryTag: "leadership.new_ceo" },
  { id: "art_01M0W27RW9WG9QZCF29ZRVE4WK", name: "Reken", domain: "reken.ai", industry: "cybersecurity", primaryTag: "product.launch" },
  { id: "art_01M16E7QVARJD3YDDAXR9D1CNN", name: "Jio", domain: "jio.com", industry: "telecom_networking", primaryTag: "funding.ipo" },
  { id: "art_01M164NMZJ559G5X4E4KQBJ92C", name: "Readily Diagnostics", domain: "readily.se", industry: "healthtech", primaryTag: "funding.seed" },
  { id: "art_01M165TPH7270GHGZCJF15KB7T", name: "Yotta", domain: "yotta.com", industry: "cloud_infra", primaryTag: "funding.ipo" },
];

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

async function findEntityId(db: ReturnType<typeof createDb>, name: string, domain?: string): Promise<string | null> {
  if (domain) {
    const byWeb = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT id FROM entities WHERE merged_into IS NULL AND website ILIKE ${"%" + domain + "%"} LIMIT 1
      `),
    );
    if (byWeb[0]?.id) return String(byWeb[0].id);
  }
  const norm = normalizeName(name);
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND (canonical_name ILIKE ${name} OR ${norm} = ANY(aliases))
      LIMIT 1
    `),
  );
  return hit[0]?.id ? String(hit[0].id) : null;
}

async function ensureEntity(db: ReturnType<typeof createDb>, name: string, domain?: string): Promise<string> {
  const existing = await findEntityId(db, name, domain);
  if (existing) return existing;
  const id = opaqueId("ent");
  if (!dryRun) {
    await db.insert(entities).values({
      id,
      canonicalName: name,
      website: domain ?? null,
      aliases: [normalizeName(name)],
      confidence: 0.68,
      createdBy: "manual:recover-editorial-fp",
      sourceRefs: ["manual:recover-editorial-fp"],
      needsBackfill: true,
    });
    await db.insert(aliases).values({
      id: opaqueId("als"),
      entityId: id,
      alias: name,
      aliasNormalized: normalizeName(name),
      kind: "name",
      weight: 0.9,
      source: "manual",
    });
  }
  console.log(`mint  ${id}  ${name}${domain ? ` (${domain})` : ""}`);
  return id;
}

async function linkPrimary(db: ReturnType<typeof createDb>, articleId: string, entityId: string): Promise<void> {
  if (!dryRun) {
    await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
    await db.insert(articleEntities).values({
      articleId,
      entityId,
      role: "primary",
      confidence: 0.9,
    });
  }
  console.log(`link  ${articleId}  ${entityId}`);
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  console.log(dryRun ? "DRY RUN" : "LIVE");

  for (const pub of PUBLISH) {
    const eid = await ensureEntity(db, pub.name, pub.domain);
    await linkPrimary(db, pub.id, eid);
    const patch: Record<string, unknown> = {
      noiseStage: "kept",
      discardReason: null,
      resolvedAt: new Date(),
      updatedAt: new Date(),
      enrichedAt: new Date(),
    };
    if (pub.industry) patch.industryPrimary = pub.industry;
    if (pub.primaryTag) patch.primaryTag = pub.primaryTag;
    if (!dryRun) {
      await db.update(articles).set(patch).where(eq(articles.id, pub.id));
      await db.execute(sql`
        UPDATE articles SET ai_summary = left(title, 400)
        WHERE id = ${pub.id}
          AND (ai_summary IS NULL OR trim(ai_summary) = '')
          AND newsworthiness IN ('high', 'medium')
      `);
    }
    console.log(`kept  ${pub.id}  ${pub.name}`);
  }

  const ids = PUBLISH.map((p) => p.id);
  const kept = rowsOf<{ c: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS c FROM articles
      WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::text[]`)})
        AND noise_stage = 'kept'
    `),
  );
  console.log(`recovered kept: ${kept[0]?.c ?? 0} / ${PUBLISH.length}`);

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
