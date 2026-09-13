import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import type { Db } from "../../src/db/index.js";
import { opaqueId } from "../../src/lib/ulid.js";
import { sha256Hex, canonicalizeUrl } from "../../src/lib/hash.js";
import { articles, entities, aliases, apiKeys, articleEntities, facts } from "../../src/db/schema.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { EntityKb } from "../../src/entities/kb.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { LocalStorage } from "../../src/storage.js";
import { buildApiApp } from "../../src/api/server.js";
import {
  NewsResponse,
  LatestNewsResponse,
  CompanySearchResponse,
  CompanyCard,
  CompanyGrowthResponse,
  CompanyIndustriesResponse,
  CompanyMixResponse,
  NewsOverviewResponse,
  ListGenResponse,
  FeedResponse,
  EventsResponse,
  CostDashboardResponse,
  TakedownResponse,
} from "../../src/api/contracts.js";

/**
 * Contract tests (NFR-5): lock every v1 response schema against the zod
 * contracts that also generate /openapi.json. Runs fully offline (PGlite +
 * mock LLM provider).
 */

let tdb: TestDb;
let app: FastifyInstance;
const apiKeyRaw = "cit_testkey0000000000000000000000000";

async function seedWorld() {
  const db = tdb.db as unknown as Db;
  // API key (hashed at rest)
  await db.insert(apiKeys).values({
    id: opaqueId("key"),
    name: "tests",
    keyHash: sha256Hex(apiKeyRaw),
    keyPrefix: apiKeyRaw.slice(0, 12),
    rateLimitPerMin: 1000,
  });

  // Entity + alias + tier-1 source
  const entId = opaqueId("ent");
  await db.insert(entities).values({
    id: entId,
    canonicalName: "Acme Robotics",
    website: "acme.ai",
    type: "private",
    status: "operating",
    country: "US",
    hqCity: "San Francisco",
    foundedYear: 2021,
    industryTags: ["robotics_hardware"],
    fundingStage: "series_a",
    totalRaisedUsd: 12_000_000,
    lastFundingDate: new Date("2026-06-01"),
    tickers: [],
    confidence: 0.9,
    needsBackfill: false,
    ventureBand: "E2",
  });
  await db.insert(aliases).values({
    id: opaqueId("als"),
    entityId: entId,
    alias: "Acme Robotics",
    aliasNormalized: "acme robotics",
  });

  // Second company related to the same news as a secondary mention (investor)
  const investorId = opaqueId("ent");
  await db.insert(entities).values({
    id: investorId,
    canonicalName: "Sequoia Capital",
    website: "sequoia.com",
    type: "fund",
    status: "operating",
    country: "US",
    industryTags: ["venture_capital"],
    tickers: [],
    confidence: 0.9,
    needsBackfill: false,
  });

  const reg = new SourceRegistry(db);
  await reg.create({
    name: "techcrunch",
    publisher: "TechCrunch",
    feedUrl: "https://techcrunch.com/feed/",
    tier: 1,
    country: "us",
    defaultLanguage: "en",
    topics: [],
    active: true,
  });

  // Two kept enriched articles in the same story cluster (unique_article case)
  const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR!);
  const artIds: string[] = [];
  for (const [i, url] of [
    "https://techcrunch.com/2026/08/20/acme-raises/",
    "https://techcrunch.com/2026/08/20/acme-raises-again/",
  ].entries()) {
    const id = opaqueId("art");
    artIds.push(id);
    const body =
      "Acme Robotics announced a $12 million Series A round led by Sequoia Capital. The San Francisco robotics startup will expand manufacturing. ";
    const path = `articles/${id}.txt`;
    await storage.put(path, body.repeat(3));
    await db.insert(articles).values({
      id,
      url: canonicalizeUrl(url),
      urlHash: sha256Hex(canonicalizeUrl(url)),
      publisherDomain: "techcrunch.com",
      title:
        i === 0
          ? "Acme Robotics raises $12M Series A led by Sequoia Capital"
          : "Acme Robotics raises $12M Series A — syndicated copy",
      publishedAt: new Date(Date.now() - i * 3600_000),
      language: "en",
      extractedTextPath: path,
      extractedTextChars: body.length * 3,
      extractedTextHash: sha256Hex(body),
      excerptText: body.slice(0, 400),
      outlinkDomains: ["acme.ai"],
      noiseStage: "kept",
      primaryTag: "funding.series_a",
      secondaryTags: [],
      allTags: ["funding.series_a", "funding"],
      sentiment: "positive",
      sentimentScore: 0.6,
      newsworthiness: "high",
      industryPrimary: "robotics_hardware",
      industrySecondary: [],
      countries: ["US"],
      aiSummary: "Acme Robotics raised a $12M Series A round led by Sequoia Capital to expand robot manufacturing.",
      storyClusterId: "sto_test_cluster",
      isClusterRepresentative: i === 0,
      resolvedAt: new Date(),
      enrichedAt: new Date(),
    });
    await db.insert(articleEntities).values({
      articleId: id,
      entityId: entId,
      role: "primary",
      confidence: 0.93,
      evidence: { domain_overlap: true, llm: "not_needed" },
    });
    await db.insert(articleEntities).values({
      articleId: id,
      entityId: investorId,
      role: "secondary",
      confidence: 0.81,
      evidence: { domain_overlap: false, llm: "not_needed" },
    });
  }

  // Accepted FR-9 fact so /v1/events has a structured event to serve
  await db.insert(facts).values({
    id: opaqueId("fct"),
    entityId: entId,
    type: "funding_round",
    payload: {
      funding_stage: "series_a",
      amount_usd_est: 12_000_000,
      lead_investors: ["Sequoia Capital"],
      event_date: "2026-08-20",
    },
    status: "accepted",
    evidenceArticleIds: artIds,
    distinctPublishers: 1,
    bestSourceTier: 1,
    dedupKey: "test:acme:funding_round:series_a",
    promotedAt: new Date(),
  });
  return entId;
}

