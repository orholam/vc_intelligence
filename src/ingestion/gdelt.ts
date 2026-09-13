import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { domainLists, entities, gdeltQueries, rawItems } from "../db/schema.js";
import { canonicalizeUrl, hostToDomain, sha256Hex, urlHash as computeUrlHash } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { recordTrace } from "../ops/traces.js";
import { getFilters } from "../config-files.js";
import { parseLooseDate } from "../lib/text.js";
import { knownPublisherDomains } from "./rss.js";

/**
 * GDELT DOC 2.0 recall backbone (FR-3). Polls every 15 min for English
 * articles matching the monitored-entity watchlist plus configured topic
 * queries; full-text fetch is enqueued only for unseen URLs whose domain
 * passes the quality allowlist/blocklist.
 */

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

const ArticleListResponse = z.object({
  articles: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().optional(),
        seendate: z.string().optional(),
        socialimage: z.string().optional(),
        domain: z.string().optional(),
        language: z.string().optional(),
        sourcecountry: z.string().optional(),
      }),
    )
    .default([]),
});

export interface GdeltHit {
  url: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
}

export async function queryGdelt(
  query: string,
  opts: { maxRecords?: number; timespan?: string } = {},
): Promise<GdeltHit[]> {
  try {
    return await queryGdeltOnce(query, opts);
  } catch (e) {
    if (e instanceof GdeltRateLimitedError) throw e;
    return queryGdeltOnce(query, opts);
  }
}

export class GdeltRateLimitedError extends Error {
  constructor() {
    super("gdelt http 429");
  }
}

function formatTimespan(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 90) return `${Math.round(minutes / 60)}h`;
  return `${Math.max(15, Math.ceil(minutes))}min`;
}

async function queryGdeltOnce(
  query: string,
  opts: { maxRecords?: number; timespan?: string } = {},
): Promise<GdeltHit[]> {
  const url = new URL(GDELT_DOC_URL);
  url.searchParams.set("query", `${query} sourcelang:english`);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("maxrecords", String(Math.min(opts.maxRecords ?? 75, 250)));
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  if (opts.timespan) url.searchParams.set("timespan", opts.timespan);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json" },
    });
  } catch {
    await new Promise((r) => setTimeout(r, 2500));
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json" },
    });
  }
  if (res.status === 429) throw new GdeltRateLimitedError();
  if (!res.ok) throw new Error(`gdelt http ${res.status}`);
  const text = await res.text();
  if (!text.trimStart().startsWith("{")) {
    // GDELT emits plain-text errors (e.g. "Queries cannot exceed ...")
    throw new Error(`gdelt: ${text.slice(0, 140)}`);
  }
  const parsed = ArticleListResponse.parse(JSON.parse(text));
  return parsed.articles.map((a) => ({
    url: a.url,
    title: a.title,
    seendate: a.seendate,
    domain: a.domain,
    language: a.language,
  }));
}

/** Domain quality gate (FR-3): blocklist always wins; optional allowlist mode. */
export async function domainPassesQualityGate(db: Db, rawDomain: string): Promise<boolean> {
  const cfgFilters = getFilters();
  const domain = hostToDomain(rawDomain);
  const rows = await db.select().from(domainLists).where(eq(domainLists.domain, domain)).limit(1);
  const entry = rows[0];
  if (entry?.list === "block") return false;
  if (!cfgFilters.gdelt.fetch_only_allowlisted_or_known_publishers) return true;
  if (entry?.list === "allow") return true;
  const known = await knownPublisherDomains(db);
  return known.has(domain);
}

async function insertGdeltItem(db: Db, hit: GdeltHit): Promise<boolean> {
  const canon = canonicalizeUrl(hit.url);
  const inserted = await db
    .insert(rawItems)
    .values({
      id: opaqueId("rit"),
      discoveredVia: "gdelt",
      url: canon,
      urlHash: sha256Hex(canon),
      guidHash: undefined,
      title: hit.title?.slice(0, 500) ?? null,
      publishedAt: parseLooseDate(hit.seendate) ?? new Date(),
      gdeltMeta: {
        seendate: hit.seendate,
        ...(hit.domain ? { sourceDomain: hostToDomain(hit.domain) } : {}),
        language: hit.language ?? "en",
      },
    })
    .onConflictDoNothing()
    .returning({ id: rawItems.id });
  if (inserted.length) {
    void recordTrace(db, {
      node: "raw",
      refId: inserted[0]!.id,
      kind: "raw",
      label: hit.title ?? undefined,
      detail: `GDELT · ${hit.domain ? hostToDomain(hit.domain) : "unknown"}`,
    });
  }
  return inserted.length > 0;
}

export interface GdeltPollResult {
  queriesRun: number;
  hitsSeen: number;
  inserted: number;
  blockedDomains: number;
  errors: string[];
}

