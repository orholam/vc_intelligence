import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import { opaqueId } from "../../src/lib/ulid.js";
import { sha256Hex, canonicalizeUrl } from "../../src/lib/hash.js";
import { rawItems, entities, aliases, articles, articleEntities, facts, pipelineTraces } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/index.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { LocalStorage } from "../../src/storage.js";
import { handleFilterArticle } from "../../src/queue/jobs.js";
import { runHarness } from "../../src/harness/run.js";

/**
 * End-to-end pipeline over an in-process Postgres (PGlite) with the offline
 * mock LLM: programmatic filter -> WAITING ROOM -> harness (corrections ->
 * story match -> publish). Golden-ish assertions lock resolver + enrichment
 * behavior on fixture articles (NFR-5).
 */

let tdb: TestDb;
let normalized: ReturnType<typeof normalizeExecuteShape>;
let deps: {
  db: Db;
  registry: SourceRegistry;
  router: LlmRouter;
  storage: LocalStorage;
};

async function insertFixtureArticle(opts: {
  title: string;
  body: string;
  url: string;
  publisherDomain: string;
  outlinkDomains?: string[];
  publishedAt?: Date;
  sourceId?: string | null;
}) {
  const id = opaqueId("art");
  const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR ?? "/tmp/opencode/intel-test-storage");
  const path = await storage.put(`articles/${id}.txt`, opts.body);
  await tdb.db.insert(articles).values({
    id,
    url: canonicalizeUrl(opts.url),
    urlHash: sha256Hex(canonicalizeUrl(opts.url)),
    publisherDomain: opts.publisherDomain,
    title: opts.title,
    publishedAt: opts.publishedAt ?? new Date(),
    language: "en",
    extractedTextPath: path,
    extractedTextChars: opts.body.length,
    extractedTextHash: sha256Hex(opts.body),
    excerptText: opts.body.slice(0, 400),
    outlinkDomains: opts.outlinkDomains ?? [],
    noiseStage: "pending",
    sourceId: opts.sourceId ?? null,
  });
  return id;
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

  // Seed one source (tier 1) and two entities with aliases.
  const tcSource = await deps.registry.create({
    name: "techcrunch",
    publisher: "TechCrunch",
    feedUrl: "https://techcrunch.com/feed/",
    tier: 1,
    country: "us",
    defaultLanguage: "en",
    topics: [],
    active: true,
  });
  process.env.INTEL_TEST_TC_SOURCE = tcSource.id;

  const acme = opaqueId("ent");
  await tdb.db.insert(entities).values({
    id: acme,
    canonicalName: "Acme Robotics",
    website: "acme.ai",
    type: "private",
    status: "operating",
    country: "US",
    hqCity: "San Francisco",
    foundedYear: 2021,
    industryTags: ["robotics_hardware"],
    confidence: 0.9,
    isMonitored: true,
  });
  for (const [alias, kind] of [
    ["Acme Robotics", "name"],
    ["Acme", "abbrev"],
    ["acme.ai", "domain"],
  ] as const) {
    await tdb.db.insert(aliases).values({
      id: opaqueId("als"),
      entityId: acme,
      alias,
      aliasNormalized: alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      kind,
    });
  }

  // A namesake in a different industry/country — the FR-11 namesake trap.
  const acmeFoods = opaqueId("ent");
  await tdb.db.insert(entities).values({
    id: acmeFoods,
    canonicalName: "Acme Foods",
    website: "acmefoods.co.uk",
    type: "private",
    status: "operating",
    country: "GB",
    industryTags: ["restaurants_delivery"],
    confidence: 0.8,
  });
  await tdb.db.insert(aliases).values({
    id: opaqueId("als"),
    entityId: acmeFoods,
    alias: "Acme",
    aliasNormalized: "acme",
  });
});

