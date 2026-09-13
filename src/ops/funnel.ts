import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * R13 funnel observability: daily per-stage counters land in one queryable
 * place (`funnel_daily`), upserted idempotently, with week-over-week deviation
 * alerts computed from the stored rows. Every §10 red flag is visible here
 * days before the month closes.
 */

export interface FunnelDay {
  day: string;
  rawItems: number;
  fetched: number;
  extracted: number;
  kept: number;
  prefilterDiscards: number;
  llmDiscards: number;
  quarantined: number;
  parkedFailures: number;
  resolved: number;
  enriched: number;
  clustered: number;
  factsProposed: number;
  factsAccepted: number;
  needsBackfillOutstanding: number;
  profilesComplete: number;
}

/** UTC YYYY-MM-DD for a Date. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Recompute one day's counters from the source tables and upsert. Idempotent:
 * safe to re-run, safe to schedule daily.
 */
export async function rollupFunnelDay(db: Db, dayKey?: string): Promise<FunnelDay> {
  const day = dayKey ?? utcDayKey(new Date(Date.now() - 24 * 3600 * 1000)); // yesterday UTC
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day key: ${day}`);

  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH w AS (
      SELECT (${day}::date)::timestamptz AS ws, (${day}::date + interval '1 day')::timestamptz AS we
    ),
    ri AS (
      SELECT
        COUNT(*)::int AS raw_items,
        COUNT(*) FILTER (WHERE fetch_state = 'fetched')::int AS fetched,
        COUNT(*) FILTER (WHERE fetch_state = 'failed')::int AS parked_failures
      FROM raw_items, w WHERE created_at >= w.ws AND created_at < w.we
    ),
    ar AS (
      SELECT
        COUNT(*) FILTER (WHERE noise_stage = 'kept')::int AS kept,
        COUNT(*) FILTER (WHERE noise_stage = 'prefilter')::int AS prefilter_discards,
        COUNT(*) FILTER (WHERE noise_stage = 'llm_filter')::int AS llm_discards,
        COUNT(*) FILTER (WHERE noise_stage = 'quarantined')::int AS quarantined,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
        COUNT(*) FILTER (WHERE enriched_at IS NOT NULL)::int AS enriched,
        COUNT(*) FILTER (WHERE clustered_at IS NOT NULL)::int AS clustered,
        COUNT(*) FILTER (WHERE extracted_text_chars IS NOT NULL)::int AS extracted
      FROM articles, w WHERE created_at >= w.ws AND created_at < w.we
    ),
    fx AS (
      SELECT
        (SELECT COUNT(*)::int FROM facts, w WHERE created_at >= w.ws AND created_at < w.we) AS facts_proposed,
        (SELECT COUNT(*)::int FROM facts, w WHERE promoted_at >= w.ws AND promoted_at < w.we) AS facts_accepted
    ),
    nb AS (
      SELECT COUNT(*)::int AS needs_backfill_outstanding
      FROM entities WHERE merged_into IS NULL AND needs_backfill = true
    ),
    pr AS (
      SELECT COUNT(*)::int AS profiles_complete
      FROM entity_profiles, w
      WHERE status = 'complete' AND generated_at >= w.ws AND generated_at < w.we
    )
    SELECT ri.raw_items, ri.fetched, ri.parked_failures,
           ar.kept, ar.prefilter_discards, ar.llm_discards, ar.quarantined,
           ar.resolved, ar.enriched, ar.clustered, ar.extracted,
           fx.facts_proposed, fx.facts_accepted,
           nb.needs_backfill_outstanding,
           pr.profiles_complete
    FROM ri, ar, fx, nb, pr
  `);

  const r = rows[0] ?? {};
  const out: FunnelDay = {
    day,
    rawItems: Number(r.raw_items ?? 0),
    fetched: Number(r.fetched ?? 0),
    extracted: Number(r.extracted ?? 0),
    kept: Number(r.kept ?? 0),
    prefilterDiscards: Number(r.prefilter_discards ?? 0),
    llmDiscards: Number(r.llm_discards ?? 0),
    quarantined: Number(r.quarantined ?? 0),
    parkedFailures: Number(r.parked_failures ?? 0),
    resolved: Number(r.resolved ?? 0),
    enriched: Number(r.enriched ?? 0),
    clustered: Number(r.clustered ?? 0),
    factsProposed: Number(r.facts_proposed ?? 0),
    factsAccepted: Number(r.facts_accepted ?? 0),
    needsBackfillOutstanding: Number(r.needs_backfill_outstanding ?? 0),
    profilesComplete: Number(r.profiles_complete ?? 0),
  };

  await db.execute(sql`
    INSERT INTO funnel_daily (
      day, raw_items, fetched, extracted, kept, prefilter_discards, llm_discards,
      quarantined, parked_failures, resolved, enriched, clustered,
      facts_proposed, facts_accepted, needs_backfill_outstanding, profiles_complete, updated_at
    ) VALUES (
      ${day}, ${out.rawItems}, ${out.fetched}, ${out.extracted}, ${out.kept},
      ${out.prefilterDiscards}, ${out.llmDiscards}, ${out.quarantined},
      ${out.parkedFailures}, ${out.resolved}, ${out.enriched}, ${out.clustered},
      ${out.factsProposed}, ${out.factsAccepted}, ${out.needsBackfillOutstanding},
      ${out.profilesComplete}, now()
    )
    ON CONFLICT (day) DO UPDATE SET
      raw_items = EXCLUDED.raw_items,
      fetched = EXCLUDED.fetched,
      extracted = EXCLUDED.extracted,
      kept = EXCLUDED.kept,
      prefilter_discards = EXCLUDED.prefilter_discards,
      llm_discards = EXCLUDED.llm_discards,
      quarantined = EXCLUDED.quarantined,
      parked_failures = EXCLUDED.parked_failures,
      resolved = EXCLUDED.resolved,
      enriched = EXCLUDED.enriched,
      clustered = EXCLUDED.clustered,
      facts_proposed = EXCLUDED.facts_proposed,
      facts_accepted = EXCLUDED.facts_accepted,
      needs_backfill_outstanding = EXCLUDED.needs_backfill_outstanding,
      profiles_complete = EXCLUDED.profiles_complete,
      updated_at = now()
  `);

  logger.info({ day }, "funnel day rolled up");
  return out;
}

