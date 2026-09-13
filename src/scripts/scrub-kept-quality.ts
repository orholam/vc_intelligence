/**
 * Scrub junk entity links from kept articles (primary AND secondary).
 *
 * Run after harness drains or whenever /latest shows headline fragments as companies.
 *
 * Usage:
 *   tsx --env-file-if-exists=.env.local src/scripts/scrub-kept-quality.ts [--dry-run] [--hours=N]
 */
import { sql, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import {
  entityNameRejectionReason,
  isHeadlineFragmentEntity,
} from "../lib/quality.js";
import { extractTitleSubject } from "../lib/title-subject.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const dryRun = process.argv.includes("--dry-run");
const auditOnly = process.argv.includes("--audit-only");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const hours = hoursArg ? Number(hoursArg.split("=")[1]) : null;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

const SCRUB_REASONS = new Set([
  "headline_fragment",
  "headline_artifact",
  "headline_lead_in",
  "prompt_field_label",
  "looks_like_headline",
  "headline_verb_glued",
  "generic_word",
  "money_phrase_not_company",
  "funding_round_fragment",
  "brand_fallback_prefix",
  "syndication_junk",
  "block_page_artifact",
  "empty",
  "legal_suffix_only",
]);

/** Legit company names that share tokens with generic_word / headline_verb_glued guards. */
const SCRUB_ALLOWLIST = new Set(["alice", "natural", "raise", "flash", "series"]);

/** Names safe to auto-unlink from kept articles — not broad person_name / media hits. */
function isScrubCandidate(name: string, title?: string): string | null {
  if (SCRUB_ALLOWLIST.has(normalizeName(name))) return null;
  if (isHeadlineFragmentEntity(name, title)) return "headline_fragment";
  const reason = entityNameRejectionReason(name);
  if (reason && SCRUB_REASONS.has(reason)) return reason;
  return null;
}

function extractLawsuitCompany(title: string): string | null {
  const lead = /\bLead\s+(.+?)\s+(?:Securities|Class Action)/i.exec(title);
  if (lead?.[1]) {
    const raw = lead[1]
      .replace(/,\s*Inc\.?$/i, "")
      .replace(/\s+Inc\.?$/i, "")
      .replace(/\s+Ltd\.?$/i, "")
      .replace(/\s+plc$/i, "")
      .trim();
    if (raw && !isScrubCandidate(raw)) return raw;
  }

  const beforeShareholders = /^(.+?)\s+Shareholders\b/i.exec(title);
  if (beforeShareholders?.[1]) {
    const raw = beforeShareholders[1]
      .replace(/,\s*Inc\.?$/i, "")
      .replace(/\s+\([A-Z]{1,5}\)\s*$/i, "")
      .trim();
    if (raw && !isScrubCandidate(raw)) return raw;
  }

  const investigation = /Investigation Launched into\s+(.+?),/i.exec(title);
  if (investigation?.[1]) {
    const raw = investigation[1].replace(/,\s*Inc\.?$/i, "").trim();
    if (raw && !isScrubCandidate(raw)) return raw;
  }

  const classAction = /^(.+?)\s+Securities Fraud Class Action/i.exec(title);
  if (classAction?.[1]) {
    const raw = classAction[1].trim();
    if (raw && !isScrubCandidate(raw)) return raw;
  }

  const subject = extractTitleSubject(title);
  return subject && !isScrubCandidate(subject, title) ? subject : null;
}

async function findEntityId(db: ReturnType<typeof createDb>, name: string): Promise<string | null> {
  const norm = normalizeName(name);
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND (canonical_name ILIKE ${name} OR ${norm} = ANY(aliases))
      ORDER BY CASE WHEN canonical_name ILIKE ${name} THEN 0 ELSE 1 END, confidence DESC
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
      createdBy: "scrub:scrub-kept-quality",
      sourceRefs: ["scrub:scrub-kept-quality"],
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
  console.log(`mint  ${name}`);
  return id;
}

async function deleteEntityIfOrphan(db: ReturnType<typeof createDb>, entityId: string): Promise<void> {
  const left = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM article_entities WHERE entity_id = ${entityId}
    `),
  );
  if ((left[0]?.n ?? 0) > 0 || dryRun) return;
  await db.delete(aliases).where(eq(aliases.entityId, entityId));
  await db.delete(entities).where(eq(entities.id, entityId));
}

async function relinkArticle(
  db: ReturnType<typeof createDb>,
  articleId: string,
  primary: string,
): Promise<void> {
  if (dryRun) {
    console.log(`would relink  ${articleId}  ${primary}`);
    return;
  }
  await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
  const primaryId = await ensureEntity(db, primary);
  await db.insert(articleEntities).values({
    articleId,
    entityId: primaryId,
    role: "primary",
    confidence: 0.9,
  });
  await db
    .update(articles)
    .set({ noiseStage: "kept", discardReason: null, updatedAt: new Date() })
    .where(eq(articles.id, articleId));
  console.log(`relinked  ${articleId}  ${primary}`);
}

async function scrubBadLinks(db: ReturnType<typeof createDb>): Promise<number> {
  const since = hours ? new Date(Date.now() - hours * 60 * 60 * 1000) : null;
  const links = rowsOf<{
    article_id: string;
    entity_id: string;
    role: string;
    canonical_name: string;
    title: string;
  }>(
    await db.execute(
      since
        ? sql`
            SELECT ae.article_id, ae.entity_id, ae.role, e.canonical_name, a.title
            FROM article_entities ae
            JOIN entities e ON e.id = ae.entity_id
            JOIN articles a ON a.id = ae.article_id
            WHERE a.noise_stage = 'kept' AND a.updated_at >= ${since.toISOString()}
          `
        : sql`
            SELECT ae.article_id, ae.entity_id, ae.role, e.canonical_name, a.title
            FROM article_entities ae
            JOIN entities e ON e.id = ae.entity_id
            JOIN articles a ON a.id = ae.article_id
            WHERE a.noise_stage = 'kept'
          `,
    ),
  );

  let unlinked = 0;
  for (const link of links) {
    const name = String(link.canonical_name);
    const title = String(link.title);
    const reason = isScrubCandidate(name, title);
    if (!reason) continue;

    console.log(`unlink  ${link.role}  ${name}  (${reason})  ${link.article_id}`);
    unlinked++;
    if (!dryRun) {
      await db.execute(sql`
        DELETE FROM article_entities
        WHERE article_id = ${link.article_id} AND entity_id = ${link.entity_id}
      `);
      await deleteEntityIfOrphan(db, String(link.entity_id));
    }

    if (link.role !== "primary") continue;

    const inferred = extractLawsuitCompany(title);
    if (inferred) {
      await relinkArticle(db, String(link.article_id), inferred);
    } else {
      console.log(`requeue  ${link.article_id}  (bad primary, no inference)`);
      if (!dryRun) {
        await db
          .update(articles)
          .set({
            noiseStage: "waiting",
            resolvedAt: null,
            discardReason: "scrub:bad_entity_link",
            updatedAt: new Date(),
          })
          .where(eq(articles.id, String(link.article_id)));
      }
    }
  }
  return unlinked;
}

async function requeueOrphanKept(db: ReturnType<typeof createDb>): Promise<number> {
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
        .set({
          noiseStage: "waiting",
          resolvedAt: null,
          discardReason: "scrub:no_entities",
          updatedAt: new Date(),
        })
        .where(eq(articles.id, row.id));
    }
  }
  return orphanKept.length;
}

async function auditKept(db: ReturnType<typeof createDb>): Promise<void> {
  const badLinks = rowsOf<{
    id: string;
    title: string;
    canonical_name: string;
    role: string;
    reason: string;
  }>(
    await db.execute(sql`
      SELECT a.id, a.title, e.canonical_name, ae.role, '' AS reason
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id
      JOIN entities e ON e.id = ae.entity_id
      WHERE a.noise_stage = 'kept'
    `),
  ).flatMap((row) => {
    const reason = isScrubCandidate(String(row.canonical_name), String(row.title));
    return reason ? [{ ...row, reason }] : [];
  });

  console.log(`bad kept links remaining: ${badLinks.length}`);
  for (const row of badLinks.slice(0, 30)) {
    console.log(`  ${row.role}  ${row.canonical_name}  (${row.reason})  ${row.title.slice(0, 70)}`);
  }
  if (badLinks.length > 30) console.log(`  ... and ${badLinks.length - 30} more`);
}

async function purgeOrphanJunkEntities(db: ReturnType<typeof createDb>): Promise<number> {
  const ents = rowsOf<{ id: string; canonical_name: string }>(
    await db.execute(sql`
      SELECT e.id, e.canonical_name FROM entities e
      WHERE e.merged_into IS NULL
        AND NOT EXISTS (SELECT 1 FROM article_entities ae WHERE ae.entity_id = e.id)
    `),
  );

  const junkIds = ents.filter((e) => entityNameRejectionReason(String(e.canonical_name))).map((e) => String(e.id));
  if (junkIds.length && !dryRun) {
    await db.delete(aliases).where(inArray(aliases.entityId, junkIds));
    await db.delete(entities).where(inArray(entities.id, junkIds));
  }
  if (junkIds.length) {
    console.log(`deleted orphan junk entities: ${junkIds.length}`);
  }
  return junkIds.length;
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  if (auditOnly) {
    await auditKept(db);
    await db.$client.end();
    return;
  }

  console.log(dryRun ? "DRY RUN" : "LIVE");
  if (hours) console.log(`window: last ${hours}h kept articles`);

  const unlinked = await scrubBadLinks(db);
  const orphans = await requeueOrphanKept(db);
  const purged = await purgeOrphanJunkEntities(db);

  console.log(JSON.stringify({ unlinked, orphans_requeued: orphans, orphan_junk_purged: purged }));
  await auditKept(db);

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
