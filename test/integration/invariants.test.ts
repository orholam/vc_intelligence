import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import { opaqueId } from "../../src/lib/ulid.js";
import { sha256Hex, canonicalizeUrl } from "../../src/lib/hash.js";
import {
  articles,
  aliases as aliasesTable,
  articleEntities,
  entities,
  facts,
  funnelDaily,
  llmCalls,
  pipelineEvents,
  sourceEvents,
  sources,
} from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { makeProvider, LlmRouter, BudgetDegradedError } from "../../src/llm/router.js";
import { LocalStorage } from "../../src/storage.js";
import type { ChatCallOpts, ChatResult, LlmProvider } from "../../src/llm/provider.js";
import { handleFilterArticle } from "../../src/queue/jobs.js";
import { runHarness } from "../../src/harness/run.js";
import { resolveArticle } from "../../src/resolution/resolver.js";
import {
  backfillEntityBaselines,
  flagBaselineFailing,
  baselineSatisfactionRate,
  STAGE_BOOTSTRAPPED,
  STAGE_UNKNOWN,
  UNCLASSIFIED_TAG,
} from "../../src/entities/baseline.js";
import { repairFactPropagation, proposeFactFromArticle } from "../../src/entities/facts.js";
import { runSourceLifecycleTick } from "../../src/sources/lifecycle.js";
import { computeFunnelAlerts, rollupFunnelDay, type FunnelDay } from "../../src/ops/funnel.js";

/**
 * R12 golden invariants suite: offline (PGlite + mock LLM) assertions for the
 * OUTPUT-RUBRIC pipeline invariants — R03 idempotent double-run, R05
 * enriched-or-quarantined, R06 baseline card, R07 fact->KB propagation,
 * R09 disclosed budget degradation, R10 source lifecycle, R13 funnel rollup +
 * alerts, R14 determinism.
 */

let tdb: TestDb;
let normalized: ReturnType<typeof normalizeExecuteShape>;
let deps: {
  db: Db;
  registry: SourceRegistry;
  router: LlmRouter;
  storage: LocalStorage;
};

/** Provider stub whose classify verdicts always fail validation (R05 trigger). */
class BrokenClassifier implements LlmProvider {
  async chatJson<T>(
    _schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    _system: string,
    _user: string,
    _opts: ChatCallOpts,
  ): Promise<ChatResult<T>> {
    return {
      ok: false,
      error: "simulated classifier outage",
      model: "stub",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
  async embed(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: "no embeddings in stub" };
  }
}

const FUNDING_BODY =
  "Acme Robotics, the San Francisco robotics startup, announced a $12 million Series A round led by Sequoia Capital. " +
  "The company will expand manufacturing of its warehouse robots and hire across engineering. ".repeat(8);

async function insertFixtureArticle(opts: {
  title?: string;
  body?: string;
  url: string;
  publisherDomain?: string;
  outlinkDomains?: string[];
}) {
  const body = opts.body ?? FUNDING_BODY;
  const id = opaqueId("art");
  const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR!);
  const p = await storage.put(`articles/${id}.txt`, body);
  await tdb.db.insert(articles).values({
    id,
    url: canonicalizeUrl(opts.url),
    urlHash: sha256Hex(canonicalizeUrl(opts.url)),
    publisherDomain: opts.publisherDomain ?? "techcrunch.com",
    title: opts.title ?? "Acme Robotics raises $12M Series A led by Sequoia Capital",
    publishedAt: new Date(),
    language: "en",
    extractedTextPath: p,
    extractedTextChars: body.length,
    extractedTextHash: sha256Hex(body),
    excerptText: body.slice(0, 400),
    outlinkDomains: opts.outlinkDomains ?? ["acme.ai"],
    noiseStage: "pending",
    sourceId: process.env.INTEL_TEST_TC_SOURCE ?? null,
  });
  return id;
}

async function counts() {
  const rows = await (normalized as unknown as Db).execute<Record<string, unknown>>(sql`
    SELECT (SELECT count(*)::int FROM articles) AS articles,
           (SELECT count(*)::int FROM raw_items) AS raw_items,
           (SELECT count(*)::int FROM article_entities) AS article_entities,
           (SELECT count(*)::int FROM facts) AS facts
  `);
  const r = rows[0]!;
  return {
    articles: Number(r.articles),
    raw_items: Number(r.raw_items),
    article_entities: Number(r.article_entities),
    facts: Number(r.facts),
  };
}

