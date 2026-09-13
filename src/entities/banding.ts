import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";

/**
 * C0 venture banding (OUTPUT-RUBRIC §4): classify every live entity using DB
 * evidence only. Bands checked in order, first match wins:
 *
 *  E3 Swarm      >=3 accepted funding_round facts lifetime; OR latest accepted
 *                round >= $50M; OR story cluster in W with >= 12 publishers;
 *                OR funding_stage in {series_c, late_stage, ipo, public}
 *  E0 Basement   no website AND no registry id AND single-source coverage AND
 *                no institutional-investor mention in attached text
 *  E2 Validated  accepted round with stage in {seed, series_a, series_b}; OR
 *                totalRaisedUsd >= $1M; OR named institutional investor in
 *                accepted-fact evidence
 *  E1 Emerging   real operating company (website AND (>=2 independent
 *                articles in W OR >=1 tier-1/2 article)) with traction
 *                signals but <=2 rounds ever
 *
 * Anything unmatched after the ordered rules falls to E0 by elimination.
 */

export type Band = "E0" | "E1" | "E2" | "E3";

export const SWARM_STAGES = new Set(["series_c", "late_stage", "ipo", "public"]);
const VALIDATED_STAGES = new Set(["seed", "series_a", "series_b"]);

/** Institutional-investor markers (fact investors + article-text mentions). */
export const INSTITUTIONAL_INVESTOR_RE =
  /\b(sequoia|andreessen|a16z|accel\b|benchmark capital|index ventures|greylock|kleiner|bessemer|lightspeed|battery ventures|bain capital|tiger global|insight partners|general catalyst|founders fund|y combinator|softbank|goldman sachs|morgan stanley|peak xv|elevation capital|matrix partners|blume ventures|stellaris|nexus venture|sapphire ventures|upfront ventures|true ventures|first round|uncork capital|costanoa|haystack|crv\b|norwest|canaan|madrona|craft ventures|lux capital|initialized|village global|boost vc|point nine|creandum|balderton|northzone|speedinvest|atomico|dawn capital|octopus ventures|localglobe|felicis|kkr|blackrock|fidelity|temasek|gic\b|qdvc|ventures?|capital|growth equity|angel (investor|round)|institutional investors?)\b/i;

interface FactAgg {
  count: number;
  maxAmount: number;
  stages: string[];
  hasInvestors: boolean;
}

interface ArticleAgg {
  articles: number;
  domains: number;
  tier12: boolean;
  traction: boolean;
}

function bandOf(row: {
  website: string | null;
  registryIds: Record<string, string> | null;
  stage: string | null;
  totalRaised: number | null;
  factAgg: FactAgg | undefined;
  artAgg: ArticleAgg | undefined;
  bigClusterPublishers: number;
}): Band {
  const fa = row.factAgg;
  const aa = row.artAgg;

  // ---- E3 Swarm -----------------------------------------------------------
  if ((fa?.count ?? 0) >= 3) return "E3";
  if ((fa?.maxAmount ?? 0) >= 50_000_000) return "E3";
  if (row.bigClusterPublishers >= 12) return "E3";
  if (row.stage && SWARM_STAGES.has(row.stage)) return "E3";

  // ---- E0 Basement --------------------------------------------------------
  const singleSource = (aa?.domains ?? 0) <= 1;
  const noInvestorMention = !(fa?.hasInvestors ?? false);
  const basement =
    !row.website && !row.registryIds && singleSource && noInvestorMention;
  if (basement) return "E0";

  // ---- E2 Validated -------------------------------------------------------
  const validatedStage = [...(fa?.stages ?? [])].some((s) => VALIDATED_STAGES.has(s)) ||
    (row.stage ? VALIDATED_STAGES.has(row.stage) : false);
  if (validatedStage || (row.totalRaised ?? 0) >= 1_000_000 || (fa?.hasInvestors ?? false)) {
    return "E2";
  }

  // ---- E1 Emerging --------------------------------------------------------
  const realOperating =
    !!row.website &&
    ((aa ? aa.articles >= 2 && aa.domains >= 2 : false) || (aa?.tier12 ?? false));
  const roundsEver = fa?.count ?? 0;
  if (realOperating && (aa?.traction ?? false) && roundsEver <= 2) return "E1";

  // ---- fallback -----------------------------------------------------------
  return "E0";
}

export interface BandingResult {
  banded: number;
  distribution: Record<Band, number>;
}

