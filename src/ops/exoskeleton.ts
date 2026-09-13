import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { LlmRouter } from "../llm/router.js";
import { stageCostBreakdown, recentPipelineEvents, blendedArticleCost } from "../llm/router.js";
import { getFilters } from "../config-files.js";
import { getConfig } from "../config.js";
import { cleanupOldTraces } from "./traces.js";
import { harnessStatus, type HarnessRunSummary } from "../harness/run.js";

/**
 * Live Pipeline observability (exoskeleton): one bounded snapshot of the whole
 * engine — sourcing, inbound, fetch/extract, programmatic filtering branches,
 * waiting room, harness batch results, winners, webhooks — plus queue depths
 * from pg-boss and a merged recent-activity feed. Item journeys are NOT part
 * of the snapshot: they stream individually as one package per item when they
 * reach a terminal bucket (no backpropagation on page load). Read-only; every
 * query hits an indexed column and the result is cached briefly so N streaming
 * clients share one build.
 */

export interface ExoSourceTier {
  tier: number;
  total: number;
  active: number;
  failing: number;
  last_fetch: string | null;
}

export interface ExoInbound {
  backlog_by_channel: Array<{ channel: string; pending: number; fetched: number; failed: number }>;
  discovered_24h_by_channel: Array<{ channel: string; n: number }>;
  /** Raw items discovered in-window that ended up parked as failures. */
  failed_discovered_24h: number;
  recent: ExoActivity[];
}

export interface ExoHourPoint {
  hour: string; // HH:00 UTC label
  discovered: number;
  extracted: number;
  published: number;
  discarded: number;
}

export interface ExoStageCounts {
  backlog: Record<string, number>; // noise_stage -> rows currently in that state
  created_24h: number;
  /** Published winners (noise_stage='kept') in the last 24h — what /latest serves. */
  published_24h: number;
  prefilter_24h: number;
  /** Harness relevance discards (llm_filter stage) in the last 24h. */
  harness_discards_24h: number;
  resolved_24h: number;
  enriched_24h: number;
  clustered_24h: number;
  /** Articles extracted and waiting on the filter job. */
  pending_now: number;
  /** Items parked in the waiting room right now. */
  waiting_now: number;
}

export interface ExoHarness {
  running_now: boolean;
  last_run: HarnessRunSummary | null;
  batch_limit: number;
  llm_provider: string;
  /** Oldest item currently in the waiting room (ISO), null when empty. */
  oldest_waiting_at: string | null;
}

export interface ExoStageItem {
  id: string;
  title: string;
  detail: string | null;
  ts: string;
  url: string | null;
}

export interface ExoStageList {
  node: string;
  count: number;
  items: ExoStageItem[];
}

export interface ExoDiscardReason {
  stage: string;
  reason: string;
  n: number;
}

export interface ExoQueueDepth {
  name: string;
  waiting: number;
  active: number;
  failing: number;
}

export interface ExoWebhooks {
  subscriptions_active: number;
  delivered_24h: number;
  failed_24h: number;
  pending_now: number;
}

export interface ExoEntities {
  live_entities: number;
  needs_backfill_outstanding: number;
  created_24h: number;
  banded: number;
  facts_proposed_24h: number;
  facts_accepted_24h: number;
  profiles_complete_24h: number;
}

/** Express lanes that skip the main article chain (c-plan left-edge sources). */
export interface ExoSideChannels {
  /** Launch-surface items routed into the waiting room (HN/PH/…), by surface, last 24h. */
  launches_by_surface_24h: Array<{ surface: string; n: number }>;
  /** Form D filing events queued for the harness batch, last 24h. */
  formd_facts_24h: number;
}

export interface ExoActivity {
  id: string;
  kind:
    | "discovered"
    | "fetch_failed"
    | "discarded"
    | "kept"
    | "resolved"
    | "enriched"
    | "clustered"
    | "fact"
    | "source_event"
    | "pipeline_event";
  ts: string;
  title: string;
  detail?: string;
  url?: string | null;
  /** Diagram node this item belongs to (client highlights/filters on it). */
  node: string;
}

