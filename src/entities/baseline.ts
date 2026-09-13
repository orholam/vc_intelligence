import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

/**
 * R06 minimum-viable company card: an entity becomes servable/searchable/
 * listable only after the baseline pass guarantees the basics — registrable
 * domain attempted (set or honestly absent), country inferred, >=1 industry
 * tag, funding_stage NON-NULL (evidenced stage, else `bootstrapped` /
 * literal `unknown` — null is a defect per rubric D3), aliases seeded,
 * confidence set. Flagged (`needs_backfill`) entities are excluded from
 * default surfaces until this worker drains them.
 *
 * Stage policy (D3): every entity carries either an evidenced stage from
 * accepted facts, `bootstrapped` where multi-signal traction without capital
 * is evidenced, or literal `unknown`. "How many seed-stage companies did we
 * see" must never silently drop most of the DB again.
 */

export const UNCLASSIFIED_TAG = "unclassified";
export const STAGE_UNKNOWN = "unknown";
export const STAGE_BOOTSTRAPPED = "bootstrapped";

export interface BaselineOutcome {
  processed: number;
  flagged: number;
}

/**
 * One-time/periodic sweep: any live entity whose stored card violates the
 * baseline predicate gets flagged so the worker picks it up. Cheap enough to
 * run inside each backfill tick.
 */