export interface FunnelAlert {
  stage: string;
  prev7: number;
  last7: number;
  delta_pct: number;
}

const FUNNEL_ALERT_STAGES = [
  "rawItems",
  "fetched",
  "extracted",
  "kept",
  "resolved",
  "enriched",
  "clustered",
  "factsProposed",
  "factsAccepted",
] as const;

/**
 * R13 alert rule: any stage deviating >30% week-over-week (trailing 7 days vs
 * the previous 7). Pure function so CI can stage an anomaly and assert firing.
 */
export function computeFunnelAlerts(daysAscending: FunnelDay[]): FunnelAlert[] {
  if (daysAscending.length < 14) return [];
  const window = daysAscending.slice(-14);
  const prev = window.slice(0, 7);
  const last = window.slice(7);
  const alerts: FunnelAlert[] = [];
  for (const stage of FUNNEL_ALERT_STAGES) {
    const p = prev.reduce((s, d) => s + d[stage], 0);
    const l = last.reduce((s, d) => s + d[stage], 0);
    if (p <= 0 && l <= 0) continue;
    // A silent stage is as alarming as an exploding one: flag when either
    // side is zero while the other moved, or relative deviation exceeds 30%.
    let deltaPct: number;
    if (p === 0) deltaPct = l > 0 ? 100 : 0;
    else deltaPct = ((l - p) / p) * 100;
    if (Math.abs(deltaPct) > 30) {
      alerts.push({
        stage,
        prev7: p,
        last7: l,
        delta_pct: Math.round(deltaPct * 10) / 10,
      });
    }
  }
  return alerts;
}

export async function loadFunnelDays(db: Db, limitDays = 14): Promise<FunnelDay[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM funnel_daily ORDER BY day ASC LIMIT ${limitDays}
  `);
  return rows.map((r) => ({
    day: String(r.day),
    rawItems: Number(r.raw_items ?? 0),
    fetched: Number(r.fetched ?? 0),
    extracted: Number(r.extracted ?? 0),
    kept: Number(r.kept ?? 0),
    prefilterDiscards: Number(r.prefilter_discards ?? 0),
    llmDiscards: Number(r.llm_discards ?? 0),
    quarantined: Number(r.quarantined ?? 0),
    parkedFailures: Number(r.parked_failures ?? 0),
    resolved: Number(r.resolved ?? 0),
    enriched: Number(r.enriched ?? 0),
    clustered: Number(r.clustered ?? 0),
    factsProposed: Number(r.facts_proposed ?? 0),
    factsAccepted: Number(r.facts_accepted ?? 0),
    needsBackfillOutstanding: Number(r.needs_backfill_outstanding ?? 0),
    profilesComplete: Number(r.profiles_complete ?? 0),
  }));
}