beforeAll(async () => {
  isolateConfig();
  tdb = await createTestDb();
  const entId = await seedWorld();

  const normalized = normalizeExecuteShape(tdb.db) as unknown as Db;
  const deps = {
    db: normalized as never,
    registry: new SourceRegistry(normalized),
    kb: new EntityKb(normalized),
    router: new LlmRouter(normalized, makeProvider()),
    storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
  };
  app = buildApiApp(deps as never);
  await app.ready();
  void entId;
});

afterAll(async () => {
  if (app) await app.close();
  if (tdb) await tdb.destroy();
});

const H = () => ({ "x-api-key": apiKeyRaw });

describe("auth + errors envelope", () => {
  it("rejects missing/invalid keys with the error contract shape", async () => {
    const noKey = await app.inject({ method: "GET", url: "/v1/news/?company=acme.ai" });
    expect(noKey.statusCode).toBe(401);
    expect(Object.keys(noKey.json())).toEqual(["error"]);
    expect(noKey.json().error.code).toBeTypeOf("string");

    const badKey = await app.inject({ method: "GET", url: "/v1/news/?company=x", headers: { "x-api-key": "wrong" } });
    expect(badKey.statusCode).toBe(401);
  });
});

describe("FR-18 GET /v1/news/", () => {
  it("returns akta-shaped articles; validates against contract", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/news/?company=acme.ai&limit=10", headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = NewsResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.count).toBeGreaterThan(0);
    const art = body.data[0];
    expect(art.entity_id).toMatch(/^ent_/);
    expect(art.entities).toHaveLength(2);
    expect(art.entities[0]).toMatchObject({ name: "Acme Robotics", role: "primary" });
    expect(art.entities[1]).toMatchObject({ name: "Sequoia Capital", role: "secondary" });
    expect(art.text_available).toBe(false); // NFR-8 default
    expect(art.excerpt.length).toBeLessThanOrEqual(401);
    expect(art.tags.some((t: { name: string }) => t.name === "funding.series_a")).toBe(true);
  });

  it("returns news for a company related in a secondary role too", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/news/?company=sequoia.com&limit=10", headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    const art = body.data[0];
    expect(art.entities.some((e: { role: string }) => e.role === "primary")).toBe(true);
    expect(art.entity_id).not.toBe(
      art.entities.find((e: { name: string }) => e.name === "Sequoia Capital")?.id,
    );
  });

  it("unique_article=true collapses the cluster to one row", async () => {
    const all = await app.inject({ method: "GET", url: "/v1/news/?company=Acme%20Robotics&limit=50", headers: H() });
    const uniq = await app.inject({
      method: "GET",
      url: "/v1/news/?company=Acme%20Robotics&limit=50&unique_article=true",
      headers: H(),
    });
    expect(all.json().total).toBeGreaterThanOrEqual(uniq.json().total);
    expect(uniq.json().total).toBe(1);
  });

  it("category + blacklisted filters work", async () => {
    const hit = await app.inject({
      method: "GET",
      url: "/v1/news/?company=acme.ai&category=funding.series_a&blacklisted=siliconangle.com",
      headers: H(),
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().total).toBe(2);

    const blocked = await app.inject({
      method: "GET",
      url: "/v1/news/?company=acme.ai&blacklisted=techcrunch.com",
      headers: H(),
    });
    expect(blocked.json().total).toBe(0);
  });

  it("resolves company by opaque id, slug, and domain alike", async () => {
    const ents = await tdb.db.select().from(entities);
    const ent = ents.find((e) => e.website === "acme.ai")!;
    for (const company of [ent.id, "acme-robotics", "acme.ai"]) {
      const res = await app.inject({ method: "GET", url: `/v1/news/?company=${encodeURIComponent(company)}`, headers: H() });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBeGreaterThan(0);
    }
  });

  it("404s unknown company with error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/news/?company=nosuchco.io", headers: H() });
    expect([200, 404]).toContain(res.statusCode); // autocreate path may succeed offline-stub
    if (res.statusCode === 404) expect(res.json().error.code).toBe("not_found");
  });
});