beforeAll(async () => {
  isolateConfig();
  tdb = await createTestDb();
  normalized = normalizeExecuteShape(tdb.db) as never;
  deps = {
    db: normalized as never,
    registry: new SourceRegistry(normalized as never),
    router: new LlmRouter(normalized as never, makeProvider()),
    storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
  };

  const src = await deps.registry.create({
    name: "techcrunch",
    publisher: "TechCrunch",
    feedUrl: "https://techcrunch.com/feed/",
    tier: 1,
    country: "us",
    defaultLanguage: "en",
    topics: [],
    active: true,
  });
  process.env.INTEL_TEST_TC_SOURCE = src.id;

  // Watchlisted entity with alias/domain evidence (resolver target).
  const acme = opaqueId("ent");
  await tdb.db.insert(entities).values({
    id: acme,
    canonicalName: "Acme Robotics",
    website: "acme.ai",
    type: "private",
    country: "US",
    industryTags: ["robotics_hardware"],
    confidence: 0.9,
    isMonitored: true,
    fundingStage: null, // baseline worker must fill this (R06)
    needsBackfill: true,
  });
});

describe("R03 — idempotent everywhere", () => {
  it("double-driving filter + harness changes zero row counts and zero decisions", async () => {
    const art = await insertFixtureArticle({ url: "https://techcrunch.com/2026/08/21/r03-double-run/" });

    const driveOnce = async () => {
      await handleFilterArticle(deps as never, art);
      await runHarness(deps as never);
    };

    await driveOnce();
    const afterFirst = await counts();
    const [firstRow] = (await tdb.db.select().from(articles).where(eq(articles.id, art)));
    expect(firstRow!.noiseStage).toBe("kept"); // harness published it

    await driveOnce(); // filter is a no-op off `pending`; harness finds an empty room
    await driveOnce();
    const afterThird = await counts();
    expect(afterThird).toEqual(afterFirst); // zero deltas (R03)

    const [secondRow] = await tdb.db.select().from(articles).where(eq(articles.id, art));
    expect(secondRow!.noiseStage).toBe(firstRow!.noiseStage);
    expect(secondRow!.primaryTag).toBe(firstRow!.primaryTag);
  });

  it("duplicate fact evidence merges into one canonical row (dedup_key)", async () => {
    const entRows = await tdb.db.select().from(entities);
    const acme = entRows.find((e) => e.website === "acme.ai")!;
    const a1 = await insertFixtureArticle({
      url: "https://techcrunch.com/2026/08/21/fact-dedup-1/",
      // Unique headline: identical titles across fixtures would trip the
      // programmatic wire-dedupe window before the harness ever sees them.
      title: "Acme Robotics completes $12M Series A financing round",
    });
    await handleFilterArticle(deps as never, a1);
    await runHarness(deps as never); // corrections + enrichment + publish
    const r1 = await proposeFactFromArticle(normalized as unknown as Db, deps.router, {
      articleId: a1,
      entityId: acme.id,
      resolverConfidence: 0.9,
    });
    const r2 = await proposeFactFromArticle(normalized as unknown as Db, deps.router, {
      articleId: a1,
      entityId: acme.id,
      resolverConfidence: 0.9,
    });
    expect(r1.proposed).toBe(true);
    expect(r2.proposed).toBe(true);
    const factRows = await tdb.db.select().from(facts).where(eq(facts.entityId, acme.id));
    expect(factRows.length).toBe(1); // merged, not duplicated
  });
});