export async function flagBaselineFailing(db: Db): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE entities SET needs_backfill = true, updated_at = now()
    WHERE merged_into IS NULL AND needs_backfill = false
      AND (
        funding_stage IS NULL OR btrim(funding_stage) = ''
        OR cardinality(industry_tags) = 0
        OR (cardinality(industry_tags) = 1 AND industry_tags[1] = ${UNCLASSIFIED_TAG})
      )
    RETURNING id
  `);
  return res.length;
}

/** Deterministic traction check: >=2 distinct non-capital event tags from >=2 publishers in-window. */
async function hasTractionWithoutCapital(db: Db, entityId: string): Promise<boolean> {
  // D3 stage policy: `bootstrapped` means traction WITH EVIDENCED ABSENCE of
  // outside capital — not merely "we have no funding facts". Any accepted
  // funding fact, ticker, or explicit raise language in attached coverage
  // disqualifies the marker (Apple/Stripe-class false positives).
  const capRows = await db.execute<{ hits: number }>(sql`
    SELECT (
      (SELECT COUNT(*) FROM facts f WHERE f.entity_id = ${entityId} AND f.status = 'accepted')
      + (SELECT COUNT(*) FROM articles a
         JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
         WHERE ae.entity_id = ${entityId} AND a.noise_stage = 'kept'
           AND (a.title ILIKE ANY (ARRAY['%raised %', '%raises %', '%raising %', '%series a%', '%series b%', '%series c%', '%seed round%', '%funding round%', '%files for ipo%', '%goes public%'])
                OR COALESCE(a.excerpt_text, '') ILIKE ANY (ARRAY['%raised $%', '%series a%', '%series b%', '%funding round%', '%%million in%round%', '%billion valuation%', '%files for ipo%']))
      )
    )::int AS hits`);
  if (Number(capRows[0]?.hits ?? 0) > 0) return false;

  const rows = await db.execute<{ tags: number; pubs: number }>(sql`
    SELECT COUNT(DISTINCT a.primary_tag)::int AS tags,
           COUNT(DISTINCT a.publisher_domain)::int AS pubs
    FROM articles a
    JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    WHERE ae.entity_id = ${entityId}
      AND a.noise_stage = 'kept'
      AND a.published_at >= now() - interval '180 days'
      AND a.primary_tag IS NOT NULL
      AND a.primary_tag NOT LIKE 'funding.%'
      AND a.primary_tag NOT IN ('token_sale', 'late_stage')
  `);
  return Number(rows[0]?.tags ?? 0) >= 2 && Number(rows[0]?.pubs ?? 0) >= 2;
}

/**
 * Drain the needs_backfill queue deterministically (no LLM): derive what the
 * corpus can evidence, mark the rest explicitly unknown. Bounded batches so a
 * nightly tick converges without stampeding the DB.
 *
 * `onlyIds` restricts the batch to specific entities (the harness deep-search
 * pass uses this to baseline exactly the companies it is about to profile —
 * the default queue drains oldest-first, so an untargeted call would leave
 * newly-selected entities flagged and ineligible).
 */
export async function backfillEntityBaselines(
  db: Db,
  limit = 100,
  onlyIds?: string[],
): Promise<BaselineOutcome> {
  const flagged = await flagBaselineFailing(db);

  const targets = onlyIds?.length
    ? await db.execute<{
        id: string;
        website: string | null;
        canonical_name: string;
        country: string | null;
      }>(sql`
        SELECT id, website, canonical_name, country
        FROM entities
        WHERE merged_into IS NULL AND needs_backfill = true
          AND id IN (${sql.join(onlyIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY created_at ASC
        LIMIT ${limit}
      `)
    : await db.execute<{
        id: string;
        website: string | null;
        canonical_name: string;
        country: string | null;
      }>(sql`
        SELECT id, website, canonical_name, country
        FROM entities
        WHERE merged_into IS NULL AND needs_backfill = true
        ORDER BY created_at ASC
        LIMIT ${limit}
      `);

  let processed = 0;
  for (const t of targets) {
    const id = String(t.id);

    // 1. Industry tag: majority industry_primary across linked kept articles.
    const tagRows = await db.execute<{ tag: string }>(sql`
      SELECT a.industry_primary AS tag, COUNT(*)::int AS n
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      WHERE ae.entity_id = ${id} AND a.noise_stage = 'kept' AND a.industry_primary IS NOT NULL
        AND a.industry_primary NOT IN ('other_diversified', ${UNCLASSIFIED_TAG})
      GROUP BY a.industry_primary ORDER BY n DESC LIMIT 1
    `);
    // Null stays null: stamping `unclassified` used to clear needs_backfill
    // and empty the harness deep-search queue. No evidenced sector → stay flagged.
    const industryTag = tagRows[0]?.tag ?? null;

    // 2. Country: majority country mention across linked kept articles.
    let country: string | null = t.country ? String(t.country) : null;
    if (!country) {
      const cRows = await db.execute<{ c: string }>(sql`
        SELECT c AS c, COUNT(*)::int AS n
        FROM articles a
        JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary',
        LATERAL unnest(a.countries) AS c
        WHERE ae.entity_id = ${id} AND a.noise_stage = 'kept'
        GROUP BY c ORDER BY n DESC LIMIT 1
      `);
      country = cRows[0]?.c ?? null;
    }

    // 3. Funding stage: evidenced > bootstrapped > unknown (never null).
    const stageRows = await db.execute<{ stage: string | null }>(sql`
      SELECT funding_stage FROM entities WHERE id = ${id}
    `);
    let stage = (stageRows[0]?.stage ?? "").trim().toLowerCase();
    if (!stage) {
      stage = (await hasTractionWithoutCapital(db, id)) ? STAGE_BOOTSTRAPPED : STAGE_UNKNOWN;
    }

    await db.execute(sql`
      UPDATE entities SET
        industry_tags = CASE WHEN cardinality(industry_tags) = 0 AND ${industryTag}::text IS NOT NULL
                             THEN ARRAY[${industryTag}]::text[] ELSE industry_tags END,
        country = COALESCE(country, ${country}),
        funding_stage = ${stage},
        needs_backfill = CASE
          WHEN cardinality(industry_tags) = 0 AND ${industryTag}::text IS NULL THEN true
          WHEN cardinality(industry_tags) = 0 AND ${industryTag}::text IS NOT NULL THEN false
          WHEN cardinality(industry_tags) = 1 AND industry_tags[1] = ${UNCLASSIFIED_TAG} THEN true
          ELSE false
        END,
        updated_at = now()
      WHERE id = ${id}
    `);

    // 4. Aliases seeded: canonical name + domain alias, idempotent.
    const norm = normalizeName(String(t.canonical_name));
    if (norm) {
      await db.execute(sql`
        INSERT INTO aliases (id, entity_id, alias, alias_normalized, kind, weight, source)
        VALUES (${opaqueId("als")}, ${id}, ${String(t.canonical_name)}, ${norm}, 'name', 1, 'baseline')
        ON CONFLICT DO NOTHING
      `);
    }
    if (t.website) {
      const dnorm = normalizeName(String(t.website).replace(/^https?:\/\//, ""));
      if (dnorm) {
        await db.execute(sql`
          INSERT INTO aliases (id, entity_id, alias, alias_normalized, kind, weight, source)
          VALUES (${opaqueId("als")}, ${id}, ${String(t.website)}, ${dnorm}, 'domain', 0.9, 'baseline')
          ON CONFLICT DO NOTHING
        `);
      }
    }
    processed++;
  }

  if (processed || flagged) {
    logger.info({ processed, newlyFlagged: flagged }, "entity baseline pass");
  }
  return { processed, flagged };
}

/**
 * R06 verify probe: % of live entities active-in-window that satisfy the full
 * baseline predicate INCLUDING non-null funding_stage. Target >=95%.
 */
export async function baselineSatisfactionRate(db: Db): Promise<{
  active_entities: number;
  baseline_ok: number;
  rate_pct: number;
}> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT COUNT(*)::int AS active_entities,
           COUNT(*) FILTER (WHERE
             e.funding_stage IS NOT NULL AND btrim(e.funding_stage) <> ''
             AND cardinality(e.industry_tags) > 0
             AND e.needs_backfill = false
           )::int AS baseline_ok
    FROM entities e
    WHERE e.merged_into IS NULL
      AND EXISTS (
        SELECT 1 FROM article_entities ae
        JOIN articles a ON a.id = ae.article_id
        WHERE ae.entity_id = e.id AND a.noise_stage = 'kept'
      )
  `);
  const r = rows[0] ?? {};
  const active = Number(r.active_entities ?? 0);
  const ok = Number(r.baseline_ok ?? 0);
  return {
    active_entities: active,
    baseline_ok: ok,
    rate_pct: active ? Math.round((ok / active) * 1000) / 10 : 100,
  };
}