export interface ExoskeletonSnapshot {
  ts: string;
  build_ms: number;
  sources: {
    tiers: ExoSourceTier[];
    due_now: number;
    total: number;
    active_total: number;
  };
  inbound: ExoInbound;
  stages: ExoStageCounts;
  harness: ExoHarness;
  discard_reasons_24h: ExoDiscardReason[];
  hourly_24h: ExoHourPoint[];
  queues: ExoQueueDepth[];
  webhooks: ExoWebhooks;
  entities: ExoEntities;
  side_channels: ExoSideChannels;
  llm: {
    budget: {
      month: string;
      spent_usd: number;
      cap_usd: number;
      soft_limit_usd: number;
      classify_only_mode: boolean;
    };
    stages: Awaited<ReturnType<typeof stageCostBreakdown>>;
    blended_article_cost_usd: number | null;
    degrade_events: Awaited<ReturnType<typeof recentPipelineEvents>>;
  };
  activity: ExoActivity[];
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function num(v: unknown): number {
  return Number(v ?? 0);
}
/** Truncate for display without breaking unicode badly. */
function clip(s: unknown, max = 120): string {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

async function sourceSummary(db: Db) {
  const tiers = await db.execute<Record<string, unknown>>(sql`
    SELECT tier, COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE active)::int AS active,
           COUNT(*) FILTER (WHERE failure_streak > 0)::int AS failing,
           MAX(last_fetched_at) AS last_fetch
    FROM sources GROUP BY tier ORDER BY tier ASC
  `);
  const due = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM sources WHERE active AND next_poll_at <= now()
  `);
  const tierRows: ExoSourceTier[] = tiers.map((r) => ({
    tier: num(r.tier),
    total: num(r.total),
    active: num(r.active),
    failing: num(r.failing),
    last_fetch: toIso(r.last_fetch),
  }));
  return {
    tiers: tierRows,
    due_now: Number(due[0]?.n ?? 0),
    total: tierRows.reduce((s, t) => s + t.total, 0),
    active_total: tierRows.reduce((s, t) => s + t.active, 0),
  };
}

async function inboundSnapshot(db: Db): Promise<ExoInbound> {
  const backlog = await db.execute<Record<string, unknown>>(sql`
    SELECT discovered_via AS channel,
           COUNT(*) FILTER (WHERE fetch_state = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE fetch_state = 'fetched')::int AS fetched,
           COUNT(*) FILTER (WHERE fetch_state = 'failed')::int AS failed
    FROM raw_items GROUP BY discovered_via ORDER BY discovered_via
  `);
  const rate = await db.execute<Record<string, unknown>>(sql`
    SELECT discovered_via AS channel, COUNT(*)::int AS n FROM raw_items
    WHERE created_at >= now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC
  `);
  const failed24 = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM raw_items
    WHERE fetch_state = 'failed' AND created_at >= now() - interval '24 hours'
  `);
  const recentRows = await db.execute<Record<string, unknown>>(sql`
    SELECT r.id, r.title, r.url, r.discovered_via, r.fetch_state, r.created_at, s.name AS source_name
    FROM raw_items r LEFT JOIN sources s ON s.id = r.source_id
    ORDER BY r.created_at DESC LIMIT 12
  `);
  const recent: ExoActivity[] = recentRows.map((r) => {
    const failed = String(r.fetch_state) === "failed";
    return {
      id: `raw-${String(r.id)}`,
      kind: failed ? "fetch_failed" : "discovered",
      ts: toIso(r.created_at) ?? new Date(0).toISOString(),
      title: clip(r.title ?? r.url),
      detail: `${String(r.discovered_via).toUpperCase()} · ${clip(r.source_name ?? "direct", 40)}${
        failed ? ` · ${clip(r.url, 60)} ` : ""
      }`,
      url: String(r.url ?? ""),
      node: failed ? "fetch_failed" : "raw",
    };
  });
  return {
    backlog_by_channel: backlog.map((r) => ({
      channel: String(r.channel),
      pending: num(r.pending),
      fetched: num(r.fetched),
      failed: num(r.failed),
    })),
    discovered_24h_by_channel: rate.map((r) => ({ channel: String(r.channel), n: num(r.n) })),
    failed_discovered_24h: Number(failed24[0]?.n ?? 0),
    recent,
  };
}

async function stageSnapshot(db: Db): Promise<ExoStageCounts> {
  const backlog = await db.execute<Record<string, unknown>>(sql`
    SELECT noise_stage, COUNT(*)::int AS n FROM articles GROUP BY noise_stage
  `);
  const win = sql`now() - interval '24 hours'`;
  const trans = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= ${win})::int AS created_24h,
      COUNT(*) FILTER (WHERE updated_at >= ${win} AND noise_stage = 'kept')::int AS published_24h,
      COUNT(*) FILTER (WHERE updated_at >= ${win} AND noise_stage = 'prefilter')::int AS prefilter_24h,
      COUNT(*) FILTER (WHERE updated_at >= ${win} AND noise_stage = 'llm_filter')::int AS harness_discards_24h,
      COUNT(*) FILTER (WHERE resolved_at >= ${win})::int AS resolved_24h,
      COUNT(*) FILTER (WHERE enriched_at >= ${win})::int AS enriched_24h,
      COUNT(*) FILTER (WHERE clustered_at >= ${win})::int AS clustered_24h,
      COUNT(*) FILTER (WHERE noise_stage = 'pending')::int AS pending_now,
      COUNT(*) FILTER (WHERE noise_stage = 'waiting')::int AS waiting_now
    FROM articles
  `);
  const t = trans[0] ?? {};
  const backlogMap: Record<string, number> = {};
  for (const r of backlog) backlogMap[String(r.noise_stage)] = num(r.n);
  return {
    backlog: backlogMap,
    created_24h: num(t.created_24h),
    published_24h: num(t.published_24h),
    prefilter_24h: num(t.prefilter_24h),
    harness_discards_24h: num(t.harness_discards_24h),
    resolved_24h: num(t.resolved_24h),
    enriched_24h: num(t.enriched_24h),
    clustered_24h: num(t.clustered_24h),
    pending_now: num(t.pending_now),
    waiting_now: num(t.waiting_now),
  };
}

async function discardReasons(db: Db): Promise<ExoDiscardReason[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT CASE WHEN noise_stage = 'llm_filter' THEN 'harness' ELSE 'prefilter' END AS stage,
           COALESCE(split_part(discard_reason, ':', 1), 'unknown') AS reason,
           COUNT(*)::int AS n
    FROM articles
    WHERE noise_stage IN ('prefilter', 'llm_filter')
      AND updated_at >= now() - interval '24 hours'
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 14
  `);
  return rows.map((r) => ({ stage: String(r.stage), reason: String(r.reason), n: num(r.n) }));
}