describe("R05 — enriched-or-unpublished, never half", () => {
  it("incomplete rows stay in the WAITING ROOM and never serve; next good run completes them", async () => {
    const art = await insertFixtureArticle({
      url: "https://techcrunch.com/2026/08/21/r05-waiting/",
      title: "Acme Robotics announces $12M Series A to expand robot fleet",
    });

    // Pass 1 with a broken classifier -> enrichment fields stay null and the
    // row remains unpublishable in the waiting room (never quarantined/served).
    const brokenDeps = { ...deps, router: new LlmRouter(normalized as never, new BrokenClassifier()) };
    await handleFilterArticle(brokenDeps as never, art);
    const sum1 = await runHarness(brokenDeps as never);
    expect(sum1.incomplete_skipped).toBeGreaterThanOrEqual(1);

    const [qRow] = await tdb.db.select().from(articles).where(eq(articles.id, art));
    expect(qRow!.noiseStage).toBe("waiting");
    expect(qRow!.enrichedAt).toBeNull();
    expect(qRow!.enrichAttempts).toBeGreaterThanOrEqual(1);

    // Serving predicate (every surface filters noise_stage='kept') excludes it.
    const served = await tdb.db.select().from(articles).where(eq(articles.noiseStage, "kept"));
    expect(served.find((a) => a.id === art)).toBeUndefined();

    // Pass 2 with the real mock provider completes and publishes it.
    const sum2 = await runHarness(deps as never);
    expect(sum2.published).toBeGreaterThanOrEqual(1);
    const [kRow] = await tdb.db.select().from(articles).where(eq(articles.id, art));
    expect(kRow!.noiseStage).toBe("kept");
    expect(kRow!.primaryTag).toBeTruthy();
  });

  it("exports a completeness validator matching the configured mandate (R05/R08)", async () => {
    const { enrichmentMissingFields } = await import("../../src/enrichment/pipeline.js");
    const { getFilters } = await import("../../src/config-files.js");
    const mandated = new Set(getFilters().enrichment.mandated_fields);

    const missing = enrichmentMissingFields(
      {
        primaryTag: null,
        secondaryTags: [],
        sentiment: null,
        sentimentScore: null,
        newsworthiness: null,
        industryPrimary: null,
        countries: [],
        aiSummary: null,
      },
      ["high"],
    );
    // Every CONFIG-MANDATED field must be reported missing on an empty card.
    for (const field of mandated) {
      expect(missing).toContain(field);
    }
    // Summary mandate fires when a mandated-tier newsworthiness is known.
    const highNoSummary = enrichmentMissingFields(
      {
        primaryTag: "funding.series_a",
        secondaryTags: [],
        sentiment: "positive",
        sentimentScore: 0.5,
        newsworthiness: "high",
        industryPrimary: "robotics_hardware",
        countries: ["US"],
        aiSummary: null,
      },
      ["high"],
    );
    expect(highNoSummary).toEqual(["ai_summary"]);

    const completeInput = {
      primaryTag: "funding.series_a",
      secondaryTags: [],
      sentiment: "positive" as const,
      sentimentScore: 0.5,
      newsworthiness: "high" as const,
      industryPrimary: "robotics_hardware",
      countries: ["US"],
      aiSummary: "ok",
    };
    expect(enrichmentMissingFields(completeInput, ["high"])).toEqual([]);

    expect(
      enrichmentMissingFields({ ...completeInput, primaryTag: "status.no_event" }, ["high"]),
    ).toContain("primary_tag");
    expect(
      enrichmentMissingFields({ ...completeInput, industryPrimary: "other_diversified" }, ["high"]),
    ).toContain("industry_primary");
  });
});

