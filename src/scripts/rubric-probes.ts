import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import type { Db } from "../db/index.js";
import { baselineSatisfactionRate } from "../entities/baseline.js";

/**
 * OUTPUT-RUBRIC probe pack (appendix P0-P13) + gate/R06/R07 verification
 * probes. Runs read-only SQL over a trailing window and prints a markdown
 * scorecard-input report.
 *
 * Usage: pnpm rubric:probes [--window-days=31] [--out=rubric/2026-08/probes.md]
 */

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

type Row = Record<string, unknown>;

async function q(db: Db, title: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  console.log(`\n### ${title}\n`);
  const rows = await db.execute<Row>(query);
  if (!rows.length) {
    console.log("(no rows)");
    return rows;
  }
  const cols = Object.keys(rows[0]!);
  console.log(`| ${cols.join(" | ")} |`);
  console.log(`| ${cols.map(() => "---").join(" | ")} |`);
  for (const r of rows) {
    console.log(`| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`);
  }
  return rows;
}

export async function runProbes(db: Db, days: number): Promise<void> {
  console.log(`# Rubric probes — trailing ${days} days (as of ${new Date().toISOString()})\n`);

  await q(db, "P0 corpus overview by noise_stage", sql`
    SELECT noise_stage, count(*)::int AS n FROM articles
    WHERE created_at >= now() - (${days} * interval '1 day') GROUP BY 1 ORDER BY 2 DESC
  `);

  await q(db, "P1 kept rate + discard reasons (B4/G5)", sql`
    SELECT round(count(*) FILTER (WHERE noise_stage = 'kept')::numeric / greatest(count(*),1), 4) AS kept_rate,
           count(*)::int AS total
    FROM articles WHERE created_at >= now() - (${days} * interval '1 day')
  `);
  await q(db, "P1b top discard reasons", sql`
    SELECT discard_reason, count(*)::int AS n FROM articles
    WHERE created_at >= now() - (${days} * interval '1 day') AND discard_reason IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 15
  `);

  await q(db, "P2 new-entity survival, stuck set (C2/A4/C5 denominator)", sql`
    WITH ne AS (
      SELECT e.id FROM entities e
      WHERE e.created_at >= now() - (${days} * interval '1 day') AND e.merged_into IS NULL
    )
    SELECT count(*)::int AS new_entities,
           count(*) FILTER (WHERE COALESCE(ea.cnt,0) >= 2 OR COALESCE(f.cnt,0) >= 1)::int AS stuck,
           count(*) FILTER (WHERE COALESCE(f.cnt,0) >= 1)::int AS with_accepted_fact
    FROM ne
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS cnt FROM article_entities ae
      JOIN articles a ON a.id = ae.article_id
      WHERE ae.entity_id = ne.id AND ae.role = 'primary' AND a.noise_stage='kept'
    ) ea ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS cnt FROM facts f
      WHERE f.entity_id = ne.id AND f.status = 'accepted'
    ) f ON true
  `);

  await q(db, "P3 field density composite (D3)", sql`
    SELECT count(*)::int AS active_entities,
           round(avg((website IS NOT NULL)::int), 3) AS website_rate,
           round(avg((country IS NOT NULL)::int), 3) AS country_rate,
           round(avg((cardinality(industry_tags) > 0)::int), 3) AS industry_rate,
           round(avg((founded_year IS NOT NULL OR registry_ids IS NOT NULL)::int), 3) AS founded_or_registry_rate,
           round(avg((funding_stage IS NOT NULL AND btrim(funding_stage) <> '')::int), 3) AS stage_non_null_rate
    FROM entities e
    WHERE merged_into IS NULL
      AND EXISTS (SELECT 1 FROM article_entities ae JOIN articles a ON a.id = ae.article_id
                  WHERE ae.entity_id = e.id AND a.noise_stage = 'kept')
  `);

  await q(db, "P4 orphan share (D2)", sql`
    SELECT round(count(*) FILTER (WHERE e.review_status = 'auto_created' AND e.confidence < 0.6)::numeric
           / greatest(count(*),1), 4) AS orphan_share
    FROM articles a
    JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    JOIN entities e ON e.id = ae.entity_id
    WHERE a.created_at >= now() - (${days} * interval '1 day') AND a.noise_stage = 'kept'
  `);

  await q(db, "P5 fact funnel (fact inputs for C-dims)", sql`
    SELECT type, status, count(*)::int AS n,
           round(avg(distinct_publishers)::numeric(10,2)) AS avg_publishers,
           round(avg(best_source_tier)::numeric(10,2)) AS avg_best_tier
    FROM facts WHERE created_at >= now() - (${days} * interval '1 day')
    GROUP BY 1, 2 ORDER BY 1, 2
  `);

  await q(db, "P6 lead-time proxy (C3)", sql`
    WITH rounds AS (
      SELECT f.entity_id, (f.payload->>'event_date')::date AS event_date
      FROM facts f
      WHERE f.type = 'funding_round' AND f.status = 'accepted'
        AND f.payload->>'event_date' IS NOT NULL
    )
    SELECT r.entity_id, r.event_date,
           round(EXTRACT(epoch FROM (r.event_date::timestamp - min(a.published_at))) / 86400.0, 1) AS lead_days
    FROM rounds r
    JOIN article_entities ae ON ae.entity_id = r.entity_id
    JOIN articles a ON a.id = ae.article_id
    GROUP BY r.entity_id, r.event_date
    HAVING min(a.published_at) IS NOT NULL
    ORDER BY lead_days DESC LIMIT 50
  `);

  await q(db, "P7 momentum coherence proxy (C6)", sql`
    SELECT round(count(*) FILTER (WHERE distinct_tags >= 2)::numeric / greatest(count(*),1), 4) AS momentum_share
    FROM (
      SELECT ae.entity_id, count(DISTINCT a.primary_tag) AS distinct_tags,
             count(DISTINCT a.publisher_domain) AS publishers
      FROM article_entities ae
      JOIN articles a ON a.id = ae.article_id
      WHERE a.noise_stage = 'kept' AND a.published_at >= now() - (${days} * interval '1 day')
      GROUP BY ae.entity_id
      HAVING count(DISTINCT a.publisher_domain) >= 2
    ) t
  `);

  await q(db, "P8 latency percentiles per tier (F1)", sql`
    SELECT s.tier,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (a.created_at - a.published_at))/3600)::numeric, 1) AS median_lag_h,
           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (a.created_at - a.published_at))/3600)::numeric, 1) AS p90_lag_h
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.noise_stage = 'kept' AND a.created_at >= now() - (${days} * interval '1 day')
    GROUP BY s.tier ORDER BY s.tier
  `);

  await q(db, "P9 source health (F2/B5 input)", sql`
    SELECT s.id, s.tier, s.failure_streak, s.last_fetched_at,
           count(a.id) FILTER (WHERE a.noise_stage = 'kept')::int AS kept_articles
    FROM sources s
    LEFT JOIN articles a ON a.source_id = s.id AND a.created_at >= now() - (${days} * interval '1 day')
    WHERE s.active
    GROUP BY s.id, s.tier, s.failure_streak, s.last_fetched_at
    ORDER BY kept_articles DESC LIMIT 25
  `);

  await q(db, "P10 sector mix of kept volume (A5/E3)", sql`
    SELECT coalesce(industry_primary, '(none)') AS industry, count(*)::int AS n
    FROM articles WHERE noise_stage = 'kept' AND published_at >= now() - (${days} * interval '1 day')
    GROUP BY 1 ORDER BY 2 DESC LIMIT 20
  `);
  await q(db, "P10b geo mix of kept volume (A5)", sql`
    SELECT c AS country, count(*)::int AS n
    FROM articles a, unnest(a.countries) AS c
    WHERE a.noise_stage = 'kept' AND a.published_at >= now() - (${days} * interval '1 day')
    GROUP BY 1 ORDER BY 2 DESC LIMIT 15
  `);

  await q(db, "P11 confidence deciles (D4 input)", sql`
    SELECT width_bucket(confidence, 0, 1, 10) AS decile, review_status, count(*)::int AS n
    FROM entities WHERE created_at >= now() - (${days} * interval '1 day') AND merged_into IS NULL
    GROUP BY 1, 2 ORDER BY 1
  `);

  await q(db, "P12 month LLM spend vs cap (FR-23 $/1K-correct input)", sql`
    SELECT round(COALESCE(sum(cost_usd), 0)::numeric, 2) AS month_llm_spend
    FROM llm_calls WHERE created_at >= date_trunc('month', now())
  `);

  await q(db, "P13 stage coverage + distribution (D3/C2)", sql`
    SELECT coalesce(funding_stage, '(NULL - DEFECT)') AS stage, count(*)::int AS n,
           round(count(*)::numeric * 100 / sum(count(*)) OVER (), 1) AS pct
    FROM entities
    WHERE merged_into IS NULL
      AND EXISTS (SELECT 1 FROM article_entities ae JOIN articles a ON a.id = ae.article_id
                  WHERE ae.entity_id = entities.id AND a.noise_stage = 'kept')
    GROUP BY 1 ORDER BY 2 DESC
  `);

  // ---- gates --------------------------------------------------------------
  await q(db, "G1 duplicate live domains", sql`
    SELECT website, count(*)::int AS n FROM entities
    WHERE merged_into IS NULL AND website IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1 LIMIT 10
  `);
  await q(db, "G1b duplicate normalized name + country", sql`
    SELECT lower(btrim(canonical_name)) AS norm_name, country, count(*)::int AS n
    FROM entities WHERE merged_into IS NULL
    GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 3 DESC LIMIT 10
  `);
  await q(db, "G2 provenance completeness on servable articles", sql`
    SELECT count(*)::int AS kept_total,
           count(*) FILTER (WHERE url IS NULL OR publisher_domain IS NULL
                            OR published_at IS NULL OR excerpt_text IS NULL)::int AS provenance_gaps
    FROM articles WHERE noise_stage = 'kept'
      AND created_at >= now() - (${days} * interval '1 day')
  `);

  // ---- R06 baseline satisfaction -----------------------------------------
  const base = await baselineSatisfactionRate(db);
  console.log(`\n### R06 baseline card satisfaction\n\nactive_entities=${base.active_entities} baseline_ok=${base.baseline_ok} rate_pct=${base.rate_pct} (target >=95)`);

  // ---- R07 fact propagation SLA ------------------------------------------
  await q(db, "R07 accepted funding facts lacking derived KB fields (>24h old)", sql`
    SELECT f.id, f.entity_id,
           (f.payload->>'funding_stage') AS fact_stage, e.funding_stage AS card_stage
    FROM facts f JOIN entities e ON e.id = f.entity_id
    WHERE f.type = 'funding_round' AND f.status = 'accepted'
      AND f.promoted_at < now() - interval '24 hours'
      AND ((f.payload->>'funding_stage' IS NOT NULL AND COALESCE(e.funding_stage,'') <> lower(f.payload->>'funding_stage'))
           OR e.last_funding_date IS NULL)
    LIMIT 20
  `);

  // ---- R05 quarantine state -----------------------------------------------
  await q(db, "R05 quarantine state", sql`
    SELECT discard_reason, enrich_attempts, count(*)::int AS n
    FROM articles WHERE noise_stage = 'quarantined'
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10
  `);

  // ---- R09 disclosed degradation ------------------------------------------
  await q(db, "R09 budget degrade events", sql`
    SELECT kind, message, created_at FROM pipeline_events ORDER BY created_at DESC LIMIT 10
  `);

  // ---- R10 lifecycle audit --------------------------------------------------
  await q(db, "R10 recent source lifecycle events", sql`
    SELECT event, reason, created_at FROM source_events ORDER BY created_at DESC LIMIT 10
  `);

  // ---- G4 ledger continuity -------------------------------------------------
  await q(db, "G4 ledger continuity (days with llm_calls in window)", sql`
    SELECT count(DISTINCT date_trunc('day', created_at))::int AS ledger_days,
           (${days})::int AS window_days
    FROM llm_calls WHERE created_at >= now() - (${days} * interval '1 day')
  `);
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 2 });
  const days = Number(arg("window-days") ?? 31);
  await runProbes(db, Number.isFinite(days) ? days : 31);
}

// CLI guard so tests can import runProbes without side effects.
if (process.argv[1] && process.argv[1].includes("rubric-probes")) {
  main()
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error("probes failed:", err.message);
      process.exit(1);
    });
}
