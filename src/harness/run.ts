import { desc, eq, sql } from "drizzle-orm";
import { getFilters } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articleEntities, articles, entities, facts, kvState } from "../db/schema.js";
import { looksLikePersonName } from "../lib/quality.js";
import { normalizeName } from "../lib/text.js";
import { extractTitleSubject } from "../lib/title-subject.js";
import { enrichmentMissingFields, writeArticleSummary } from "../enrichment/pipeline.js";
import { clusterArticle } from "../clustering/cluster.js";
import { resolveArticle, persistResolution } from "../resolution/resolver.js";
import { proposeFactFromArticle, attachFactToArticle } from "../entities/facts.js";
import { backfillEntityBaselines } from "../entities/baseline.js";
import { recordTrace } from "../ops/traces.js";
import { enqueueArticleDeliveries } from "../webhooks/deliver.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { isMockModelName, mockMustNotPublish } from "../llm/router.js";
import { auditOneChunk, type BatchAuditVerdict } from "./batch-audit.js";
import { rescueBatchAuditVerdict } from "./batch-audit-rescue.js";
import type { PipelineDeps } from "../queue/jobs.js";

/**
 * THE HARNESS — one operator-fired LLM job over the waiting room.
 *
 * Programmatic fetch parks survivors as `waiting`. Nothing LLM-powered runs
 * per-article on a cron. When an operator fires this job:
 *
 *   Part 1 — batch audit: look at the pile in chunks. After EACH chunk,
 *            drops leave the waiting room and keepers that clear
 *            completeness publish — do not wait for later chunks.
 *   Part 1½ — story match as each keeper publishes.
 *   Part 2 — hone in: deep search each company NEW in this batch.
 *   Part 3 — hone in: card updates (facts) on surviving companies.
 *
 * Survivors publish as noise_stage='kept' (/v1/news/latest).
 */

const LOCK_KEY = "harness_run";
const STALE_LOCK_MS = 2 * 60 * 60_000;

export interface HarnessRunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  scanned: number;
  corrected: number;
  relevance_discards: number;
  incomplete_skipped: number;
  published: number;
  stories_clustered: number;
  facts_proposed: number;
  facts_accepted: number;
  cards_updated: number;
  new_companies_deep_searched: number;
  /** 1-based index of the last batch_audit chunk whose keep/drop hit the DB. */
  chunk_done?: number;
  chunks_total?: number;
  /**
   * Set when the run did not publish. `mock_fallback_refused` means the
   * waiting-room SELECT ran (see `scanned`) but the model that answered
   * part 1 was mock while LLM_PROVIDER is not `mock` — waiting rows stay.
   */
  skip_reason?: string;
}

export interface HarnessStatus {
  running_now: boolean;
  last_run: HarnessRunSummary | null;
}

/** Read the harness status block for the snapshot (cheap). */
export async function harnessStatus(db: Db): Promise<HarnessStatus> {
  const rows = await db.select().from(kvState).where(eq(kvState.key, LOCK_KEY)).limit(1);
  const value = (rows[0]?.value ?? {}) as {
    status?: string;
    startedAt?: string;
    lastRun?: HarnessRunSummary;
    staleAt?: string;
  };
  const running =
    value.status === "running" &&
    (!value.startedAt || Date.now() - new Date(value.startedAt).getTime() < STALE_LOCK_MS);
  return { running_now: running, last_run: value.lastRun ?? null };
}