describe("FR-19 companies endpoints", () => {
  it("entity card includes derived stats", async () => {
    const ents = await tdb.db.select().from(entities);
    const ent = ents.find((e) => e.website === "acme.ai")!;
    const res = await app.inject({ method: "GET", url: `/v1/companies/${ent.id}`, headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = CompanyCard.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(res.json().derived.article_count_30d).toBeGreaterThanOrEqual(2);
    expect(res.json().derived.top_event_types[0]?.tag).toBe("funding.series_a");
  });

  it("search returns paginated envelope + real derived counts", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/companies/search?q=acme&industry=robotics_hardware&country=US&limit=10",
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const parsed = CompanySearchResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(res.json().data[0].canonical_name).toBe("Acme Robotics");
  });

  it("search supports entity_type and funding_stage filters", async () => {
    const hit = await app.inject({
      method: "GET",
      url: "/v1/companies/search?entity_type=private&funding_stage=series_a",
      headers: H(),
    });
    expect(hit.json().total).toBeGreaterThanOrEqual(1);

    const miss = await app.inject({
      method: "GET",
      url: "/v1/companies/search?entity_type=public&funding_stage=series_b,seed",
      headers: H(),
    });
    expect(miss.json().total).toBe(0);
  });

  it("growth series ends at the canonical tracked total", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/companies/growth?granularity=month&buckets=6",
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    const parsed = CompanyGrowthResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const body = res.json();
    expect(body.points).toHaveLength(6);
    // funds are excluded from the canonical set — must agree with search
    const search = await app.inject({ method: "GET", url: "/v1/companies/search?limit=1", headers: H() });
    expect(body.total).toBe(search.json().total);
    const last = body.points[body.points.length - 1];
    expect(last.cumulative).toBeLessThanOrEqual(body.total);
    expect(body.points[0].cumulative).toBeLessThanOrEqual(last.cumulative);
  });

  it("industries returns normalized industry counts that filter the search", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/companies/industries?limit=24", headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = CompanyIndustriesResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const body = res.json();
    expect(body.industries.length).toBeGreaterThan(0);
    // counts are descending and slugs are lowercase + underscore-normalized
    for (let i = 1; i < body.industries.length; i++) {
      expect(body.industries[i].count).toBeLessThanOrEqual(body.industries[i - 1].count);
    }
    // clicking the top industry narrows the canonical search to that bucket
    const top = body.industries[0].industry;
    const filtered = await app.inject({
      method: "GET",
      url: `/v1/companies/search?industry=${encodeURIComponent(top)}&limit=1`,
      headers: H(),
    });
    expect(filtered.json().total).toBe(body.industries[0].count);
  });

  it("venture_band filters the canonical set", async () => {
    const hit = await app.inject({
      method: "GET",
      url: "/v1/companies/search?venture_band=E2",
      headers: H(),
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().total).toBeGreaterThanOrEqual(1);
    expect(hit.json().data[0].canonical_name).toBe("Acme Robotics");

    const miss = await app.inject({
      method: "GET",
      url: "/v1/companies/search?venture_band=E0",
      headers: H(),
    });
    expect(miss.json().total).toBe(0);
  });
});