async function hourlyFlow(db: Db): Promise<ExoHourPoint[]> {
  const start = sql`date_trunc('hour', now()) - interval '23 hours'`;
  const [disc, extr, filt] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      SELECT date_trunc('hour', created_at) AS h, COUNT(*)::int AS n FROM raw_items
      WHERE created_at >= ${start} GROUP BY 1`),
    db.execute<Record<string, unknown>>(sql`
      SELECT date_trunc('hour', created_at) AS h, COUNT(*)::int AS n FROM articles
      WHERE created_at >= ${start} GROUP BY 1`),
    db.execute<Record<string, unknown>>(sql`
      SELECT date_trunc('hour', updated_at) AS h,
             COUNT(*) FILTER (WHERE noise_stage IN ('prefilter','llm_filter'))::int AS bad,
             COUNT(*) FILTER (WHERE noise_stage = 'kept')::int AS good
      FROM articles WHERE updated_at >= ${start} GROUP BY 1`),
  ]);
  const map = new Map<string, ExoHourPoint>();
  const key = (v: unknown) => toIso(v)?.slice(11, 13) + ":00";
  const ensure = (k: string): ExoHourPoint => {
    let p = map.get(k);
    if (!p) {
      p = { hour: k, discovered: 0, extracted: 0, published: 0, discarded: 0 };
      map.set(k, p);
    }
    return p!;
  };
  for (let i = 0; i < 24; i++) {
    const hh = new Date(Date.now() - (23 - i) * 3600_000);
    ensure(`${String(hh.getUTCHours()).padStart(2, "0")}:00`);
  }
  for (const r of disc) ensure(key(r.h)!).discovered += num(r.n);
  for (const r of extr) ensure(key(r.h)!).extracted += num(r.n);
  for (const r of filt) {
    const p = ensure(key(r.h)!);
    p.discarded += num(r.bad);
    p.published += num(r.good);
  }
  return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

async function queueDepths(db: Db): Promise<ExoQueueDepth[]> {
  // pg-boss v10 keeps every job in partitioned children under pgboss.job.
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT name,
           COUNT(*) FILTER (WHERE state = 'created')::int AS waiting,
           COUNT(*) FILTER (WHERE state = 'active')::int AS active,
           COUNT(*) FILTER (WHERE state IN ('retry', 'failed'))::int AS failing
    FROM pgboss.job
    GROUP BY name ORDER BY name
  `);
  return rows
    .filter((r) => !String(r.name).startsWith("__"))
    .map((r) => ({
      name: String(r.name),
      waiting: num(r.waiting),
      active: num(r.active),
      failing: num(r.failing),
    }));
}

