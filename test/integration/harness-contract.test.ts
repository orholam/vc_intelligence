import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import { opaqueId } from "../../src/lib/ulid.js";
import { sha256Hex, canonicalizeUrl } from "../../src/lib/hash.js";
import { articles, llmCalls, entities, aliases } from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { LocalStorage } from "../../src/storage.js";
import { runHarness } from "../../src/harness/run.js";

let tdb: TestDb;
let normalized: ReturnType<typeof normalizeExecuteShape>;
let deps: {
  db: Db;
  registry: SourceRegistry;
  router: LlmRouter;
  storage: LocalStorage;
};

async function insertWaiting(title: string, url: string, body: string) {
  const id = opaqueId("art");
  const path = await deps.storage.put(`articles/${id}.txt`, body);
  await tdb.db.insert(articles).values({
    id,
    url: canonicalizeUrl(url),
    urlHash: sha256Hex(canonicalizeUrl(url)),
    publisherDomain: "techcrunch.com",
    title,
    publishedAt: new Date(),
    language: "en",
    extractedTextPath: path,
    extractedTextChars: body.length,
    extractedTextHash: sha256Hex(body),
    excerptText: body.slice(0, 400),
    outlinkDomains: ["acme.ai"],
    noiseStage: "waiting",
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
  const acme = opaqueId("ent");
  await tdb.db.insert(entities).values({
    id: acme,
    canonicalName: "Acme Robotics",
    website: "acme.ai",
    type: "private",
    status: "operating",
    country: "US",
    industryTags: ["robotics_hardware"],
    confidence: 0.9,
  });
  await tdb.db.insert(aliases).values({
    id: opaqueId("als"),
    entityId: acme,
    alias: "Acme Robotics",
    aliasNormalized: "acme robotics",
    kind: "name",
  });
  await tdb.db.insert(aliases).values({
    id: opaqueId("als"),
    entityId: acme,
    alias: "acme.ai",
    aliasNormalized: "acme.ai",
    kind: "domain",
  });
});

afterAll(async () => {
  await tdb.destroy();
});

describe("harness contract: batch audit + mock refuse", () => {
  it("audits the waiting-room pile in one batch_audit call, not N classify_enrich jobs", async () => {
    const body =
      "Acme Robotics announced a $12 million Series A round led by Sequoia Capital. ".repeat(8);
    const a = await insertWaiting(
      "Acme Robotics raises $12M Series A led by Sequoia Capital",
      "https://techcrunch.com/2026/08/26/batch-a/",
      body,
    );
    const b = await insertWaiting(
      "Acme Robotics raises $12M Series A led by Sequoia Capital",
      "https://siliconangle.com/2026/08/26/batch-b/",
      body,
    );

    const summary = await runHarness(deps as never);
    expect(summary.scanned).toBeGreaterThanOrEqual(2);
    expect(summary.published).toBeGreaterThanOrEqual(2);

    const calls = await tdb.db.select().from(llmCalls);
    const audits = calls.filter((c) => c.stage === "batch_audit");
    const classify = calls.filter((c) => c.stage === "classify_enrich");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(classify.length).toBe(0);

    const [rowA] = await tdb.db.select().from(articles).where(eq(articles.id, a));
    const [rowB] = await tdb.db.select().from(articles).where(eq(articles.id, b));
    expect(rowA!.noiseStage).toBe("kept");
    expect(rowB!.noiseStage).toBe("kept");
    expect(rowA!.industryPrimary).not.toBe("other_diversified");
    expect(rowA!.industryPrimary).toBeTruthy();
  });

  it("re-audits items that already have resolvedAt/enrichedAt (no skip flags)", async () => {
    const id = await insertWaiting(
      "Acme Robotics raises $25M Series B",
      "https://techcrunch.com/2026/08/26/reaudit/",
      "Acme Robotics closed a $25 million Series B. ".repeat(8),
    );
    await tdb.db
      .update(articles)
      .set({
        resolvedAt: new Date("2020-01-01"),
        enrichedAt: new Date("2020-01-01"),
        primaryTag: "status.no_event",
        industryPrimary: "other_diversified",
      })
      .where(eq(articles.id, id));

    await runHarness(deps as never);
    const [row] = await tdb.db.select().from(articles).where(eq(articles.id, id));
    expect(row!.noiseStage).toBe("kept");
    expect(row!.primaryTag).toBe("funding.series_b");
  });
});
