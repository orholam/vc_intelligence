import { sql } from "drizzle-orm";
import { getFilters } from "../config-files.js";
import type { Db } from "../db/index.js";
import { extractCountries } from "../lib/countries.js";
import type { InterpretedFilters } from "./interpret.js";

/**
 * FR-20 stages 2-4: entity KB query -> rank by signal recency/strength ->
 * attach per-company latest signals (top 3 headlines).
 */

export interface RankedCompany {
  entity: Record<string, unknown>;
  relevance_score: number;
  recent_signals: Array<{
    headline: string;
    url: string;
    published_date: string;
    tag: string | null;
  }>;
  derived: {
    article_count_30d: number;
    last_news_date: string | null;
    top_event_types: Array<{ tag: string; count: number }>;
  };
}

export async function queryRankedCompanies(
  db: Db,
  filters: InterpretedFilters,
  limit: number,
): Promise<RankedCompany[]> {
  const cfg = getFilters().listgen;

  // R06: baseline-incomplete entities stay out of ListGen until drained;
  // C4: launch-surface entities stay out until they earn signal.
  const conds = [
    sql`e.merged_into IS NULL`,
    sql`e.needs_backfill = false`,
    // Funds are not operating companies; a "pre-seed fintech" list must not
    // return pooled investment vehicles that filed their own Form Ds.
    sql`(e.type IS NULL OR e.type NOT IN ('fund','person-org'))`,
  ];
  // C4 swarm demotion: E3 entities never appear on discovery surfaces unless
  // the query explicitly targets the stages where swarm companies live.
  const lateStageQuery = filters.funding_stage.some((f) =>
    ["series_c", "late_stage"].includes(f),
  );
  if (!lateStageQuery) conds.push(sql`(e.venture_band IS NULL OR e.venture_band <> 'E3')`);
  if (filters.sectors.length) {
    conds.push(sql`(${sql.join(filters.sectors.map((x) => sql`${x}::text = ANY(e.industry_tags)`), sql` OR `)})`);
  }
  if (filters.countries.length) {
    conds.push(sql`(${sql.join(filters.countries.map((c) => sql`e.country = ${c}`), sql` OR `)})`);
  }
  if (filters.funding_stage.length) {
    conds.push(sql`(${sql.join(filters.funding_stage.map((f) => sql`e.funding_stage = ${f}`), sql` OR `)})`);
  }
  if (filters.founded_after != null) conds.push(sql`e.founded_year >= ${filters.founded_after}`);
  if (filters.founded_before != null) conds.push(sql`e.founded_year <= ${filters.founded_before}`);
  // Signal filters (FR-20): interpreted signals must constrain results, not
  // just decorate the response.
  for (const sig of filters.signals ?? []) {
    if (sig === "raised_recently") {
      conds.push(sql`(e.last_funding_date >= now() - interval '180 days' OR EXISTS (
        SELECT 1 FROM facts rf WHERE rf.entity_id = e.id AND rf.status = 'accepted'
          AND rf.type = 'funding_round' AND rf.created_at >= now() - interval '180 days'))`);
    } else if (sig === "hiring") {
      conds.push(sql`EXISTS (
        SELECT 1 FROM article_entities he JOIN articles ha ON ha.id = he.article_id
        WHERE he.entity_id = e.id AND ha.noise_stage = 'kept'
          AND ha.published_at >= now() - interval '90 days'
          AND ha.primary_tag IN ('expansion.hiring_growth','leadership.executive_appointment'))`);
    } else if (sig === "expanding") {
      conds.push(sql`EXISTS (
        SELECT 1 FROM article_entities xe JOIN articles xa ON xa.id = xe.article_id
        WHERE xe.entity_id = e.id AND xa.noise_stage = 'kept'
          AND xa.published_at >= now() - interval '90 days'
          AND split_part(COALESCE(xa.primary_tag,'x'), '.', 1) IN ('expansion_restructuring','partnership'))`);
    } else if (sig === "distress") {
      conds.push(sql`EXISTS (
        SELECT 1 FROM article_entities de JOIN articles da ON da.id = de.article_id
        WHERE de.entity_id = e.id AND da.noise_stage = 'kept'
          AND da.published_at >= now() - interval '90 days'
          AND split_part(COALESCE(da.primary_tag,'x'), '.', 1) IN ('risk','legal'))`);
    } else if (sig === "acquiring") {
      conds.push(sql`(EXISTS (
        SELECT 1 FROM facts af WHERE af.entity_id = e.id AND af.status = 'accepted'
          AND af.type = 'acquisition'
        ) OR EXISTS (
        SELECT 1 FROM article_entities ae2 JOIN articles a2 ON a2.id = ae2.article_id
        WHERE ae2.entity_id = e.id AND a2.noise_stage = 'kept'
          AND a2.published_at >= now() - interval '90 days'
          AND a2.primary_tag IN ('mna.acquisition_announced','mna.acquisition_completed')))`);
    }
  }

  for (const kw of filters.keywords) {
    const like = `%${kw}%`;
    conds.push(
      sql`(e.canonical_name ILIKE ${like} OR e.legal_name ILIKE ${like}
           OR EXISTS (SELECT 1 FROM aliases al WHERE al.entity_id = e.id AND al.alias_normalized LIKE ${like})
           OR e.website ILIKE ${like})`,
    );
  }
  for (const kw of filters.exclude_keywords) {
    const like = `%${kw}%`;
    conds.push(sql`NOT (e.canonical_name ILIKE ${like})`);
  }

  // Signal scoring: recency-weighted kept-article volume + accepted funding facts.
  const halfLifeDays = Math.max(1, cfg.signal_recency_half_life_days);
  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH base AS (
      SELECT e.*
      FROM entities e
      WHERE ${sql.join(conds, sql` AND `)}
      LIMIT 500
    ),
    scored AS (
      SELECT b.*,
        COALESCE(sig.signal_score, 0) AS signal_score,
        COALESCE(sig.last_signal_at, to_timestamp(0)) AS last_signal_at
      FROM base b
      LEFT JOIN LATERAL (
        SELECT SUM(exp(-ln(2) * GREATEST(0, EXTRACT(epoch FROM (now() - a.published_at)) / 86400.0) / ${halfLifeDays}))
               AS signal_score,
               MAX(a.published_at) AS last_signal_at
        FROM articles a
        JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
        WHERE ae.entity_id = b.id
          AND a.noise_stage = 'kept'
          AND a.published_at >= now() - interval '90 days'
      ) sig ON true
      WHERE NOT (
        -- c-plan guard: launch-surface entities stay out until they earn signal
        b.created_by LIKE 'launch:%'
        AND COALESCE(sig.signal_score, 0) < ${cfg.launch_entity_min_signal}
      )
      ORDER BY signal_score DESC, b.confidence DESC
      LIMIT ${Math.min(limit, 200)}
    )
    SELECT scored.*, f.fact_count, f.latest_fact_date,
           COALESCE(d.article_count_30d, 0) AS article_count_30d,
           d.last_news_date, d.top_event_types
    FROM scored
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS fact_count, MAX(f2.promoted_at) AS latest_fact_date
      FROM facts f2 WHERE f2.entity_id = scored.id AND f2.status = 'accepted'
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS article_count_30d,
             MAX(a.published_at) AS last_news_date,
             COALESCE(
               (SELECT json_agg(y) FROM (
                  SELECT d2.primary_tag AS tag, COUNT(*)::int AS count
                  FROM articles d2
                  JOIN article_entities de2 ON de2.article_id = d2.id AND de2.role = 'primary'
                  WHERE de2.entity_id = scored.id AND d2.noise_stage = 'kept'
                    AND d2.primary_tag IS NOT NULL
                    AND d2.published_at >= now() - interval '90 days'
                  GROUP BY d2.primary_tag ORDER BY count DESC LIMIT 5
                ) y),
               '[]'::json
             ) AS top_event_types
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      WHERE ae.entity_id = scored.id AND a.noise_stage = 'kept'
        AND a.published_at >= now() - interval '30 days'
    ) d ON true
    ORDER BY
      (signal_score * 0.8 + COALESCE(f.fact_count, 0) * 0.5) DESC,
      confidence DESC
  `);

  const ids = rows.map((r) => String(r.id));
  const signalsByEntity = await loadRecentSignals(db, ids);

  return rows.map((r) => {
    const id = String(r.id);
    const signalScore = Number(r.signal_score ?? 0);
    const factBoost = Math.min(Number(r.fact_count ?? 0), 5) * 0.1;
    return {
      entity: r,
      relevance_score: Number(Math.min(signalScore * 0.15 + factBoost + 0.05, 1).toFixed(3)),
      recent_signals: signalsByEntity.get(id) ?? [],
      derived: {
        article_count_30d: Number(r.article_count_30d ?? 0),
        last_news_date: r.last_news_date
          ? new Date(String(r.last_news_date)).toISOString()
          : null,
        top_event_types: Array.isArray(r.top_event_types)
          ? (r.top_event_types as Array<{ tag: string; count: number }>)
          : [],
      },
    };
  });
}

async function loadRecentSignals(db: Db, entityIds: string[]): Promise<Map<string, RankedCompany["recent_signals"]>> {
  const out = new Map<string, RankedCompany["recent_signals"]>();
  if (!entityIds.length) return out;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT ON (ae.entity_id, a.id)
           ae.entity_id, a.title, a.url, a.published_at, a.primary_tag, a.newsworthiness
    FROM articles a
    JOIN article_entities ae ON ae.article_id = a.id
    WHERE ae.entity_id IN (${sql.join(entityIds.map((e2) => sql`${e2}`), sql`, `)})
      AND a.noise_stage = 'kept'
      AND a.published_at >= now() - interval '60 days'
    ORDER BY ae.entity_id, a.id,
             CASE a.newsworthiness WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             a.published_at DESC
  `);

  for (const r of rows) {
    const entityId = String(r.entity_id);
    const list = out.get(entityId) ?? [];
    if (list.length < 3) {
      list.push({
        headline: String(r.title ?? ""),
        url: String(r.url ?? ""),
        published_date: new Date(String(r.published_at)).toISOString(),
        tag: (r.primary_tag as string | null) ?? null,
      });
      out.set(entityId, list);
    }
  }
  void extractCountries;
  return out;
}