async function webhookSnapshot(db: Db): Promise<ExoWebhooks> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM webhook_subscriptions WHERE active) AS subs,
      (SELECT COUNT(*)::int FROM webhook_deliveries WHERE created_at >= now() - interval '24 hours' AND status = 'delivered') AS delivered,
      (SELECT COUNT(*)::int FROM webhook_deliveries WHERE created_at >= now() - interval '24 hours' AND status = 'failed') AS failed,
      (SELECT COUNT(*)::int FROM webhook_deliveries WHERE status = 'pending') AS pending
  `);
  const r = rows[0] ?? {};
  return {
    subscriptions_active: num(r.subs),
    delivered_24h: num(r.delivered),
    failed_24h: num(r.failed),
    pending_now: num(r.pending),
  };
}

async function entitySnapshot(db: Db): Promise<ExoEntities> {
  const e = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE merged_into IS NULL)::int AS live,
      COUNT(*) FILTER (WHERE merged_into IS NULL AND needs_backfill)::int AS backfill,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS created_24h,
      COUNT(*) FILTER (WHERE merged_into IS NULL AND venture_band IS NOT NULL)::int AS banded
    FROM entities
  `);
  const f = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS proposed,
      COUNT(*) FILTER (WHERE promoted_at >= now() - interval '24 hours')::int AS accepted
    FROM facts
  `);
  const p = await db.execute<Record<string, unknown>>(sql`
    SELECT COUNT(*)::int AS n FROM entity_profiles
    WHERE generated_at >= now() - interval '24 hours' AND status = 'complete'
  `);
  const er = e[0] ?? {};
  const fr = f[0] ?? {};
  return {
    live_entities: num(er.live),
    needs_backfill_outstanding: num(er.backfill),
    created_24h: num(er.created_24h),
    banded: num(er.banded),
    facts_proposed_24h: num(fr.proposed),
    facts_accepted_24h: num(fr.accepted),
    profiles_complete_24h: num(p[0]?.n),
  };
}

interface ArticleRow extends Record<string, unknown> {
  id: string;
  title: string;
  publisher_domain: string;
  noise_stage: string;
  discard_reason: string | null;
  noise_score: number | null;
  primary_tag: string | null;
  entity_name: string | null;
  ts: string;
}

async function recentArticleEvents(db: Db): Promise<ExoActivity[]> {
  const win = sql`now() - interval '36 hours'`;
  const discards = await db.execute<ArticleRow>(sql`
    SELECT a.id, a.title, a.publisher_domain, a.noise_stage, a.discard_reason, a.noise_score, a.updated_at AS ts
    FROM articles a
    WHERE a.noise_stage IN ('prefilter', 'llm_filter') AND a.updated_at >= ${win}
    ORDER BY a.updated_at DESC LIMIT 12
  `);
  const winners = await db.execute<ArticleRow>(sql`
    SELECT a.id, a.title, a.publisher_domain, a.primary_tag, e.canonical_name AS entity_name,
           GREATEST(a.resolved_at, a.enriched_at, a.clustered_at, a.updated_at) AS ts
    FROM articles a
    LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    LEFT JOIN entities e ON e.id = ae.entity_id
    WHERE a.noise_stage = 'kept' AND a.updated_at >= ${win}
    ORDER BY ts DESC NULLS LAST LIMIT 14
  `);
  const out: ExoActivity[] = [];
  for (const r of discards) {
    out.push({
      id: `dis-${r.id}`,
      kind: "discarded",
      ts: toIso(r.ts) ?? new Date(0).toISOString(),
      title: clip(r.title),
      detail: `${r.noise_stage === "prefilter" ? "rules" : "harness"} · ${clip(
        r.discard_reason?.split(":")[0] ?? r.noise_stage,
        44,
      )}${r.noise_score !== null && r.noise_score !== undefined ? ` · score ${(r.noise_score as number).toFixed(2)}` : ""}`,
      url: null,
      node: r.noise_stage === "prefilter" ? "prefilter_discards" : "harness_discards",
    });
  }
  for (const r of winners) {
    out.push({
      id: `win-${r.id}`,
      kind: "kept",
      ts: toIso(r.ts) ?? new Date(0).toISOString(),
      title: clip(r.entity_name ?? r.title),
      detail: `published · ${[r.primary_tag].filter(Boolean).join(" · ")}`,
      url: null,
      node: "winners",
    });
  }
  return out;
}

async function factAndSourceEvents(db: Db): Promise<ExoActivity[]> {
  const facts = await db.execute<Record<string, unknown>>(sql`
    SELECT f.id, f.type, f.payload, f.status, f.created_at, e.canonical_name
    FROM facts f JOIN entities e ON e.id = f.entity_id
    ORDER BY f.created_at DESC LIMIT 6
  `);
  const srcEvents = await db.execute<Record<string, unknown>>(sql`
    SELECT se.id, se.event, se.reason, se.created_at, s.name
    FROM source_events se LEFT JOIN sources s ON s.id = se.source_id
    ORDER BY se.created_at DESC LIMIT 6
  `);
  const out: ExoActivity[] = [];
  for (const f of facts) {
    const payload = (f.payload ?? {}) as Record<string, unknown>;
    const amount = payload["amount_usd_est"];
    out.push({
      id: `fact-${String(f.id)}`,
      kind: "fact",
      ts: toIso(f.created_at) ?? new Date(0).toISOString(),
      title: `${String(f.type).replace(/_/g, " ")} · ${clip(f.canonical_name, 40)}`,
      detail: [
        typeof amount === "number" ? `~$${Math.round(amount / 100000) / 10}M` : null,
        payload["funding_stage"] ?? null,
        String(f.status),
      ]
        .filter(Boolean)
        .join(" · "),
      url: null,
      node: "facts",
    });
  }
  for (const s of srcEvents) {
    out.push({
      id: `sev-${String(s.id)}`,
      kind: "source_event",
      ts: toIso(s.created_at) ?? new Date(0).toISOString(),
      title: `${String(s.event)} · ${clip(s.name ?? "?", 40)}`,
      detail: clip(s.reason, 80),
      url: null,
      node: "sources",
    });
  }
  return out;
}

async function sideChannels(db: Db): Promise<ExoSideChannels> {
  const launches = await db.execute<Record<string, unknown>>(sql`
    SELECT COALESCE(platform_meta->>'surface', 'other') AS surface, COUNT(*)::int AS n
    FROM articles
    WHERE platform_meta IS NOT NULL AND created_at >= now() - interval '24 hours'
    GROUP BY 1 ORDER BY 2 DESC
  `);
  const formd = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM articles
    WHERE platform_meta->>'formd' IS NOT NULL AND created_at >= now() - interval '24 hours'
  `);
  return {
    launches_by_surface_24h: launches.map((r) => ({ surface: String(r.surface), n: num(r.n) })),
    formd_facts_24h: Number(formd[0]?.n ?? 0),
  };
}