/** One GDELT sweep over watchlist + topic queries. */
export async function pollGdelt(
  db: Db,
  opts: { timespanMinutes?: number } = {},
): Promise<GdeltPollResult> {
  const cfg = getConfig();
  void cfg;
  const filters = getFilters();
  const maxPerQuery = filters.gdelt.max_records_per_query;
  const result: GdeltPollResult = {
    queriesRun: 0,
    hitsSeen: 0,
    inserted: 0,
    blockedDomains: 0,
    errors: [],
  };

  // Build per-entity queries from the monitored watchlist (FR-3).
  // Coverage-seeking order + per-tick cap: with a large watchlist the full
  // OR-batch set exceeds GDELT's rate budget and every tick aborted on 429
  // before later batches ever ran (queriesRun=0), silently starving exactly
  // the uncovered cohort. Prioritize least-recently-covered entities and cap
  // batches so ticks complete inside the rate budget; covered entities sink
  // until their coverage goes stale again.
  const maxEntities = filters.gdelt.max_entities_per_poll ?? 400;
  const monitored = await db
    .select({ id: entities.id, name: entities.canonicalName, website: entities.website })
    .from(entities)
    .where(eq(entities.isMonitored, true))
    .orderBy(sql`
      COALESCE((SELECT MAX(a.published_at) FROM article_entities ae
        JOIN articles a ON a.id = ae.article_id AND a.noise_stage = 'kept'
        WHERE ae.entity_id = ${entities.id}), to_timestamp(0)) ASC,
      created_at ASC
    `)
    .limit(maxEntities);

  const topics = await db
    .select()
    .from(gdeltQueries)
    .where(eq(gdeltQueries.active, true));

  const timespan =
    opts.timespanMinutes != null ? formatTimespan(Math.ceil(opts.timespanMinutes * 1.25)) : undefined;

  // Batch the watchlist so N entities cost far fewer API calls. GDELT DOC 2.0
  // enforces a ~256-char query limit and rate-limits per minute, so pack as
  // many OR'd alternatives as fit under the length budget.
  const MAX_QUERY_CHARS = 225; // headroom under GDELT's 256 incl. " sourcelang:english"
  const entityQueries: string[] = [];
  let alts: string[] = [];
  const flush = () => {
    if (!alts.length) return;
    entityQueries.push(`(${alts.join(" OR ")})`);
    alts = [];
  };
  const MIN_TERM_CHARS = 3; // GDELT rejects shorter phrases
  for (const m of monitored) {
    for (const alt of [m.name, ...(m.website ? [m.website] : [])]) {
      if (!alt || alt.trim().length < MIN_TERM_CHARS) continue;
      const candidate = `"${alt}"`;
      const projected = [...alts, candidate].join(" OR ").length + 2;
      if (projected > MAX_QUERY_CHARS && alts.length) flush();
      alts.push(candidate);
      if (candidate.length > MAX_QUERY_CHARS) flush(); // oversized single term
    }
  }
  flush();

  interface JobSpec {
    key: string;
    query: string;
    id?: string;
  }
  const specs: JobSpec[] = [
    ...entityQueries.map((q, i) => ({ key: `entities:${i}`, query: q })),
    ...topics.map((t) => ({ key: `topic:${t.query}`, id: t.id, query: t.query })),
  ];

  let consecutive429 = 0;
  const maxConsecutive429 = filters.gdelt.abort_after_consecutive_429 ?? 3;
  // GDELT enforces "one request every 5 seconds" — a fixed 1.2s gap fired
  // batches back-to-back and every tick aborted on 429 before covering the
  // watchlist. Honor the published interval between request STARTS.
  const minIntervalMs = filters.gdelt.min_query_interval_ms ?? 5500;
  let lastRequestAt = 0;

  for (const spec of specs) {
    if (consecutive429 >= maxConsecutive429) {
      result.errors.push(`aborted after ${consecutive429} consecutive 429s; resumes next tick`);
      break;
    }
    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < minIntervalMs) {
      await new Promise((r) => setTimeout(r, minIntervalMs - sinceLast));
    }
    lastRequestAt = Date.now();
    try {
      const arts = await queryGdelt(spec.query, { maxRecords: maxPerQuery, timespan });
      consecutive429 = 0;
      result.queriesRun++;
      for (const art of arts) {
        result.hitsSeen++;
        const domain = art.domain ?? hostToDomain(art.url);
        if (!(await domainPassesQualityGate(db, domain))) {
          result.blockedDomains++;
          continue;
        }
        const exists = await db.execute(sql`SELECT 1 FROM raw_items WHERE url_hash = ${computeUrlHash(art.url)} LIMIT 1`);
        if (exists.length > 0) continue; // already captured
        if (await insertGdeltItem(db, { ...art, domain })) result.inserted++;
      }
      if (spec.id) {
        await db
          .update(gdeltQueries)
          .set({ lastPolledAt: new Date() })
          .where(eq(gdeltQueries.id, spec.id));
      }
    } catch (e) {
      const msg = (e as Error).message;
      result.errors.push(`${spec.key}: ${msg}`);
      if (e instanceof GdeltRateLimitedError) consecutive429++;
      else logger.warn({ query: spec.key, err: msg }, "gdelt sub-query failed");
      if (consecutive429 > 0) {
        // back off well beyond the per-minute window
        await new Promise((r) => setTimeout(r, 20_000 * consecutive429));
      }
    }
  }
  return result;
}