async function acquireLock(db: Db, runId: string): Promise<boolean> {
  const status = await harnessStatus(db);
  if (status.running_now) return false;
  await db
    .insert(kvState)
    .values({
      key: LOCK_KEY,
      value: { status: "running", runId, startedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: kvState.key,
      set: {
        value: { status: "running", runId, startedAt: new Date().toISOString() },
        updatedAt: new Date(),
      },
    });
  return true;
}

async function persistProgress(
  db: Db,
  runId: string,
  startedAt: string,
  lastRun: HarnessRunSummary,
): Promise<void> {
  await db
    .update(kvState)
    .set({
      value: { status: "running", runId, startedAt, lastRun },
      updatedAt: new Date(),
    })
    .where(eq(kvState.key, LOCK_KEY));
  void import("../ops/exoskeleton.js").then((m) => m.invalidateExoskeletonCache());
}

async function releaseLock(db: Db, lastRun: HarnessRunSummary): Promise<void> {
  await db
    .update(kvState)
    .set({ value: { status: "done", lastRun }, updatedAt: new Date() })
    .where(eq(kvState.key, LOCK_KEY));
}

/** Stable journey ref for an article row: raw-item id when present, else article id. */
function journeyRef(a: { id: string; rawItemId: string | null }): string {
  return a.rawItemId ?? a.id;
}

function namesRoughlyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export async function runHarness(deps: PipelineDeps, runId?: string): Promise<HarnessRunSummary> {
  const { db, router, storage } = deps;
  const rid = runId ?? opaqueId("run");
  const started = new Date();
  if (!(await acquireLock(db, rid))) {
    throw new Error("harness_busy");
  }
  const summary: HarnessRunSummary = {
    run_id: rid,
    started_at: started.toISOString(),
    finished_at: "",
    scanned: 0,
    corrected: 0,
    relevance_discards: 0,
    incomplete_skipped: 0,
    published: 0,
    stories_clustered: 0,
    facts_proposed: 0,
    facts_accepted: 0,
    cards_updated: 0,
    new_companies_deep_searched: 0,
  };

  try {
    // Do NOT refuse here for LLM_PROVIDER=auto + placeholder key. Auto is
    // supposed to offer completions to a connected agent first; bailing
    // before the waiting-room SELECT made last_run.scanned=0 in ~10ms while
    // hundreds of noise_stage='waiting' rows sat unused, and created no
    // llm_requests for the looping brain to claim. Mock publish is blocked
    // after part 1 (mockMustNotPublish). Scheduled ticks still use
    // refuseHarnessWithoutModel() so hourly mock profiles do not run.

    const maxBatch = getFilters().harness?.max_batch ?? 120;
    const batch = await db
      .select()
      .from(articles)
      .where(eq(articles.noiseStage, "waiting"))
      .orderBy(desc(articles.publishedAt), desc(articles.createdAt))
      .limit(maxBatch);
    summary.scanned = batch.length;

    // ---------------------------------------------------------- PART 1 ----
    // Audit the pile in chunks. After each chunk: write drops immediately,
    // then hone in and publish each keeper — do not wait for later chunks
    // or for the rest of this run's keepers.
    const texts = new Map<string, string>();
    for (const article of batch) {
      texts.set(article.id, (await storage.get(article.extractedTextPath ?? "")) ?? article.title);
    }
    const inputs = batch.map((a) => ({
      id: a.id,
      title: a.title,
      publisherDomain: a.publisherDomain,
      lead: (texts.get(a.id) ?? a.title).slice(0, 1600),
    }));
    const chunkSize = getFilters().harness?.audit_chunk_size ?? 40;
    const survivors: typeof batch = [];
    const mandatoryTiers = getFilters().summary.mandatory_tiers;
    const startedAtIso = started.toISOString();
    summary.chunks_total = Math.max(1, Math.ceil(batch.length / chunkSize));
    await persistProgress(db, rid, startedAtIso, summary);

    for (let offset = 0; offset < batch.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, batch.length);
      const chunkAudit = await auditOneChunk(router, inputs, offset, chunkSize);
      if (mockMustNotPublish() && isMockModelName(chunkAudit.model)) {
        logger.error(
          { model: chunkAudit.model, scanned: batch.length, offset },
          "harness refused mock fallback as a publish path; waiting room untouched for this chunk",
        );
        if (summary.published === 0 && summary.relevance_discards === 0) {
          summary.skip_reason = "mock_fallback_refused";
          summary.finished_at = new Date().toISOString();
          await releaseLock(db, summary);
          return summary;
        }
        break;
      }

      const keepers: Array<{ article: (typeof batch)[number]; verdict: BatchAuditVerdict }> = [];
      for (let i = offset; i < end; i++) {
        const article = batch[i]!;
        const ref = journeyRef(article);
        const verdict = chunkAudit.byIndex.get(i);
        const rescued = verdict
          ? rescueBatchAuditVerdict(verdict, article.title, {
              priorDiscardReason: article.discardReason,
            })
          : undefined;
        if (!rescued) {
          const attempts = (article.enrichAttempts ?? 0) + 1;
          const maxAttempts = getFilters().enrichment.max_attempts;
          const parked = attempts >= maxAttempts;
          await db
            .update(articles)
            .set({
              noiseStage: parked ? "llm_filter" : "waiting",
              discardReason: `batch_audit:no_verdict${parked ? ":parked_max_attempts" : ""}`,
              enrichAttempts: attempts,
              enrichedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(articles.id, article.id));
          summary.incomplete_skipped += 1;
          continue;
        }
        if (!rescued.keep) {
          await db
            .update(articles)
            .set({
              noiseStage: "llm_filter",
              discardReason: (rescued.reason || "batch_audit:missing_index").slice(0, 200),
              updatedAt: new Date(),
            })
            .where(eq(articles.id, article.id));
          summary.relevance_discards += 1;
          void recordTrace(db, {
            node: "harness_discards",
            refId: ref,
            kind: "article",
            label: article.title,
            detail: `relevance · ${(rescued.reason || "no explanation given").slice(0, 80)}`,
          });
          continue;
        }
        const allTags = [
          ...new Set([rescued.primary_tag, ...rescued.secondary_tags].filter((t): t is string => Boolean(t))),
        ];
        await db
          .update(articles)
          .set({
            primaryTag: rescued.primary_tag,
            secondaryTags: rescued.secondary_tags,
            allTags,
            sentiment: rescued.sentiment,
            sentimentScore: rescued.sentiment_score,
            newsworthiness: rescued.newsworthiness,
            industryPrimary: rescued.industry_primary,
            industrySecondary: rescued.industry_secondary,
            countries: rescued.countries,
            enrichedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(articles.id, article.id));
        keepers.push({ article, verdict: rescued });
      }
      summary.chunk_done = Math.floor(offset / chunkSize) + 1;
      await persistProgress(db, rid, startedAtIso, summary);

      for (const { article, verdict } of keepers) {
        const ref = journeyRef(article);
        const text = texts.get(article.id) ?? article.title;
        const wantSummary =
          verdict.newsworthiness === "high" || verdict.newsworthiness === "medium";
        if (wantSummary) {
          await writeArticleSummary(db, router, {
            articleId: article.id,
            title: article.title,
            body: text,
            entityName: verdict.subject_name,
            primaryTag: verdict.primary_tag,
          });
        }

        const meta = (article.platformMeta ?? {}) as Record<string, unknown>;
        const registryAttributed = Boolean(meta.formd || meta.launch);
        const lead = text.slice(0, 1600) || article.title;
        const resolution = await resolveArticle(db, router, {
          articleId: article.id,
          title: article.title,
          lead,
          outlinkDomains: article.outlinkDomains,
          subjectHint: verdict.subject_name ?? extractTitleSubject(article.title),
        });

        let dropReason: string | null = null;
        const titleSubject = verdict.subject_name ?? extractTitleSubject(article.title);
        if (resolution.primaryEntityId) {
          const [pe] = await db
            .select()
            .from(entities)
            .where(eq(entities.id, resolution.primaryEntityId))
            .limit(1);
          if (
            pe &&
            pe.type === "private" &&
            looksLikePersonName(pe.canonicalName) &&
            !pe.registryIds &&
            pe.tickers.length === 0 &&
            !pe.website &&
            !namesRoughlyMatch(pe.canonicalName, titleSubject) &&
            !namesRoughlyMatch(pe.canonicalName, verdict.subject_name)
          ) {
            dropReason = "person_not_company_subject";
          }
        }

        if (!resolution.primaryEntityId) {
          if (!registryAttributed) {
            await db
              .update(articles)
              .set({
                resolvedAt: new Date(),
                noiseStage: "waiting",
                discardReason: "harness:unresolved_subject",
                updatedAt: new Date(),
              })
              .where(eq(articles.id, article.id));
            summary.incomplete_skipped += 1;
            void recordTrace(db, {
              node: "harness",
              refId: ref,
              kind: "article",
              label: article.title,
              detail: "unresolved · retry when entity links",
            });
            await persistProgress(db, rid, startedAtIso, summary);
            continue;
          }
        }

        if (dropReason) {
          await db
            .update(articles)
            .set({
              resolvedAt: new Date(),
              noiseStage: "llm_filter",
              discardReason: `harness:${dropReason}`,
              updatedAt: new Date(),
            })
            .where(eq(articles.id, article.id));
          summary.relevance_discards += 1;
          void recordTrace(db, {
            node: "harness_discards",
            refId: ref,
            kind: "article",
            label: article.title,
            detail: `relevance · ${dropReason.replace(/_/g, " ")}`,
          });
          await persistProgress(db, rid, startedAtIso, summary);
          continue;
        }

        if (resolution.primaryEntityId || resolution.secondaries.length > 0) {
          await persistResolution(db, article.id, resolution);
        } else {
          await db.update(articles).set({ resolvedAt: new Date() }).where(eq(articles.id, article.id));
        }
        void recordTrace(db, {
          node: "harness",
          refId: ref,
          kind: "article",
          label: article.title,
          detail: resolution.primaryEntityId
            ? `batch audit · resolved ${resolution.primaryEntityId}`
            : "batch audit · kept",
        });

        const [fresh] = await db.select().from(articles).where(eq(articles.id, article.id)).limit(1);
        const missing = fresh ? enrichmentMissingFields(fresh, mandatoryTiers) : ["row_missing"];
        if (missing.length > 0) {
          const attempts = (fresh?.enrichAttempts ?? 0) + 1;
          const maxAttempts = getFilters().enrichment.max_attempts;
          const parked = attempts >= maxAttempts;
          await db
            .update(articles)
            .set({
              noiseStage: parked ? "llm_filter" : "waiting",
              discardReason: `enrich_missing:${missing.join("+")}${parked ? ":parked_max_attempts" : ""}`,
              enrichAttempts: attempts,
              enrichedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(articles.id, article.id));
          summary.incomplete_skipped += 1;
          void recordTrace(db, {
            node: parked ? "harness_discards" : "harness",
            refId: ref,
            kind: "article",
            label: article.title,
            detail: parked
              ? `incomplete · parked (${missing.join("+").slice(0, 60)})`
              : `incomplete · retry next run (${missing.join("+").slice(0, 60)})`,
          });
          await persistProgress(db, rid, startedAtIso, summary);
          continue;
        }

        try {
          const res = await clusterArticle(db, router, fresh!.id);
          summary.stories_clustered += 1;
          void recordTrace(db, {
            node: "cluster",
            refId: ref,
            kind: "article",
            label: article.title,
            detail: res.created ? `new story ${res.storyId}` : `story ${res.storyId}`,
          });
        } catch (e) {
          logger.warn({ err: (e as Error).message, articleId: article.id }, "cluster failed in harness");
        }
        await db
          .update(articles)
          .set({ noiseStage: "kept", discardReason: null, updatedAt: new Date() })
          .where(eq(articles.id, article.id));
        summary.corrected += 1;
        summary.published += 1;
        survivors.push(fresh!);
        await persistProgress(db, rid, startedAtIso, summary);
      }
    }

    // ---------------------------------------------------------- PART 2 ----
    // Deterministic baseline only. LLM company_profile is a separate tick —
    // running it here stole the claim queue (Kortek product_offering loop)
    // and froze waiting-room movement on the exoskeleton.
    const batchIds = survivors.map((a) => a.id);
    const cap = getFilters().harness?.deep_search_entities ?? 8;
    const newEntities =
      batchIds.length === 0
        ? []
        : await db.execute<{ id: string }>(sql`
            SELECT e.id
            FROM entities e
            WHERE e.merged_into IS NULL
              AND (e.created_at >= ${started} OR e.needs_backfill = true)
              AND EXISTS (
                SELECT 1 FROM article_entities ae
                WHERE ae.entity_id = e.id
                  AND ae.article_id IN (${sql.join(batchIds.map((id) => sql`${id}`), sql`, `)})
              )
            ORDER BY e.created_at DESC
            LIMIT ${cap}
          `);
    if (newEntities.length > 0) {
      await backfillEntityBaselines(db, newEntities.length, newEntities.map((r) => String(r.id)));
      summary.new_companies_deep_searched = newEntities.length;
      await persistProgress(db, rid, startedAtIso, summary);
    }

    // ---------------------------------------------------------- PART 3 ----
    // Card updates from significant data in the events themselves.
    for (const article of survivors) {
      const ref = journeyRef(article);
      const meta = (article.platformMeta ?? {}) as Record<string, unknown>;

      // Deferred deterministic facts (launch surfaces / Form D filings).
      if (meta.launch && typeof meta.launch === "object") {
        const l = meta.launch as { surface: string; itemId: string; domain: string; day: string };
        const link = await primaryLink(db, article.id);
        if (link) {
          const ins = await db
            .insert(facts)
            .values({
              id: opaqueId("fct"),
              entityId: link.entityId,
              type: "product_launch",
              payload: { event_date: l.day },
              status: "accepted",
              evidenceArticleIds: [article.id],
              distinctPublishers: 1,
              dedupKey: `launch:${l.domain}:${l.day}:${l.itemId}`,
              promotedAt: new Date(),
            })
            .onConflictDoNothing({ target: facts.dedupKey })
            .returning({ id: facts.id });
          const launchFactId =
            ins[0]?.id ??
            (
              await db
                .select({ id: facts.id })
                .from(facts)
                .where(eq(facts.dedupKey, `launch:${l.domain}:${l.day}:${l.itemId}`))
                .limit(1)
            )[0]?.id;
          if (launchFactId) await attachFactToArticle(db, article.id, launchFactId);
          if (ins.length) {
            summary.facts_proposed += 1;
            summary.facts_accepted += 1;
            summary.cards_updated += 1;
            void recordTrace(db, {
              node: "facts",
              refId: ref,
              kind: "fact",
              label: article.title,
              detail: `product_launch · card updated (${l.surface})`,
            });
          }
        }
      } else if (meta.formd && typeof meta.formd === "object") {
        const f = meta.formd as { accession: string; fileDate: string | null; cik: string };
        const link = await primaryLink(db, article.id);
        if (link) {
          const payload = f.fileDate ? { event_date: f.fileDate } : {};
          const quantified = false; // ingest carries no amount/stage; stay proposed
          const ins = await db
            .insert(facts)
            .values({
              id: opaqueId("fct"),
              entityId: link.entityId,
              type: "funding_round",
              payload,
              status: quantified ? "accepted" : "proposed",
              evidenceArticleIds: [article.id],
              distinctPublishers: 1,
              bestSourceTier: 1,
              dedupKey: `formd:${f.accession}`,
              promotedAt: quantified ? new Date() : null,
            })
            .onConflictDoNothing({ target: facts.dedupKey })
            .returning({ id: facts.id });
          const formdFactId =
            ins[0]?.id ??
            (
              await db
                .select({ id: facts.id })
                .from(facts)
                .where(eq(facts.dedupKey, `formd:${f.accession}`))
                .limit(1)
            )[0]?.id;
          if (formdFactId) await attachFactToArticle(db, article.id, formdFactId);
          if (ins.length) {
            summary.facts_proposed += 1;
            void recordTrace(db, {
              node: "facts",
              refId: ref,
              kind: "fact",
              label: article.title,
              detail: `funding_round · Form D proposed (no amount/stage yet)`,
            });
          }
        }
      } else {
        // Signal-derived fact extraction from press coverage (LLM, mini).
        const link = await primaryLink(db, article.id);
        if (!link) continue;
        const res = await proposeFactFromArticle(db, router, {
          articleId: article.id,
          entityId: link.entityId,
          resolverConfidence: link.confidence,
        });
        if (res.proposed) {
          summary.facts_proposed += 1;
          if (res.accepted) {
            summary.facts_accepted += 1;
            summary.cards_updated += 1;
          }
          void recordTrace(db, {
            node: "facts",
            refId: ref,
            kind: "fact",
            label: article.title,
            detail: `${res.accepted ? "accepted · card updated" : "proposed"}${
              res.reason ? ` · ${res.reason.slice(0, 60)}` : ""
            }`,
          });
        }
      }
    }

    // ------------------------------------------------- WINNERS + FAN-OUT --
    // Publish trace LAST so each winner's package carries its complete path
    // (… → waiting_room → corrections → cluster → facts → winners), then wire
    // fan-out appends its step before the terminal is recorded.
    for (const article of survivors) {
      const ref = journeyRef(article);
      const deliveries = await enqueueArticleDeliveries(db, article.id);
      if (deliveries > 0) {
        void recordTrace(db, {
          node: "webhooks",
          refId: ref,
          kind: "article",
          label: article.title,
          detail: `${deliveries} subscription${deliveries === 1 ? "" : "s"}`,
        });
      }
      void recordTrace(db, {
        node: "winners",
        refId: ref,
        kind: "article",
        label: article.title,
        detail: "published · served on /latest",
      });
    }

    summary.finished_at = new Date().toISOString();
    await releaseLock(db, summary);
    logger.info(summary, "harness run complete");
    return summary;
  } catch (e) {
    summary.finished_at = new Date().toISOString();
    await releaseLock(db, summary);
    throw e;
  }
}

async function primaryLink(
  db: Db,
  articleId: string,
): Promise<{ entityId: string; confidence: number } | null> {
  const rows = await db
    .select({ entityId: articleEntities.entityId, confidence: articleEntities.confidence })
    .from(articleEntities)
    .where(eq(articleEntities.articleId, articleId))
    .limit(5);
  const primary = rows[0];
  return primary ? { entityId: primary.entityId, confidence: primary.confidence } : null;
}
