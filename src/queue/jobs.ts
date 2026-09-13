import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { getCompanyProfileConfig, getFilters } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articles, rawItems, sources } from "../db/schema.js";
import { sha256Hex, canonicalizeUrl, hostToDomain } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { excerpt } from "../lib/text.js";
import { extractFromHtml } from "../ingestion/extract.js";
import { ingestFormDFilings } from "../ingestion/formd.js";
import { ingestLaunchSurfaces } from "../ingestion/launches.js";
import { fetchWithRetry, politeFetch } from "../ingestion/fetcher.js";
import { isGoogleNewsWrapper, resolveGoogleNewsUrl } from "../ingestion/googlenews.js";
import { pollFeed } from "../ingestion/rss.js";
import type { SourceRegistry } from "../sources/registry.js";
import { pollGdelt } from "../ingestion/gdelt.js";
import { prefilter } from "../filtering/prefilter.js";
import { backfillEntityBaselines } from "../entities/baseline.js";
import { dueProfileEntities, generateEntityProfile } from "../entities/profile.js";
import { harnessStatus, runHarness } from "../harness/run.js";
import { refuseHarnessWithoutModel } from "../llm/router.js";
import { runSourceLifecycleTick } from "../sources/lifecycle.js";
import { rollupFunnelDay } from "../ops/funnel.js";
import { recordTrace } from "../ops/traces.js";
import { ghostArticleHtml, isGhostUrl } from "../ops/ghost.js";
import { processDueDeliveries } from "../webhooks/deliver.js";
import type { LlmRouter } from "../llm/router.js";
import type { Storage } from "../storage.js";
import type { Boss } from "./boss.js";

/**
 * Pipeline job definitions (pg-boss on Postgres; no Redis/Kafka per §3).
 * Every handler is idempotent under at-least-once delivery: content-hash
 * unique indexes + stage guards make replays safe (NFR-3).
 *
 * PROGRAMMATIC ONLY: everything here is deterministic and LLM-free. Items
 * that survive rules-prefilter + wire-dedupe park in the waiting room
 * (`articles.noise_stage = 'waiting'`) until an operator fires the harness
 * (QUEUE.harnessRun → runHarness) which performs the single batched LLM job
 * (batch audit of the waiting-room pile → story match → per-company deep
 * search → card updates) and publishes survivors to /latest. The one other
 * LLM-touching worker — QUEUE.companyProfileTick — backfills deep profiles
 * for companies the harness's bounded new-entity pass didn't reach, and
 * refuses to run when auto has no real model (same publish-path rule).
 */
export const QUEUE = {
  rssPollTick: "rss-poll-tick",
  fetchFeed: "fetch-feed",
  gdeltPollTick: "gdelt-poll-tick",
  formdPollTick: "formd-poll-tick",
  launchPollTick: "launch-poll-tick",
  fetchArticle: "fetch-article",
  filterArticle: "filter-article",
  harnessRun: "harness-run",
  companyProfileTick: "company-profile-tick",
  webhookSweep: "webhook-sweep",
  retentionSweep: "retention-sweep",
  // R02/R04/R06/R10/R13 invariant machinery (LLM-free):
  funnelRollup: "funnel-rollup",
  sourceLifecycleTick: "source-lifecycle-tick",
  entityBackfillTick: "entity-backfill-tick",
} as const;

export const ALL_QUEUES = Object.values(QUEUE);

export interface PipelineDeps {
  db: Db;
  registry: SourceRegistry;
  router: LlmRouter;
  storage: Storage;
  /** Optional search-index extraction fallback for bot-blocked pages. */
  keenable?: {
    fetchMarkdown(url: string): Promise<{ title: string | null; text: string } | null>;
  };
}

// ------------------------------------------------------------------ handlers
export async function handleRssPollTick(deps: PipelineDeps): Promise<string[]> {
  const due = await deps.registry.dueSources(200);
  return due.map((s) => s.id);
}