const STAGE_LIST_NODES = new Set([
  "src_rss",
  "src_gdelt",
  "src_search",
  "src_launch",
  "src_formd",
  "raw",
  "fetch",
  "prefilter",
  "dedupe",
  "waiting_room",
  "harness",
  "winners",
  "facts",
  "webhooks",
  "fetch_failed",
  "prefilter_discards",
  "harness_discards",
]);

function itemFromArticle(r: Record<string, unknown>): ExoStageItem {
  const reason = r.discard_reason ? clip(r.discard_reason, 80) : null;
  const pub = r.publisher_domain ? String(r.publisher_domain) : null;
  return {
    id: String(r.id),
    title: clip(r.title),
    detail: [pub, reason].filter(Boolean).join(" · ") || null,
    ts: toIso(r.ts) ?? new Date(0).toISOString(),
    url: r.url ? String(r.url) : null,
  };
}

/**
 * Items currently sitting in (or most recently through) a diagram node.
 * Holding stages list live rows; pass-through stages fall back to traces.
 */
export async function listStageItems(db: Db, node: string, limit = 40): Promise<ExoStageList> {
  const lim = Math.min(80, Math.max(1, Math.floor(limit)));
  if (!STAGE_LIST_NODES.has(node)) return { node, count: 0, items: [] };

  const counted = async (
    countSql: ReturnType<typeof sql>,
    itemsSql: ReturnType<typeof sql>,
    map: (r: Record<string, unknown>) => ExoStageItem,
  ): Promise<ExoStageList> => {
    const [countRows, itemRows] = await Promise.all([
      db.execute<{ n: number }>(countSql),
      db.execute<Record<string, unknown>>(itemsSql),
    ]);
    return { node, count: Number(countRows[0]?.n ?? 0), items: itemRows.map(map) };
  };

  switch (node) {
    case "raw":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM raw_items WHERE fetch_state = 'pending'`,
        sql`SELECT id, title, url, discovered_via, created_at AS ts FROM raw_items
            WHERE fetch_state = 'pending' ORDER BY created_at DESC LIMIT ${lim}`,
        (r) => ({
          id: String(r.id),
          title: clip(r.title ?? r.url),
          detail: String(r.discovered_via ?? ""),
          ts: toIso(r.ts) ?? new Date(0).toISOString(),
          url: r.url ? String(r.url) : null,
        }),
      );
    case "src_rss":
    case "src_gdelt":
    case "src_search": {
      const channel = node === "src_rss" ? "rss" : node === "src_gdelt" ? "gdelt" : "search";
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM raw_items WHERE discovered_via = ${channel} AND created_at >= now() - interval '24 hours'`,
        sql`SELECT id, title, url, fetch_state, created_at AS ts FROM raw_items
            WHERE discovered_via = ${channel} ORDER BY created_at DESC LIMIT ${lim}`,
        (r) => ({
          id: String(r.id),
          title: clip(r.title ?? r.url),
          detail: String(r.fetch_state ?? ""),
          ts: toIso(r.ts) ?? new Date(0).toISOString(),
          url: r.url ? String(r.url) : null,
        }),
      );
    }
    case "src_launch":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE platform_meta IS NOT NULL AND created_at >= now() - interval '24 hours'`,
        sql`SELECT id, title, url, publisher_domain, created_at AS ts FROM articles
            WHERE platform_meta IS NOT NULL ORDER BY created_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "src_formd":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE platform_meta->>'formd' IS NOT NULL AND created_at >= now() - interval '24 hours'`,
        sql`SELECT id, title, url, publisher_domain, created_at AS ts FROM articles
            WHERE platform_meta->>'formd' IS NOT NULL ORDER BY created_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "fetch":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM pgboss.job WHERE name = 'fetch-article' AND state IN ('created', 'active')`,
        sql`SELECT COALESCE(r.id, j.data->>'rawItemId', j.id::text) AS id,
                   COALESCE(r.title, r.url, j.data->>'rawItemId', 'queued fetch') AS title,
                   r.url, j.created_on AS ts
            FROM pgboss.job j
            LEFT JOIN raw_items r ON r.id = j.data->>'rawItemId'
            WHERE j.name = 'fetch-article' AND j.state IN ('created', 'active')
            ORDER BY j.created_on DESC LIMIT ${lim}`,
        (r) => ({
          id: String(r.id),
          title: clip(r.title ?? r.id),
          detail: "in fetch queue",
          ts: toIso(r.ts) ?? new Date(0).toISOString(),
          url: r.url ? String(r.url) : null,
        }),
      );
    case "prefilter":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles a
            WHERE a.noise_stage = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM pgboss.job j
                WHERE j.name = 'filter-article' AND j.state = 'active'
                  AND j.data->>'articleId' = a.id
              )`,
        sql`SELECT a.id, a.title, a.url, a.publisher_domain, a.created_at AS ts FROM articles a
            WHERE a.noise_stage = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM pgboss.job j
                WHERE j.name = 'filter-article' AND j.state = 'active'
                  AND j.data->>'articleId' = a.id
              )
            ORDER BY a.created_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "dedupe":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE discard_reason LIKE 'title_duplicate_of%' AND updated_at >= now() - interval '24 hours'`,
        sql`SELECT id, title, url, publisher_domain, discard_reason, updated_at AS ts FROM articles
            WHERE discard_reason LIKE 'title_duplicate_of%' ORDER BY updated_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "waiting_room":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE noise_stage = 'waiting'`,
        sql`SELECT id, title, url, publisher_domain, discard_reason, created_at AS ts FROM articles
            WHERE noise_stage = 'waiting' ORDER BY created_at ASC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "harness": {
      const [jobRows, statusRows] = await Promise.all([
        db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM pgboss.job WHERE name = 'harness-run' AND state IN ('created', 'active')`),
        db.execute<Record<string, unknown>>(sql`
          SELECT value->>'startedAt' AS started_at,
                 value->'lastRun'->>'published' AS published,
                 value->'lastRun'->>'scanned' AS scanned,
                 value->'lastRun'->>'skip_reason' AS skip_reason
          FROM kv_state WHERE key = 'harness_run' LIMIT 1`),
      ]);
      const st = statusRows[0] ?? {};
      const lastRun = st.skip_reason
        ? `last run · ${clip(st.scanned ?? 0)} scanned, skipped (${String(st.skip_reason)})`
        : st.published !== null && st.published !== undefined
          ? `last run · ${clip(st.scanned ?? 0)} scanned, ${st.published} published`
          : "never run";
      return {
        node,
        count: Number(jobRows[0]?.n ?? 0),
        items: [
          {
            id: "harness-run",
            title: lastRun,
            detail: st.started_at ? `started ${toIso(st.started_at)}` : "manual trigger",
            ts: toIso(st.started_at) ?? new Date(0).toISOString(),
            url: null,
          },
        ],
      };
    }
    case "winners":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE noise_stage = 'kept' AND updated_at >= now() - interval '24 hours'`,
        sql`SELECT a.id, a.title, a.url, a.publisher_domain,
                   COALESCE(e.canonical_name, '') || CASE WHEN e.canonical_name IS NOT NULL THEN ' · published' ELSE ' · published (unresolved)' END AS discard_reason,
                   a.updated_at AS ts
            FROM articles a
            LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
            LEFT JOIN entities e ON e.id = ae.entity_id
            WHERE a.noise_stage = 'kept' ORDER BY a.updated_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "prefilter_discards":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE noise_stage = 'prefilter'`,
        sql`SELECT id, title, url, publisher_domain, discard_reason, updated_at AS ts FROM articles
            WHERE noise_stage = 'prefilter' ORDER BY updated_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "harness_discards":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM articles WHERE noise_stage = 'llm_filter'`,
        sql`SELECT id, title, url, publisher_domain, discard_reason, updated_at AS ts FROM articles
            WHERE noise_stage = 'llm_filter' ORDER BY updated_at DESC LIMIT ${lim}`,
        itemFromArticle,
      );
    case "fetch_failed":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM raw_items WHERE fetch_state = 'failed'`,
        sql`SELECT id, title, url, fetch_error, discovered_via, created_at AS ts FROM raw_items
            WHERE fetch_state = 'failed' ORDER BY created_at DESC LIMIT ${lim}`,
        (r) => ({
          id: String(r.id),
          title: clip(r.title ?? r.url),
          detail: clip(r.fetch_error ?? r.discovered_via, 100),
          ts: toIso(r.ts) ?? new Date(0).toISOString(),
          url: r.url ? String(r.url) : null,
        }),
      );
    case "facts":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM facts WHERE created_at >= now() - interval '24 hours'`,
        sql`SELECT f.id, f.type, f.status, e.canonical_name, f.created_at AS ts
            FROM facts f JOIN entities e ON e.id = f.entity_id
            ORDER BY f.created_at DESC LIMIT ${lim}`,
        (r) => ({
          id: String(r.id),
          title: `${String(r.type).replace(/_/g, " ")} · ${clip(r.canonical_name, 50)}`,
          detail: String(r.status ?? ""),
          ts: toIso(r.ts) ?? new Date(0).toISOString(),
          url: null,
        }),
      );
    case "webhooks":
      return counted(
        sql`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE status = 'pending'`,
        sql`SELECT id, status, created_at AS ts FROM webhook_deliveries
            ORDER BY created_at DESC LIMIT ${lim}`,
        (r) => ({
          id: String(r.id),
          title: `delivery ${String(r.id).slice(0, 18)}`,
          detail: String(r.status ?? ""),
          ts: toIso(r.ts) ?? new Date(0).toISOString(),
          url: null,
        }),
      );
    default:
      break;
  }

  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT ref_id, label, detail, created_at
    FROM pipeline_traces
    WHERE node = ${node} AND created_at >= now() - interval '2 hours'
    ORDER BY created_at DESC
    LIMIT ${lim}
  `);
  return {
    node,
    count: rows.length,
    items: rows.map((r) => ({
      id: String(r.ref_id),
      title: clip(r.label ?? r.ref_id),
      detail: r.detail === null || r.detail === undefined ? null : clip(r.detail, 160),
      ts: toIso(r.created_at) ?? new Date(0).toISOString(),
      url: null,
    })),
  };
}

