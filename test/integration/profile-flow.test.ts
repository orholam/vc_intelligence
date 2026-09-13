import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { eq } from "drizzle-orm";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import type { Db } from "../../src/db/index.js";
import { opaqueId } from "../../src/lib/ulid.js";
import { sha256Hex } from "../../src/lib/hash.js";
import {
  apiKeys,
  articleEntities,
  articles,
  entities,
  entityProfiles,
  facts,
  llmCalls,
} from "../../src/db/schema.js";
import { resetConfigCache } from "../../src/config.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { EntityKb } from "../../src/entities/kb.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { LocalStorage } from "../../src/storage.js";
import type { ChatCallOpts, ChatResult, LlmProvider } from "../../src/llm/provider.js";
import {
  dueProfileEntities,
  generateEntityProfile,
  profileProgress,
  readEntityProfile,
} from "../../src/entities/profile.js";
import { buildApiApp } from "../../src/api/server.js";
import { CompanyEnrichmentResponse } from "../../src/api/contracts-enrichment.js";

/**
 * FR-25 golden suite (offline: PGlite + mock LLM):
 *  - deterministic sections finalize from FR-9 facts / registry without LLM;
 *  - narrative sections complete via evidence-bound LLM chunks and merge over
 *    the deterministic floor;
 *  - double-run idempotence (R03 analog), budget hard-stop, parking after
 *    max attempts, due-selection gates, API contract.
 */

let tdb: TestDb;
let normalized: ReturnType<typeof normalizeExecuteShape>;
let storage: LocalStorage;
const apiKeyRaw = "cit_profilekey0000000000000000000000";