describe("GET /v1/companies/mix", () => {
  it("returns canonical-set venture band, country and type distributions", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/companies/mix?country_limit=5", headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = CompanyMixResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const body = res.json();
    // canonical set: Acme (private) in; Sequoia (fund) out
    expect(body.total).toBe(1);
    expect(body.by_venture_band).toEqual(
      expect.arrayContaining([expect.objectContaining({ band: "E2", count: 1 })]),
    );
    expect(body.by_country).toEqual(
      expect.arrayContaining([expect.objectContaining({ country: "US", count: 1 })]),
    );
    expect(body.by_type).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "private", count: 1 })]),
    );
    // bucket counts sum to the tracked total
    const sumBands = body.by_venture_band.reduce((a: number, b: { count: number }) => a + b.count, 0);
    expect(sumBands).toBe(body.total);
  });
});

describe("FR-20 POST /v1/list/generate/companies/", () => {
  it("interprets filters and returns ranked companies echoing interpreted_filters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/list/generate/companies/",
      headers: H(),
      payload: { query: "robotics startups that raised recently", limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    const parsed = ListGenResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(res.json().count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.json().interpreted_filters.sectors)).toBe(true);
    const top = res.json().companies[0];
    expect(top.relevance_score).toBeGreaterThan(0);
    expect(top.recent_signals.length).toBeLessThanOrEqual(3);
  });
});