/** Compute and persist venture bands for all live entities. Idempotent. */
export async function computeBands(db: Db, windowDays = 31): Promise<BandingResult> {
  const since = new Date(Date.now() - windowDays * 86_400_000);

  // Entities excluded from banding must not carry stale labels from earlier
  // policy generations: clear their band so C0 surfaces stay honest.
  await db.execute(sql`
    UPDATE entities SET venture_band = NULL, banded_at = now()
    WHERE merged_into IS NULL
      AND COALESCE(type, 'private') IN ('fund', 'person-org')
      AND venture_band IS NOT NULL
  `);

  const entRows = await db.execute<Record<string, unknown>>(sql`
    SELECT id, website, registry_ids, funding_stage, total_raised_usd
    FROM entities
    WHERE merged_into IS NULL
      -- Funds/pooled vehicles are not operating companies (C0 bands judge
      -- venture companies); they stay unbanded and off company surfaces.
      AND COALESCE(type, 'private') NOT IN ('fund', 'person-org')
  `);

  const factRows = await db.execute<Record<string, unknown>>(sql`
    SELECT entity_id,
           COUNT(*)::int AS n,
           COALESCE(MAX((payload->>'amount_usd_est')::float8), 0) AS max_amount,
           ARRAY_AGG(DISTINCT lower(COALESCE(payload->>'funding_stage', ''))) AS stages,
           BOOL_OR(jsonb_array_length(COALESCE(payload->'lead_investors', '[]'::jsonb)) > 0) AS has_investors
    FROM facts
    WHERE status = 'accepted' AND type = 'funding_round'
    GROUP BY entity_id
  `);

  const artRows = await db.execute<Record<string, unknown>>(sql`
    SELECT ae.entity_id,
           COUNT(*)::int AS n,
           COUNT(DISTINCT a.publisher_domain)::int AS domains,
           BOOL_OR(s.tier <= 2) AS tier12,
           BOOL_OR(a.primary_tag IS NOT NULL AND split_part(a.primary_tag, '.', 1) IN ('product','partnership','expansion_restructuring','leadership')) AS traction
    FROM article_entities ae
    JOIN articles a ON a.id = ae.article_id AND a.noise_stage = 'kept'
    LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.published_at >= ${since.toISOString()}
    GROUP BY ae.entity_id
  `);

  const clusterRows = await db.execute<Record<string, unknown>>(sql`
    SELECT ae.entity_id, MAX(s.article_count)::int AS max_publishers
    FROM stories s
    JOIN articles ar ON ar.story_cluster_id = s.id AND ar.noise_stage = 'kept'
    JOIN article_entities ae ON ae.article_id = ar.id AND ae.role = 'primary'
    WHERE s.first_seen_at >= ${since.toISOString()}
    GROUP BY ae.entity_id
  `);

  const factsByEntity = new Map<string, FactAgg>();
  for (const r of factRows) {
    factsByEntity.set(String(r.entity_id), {
      count: Number(r.n ?? 0),
      maxAmount: Number(r.max_amount ?? 0),
      stages: (r.stages as string[] | null) ?? [],
      hasInvestors: Boolean(r.has_investors),
    });
  }
  const artsByEntity = new Map<string, ArticleAgg>();
  for (const r of artRows) {
    artsByEntity.set(String(r.entity_id), {
      articles: Number(r.n ?? 0),
      domains: Number(r.domains ?? 0),
      tier12: Boolean(r.tier12),
      traction: Boolean(r.traction),
    });
  }
  const clusterByEntity = new Map<string, number>();
  for (const r of clusterRows) {
    clusterByEntity.set(String(r.entity_id), Number(r.max_publishers ?? 0));
  }

  const distribution: Record<Band, number> = { E0: 0, E1: 0, E2: 0, E3: 0 };
  const updates: Array<{ id: string; band: Band }> = [];
  for (const r of entRows) {
    const id = String(r.id);
    const band = bandOf({
      website: (r.website as string | null) ?? null,
      registryIds: (r.registry_ids as Record<string, string> | null) ?? null,
      stage: (r.funding_stage as string | null) ?? null,
      totalRaised: (r.total_raised_usd as number | null) ?? null,
      factAgg: factsByEntity.get(id),
      artAgg: artsByEntity.get(id),
      bigClusterPublishers: clusterByEntity.get(id) ?? 0,
    });
    distribution[band]++;
    updates.push({ id, band });
  }

  // Batched update: one statement per band keeps round-trips tiny.
  for (const band of ["E0", "E1", "E2", "E3"] as Band[]) {
    const ids = updates.filter((u) => u.band === band).map((u) => u.id);
    if (!ids.length) continue;
    await db.execute(sql`
      UPDATE entities SET venture_band = ${band}, banded_at = now()
      WHERE merged_into IS NULL AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `);
  }

  return { banded: updates.length, distribution };
}

/** C4 helper: is this entity swarm-grade (must stay off discovery surfaces)? */
export function isSwarmBand(band: string | null | undefined): boolean {
  return band === "E3";
}