export async function buildExoskeletonSnapshot(db: Db, router: LlmRouter): Promise<ExoskeletonSnapshot> {
  const started = Date.now();
  const [sources, inbound, stages, harness, reasons, hourly, queues, webhooks, entities, sides, budget, costs, blended, degrades] =
    await Promise.all([
      sourceSummary(db),
      inboundSnapshot(db),
      stageSnapshot(db),
      harnessSnapshot(db),
      discardReasons(db),
      hourlyFlow(db),
      queueDepths(db),
      webhookSnapshot(db),
      entitySnapshot(db),
      sideChannels(db),
      router.budgetStatus(),
      stageCostBreakdown(db),
      blendedArticleCost(db),
      recentPipelineEvents(db, 5),
    ]);
  void cleanupOldTraces(db);

  const [articleActs, factSrcActs] = await Promise.all([
    recentArticleEvents(db),
    factAndSourceEvents(db),
  ]);
  const activity: ExoActivity[] = [...inbound.recent, ...articleActs, ...factSrcActs]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 80);

  return {
    ts: new Date().toISOString(),
    build_ms: Date.now() - started,
    sources,
    inbound,
    stages,
    harness,
    discard_reasons_24h: reasons,
    hourly_24h: hourly,
    queues,
    webhooks,
    entities,
    side_channels: sides,
    llm: {
      budget: {
        month: budget.month,
        spent_usd: budget.spentUsd,
        cap_usd: budget.capUsd,
        soft_limit_usd: budget.softLimitUsd,
        classify_only_mode: budget.classifyOnlyMode,
      },
      stages: costs,
      blended_article_cost_usd: blended,
      degrade_events: degrades,
    },
    activity,
  };
}