describe("R06/D3 — minimum viable company card", () => {
  it("flags baseline-failing entities, fills deterministic basics, unflags", async () => {
    const thin = opaqueId("ent");
    await tdb.db.insert(entities).values({
      id: thin,
      canonicalName: "Thin Labs",
      type: "private",
      confidence: 0.3,
      reviewStatus: "auto_created",
      createdBy: "autocreate",
      needsBackfill: false, // simulate pre-flagging drift
      fundingStage: null,
      industryTags: [],
    });

    const flagged = await flagBaselineFailing(normalized as unknown as Db);
    expect(flagged).toBeGreaterThanOrEqual(1);

    const res = await backfillEntityBaselines(normalized as unknown as Db, 50);
    expect(res.processed).toBeGreaterThanOrEqual(1);

    const [after] = await tdb.db.select().from(entities).where(eq(entities.id, thin));
    expect(after!.fundingStage).toBe(STAGE_UNKNOWN); // no traction evidence -> explicit unknown
    expect(after!.industryTags).toEqual([]); // no sector invented
    expect(after!.needsBackfill).toBe(true); // stay flagged until a real industry exists
  });

  it("bootstraps traction-without-capital entities instead of guessing a round", async () => {
    const boot = opaqueId("ent");
    await tdb.db.insert(entities).values({
      id: boot,
      canonicalName: "Bootstrapped Co",
      type: "private",
      country: "US",
      confidence: 0.5,
      needsBackfill: true,
      fundingStage: null,
      industryTags: [],
    });
    // Two kept articles, two distinct non-funding tags, two publishers.
    const tagPlan: Array<[number, string, string, string]> = [
      [0, "product.launch_release", "news.example.com", "launches"],
      [1, "partnership.signed", "wire.example.org", "signs partnership"],
    ];
    for (const [i, tag, publisher, verb] of tagPlan) {
      const id = opaqueId("art");
      const body = FUNDING_BODY.replace(/\$12 million Series A/g, "grew customers").repeat(2);
      const p = await deps.storage.put(`articles/${id}.txt`, body);
      await tdb.db.insert(articles).values({
        id,
        url: canonicalizeUrl(`https://${publisher}/boot/${i}`),
        urlHash: sha256Hex(canonicalizeUrl(`https://${publisher}/boot/${i}`)),
        publisherDomain: publisher,
        title: `Bootstrapped Co ${verb}`,
        publishedAt: new Date(),
        extractedTextPath: p,
        extractedTextChars: body.length,
        excerptText: body.slice(0, 400),
        primaryTag: tag,
        sentiment: "positive",
        sentimentScore: 0.4,
        newsworthiness: "medium",
        industryPrimary: "saas_enterprise",
        countries: ["US"],
        enrichedAt: new Date(),
        resolvedAt: new Date(),
        clusteredAt: new Date(),
        noiseStage: "kept",
        sourceId: process.env.INTEL_TEST_TC_SOURCE ?? null,
      });
      await tdb.db.insert(articleEntities).values({
        articleId: id,
        entityId: boot,
        role: "primary",
        confidence: 0.8,
      });
    }
    await backfillEntityBaselines(normalized as unknown as Db, 50);
    const [after] = await tdb.db.select().from(entities).where(eq(entities.id, boot));
    expect(after!.fundingStage).toBe(STAGE_BOOTSTRAPPED);
    expect(after!.country).toBe("US");
    expect(after!.industryTags).not.toContain(UNCLASSIFIED_TAG);
  });

  it("kb.create never stores a null stage and flags incomplete cards at birth", async () => {
    const { EntityKb } = await import("../../src/entities/kb.js");
    const kb = new EntityKb(normalized as unknown as Db);
    const created = await kb.create(
      {
        canonicalName: "Newborn AI",
        website: "newborn.ai",
        confidence: 0.5,
        createdBy: "autocreate",
        reviewStatus: "auto_created",
      },
      "test",
    );
    expect(created.fundingStage).toBe(STAGE_UNKNOWN);
    expect(created.needsBackfill).toBe(true);

    const complete = await kb.create(
      {
        canonicalName: "Complete Card Inc",
        website: "completecard.io",
        country: "GB",
        industryTags: ["fintech"],
        fundingStage: "seed",
        confidence: 0.7,
      },
      "test",
    );
    expect(complete.needsBackfill).toBe(false);
  });
});

describe("R07 — facts propagate to the entity KB with provenance", () => {
  it("accepted funding facts land stage/raise/date AND source_refs on the card", async () => {
    // Fresh entity so prominence/exclusivity terms are unambiguous (high tier).
    const refco = opaqueId("ent");
    await tdb.db.insert(entities).values({
      id: refco,
      canonicalName: "Refco Robotics",
      website: "refco.ai",
      type: "private",
      country: "US",
      industryTags: ["robotics_hardware"],
      confidence: 0.9,
      isMonitored: true,
      fundingStage: null,
      needsBackfill: true,
    });
    await tdb.db.insert(aliasesTable).values([
      { id: opaqueId("als"), entityId: refco, alias: "Refco Robotics", aliasNormalized: "refco robotics", kind: "name" },
      { id: opaqueId("als"), entityId: refco, alias: "refco.ai", aliasNormalized: "refco ai", kind: "domain" },
    ]);

    const art = await insertFixtureArticle({
      url: "https://techcrunch.com/2026/08/21/r07-refs/",
      title: "Refco Robotics raises $40M Series B led by Hex Ventures",
      body: "Refco Robotics, the Austin warehouse-robotics company, announced a $40 million Series B led by Hex Ventures with strong customer demand and record growth across engineering and manufacturing. ".repeat(8),
      outlinkDomains: ["refco.ai"],
    });
    await handleFilterArticle(deps as never, art);
    await runHarness(deps as never); // corrections + enrichment + publish
    const [afterRun] = await tdb.db.select().from(articles).where(eq(articles.id, art));
    expect(afterRun!.enrichedAt).not.toBeNull();

    const res = await proposeFactFromArticle(normalized as unknown as Db, deps.router, {
      articleId: art,
      entityId: refco,
      resolverConfidence: 0.9,
    });
    expect(res.proposed).toBe(true);
    // Harness part 3 already promoted this canonical fact (dedup_key merge);
    // re-proposal finds it accepted either way.
    const [factRow] = await tdb.db.select().from(facts).where(eq(facts.entityId, refco));
    expect(factRow!.status).toBe("accepted");

    const [after] = await tdb.db.select().from(entities).where(eq(entities.id, refco));
    expect(after!.fundingStage).toBe("series_b");
    expect(after!.sourceRefs).toContain(art);

    // R07 verify probe: accepted facts older than the SLA lacking derived fields = 0.
    const repaired = await repairFactPropagation(normalized as unknown as Db);
    expect(repaired).toBe(0);
  });
});