export async function handleFetchFeed(
  deps: PipelineDeps,
  sourceId: string,
): Promise<{ insertedIds: string[] }> {
  const [source] = await deps.db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source || !source.active) return { insertedIds: [] };
  const result = await pollFeed(deps.db, deps.registry, source);
  for (const rawItemId of result.insertedIds) {
    void recordTrace(deps.db, { node: "raw", refId: rawItemId, kind: "raw", detail: `rss · ${source.name}` });
  }
  logger.info(
    { sourceId, seen: result.seen, inserted: result.inserted },
    "feed polled",
  );
  return { insertedIds: result.insertedIds };
}

/** FR-3/FR-4: fetch + extract full text for a discovered raw item. */
export async function handleFetchArticle(
  deps: PipelineDeps,
  rawItemId: string,
): Promise<{ articleId?: string }> {
  const [item] = await deps.db.select().from(rawItems).where(eq(rawItems.id, rawItemId)).limit(1);
  if (!item || item.fetchState === "fetched") return {};

  // Google News RSS feeds hand out redirect wrappers, not publisher URLs.
  // Resolve to the real article first: the wrapper page is robots-disallowed
  // (fetching it would park every gn-* item as blocked) and extraction on it
  // yields nothing. The resolved URL is persisted so dedup + reconciliation
  // see the publisher identity.
  let targetUrl = item.url;
  if (isGoogleNewsWrapper(targetUrl)) {
    try {
      const resolved = await resolveGoogleNewsUrl(targetUrl);
      if (!resolved || !/^https?:\/\//i.test(resolved)) {
        throw new Error("google news wrapper unresolved");
      }
      const cUrl = canonicalizeUrl(resolved);
      const newHash = sha256Hex(cUrl);
      const dup = await deps.db
        .select({ id: rawItems.id, title: rawItems.title })
        .from(rawItems)
        .where(eq(rawItems.urlHash, newHash))
        .limit(1);
      if (dup.length && dup[0]!.id !== rawItemId) {
        await deps.db
          .update(rawItems)
          .set({ fetchState: "fetched", fetchError: "duplicate_url_hash" })
          .where(eq(rawItems.id, rawItemId));
        void recordTrace(deps.db, {
          node: "dedupe",
          refId: rawItemId,
          kind: "raw",
          label: item.title,
          detail: traceDupDetail({
            reason: "url",
            dupTitle: dup[0]!.title ?? null,
            extra: "gn-resolved URL matches an earlier item",
          }),
        });
        return {};
      }
      await deps.db
        .update(rawItems)
        .set({ url: cUrl, urlHash: newHash })
        .where(eq(rawItems.id, rawItemId));
      targetUrl = cUrl;
    } catch (e) {
      // Transient Google flakiness must not burn the article: mirror the
      // network-error path — one job-level retry, then park with the error.
      if (/robots/i.test((e as Error).message)) {
        await markFetchFailed(deps.db, rawItemId, e as Error);
        return {};
      }
      const attempts = item.fetchAttempts + 1;
      if (attempts >= 2) {
        await markFetchFailed(deps.db, rawItemId, e as Error);
        return {};
      }
      await deps.db
        .update(rawItems)
        .set({ fetchAttempts: attempts })
        .where(eq(rawItems.id, rawItemId));
      throw e;
    }
  }

  let page;
  if (isGhostUrl(item.url)) {
    // Ops-console debug probes: never hit the network; canned HTML still
    // runs the real extract → filter → resolve → enrich chain.
    page = {
      url: item.url,
      finalUrl: item.url,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      body: ghostArticleHtml({
        title: item.title ?? "Ghost Probe Labs raises $12 million Series A",
        publishedAt: item.publishedAt ?? new Date(),
      }),
    };
  } else {
    try {
      page = await fetchWithRetry(targetUrl);
      if (page.status >= 400) throw new Error(`http ${page.status}`);
    } catch (e) {
      if (/robots/i.test((e as Error).message)) {
        await markFetchFailed(deps.db, rawItemId, e as Error);
        return {};
      }
      // retry once via rethrow (job-level retryLimit=1); then dead-letter
      const attempts = item.fetchAttempts + 1;
      if (attempts >= 2) {
        await markFetchFailed(deps.db, rawItemId, e as Error);
        return {};
      }
      await deps.db
        .update(rawItems)
        .set({ fetchAttempts: attempts })
        .where(eq(rawItems.id, rawItemId));
      throw e;
    }
  }

  let extracted = extractFromHtml(page.body, page.finalUrl);

  // Bot-blocked / empty extraction -> search-index markdown fallback (FR-4
  // coverage aid), never for robots-blocked hosts.
  if ((!extracted || extracted.charCount < 80) && deps.keenable) {
    try {
      const md = await deps.keenable.fetchMarkdown(targetUrl);
      if (md && md.text.length >= 200) {
        extracted = {
          title: md.title ?? item.title ?? page.finalUrl,
          byline: null,
          publishedAt: item.publishedAt ?? null,
          textContent: md.text.replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/[#>*_`|]/g, " ").replace(/\s+/g, " ").trim(),
          charCount: md.text.length,
          language: "en",
          outlinkDomains: [...new Set((md.text.match(/https?:\/\/[^)\s"']+/g) ?? [])
            .map((u) => { try { return hostToDomain(new URL(u).hostname); } catch { return ""; } })
            .filter(Boolean))].slice(0, 40),
          ogMetadata: {},
        };
      }
    } catch (e) {
      logger.debug({ err: (e as Error).message }, "keenable fallback unavailable");
    }
  }

  if (!extracted || extracted.charCount < 80) {
    await markFetchFailed(deps.db, rawItemId, new Error("extraction produced no usable text"));
    return {};
  }
  const urlHash = sha256Hex(canonicalizeUrl(page.finalUrl));
  const articleId = opaqueId("art");
  // Origin-aware staleness: RSS feeds may legitimately lag days; a GDELT or
  // web-search hit whose page-date lags its (just-now) indexing is an
  // evergreen resurface, not delayed news.
  const ageLimit =
    item.discoveredVia === "rss" || item.discoveredVia === "manual"
      ? (getFilters().prefilter.max_article_age_days ?? 45)
      : (getFilters().prefilter.max_article_age_days_discovered ?? 3);
  const dated = resolveIngestPublishedAt(extracted.publishedAt ?? item.publishedAt ?? null, Date.now(), ageLimit);
  if (!dated.ok) {
    // Stale resurface (GDELT/search re-indexing old pages) — R04 auditable
    // consumed-with-reason, never silently vanished.
    await deps.db
      .update(rawItems)
      .set({ fetchState: "fetched", fetchError: `stale_publish_date:${dated.publishedAt.toISOString().slice(0, 10)}` })
      .where(eq(rawItems.id, rawItemId));
    void recordTrace(deps.db, {
      node: "prefilter_discards",
      refId: rawItemId,
      kind: "raw",
      label: item.title,
      detail: `stale_publish_date · ${item.discoveredVia}`,
    });
    return {};
  }
  const publishedAt = dated.publishedAt;
  const inserted = await deps.db
    .insert(articles)
    .values({
      id: articleId,
      rawItemId: item.id,
      sourceId: item.sourceId,
      url: canonicalizeUrl(page.finalUrl),
      urlHash,
      publisherDomain: hostToDomain(new URL(page.finalUrl).hostname),
      title: extracted.title || item.title || page.finalUrl,
      byline: extracted.byline,
      publishedAt,
      language: extracted.language || item.gdeltMeta?.language || "en",
      outlinkDomains: extracted.outlinkDomains,
      ogMetadata: extracted.ogMetadata,
      noiseStage: "pending",
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: articles.urlHash })
    .returning({ id: articles.id });

  if (!inserted.length) {
    // duplicate article — mark raw consumed with an auditable marker
    // (R04 reconciliation counts these as duplicate_consumed, not vanished)
    const [existingDup] = await deps.db
      .select({
        title: articles.title,
        publisherDomain: articles.publisherDomain,
        publishedAt: articles.publishedAt,
      })
      .from(articles)
      .where(eq(articles.urlHash, urlHash))
      .limit(1);
    await deps.db
      .update(rawItems)
      .set({ fetchState: "fetched", fetchError: "duplicate_url_hash" })
      .where(eq(rawItems.id, rawItemId));
    void recordTrace(deps.db, {
      node: "dedupe",
      refId: rawItemId,
      kind: "raw",
      label: item.title,
      detail: traceDupDetail({
        reason: "url",
        dupTitle: existingDup?.title ?? null,
        dupDomain: existingDup?.publisherDomain ?? null,
        dupDate: dateOnly(existingDup?.publishedAt),
      }),
    });
    return {};
  }

  const textPath = `articles/${articleId}.txt`;
  const storedRef = await deps.storage.put(textPath, extracted.textContent);
  await deps.db
    .update(articles)
    .set({
      extractedTextPath: storedRef,
      extractedTextChars: extracted.charCount,
      extractedTextHash: sha256Hex(extracted.textContent),
      excerptText: excerpt(extracted.textContent, 400),
    })
    .where(eq(articles.id, articleId));

  await deps.db
    .update(rawItems)
    .set({ fetchState: "fetched", fetchError: null })
    .where(eq(rawItems.id, rawItemId));

  void recordTrace(deps.db, {
    node: "fetch",
    refId: rawItemId,
    kind: "article",
    label: extracted.title || item.title || undefined,
    detail: hostToDomain(new URL(page.finalUrl).hostname),
  });
  return { articleId };
}

/**
 * Human-readable "what did it duplicate against?" for the feed: names the
 * pre-existing copy (title, outlet, first-seen date) and which outlet the
 * cut copy came from. The machine reason (`title_duplicate_of:<id>`) stays
 * on the row's discard_reason for reconciliation; the trace detail is for
 * people, so it mentions the original — not the raw id.
 */
function traceDupDetail(opts: {
  reason: "title" | "url";
  dupTitle?: string | null;
  dupDomain?: string | null;
  dupDate?: string | null;
  self?: string | null;
  extra?: string | null;
}): string {
  const title = (opts.dupTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  let s =
    opts.reason === "title"
      ? title
        ? `duplicate of “${title}”`
        : "duplicate of an already-ingested copy"
      : title
        ? `same story already ingested (“${title}”)`
        : "same article already ingested";
  const origin: string[] = [];
  if (opts.dupDomain) origin.push(`by ${opts.dupDomain}`);
  if (opts.dupDate) origin.push(`first seen ${opts.dupDate}`);
  if (origin.length) s += ` — ${origin.join(", ")}`;
  if (opts.self) s += `; this copy: ${opts.self}`;
  if (opts.extra) s += ` · ${opts.extra}`;
  return s;
}

/** YYYY-MM-DD for display; null when unparseable. */
function dateOnly(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Publish-date hygiene for ingestion (pure, unit-testable).
 *  - Future stamps (>2min ahead) are page metadata garbage (timezone slips,
 *    bad <time> markup) and would pin articles atop published_at feeds
 *    forever — clamped to ingest time.
 *  - Dates older than prefilter.max_article_age_days mark the item as a
 *    stale resurface (GDELT/search constantly re-index evergreen pages);
 *    caller records it consumed-with-reason instead of ingesting.
 */
export function resolveIngestPublishedAt(
  candidate: Date | null,
  now = Date.now(),
  maxAgeDays: number = getFilters().prefilter.max_article_age_days ?? 45,
): { ok: true; publishedAt: Date } | { ok: false; publishedAt: Date } {
  const resolved = candidate ?? new Date(now);
  if (resolved.getTime() > now + 2 * 60 * 1000) {
    return { ok: true, publishedAt: new Date(now) };
  }
  if (resolved.getTime() < now - maxAgeDays * 24 * 3600 * 1000) {
    return { ok: false, publishedAt: resolved };
  }
  return { ok: true, publishedAt: resolved };
}

async function markFetchFailed(db: Db, rawItemId: string, err: Error): Promise<void> {
  const [row] = await db.select().from(rawItems).where(eq(rawItems.id, rawItemId)).limit(1);
  await db
    .update(rawItems)
    .set({
      fetchState: "failed",
      fetchAttempts: (row?.fetchAttempts ?? 0) + 1,
      fetchError: err.message.slice(0, 300),
    })
    .where(eq(rawItems.id, rawItemId));
  void recordTrace(db, {
    node: "fetch_failed",
    refId: rawItemId,
    kind: "raw",
    label: row?.title ?? undefined,
    detail: err.message.slice(0, 120),
  });
}

/**
 * Programmatic filter stage: rules prefilter → wire dedupe → WAITING ROOM.
 * No LLM here — relevance judgment, resolution corrections and enrichment all
 * happen later in the operator-triggered harness batch. Survivors park in
 * `noise_stage = 'waiting'` indefinitely; every discard is a journey terminal.
 */
export async function handleFilterArticle(
  deps: PipelineDeps,
  articleId: string,
): Promise<{ waiting: boolean }> {
  const [article] = await deps.db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!article || article.noiseStage !== "pending") return { waiting: false };
  const ref = article.rawItemId ?? article.id;

  const text = (await deps.storage.get(article.extractedTextPath ?? "")) ?? "";
  const discard = async (node: string, score: number, reason: string, detailOverride?: string) => {
    await deps.db
      .update(articles)
      .set({ noiseStage: "prefilter", noiseScore: score, discardReason: reason.slice(0, 200), updatedAt: new Date() })
      .where(eq(articles.id, articleId));
    void recordTrace(deps.db, {
      node,
      refId: ref,
      kind: "article",
      label: article.title,
      detail: detailOverride ?? `${reason.slice(0, 60)} · ${article.publisherDomain}`,
    });
  };

  const pre = prefilter({ url: article.url, title: article.title, body: text });
  if (!pre.kept) {
    await discard("prefilter_discards", pre.score, pre.reason ?? "prefilter");
    return { waiting: false };
  }
  void recordTrace(deps.db, {
    node: "prefilter",
    refId: ref,
    kind: "article",
    label: article.title,
    detail: `passed rules · ${article.publisherDomain}`,
  });

  // Wire-copy collapse before any model spend: an identical normalized title
  // inside the window is a syndicated duplicate (iHeart/Fool-style networks).
  const dupWindowHours = getFilters().prefilter.dedup_window_hours;
  const normTitle = article.title.replace(/\s+/g, " ").trim().toLowerCase();
  const dupe = await deps.db.execute<{
    id: string;
    title: string | null;
    publisher_domain: string | null;
    published_at: string | null;
  }>(sql`
    SELECT id, title, publisher_domain, published_at FROM articles
    WHERE id != ${articleId}
      AND created_at > now() - (${dupWindowHours} * interval '1 hour')
      AND lower(btrim(regexp_replace(title, '\\s+', ' ', 'g'))) = ${normTitle}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `);
  if (dupe.length > 0) {
    const dupId = dupe[0]?.id ?? "unknown";
    await discard(
      "dedupe",
      0.92,
      `title_duplicate_of:${dupId}`,
      traceDupDetail({
        reason: "title",
        dupTitle: dupe[0]?.title ?? null,
        dupDomain: dupe[0]?.publisher_domain ?? null,
        dupDate: dateOnly(dupe[0]?.published_at),
        self: article.publisherDomain,
      }),
    );
    return { waiting: false };
  }
  void recordTrace(deps.db, {
    node: "dedupe",
    refId: ref,
    kind: "article",
    label: article.title,
    detail: `unique · ${article.publisherDomain}`,
  });

  // All programmatic gates passed — enter the waiting room. Accumulates
  // indefinitely until the harness batch runs.
  await deps.db
    .update(articles)
    .set({ noiseStage: "waiting", updatedAt: new Date() })
    .where(eq(articles.id, articleId));
  void recordTrace(deps.db, {
    node: "waiting_room",
    refId: ref,
    kind: "article",
    label: article.title,
    detail: `awaiting harness · ${article.publisherDomain}`,
  });
  return { waiting: true };
}

/** FR-21 webhook retries. */
export async function handleWebhookSweep(deps: PipelineDeps): Promise<void> {
  const res = await processDueDeliveries(deps.db, { limit: 100 });
  if (res.attempted) logger.info(res, "webhook deliveries processed");
}

/** NFR-8 hot retention sweep. */
export async function handleRetentionSweep(deps: PipelineDeps): Promise<{ removed: number }> {
  const cfg = getConfig();
  const cutoff = new Date(Date.now() - cfg.HOT_RETENTION_DAYS * 24 * 3600 * 1000);
  const rows = await deps.db.execute<{ id: string; path: string | null }>(sql`
    SELECT id, extracted_text_path AS path
    FROM articles WHERE created_at < ${cutoff.toISOString()} LIMIT 5000
  `);
  for (const r of rows) {
    if (r.path) await deps.storage.delete(r.path);
  }
  await deps.db.execute(sql`DELETE FROM articles WHERE created_at < ${cutoff.toISOString()}`);
  // R04: parked fetch failures stay auditable — only successfully consumed
  // raw items age out. Failed rows keep their stage+error for reconciliation.
  await deps.db.execute(sql`
    DELETE FROM raw_items
    WHERE created_at < ${cutoff.toISOString()} AND fetch_state = 'fetched'
  `);
  logger.info({ removed: rows.length }, "retention sweep complete");
  return { removed: rows.length };
}

// ------------------------------------------------------------------- workers
export async function registerWorkers(boss: Boss, deps: PipelineDeps): Promise<void> {
  await boss.work(QUEUE.fetchFeed, { pollingIntervalSeconds: 1, batchSize: 5 }, async (jobs) => {
    for (const job of jobs) {
      const sourceId = String((job.data as { sourceId?: string }).sourceId ?? "");
      const { insertedIds } = await handleFetchFeed(deps, sourceId);
      // R02 uniform stage contract: RSS-discovered items traverse the same
      // deterministic chain as GDELT items — every new raw item gets fetched.
      for (const rawItemId of insertedIds.slice(0, 100)) {
        await boss.send(QUEUE.fetchArticle, { rawItemId }, { singletonKey: rawItemId });
      }
    }
  });

  await boss.work(QUEUE.fetchArticle, { pollingIntervalSeconds: 1, batchSize: 3 }, async (jobs) => {
    for (const job of jobs) {
      const rawItemId = String((job.data as { rawItemId?: string }).rawItemId ?? "");
      const { articleId } = await handleFetchArticle(deps, rawItemId);
      // R02 uniform stage contract: a fetched article always enters the filter
      // stage — dropping the result here left rows pending forever and forced
      // legacy inline paths to keep serving unenriched rows.
      if (articleId) await boss.send(QUEUE.filterArticle, { articleId }, { singletonKey: articleId });
    }
  });

  await boss.work(QUEUE.filterArticle, { pollingIntervalSeconds: 1, batchSize: 5 }, async (jobs) => {
    for (const job of jobs) {
      const articleId = String((job.data as { articleId?: string }).articleId ?? "");
      // Programmatic gates only; survivors park in the waiting room. No
      // downstream enqueue — the harness batch is operator-triggered.
      await handleFilterArticle(deps, articleId);
    }
  });

  await boss.work(QUEUE.harnessRun, { pollingIntervalSeconds: 2 }, async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    const runId = (job.data as { runId?: string }).runId;
    try {
      await runHarness(deps, runId);
    } catch (e) {
      if ((e as Error).message === "harness_busy") {
        logger.info("harness run requested while already running — ignored");
        return;
      }
      throw e;
    }
  });

  // GDELT items skip the feed step and go straight to fetching.
  void politeFetch;
}

export interface SendFn {
  (queue: string, data: unknown, options?: { singletonKey?: string }): Promise<string | null>;
}

export async function startSchedules(boss: Boss, deps: PipelineDeps, send: SendFn): Promise<void> {
  const cfg = getConfig();
  await boss.schedule(QUEUE.rssPollTick, "*/1 * * * *");
  if (cfg.GDELT_ENABLED) {
    await boss.schedule(QUEUE.gdeltPollTick, `*/${Math.max(15, cfg.GDELT_POLL_MINUTES)} * * * *`);
  }
  if (cfg.FORMD_ENABLED) {
    await boss.schedule(QUEUE.formdPollTick, "10 6 * * *");
  }
  if (cfg.LAUNCH_SURFACES_ENABLED) {
    await boss.schedule(QUEUE.launchPollTick, "23 */2 * * *");
  }
  await boss.schedule(QUEUE.webhookSweep, "*/1 * * * *");
  await boss.schedule(QUEUE.retentionSweep, "17 3 * * *"); // daily 03:17 UTC
  // Invariant machinery (R06/R10/R13): bounded, idempotent ticks. The harness
  // is NOT scheduled — the waiting room accumulates until an operator fires it.
  await boss.schedule(QUEUE.entityBackfillTick, "9 */2 * * *"); // every 2h
  await boss.schedule(QUEUE.sourceLifecycleTick, "41 * * * *"); // hourly
  await boss.schedule(QUEUE.funnelRollup, "40 5 * * *"); // yesterday's full day
  // FR-25 convergence: profile companies the harness's 8-slot new-entity pass
  // missed (baseline completes via entityBackfillTick after they were created).
  await boss.schedule(QUEUE.companyProfileTick, "23 * * * *"); // hourly

  await boss.work(QUEUE.rssPollTick, async () => {
    const dueIds = await handleRssPollTick(deps);
    for (const sourceId of dueIds) {
      // One outstanding poll per source — prevents 167k-job backlogs when workers
      // restart and the cron keeps enqueueing while the queue drains slowly.
      await send(QUEUE.fetchFeed, { sourceId }, { singletonKey: sourceId });
    }
  });

  await boss.work(QUEUE.gdeltPollTick, async () => {
    const cfg2 = getConfig();
    const result = await pollGdelt(deps.db, { timespanMinutes: cfg2.GDELT_POLL_MINUTES });
    // Fetch only URLs not already captured (pollGdelt already dedupes).
    const pending = await deps.db
      .select({ id: rawItems.id })
      .from(rawItems)
      .where(and(eq(rawItems.discoveredVia, "gdelt"), eq(rawItems.fetchState, "pending")))
      .limit(50);
    for (const item of pending) {
      await send(QUEUE.fetchArticle, { rawItemId: item.id });
    }
    logger.info(result, "gdelt poll tick done");
  });

  await boss.work(QUEUE.formdPollTick, async () => {
    try {
      const result = await ingestFormDFilings(deps.db, { days: 3 }); // overlap for late-posted indexes
      logger.info(result, "formd poll tick done");
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "formd poll tick failed");
    }
  });

  await boss.work(QUEUE.launchPollTick, async () => {
    try {
      const results = await ingestLaunchSurfaces(deps.db);
      for (const r of results) {
        if (r.enabled) logger.info({ surface: r.surface, seen: r.seen, ingested: r.ingested }, "launch poll tick done");
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "launch poll tick failed");
    }
  });

  await boss.work(QUEUE.webhookSweep, async () => handleWebhookSweep(deps));
  await boss.work(QUEUE.retentionSweep, async () => handleRetentionSweep(deps));

  // ---- invariant machinery workers (LLM-free) -----------------------------
  await boss.work(QUEUE.entityBackfillTick, async () => {
    await backfillEntityBaselines(deps.db, 100);
  });

  // ---- deep profiles (LLM; budget-guarded inside generateEntityProfile) ---
  await boss.work(QUEUE.companyProfileTick, async () => {
    if (refuseHarnessWithoutModel()) {
      logger.info("company-profile-tick skipped: no in-process LLM (use enrich-new-companies skill in harness mode)");
      return;
    }
    const hs = await harnessStatus(deps.db);
    if (hs.running_now) {
      logger.info("company-profile-tick skipped: waiting-room harness is running");
      return;
    }
    try {
      const cfg = getCompanyProfileConfig();
      const due = await dueProfileEntities(deps.db, cfg.max_entities_per_tick);
      let sections = 0;
      for (const id of due) {
        try {
          const res = await generateEntityProfile(deps.db, deps.router, id);
          sections += res.finalized.length + res.completed.length;
          if (res.skipped === "budget_hard") break;
        } catch (e) {
          logger.warn({ err: (e as Error).message, entityId: id }, "profile tick entity failed");
        }
      }
      if (due.length > 0) {
        logger.info({ due: due.length, sections_completed: sections }, "company-profile-tick done");
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "company profile tick failed");
    }
  });

  await boss.work(QUEUE.sourceLifecycleTick, async () => {
    try {
      await runSourceLifecycleTick(deps.db);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "source lifecycle tick failed");
    }
  });

  await boss.work(QUEUE.funnelRollup, async () => {
    try {
      await rollupFunnelDay(deps.db);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "funnel rollup failed");
    }
  });
}
