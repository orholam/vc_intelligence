import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import type { Db } from "../db/index.js";

/**
 * R04/G5 monthly reconciliation probe: every raw item terminates in exactly
 * one auditable state - served/kept article, discard with stage+reason,
 * quarantined (R05), parked failure, pending backlog, or duplicate-consumed.
 * Nothing dies silently, nothing vanishes between fetch and serve.
 *
 * Exit code 1 when accounted share < threshold or any discard lacks a reason.
 *
 * Usage: pnpm pipeline:reconcile [--window-days=31] [--min-accounted=99]
 */

function arg(name: string, def: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw === undefined) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

export interface Reconciliation {
  window_days: number;
  raw_items_total: number;
  served_kept: number;
  audited_prefilter_discards: number;
  audited_llm_discards: number;
  quarantined: number;
  parked_failures: number;
  pending_backlog: number;
  duplicate_consumed: number;
  unaccounted: number;
  discards_without_reason: number;
  r05_incomplete_served: number;
  accounted_pct: number;
}

/** Classify every raw item in the window into its terminal state. */
export async function reconcileWindow(db: Db, days: number): Promise<Reconciliation> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH ri AS (
      SELECT r.id, r.fetch_state, r.fetch_error,
             CASE WHEN a.id IS NOT NULL THEN a.noise_stage ELSE NULL END AS article_stage,
             (r.fetch_state = 'fetched' AND a.id IS NULL) AS fetched_no_article
      FROM raw_items r
      LEFT JOIN articles a ON a.raw_item_id = r.id
      WHERE r.created_at >= now() - (${days} * interval '1 day')
    )
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE article_stage = 'kept')::int AS kept,
           COUNT(*) FILTER (WHERE article_stage = 'prefilter')::int AS prefilter_d,
           COUNT(*) FILTER (WHERE article_stage = 'llm_filter')::int AS llm_d,
           COUNT(*) FILTER (WHERE article_stage = 'quarantined')::int AS quarantined,
           COUNT(*) FILTER (WHERE fetch_state = 'failed' AND article_stage IS NULL)::int AS parked,
           COUNT(*) FILTER (WHERE fetch_state = 'pending' AND article_stage IS NULL)::int AS backlog,
           COUNT(*) FILTER (WHERE fetched_no_article
                            AND fetch_error = 'duplicate_url_hash')::int AS dup_consumed,
           COUNT(*) FILTER (WHERE fetched_no_article
                            AND COALESCE(fetch_error, '') <> 'duplicate_url_hash')::int AS unaccounted
    FROM ri
  `);
  const r = rows[0] ?? {};
  const total = Number(r.total ?? 0);
  const unaccounted = Number(r.unaccounted ?? 0);

  // G5 companion: discards must always explain themselves.
  const audit = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM articles
    WHERE created_at >= now() - (${days} * interval '1 day')
      AND noise_stage IN ('prefilter', 'llm_filter')
      AND (discard_reason IS NULL OR btrim(discard_reason) = '')
  `);

  // R05 nightly zero-row assertion: servable (kept) articles must never carry
  // a null mandated enrichment field; mandatory-summary tiers included.
  const r05 = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM articles
    WHERE noise_stage = 'kept'
      AND created_at >= now() - (${days} * interval '1 day')
      AND (
        primary_tag IS NULL OR sentiment IS NULL OR sentiment_score IS NULL
        OR newsworthiness IS NULL OR industry_primary IS NULL
        OR cardinality(countries) = 0
        OR (newsworthiness = 'high' AND COALESCE(btrim(ai_summary), '') = '')
      )
  `);

  return {
    window_days: days,
    raw_items_total: total,
    served_kept: Number(r.kept ?? 0),
    audited_prefilter_discards: Number(r.prefilter_d ?? 0),
    audited_llm_discards: Number(r.llm_d ?? 0),
    quarantined: Number(r.quarantined ?? 0),
    parked_failures: Number(r.parked ?? 0),
    pending_backlog: Number(r.backlog ?? 0),
    duplicate_consumed: Number(r.dup_consumed ?? 0),
    unaccounted,
    discards_without_reason: Number(audit[0]?.n ?? 0),
    r05_incomplete_served: Number(r05[0]?.n ?? 0),
    accounted_pct: total ? Math.round(((total - unaccounted) / total) * 10000) / 100 : 100,
  };
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 1 });
  const days = arg("window-days", 31);
  const minAccounted = arg("min-accounted", 99);

  const rec = await reconcileWindow(db, days);
  console.log("");
  console.log(`=== R04 reconciliation (window: ${rec.window_days}d) ===`);
  for (const [k, v] of Object.entries(rec)) {
    if (k !== "window_days") console.log(`${k.padEnd(28)} ${v}`);
  }

  const ok =
    rec.accounted_pct >= minAccounted &&
    rec.discards_without_reason === 0 &&
    rec.r05_incomplete_served === 0;

  if (!ok) {
    console.error(
      `RECONCILIATION FAIL: accounted=${rec.accounted_pct}% (min ${minAccounted}%), ` +
        `discards_without_reason=${rec.discards_without_reason}, ` +
        `r05_incomplete_served=${rec.r05_incomplete_served}`,
    );
  } else {
    console.log("RECONCILIATION OK");
  }
  process.exit(ok ? 0 : 1);
}

// CLI guard so tests can import reconcileWindow without side effects.
if (process.argv[1] && process.argv[1].includes("reconcile")) {
  main().catch((err: Error) => {
    console.error("reconcile failed:", err.message);
    process.exit(1);
  });
}