describe("R09 — budget degradation disclosed, never silent", () => {
  it("hard-cap exhaustion throws AND records exactly one disclosed stop event per month", async () => {
    // Push the month's ledger spend over the default cap ($250).
    await tdb.db.insert(llmCalls).values({
      id: opaqueId("llm"),
      stage: "test_spend",
      tier: "big",
      model: "test-model",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 5000,
    });

    const capped = new LlmRouter(normalized as unknown as Db, makeProvider());
    let threw: unknown = null;
    try {
      await capped.chatJson(z.object({ v: z.string() }), "s", "u", { stage: "test", tier: "big" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(BudgetDegradedError);
    expect((threw as BudgetDegradedError).reason).toBe("hard_cap_exhausted");

    // The same blocked call path wrote the disclosure event (once per kind+month).
    const events = await tdb.db.select().from(pipelineEvents);
    const stops = events.filter((e) => e.kind === "budget_stop_hard");
    expect(stops.length).toBe(1);
    expect(stops[0]!.dedupKey).toBe(`budget_stop_hard:${new Date().toISOString().slice(0, 7)}`);
    expect(stops[0]!.message).toContain("spent");

    // Dashboard-facing reader exposes the event.
    const { recentPipelineEvents } = await import("../../src/llm/router.js");
    const recent = await recentPipelineEvents(normalized as unknown as Db);
    expect(recent.some((e) => e.kind === "budget_stop_hard")).toBe(true);

    // Remove the synthetic spend so later tests see a clean budget.
    await tdb.db.delete(llmCalls).where(eq(llmCalls.stage, "test_spend"));
  });

  it("ledger rows carry prompt template + version for every chat call (G4/R08)", async () => {
    const art = await insertFixtureArticle({
      url: "https://techcrunch.com/2026/08/21/r08-ledger/",
      title: "Acme Robotics secures $12M Series A as warehouse automation demand climbs",
    });
    await handleFilterArticle(deps as never, art);
    await runHarness(deps as never);
    const rows = await tdb.db.select().from(llmCalls);
    const audited = rows.filter((r) => r.stage === "batch_audit");
    expect(audited.length).toBeGreaterThan(0);
    for (const r of audited) {
      expect(r.promptTemplate).toBe("batch_audit");
      expect(r.promptTemplateVersion).toMatch(/#\d+$/);
    }
  });
});

describe("R10 — automated source lifecycle", () => {
  it("prunes failure-streak sources inactive and audits the transition", async () => {
    const s = await deps.registry.create({
      name: "dead feed",
      publisher: "Dead Feed",
      feedUrl: "https://dead.example.com/rss",
      tier: 3,
      defaultLanguage: "en",
      topics: [],
      active: true,
    });
    await deps.registry.recordFetchFailure(s.id, "timeout");
    await deps.registry.recordFetchFailure(s.id, "timeout");
    await tdb.db
      .update(sources)
      .set({ failureStreak: 10 })
      .where(eq(sources.id, s.id));

    const report = await runSourceLifecycleTick(normalized as unknown as Db);
    expect(report.pruned).toContain(s.id);
    const [row] = await tdb.db.select().from(sources).where(eq(sources.id, s.id));
    expect(row!.active).toBe(false);
    const evts = await tdb.db.select().from(sourceEvents).where(eq(sourceEvents.sourceId, s.id));
    expect(evts.some((e) => e.event === "pruned")).toBe(true);
  });

  it("marks stale onboarded-but-never-fetched sources unhealthy once", async () => {
    const s = await deps.registry.create({
      name: "stale feed",
      publisher: "Stale Feed",
      feedUrl: "https://stale.example.com/rss",
      tier: 3,
      defaultLanguage: "en",
      topics: [],
      active: true,
    });
    await tdb.db.execute(sql`
      UPDATE sources SET created_at = now() - interval '48 hours' WHERE id = ${s.id}
    `);
    const report1 = await runSourceLifecycleTick(normalized as unknown as Db);
    expect(report1.onboardUnhealthy).toContain(s.id);
    const report2 = await runSourceLifecycleTick(normalized as unknown as Db);
    expect(report2.onboardUnhealthy).not.toContain(s.id); // audited once per window
  });
});

describe("R13 — funnel observability", () => {
  it("rolls a day up idempotently", async () => {
    const day = "2026-08-20";
    const first = await rollupFunnelDay(normalized as unknown as Db, day);
    const second = await rollupFunnelDay(normalized as unknown as Db, day);
    expect(second).toEqual(first);
    const rows = await tdb.db.select().from(funnelDaily).where(eq(funnelDaily.day, day));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rawItems).toBeGreaterThanOrEqual(0);
  });

  it("alerts when any stage deviates >30% week-over-week", async () => {
    const days: FunnelDay[] = [];
    for (let i = 0; i < 14; i++) {
      days.push({
        day: `2026-08-${String(i + 1).padStart(2, "0")}`,
        rawItems: 100,
        fetched: 100,
        extracted: 100,
        kept: i < 7 ? 40 : 10, // -75% WoW -> alert
        prefilterDiscards: 30,
        llmDiscards: 20,
        quarantined: 0,
        parkedFailures: 0,
        resolved: 20,
        enriched: 20,
        clustered: 20,
        factsProposed: 2,
        factsAccepted: 1,
        needsBackfillOutstanding: 0,
        profilesComplete: 0,
      });
    }
    const alerts = computeFunnelAlerts(days);
    expect(alerts.some((a) => a.stage === "kept" && Math.abs(a.delta_pct) > 30)).toBe(true);
    // Stable stages produce no alerts.
    expect(alerts.some((a) => a.stage === "factsAccepted")).toBe(false);
    // Short windows cannot alert.
    expect(computeFunnelAlerts(days.slice(0, 10))).toEqual([]);
  });
});

describe("R14 — determinism where it matters", () => {
  it("identical fixtures get identical filter/resolve decisions on replay", async () => {
    const mk = async (n: number) =>
      insertFixtureArticle({
        url: `https://techcrunch.com/2026/08/21/r14-det-${n}/`,
        title: "Zeta Systems raises $5M seed round",
        body: "Zeta Systems, an Austin robotics startup, raised a $5 million seed round led by Hex Ventures to expand its warehouse robots fleet. ".repeat(8),
        outlinkDomains: [],
      });
    const a = await mk(1);
    const b = await mk(2);

    const fa = await handleFilterArticle(deps as never, a);
    const fb = await handleFilterArticle(deps as never, b);
    expect(fa.waiting).toBe(fb.waiting);

    const decide = async (id: string) => {
      const [row] = await tdb.db.select().from(articles).where(eq(articles.id, id));
      const stored = (await deps.storage.get(row!.extractedTextPath ?? "")) ?? "";
      return resolveArticle(normalized as unknown as Db, deps.router, {
        articleId: id,
        title: row!.title,
        lead: stored.slice(0, 1600) || row!.title,
        outlinkDomains: row!.outlinkDomains,
      });
    };
    const ra = await decide(a);
    const rb = await decide(b);
    expect(ra.primaryEntityId ?? null).toBe(rb.primaryEntityId ?? null);
    expect(ra.primaryConfidence ?? null).toBe(rb.primaryConfidence ?? null);

    // Replay lands on identical values again.
    const ra2 = await decide(a);
    expect(ra2.primaryEntityId ?? null).toBe(ra.primaryEntityId ?? null);
    expect(ra2.primaryConfidence ?? null).toBe(ra.primaryConfidence ?? null);
  });
});