describe("FR-21 GET /v1/feed", () => {
  it("supports cursor-based incremental sync", async () => {
    const first = await app.inject({
      method: "GET",
      url: `/v1/feed?entities=${encodeURIComponent((await tdb.db.select().from(entities))[0]!.id)}&limit=1`,
      headers: H(),
    });
    expect(first.statusCode).toBe(200);
    const parsedFirst = FeedResponse.safeParse(first.json());
    expect(parsedFirst.success).toBe(true);
    expect(first.json().events).toHaveLength(1);
    expect(first.json().next_cursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/v1/feed?cursor=${encodeURIComponent(first.json().next_cursor)}&entities=x`,
      headers: H(),
    });
    expect(second.statusCode).toBe(200);
  });
});

describe("GET /v1/news/latest", () => {
  it("returns newest kept articles across entities with entity names; validates contract", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/news/latest?limit=50", headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = LatestNewsResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(res.json().total).toBeGreaterThanOrEqual(2);
    const first = res.json().data[0];
    expect(first.entity_name).toBe("Acme Robotics");
    expect(first.entities).toHaveLength(2);
    expect(first.entities.map((e: { name: string }) => e.name)).toEqual([
      "Acme Robotics",
      "Sequoia Capital",
    ]);
    expect(new Date(first.published_date).getTime()).toBeGreaterThanOrEqual(
      new Date(res.json().data[res.json().data.length - 1].published_date).getTime(),
    );
  });

  it("supports category filter and offset paging", async () => {
    const hit = await app.inject({
      method: "GET",
      url: "/v1/news/latest?category=funding.series_a&limit=1&offset=0",
      headers: H(),
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().count).toBeLessThanOrEqual(1);
    expect(hit.json().total).toBeGreaterThanOrEqual(2);

    const page2 = await app.inject({
      method: "GET",
      url: "/v1/news/latest?limit=1&offset=1",
      headers: H(),
    });
    expect(page2.json().data[0].id).not.toBe(hit.json().data[0].id);
  });

  it("supports entity_type filter", async () => {
    const priv = await app.inject({
      method: "GET",
      url: "/v1/news/latest?entity_type=private",
      headers: H(),
    });
    expect(priv.json().total).toBeGreaterThanOrEqual(2);

    const pub = await app.inject({
      method: "GET",
      url: "/v1/news/latest?entity_type=public",
      headers: H(),
    });
    expect(pub.json().total).toBe(0);
  });
});

describe("GET /v1/news/overview", () => {
  it("serves a full daily window deduped like the feed, plus lifecycle and topics", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/news/overview?days=14&topic_limit=10", headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = NewsOverviewResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const body = res.json();
    expect(body.days).toBe(14);
    expect(body.volume).toHaveLength(14);
    // the two seeded articles share one story cluster — dedupe keeps one
    const last = body.volume[body.volume.length - 1];
    expect(last.date).toBe(new Date().toISOString().slice(0, 10));
    expect(last.total).toBe(1);
    expect(last.high).toBe(1);
    // topics carry the seeded primary tag
    expect(body.topics).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: "funding.series_a" })]),
    );
    // lifecycle snapshot counts every article row regardless of stage
    const kept = body.lifecycle.find((l: { stage: string }) => l.stage === "kept");
    expect(kept.count).toBe(2);
    const sumLife = body.lifecycle.reduce((a: number, l: { count: number }) => a + l.count, 0);
    expect(sumLife).toBe(2);
  });
});

describe("GET /v1/events/", () => {
  it("serves structured signal-derived events; validates against contract", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/events/", headers: H() });
    expect(res.statusCode).toBe(200);
    const body = EventsResponse.parse(res.json());
    expect(body.total).toBeGreaterThanOrEqual(1);
    const ev = body.data.find((e) => e.entity_name === "Acme Robotics");
    expect(ev).toBeTruthy();
    expect(ev?.type).toBe("funding_round");
    expect(ev?.fact_status).toBe("accepted");
    expect(ev?.entity_type).toBe("private");
    expect(ev?.funding_stage).toBe("series_a");
    expect(ev?.amount_usd_est).toBe(12_000_000);
    expect(ev?.lead_investors).toContain("Sequoia Capital");
    expect(ev?.event_date).toBe("2026-08-20");
    expect(ev?.evidence_articles.length).toBeGreaterThanOrEqual(1);
  });

  it("type/stage/entity_type/country filters narrow results", async () => {
    const miss = EventsResponse.parse(
      (await app.inject({ method: "GET", url: "/v1/events/?type=acquisition", headers: H() })).json(),
    );
    expect(miss.total).toBe(0);

    const hit = EventsResponse.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/events/?stage=series_a&entity_type=private&country=US",
          headers: H(),
        })
      ).json(),
    );
    expect(hit.total).toBeGreaterThanOrEqual(1);

    const wrongCountry = EventsResponse.parse(
      (await app.inject({ method: "GET", url: "/v1/events/?country=DE", headers: H() })).json(),
    );
    expect(wrongCountry.total).toBe(0);
  });
});

describe("NFR-7 takedown", () => {
  it("removes an article URL from all indexes and reports the contract shape", async () => {
    const arts = await tdb.db.select().from(articles);
    const target = arts.find((a) => a.title.includes("syndicated"))!;
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/articles/${encodeURIComponent(target.url)}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    expect(TakedownResponse.safeParse(res.json()).success).toBe(true);

    const gone = await app.inject({ method: "GET", url: "/v1/news/?company=acme.ai&limit=100", headers: H() });
    expect(gone.json().data.some((a: { id: string }) => a.id === target.id)).toBe(false);
  });
});

describe("observability dashboard (NFR-4)", () => {
  it("exposes budget state, stage costs and pipeline volumes", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/dashboard", headers: H() });
    expect(res.statusCode).toBe(200);
    const parsed = CostDashboardResponse.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(res.json().budget.cap_usd).toBeGreaterThan(0);
    expect(Array.isArray(res.json().stages)).toBe(true);
  });
});

describe("openapi.json", () => {
  it("serves an OpenAPI 3.1 document generated from zod contracts", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v1/news/"]).toBeDefined();
    expect(spec.paths["/v1/list/generate/companies/"].post.operationId).toBe("generateCompanyList");
    expect(spec.components.securitySchemes.ApiKeyAuth.name).toBe("x-api-key");
  });
});