/** Provider stub whose calls always fail (parking trigger). */
class BrokenProfiler implements LlmProvider {
  async chatJson<T>(
    _schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    _system: string,
    _user: string,
    _opts: ChatCallOpts,
  ): Promise<ChatResult<T>> {
    return {
      ok: false,
      error: "simulated profiler outage",
      model: "stub",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
  async embed() {
    return { ok: false as const, error: "no embed" };
  }
}

async function seedCompany(over: Partial<typeof entities.$inferInsert> = {}): Promise<string> {
  const id = opaqueId("ent");
  await tdb.db.insert(entities).values({
    id,
    canonicalName: "Acme Robotics",
    legalName: "Acme Robotics, Inc.",
    website: "acme.ai",
    type: "private",
    status: "operating",
    country: "US",
    hqCity: "San Francisco",
    foundedYear: 2021,
    industryTags: ["robotics_hardware"],
    tickers: [],
    fundingStage: "series_b",
    totalRaisedUsd: 25_000_000,
    lastFundingDate: new Date("2026-05-14"),
    sourceRefs: [],
    confidence: 0.9,
    needsBackfill: false,
    isMonitored: true,
    ...over,
  });
  return id;
}

async function seedFact(
  entityId: string,
  type: "funding_round" | "acquisition" | "leadership_change",
  payload: Record<string, unknown>,
): Promise<void> {
  await tdb.db.insert(facts).values({
    id: opaqueId("fac"),
    entityId,
    type,
    payload: payload as never,
    status: "accepted",
    evidenceArticleIds: [],
    distinctPublishers: 2,
    promotedAt: new Date(),
    dedupKey: `${entityId}:${type}:${opaqueId("k")}`,
  });
}

describe("FR-25 company profiles (akta parity)", () => {
  let entityIdA: string; // full happy path
  let entityIdB: string; // budget hard-stop
  let entityIdC: string; // parking under broken provider

  beforeAll(async () => {
    isolateConfig();
    tdb = await createTestDb();
    normalized = normalizeExecuteShape(tdb.db) as unknown as ReturnType<typeof normalizeExecuteShape>;
    storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR!);

    await tdb.db.insert(apiKeys).values({
      id: opaqueId("key"),
      name: "tests",
      keyHash: sha256Hex(apiKeyRaw),
      keyPrefix: apiKeyRaw.slice(0, 12),
      rateLimitPerMin: 1000,
    });

    entityIdA = await seedCompany();
    entityIdB = await seedCompany({ canonicalName: "Beta Labs", website: "betalabs.io", isMonitored: false });
    entityIdC = await seedCompany({ canonicalName: "Gamma Systems", website: "gamma.dev", isMonitored: false });

    // FR-9 accepted facts for A
    await seedFact(entityIdA, "funding_round", {
      funding_stage: "series_b",
      amount_usd_est: 25_000_000,
      lead_investors: ["Founders Fund", "Index Ventures"],
      event_date: "2026-05-14",
    });
    await seedFact(entityIdA, "acquisition", {
      acquirer: "Acme Robotics",
      target: "OtherCo",
      amount_usd_est: 3_000_000,
      event_date: "2026-07-02",
    });
    await seedFact(entityIdA, "leadership_change", {
      person: "Jane Roe",
      role: "Chief Executive Officer",
      event_date: "2026-04-01",
    });

    // one kept primary article so the corpus evidence block is non-empty
    const artId = opaqueId("art");
    await tdb.db.insert(articles).values({
      id: artId,
      url: `https://news.example.com/${opaqueId("n")}`,
      urlHash: opaqueId("h"),
      publisherDomain: "news.example.com",
      title: "Acme Robotics raises $25M Series B",
      publishedAt: new Date(),
      noiseStage: "kept",
      excerptText: "Acme Robotics announced a $25 million Series B round led by Founders Fund.",
    });
    await tdb.db.insert(articleEntities).values({
      articleId: artId,
      entityId: entityIdA,
      role: "primary",
      confidence: 0.95,
    });
  });

  afterAll(async () => {
    await tdb.destroy();
  });

  it("finalizes deterministic sections; hollow mock narrative payloads stay pending", async () => {
    const router = new LlmRouter(normalized as unknown as Db, makeProvider());
    const res = await generateEntityProfile(normalized as unknown as Db, router, entityIdA);

    expect(res.skipped).toBeUndefined();
    for (const s of ["location", "company_hierarchy", "funding_detail", "mna_and_investment", "management_profile"]) {
      expect(res.finalized).toContain(s);
    }
    // firmographic mock payload has name/website so it may complete; empty
    // array sections must NOT be marked complete.
    const rows = await tdb.db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityIdA));
    expect(rows).toHaveLength(16);
    const bySection = new Map(rows.map((r) => [r.section, r]));
    for (const s of ["location", "company_hierarchy", "funding_detail", "mna_and_investment", "management_profile"]) {
      expect(bySection.get(s)!.status).toBe("complete");
    }
    expect(bySection.get("business_model")!.status).toBe("pending");
    expect(bySection.get("technology")!.status).toBe("pending");
    expect(bySection.get("product_offering")!.status).toBe("pending");

    // fact-derived payloads are exact
    const payload = new Map(rows.map((r) => [r.section, r.payload as Record<string, unknown>]));
    const funding = payload.get("funding_detail") as Record<string, unknown>;
    const overview = funding.funding_overview as Record<string, unknown>;
    expect(overview.total_funding_usd).toBe(25_000_000);
    expect((overview.funding_stage as { label: string }).label).toBe("Series B");
    const rounds = funding.funding_rounds as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(1);
    expect((rounds[0]!.investors as Array<{ name: string }>).map((i) => i.name)).toEqual([
      "Founders Fund",
      "Index Ventures",
    ]);

    const mna = payload.get("mna_and_investment") as Record<string, unknown>;
    expect((mna.mna as Array<{ acquiree: { name: string | null } }>)[0]!.acquiree.name).toBe("OtherCo");

    const mgmt = payload.get("management_profile") as Record<string, unknown>;
    const profiles = mgmt.profiles as Array<Record<string, unknown>>;
    expect(profiles[0]!.name).toBe("Jane Roe");
    expect(profiles[0]!.designation_category).toBe("Chief Executive Officer");

    const loc = payload.get("location") as Record<string, unknown>;
    expect((loc.hq as Record<string, unknown>).city).toBe("San Francisco");
    expect((loc.hq as Record<string, unknown>).region).toBe("North America");

    // merged LLM section carries both floor fields and mock-provided identity
    const firm = payload.get("firmographic") as Record<string, unknown>;
    expect(firm.name).toBe("Acme Robotics");
    expect(firm.founded_year).toBe(2021);
    expect(firm.operating_status).toBeTruthy();

    // ledger discipline (NFR-9): every chunk call recorded with template+version
    const calls = await tdb.db.select().from(llmCalls).where(eq(llmCalls.stage, "company_profile"));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.promptTemplate === "company_profile")).toBe(true);
    expect(calls.every((c) => (c.promptTemplateVersion ?? "").includes("#"))).toBe(true);
  });

  it("serves via readEntityProfile with missing-section accounting", async () => {
    const requested = ["firmographic", "funding_detail"] as const;
    const profile = await readEntityProfile(normalized as unknown as Db, entityIdA, [...requested]);
    expect(profile.completeSections).toContain("funding_detail");
    expect(profile.missingSections).not.toContain("funding_detail");
    expect((profile.sections.firmographic as Record<string, unknown>).name).toBe("Acme Robotics");
  });

  it("is idempotent on double-run (R03 analog)", async () => {
    const router = new LlmRouter(normalized as unknown as Db, makeProvider());
    const db = normalized as unknown as Db;
    const beforeRows = await tdb.db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityIdA));
    const beforeCalls = await tdb.db.select().from(llmCalls).where(eq(llmCalls.stage, "company_profile"));

    const res = await generateEntityProfile(db, router, entityIdA);
    expect(res.finalized).toHaveLength(0);
    expect(res.completed).toHaveLength(0);

    const afterRows = await tdb.db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityIdA));
    const afterCalls = await tdb.db.select().from(llmCalls).where(eq(llmCalls.stage, "company_profile"));
    expect(afterRows.map((r) => [r.section, r.status])).toEqual(beforeRows.map((r) => [r.section, r.status]));
    expect(afterCalls).toHaveLength(beforeCalls.length); // zero new spend when fresh
  });

  it("hard budget cap stops generation with rows left pending (R09 analog)", async () => {
    process.env.MONTHLY_BUDGET_USD = "0";
    resetConfigCache();
    try {
      const router = new LlmRouter(normalized as unknown as Db, makeProvider());
      const res = await generateEntityProfile(normalized as unknown as Db, router, entityIdB);
      expect(res.skipped).toBe("budget_hard");
      const rows = await tdb.db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityIdB));
      const deterministicSections = ["location", "company_hierarchy", "funding_detail", "mna_and_investment", "management_profile"];
      const llmRows = rows.filter((r) => !deterministicSections.includes(r.section));
      expect(llmRows.length).toBeGreaterThan(0);
      expect(llmRows.some((r) => r.status === "pending")).toBe(true);
      // deterministic finalize still happened — free work is not wasted
      expect(rows.filter((r) => r.status === "complete").length).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.MONTHLY_BUDGET_USD;
      resetConfigCache();
    }
  });

  it("parks sections after max attempts under a broken provider", async () => {
    const router = new LlmRouter(normalized as unknown as Db, new BrokenProfiler());
    const db = normalized as unknown as Db;
    let last;
    for (let i = 0; i < 4; i++) last = await generateEntityProfile(db, router, entityIdC, { crawl: false });
    expect(last!.failedNow.length).toBeGreaterThan(0);
    const rows = await tdb.db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityIdC));
    const failed = rows.filter((r) => r.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => (r.lastError ?? "").includes("parked_max_attempts"))).toBe(true);
    expect(failed.every((r) => r.attempts === 4)).toBe(true);
  });

  it("due-selection honors gates: fresh excluded, failed parked, funds/backfill/merged out", async () => {
    await seedCompany({ canonicalName: "Merged Co", website: null, mergedInto: entityIdA });
    await seedCompany({ canonicalName: "Some Fund", website: "fund.example", type: "fund" });
    await seedCompany({ canonicalName: "Backfill Me", website: "backfill.example", needsBackfill: true });

    const due = await dueProfileEntities(normalized as unknown as Db, 100);
    expect(due).toContain(entityIdA); // mandated narrative sections stayed pending
    expect(due).not.toContain(entityIdC); // parked failures wait for ops
    expect(due).toContain(entityIdB);

    const progress = await profileProgress(normalized as unknown as Db);
    expect(progress.sections_pending).toBeGreaterThan(0);
    expect(progress.sections_failed).toBeGreaterThan(0);
  });

  it("GET /v1/companies/:id/enrichment validates against the wire contract", async () => {
    const app: FastifyInstance = buildApiApp({
      db: normalized as unknown as Db,
      router: new LlmRouter(normalized as unknown as Db, makeProvider()),
      registry: new SourceRegistry(normalized as unknown as Db),
      kb: new EntityKb(normalized as unknown as Db),
      storage,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/companies/${entityIdA}/enrichment`,
      headers: { "x-api-key": apiKeyRaw },
    });
    expect(res.statusCode).toBe(200);
    const parsed = CompanyEnrichmentResponse.parse(res.json());
    expect(parsed.company_id).toBe(entityIdA);
    expect(parsed.complete_sections).toContain("funding_detail");
    expect(Object.keys(parsed.sections).length).toBe(parsed.complete_sections.length);

    // section filter
    const res2 = await app.inject({
      method: "GET",
      url: `/v1/companies/${entityIdA}/enrichment?sections=funding_detail`,
      headers: { "x-api-key": apiKeyRaw },
    });
    expect(res2.statusCode).toBe(200);
    const parsed2 = CompanyEnrichmentResponse.parse(res2.json());
    expect(parsed2.complete_sections).toEqual(["funding_detail"]);

    // invalid section + invalid id shapes
    const res3 = await app.inject({
      method: "GET",
      url: `/v1/companies/${entityIdA}/enrichment?sections=nonsense`,
      headers: { "x-api-key": apiKeyRaw },
    });
    expect(res3.statusCode).toBe(400);

    const res4 = await app.inject({
      method: "GET",
      url: "/v1/companies/not_an_id/enrichment",
      headers: { "x-api-key": apiKeyRaw },
    });
    expect(res4.statusCode).toBe(400);
  });
});