describe("FR-2 ingestion dedup", () => {
  it("raw item url_hash unique index blocks duplicates", async () => {
    const url = "https://techcrunch.com/2026/08/21/acme-raises/";
    const base = {
      id: opaqueId("rit"),
      discoveredVia: "rss" as const,
      sourceId: null,
      url: canonicalizeUrl(url),
      urlHash: sha256Hex(canonicalizeUrl(url)),
      guidHash: sha256Hex("guid-1"),
      title: "t",
      publishedAt: new Date(),
    };
    const first = await tdb.db.insert(rawItems).values(base).onConflictDoNothing().returning({ id: rawItems.id });
    const second = await tdb.db.insert(rawItems).values(base).onConflictDoNothing().returning({ id: rawItems.id });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("dedupe trace detail (what it duplicated against)", () => {
  it("records a human-readable duplicate line naming the original copy", async () => {
    const title = "Nimbus Cloud raises $9M Series A to expand its managed Kubernetes platform";
    const body =
      "Nimbus Cloud, a Seattle-based developer-tools startup, announced a $9 million Series A round led by Accel. " +
      "The company will use the capital to expand its managed Kubernetes platform and double the engineering team next year. ".repeat(4);
    const origId = await insertFixtureArticle({
      title,
      body,
      url: "https://alphaoutlet.com/2026/09/01/nimbus-raises/",
      publisherDomain: "alphaoutlet.com",
      publishedAt: new Date(Date.now() - 3600_000),
    });
    const dupId = await insertFixtureArticle({
      title,
      body,
      url: "https://betaoutlet.com/2026/09/01/nimbus-raises-syndicated/",
      publisherDomain: "betaoutlet.com",
      publishedAt: new Date(Date.now() - 1200_000),
    });

    const res = await handleFilterArticle(deps as never, dupId);
    expect(res.waiting).toBe(false);

    const [dupRow] = await tdb.db.select().from(articles).where(eq(articles.id, dupId));
    expect(dupRow!.noiseStage).toBe("prefilter");
    // The machine reason (reconciliation contract) keeps the dup id…
    expect(dupRow!.discardReason).toBe(`title_duplicate_of:${origId}`);

    // …but the feed trace speaks human: names the original copy, not the id.
    const traces = await tdb.db.select().from(pipelineTraces).where(eq(pipelineTraces.refId, dupId));
    const dedupeTrace = traces.find((t) => t.node === "dedupe");
    const firstSeen = new Date(Date.now() - 3600_000).toISOString().slice(0, 10);
    expect(dedupeTrace?.detail).toContain(`duplicate of “${title}”`);
    expect(dedupeTrace?.detail).toContain("by alphaoutlet.com");
    expect(dedupeTrace?.detail).toContain(`first seen ${firstSeen}`);
    expect(dedupeTrace?.detail).toContain("this copy: betaoutlet.com");
    expect(dedupeTrace?.detail).not.toMatch(/^title_duplicate_of|duplicate_url_hash/);
  });
});

describe("pipeline: filter -> waiting room -> harness publish", () => {
  let articleA: string;

  it("filters a genuine funding article into the WAITING ROOM (no LLM inline)", async () => {
    articleA = await insertFixtureArticle({
      title: "Acme Robotics raises $12M Series A led by Sequoia Capital",
      body:
        "Acme Robotics, the San Francisco robotics startup, announced a $12 million Series A round led by Sequoia Capital. " +
        "The company will expand manufacturing of its warehouse robots and hire across engineering, backed by strong customer demand and record growth. ".repeat(6),
      url: "https://techcrunch.com/2026/08/21/acme-raises/",
      publisherDomain: "techcrunch.com",
      outlinkDomains: ["acme.ai"],
      sourceId: process.env.INTEL_TEST_TC_SOURCE,
    });
    const res = await handleFilterArticle(deps as never, articleA);
    expect(res.waiting).toBe(true);
    const art = (await tdb.db.select().from(articles)).find((a) => a.id === articleA)!;
    expect(art.noiseStage).toBe("waiting");
  });

  it("harness corrects, resolves, enriches, clusters and PUBLISHES winners", async () => {
    // A syndicated copy enters the room too — must collapse into one story.
    const dupB = await insertFixtureArticle({
      title: "Acme Robotics raises $12M Series A led by Sequoia Capital",
      body:
        "Acme Robotics, the San Francisco robotics startup, announced a $12 million Series A round led by Sequoia Capital. " +
        "The company will expand manufacturing of its warehouse robots and hire across engineering, backed by strong customer demand and record growth. ".repeat(6),
      url: "https://siliconangle.com/2026/08/21/acme-series-a/",
      publisherDomain: "siliconangle.com",
      outlinkDomains: ["acme.ai"],
      publishedAt: new Date(Date.now() - 3600_000),
    });
    await tdb.db.update(articles).set({ noiseStage: "waiting" }).where(eqId(dupB));

    const summary = await runHarness(deps as never);
    expect(summary.scanned).toBeGreaterThanOrEqual(2);
    expect(summary.published).toBeGreaterThanOrEqual(2);

    const rows = await tdb.db.select().from(articles);
    const a = rows.find((r) => r.id === articleA)!;
    const b = rows.find((r) => r.id === dupB)!;
    expect(a.noiseStage).toBe("kept");
    expect(b.noiseStage).toBe("kept");

    // Resolution corrections: Acme Robotics via domain evidence, not the GB namesake.
    const links = await tdb.db.select().from(articleEntities);
    const primary = links.find((l) => l.articleId === articleA && l.role === "primary");
    expect(primary).toBeDefined();
    const entRows = await tdb.db.select().from(entities);
    const acmeRow = entRows.find((e) => e.id === primary!.entityId)!;
    expect(acmeRow.website).toBe("acme.ai");
    expect(primary!.confidence).toBeGreaterThan(0.55);

    // Enrichment fields (kept ACs).
    expect(a.primaryTag).toBe("funding.series_a");
    expect(a.sentiment).toBe("positive");
    expect(a.industryPrimary).toBe("robotics_hardware");
    expect(["high", "medium"]).toContain(a.newsworthiness!);
    expect(a.enrichedAt).not.toBeNull();

    // Story match: syndicated copy collapsed into ONE story (FR-17).
    expect(a.storyClusterId).toBeTruthy();
    expect(b.storyClusterId).toBe(a.storyClusterId);
    expect(a.isClusterRepresentative || b.isClusterRepresentative).toBe(true);
  });

  it("proposes and ACCEPTS a funding fact (tier-1 rule), updating entity KB fields (FR-9)", async () => {
    const { proposeFactFromArticle } = await import("../../src/entities/facts.js");
    const entRows = await tdb.db.select().from(entities);
    const acme = entRows.find((e) => e.website === "acme.ai")!;
    const res = await proposeFactFromArticle(normalized as unknown as Db, deps.router, {
      articleId: articleA,
      entityId: acme.id,
      resolverConfidence: 0.9,
    });
    expect(res.proposed).toBe(true);
    // The harness batch already proposed AND promoted this exact fact
    // (dedup_key merge); re-proposal finds the canonical row already accepted.
    const [factRow] = await tdb.db.select().from(facts).where(eq(facts.entityId, acme.id));
    expect(factRow!.status).toBe("accepted");

    const after = (await tdb.db.select().from(entities)).find((e) => e.id === acme.id)!;
    expect(after.fundingStage).toBe("series_a");
    expect(after.totalRaisedUsd).toBeGreaterThanOrEqual(12_000_000);
    expect(after.lastFundingDate).not.toBeNull();
  });
});

function eqId(id: string) {
  return eq(articles.id, id);
}