/** Waiting-room occupancy + last/running harness run state. */
async function harnessSnapshot(db: Db): Promise<ExoHarness> {
  const [status, oldest] = await Promise.all([
    harnessStatus(db),
    db.execute<{ oldest: unknown }>(sql`
      SELECT MIN(created_at) AS oldest FROM articles WHERE noise_stage = 'waiting'
    `),
  ]);
  return {
    running_now: status.running_now,
    last_run: status.last_run,
    batch_limit: getFilters().harness?.max_batch ?? 120,
    llm_provider: getConfig().LLM_PROVIDER,
    oldest_waiting_at: toIso(oldest[0]?.oldest ?? null),
  };
}

// ------------------------------------------------------------- shared caching
const CACHE_TTL_MS = 1500;
let cache: { at: number; snap: ExoskeletonSnapshot } | null = null;
let inflight: Promise<ExoskeletonSnapshot> | null = null;

/**
 * Cached snapshot shared by every SSE client + REST polls. A single in-flight
 * build prevents query stampedes when multiple tabs stream concurrently.
 */
export function invalidateExoskeletonCache(): void {
  cache = null;
}

export async function getExoskeletonSnapshot(db: Db, router: LlmRouter): Promise<ExoskeletonSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.snap;
  if (!inflight) {
    inflight = buildExoskeletonSnapshot(db, router)
      .then((snap) => {
        cache = { at: Date.now(), snap };
        return snap;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
