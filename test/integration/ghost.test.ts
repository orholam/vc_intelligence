import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import type { Db } from "../../src/db/index.js";
import { articles, pipelineTraces, rawItems } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { LocalStorage } from "../../src/storage.js";
import { extractFromHtml } from "../../src/ingestion/extract.js";
import { ghostArticleHtml, injectGhostNews, isGhostUrl } from "../../src/ops/ghost.js";
import { handleFetchArticle, handleFilterArticle } from "../../src/queue/jobs.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { EntityKb } from "../../src/entities/kb.js";
import { buildApiApp } from "../../src/api/server.js";
import type { FastifyInstance } from "fastify";

describe("ghost url + html fixture", () => {
  it("recognizes reserved ghost.invalid hosts only", () => {
    expect(isGhostUrl("https://ghost.invalid/probe/rit_x")).toBe(true);
    expect(isGhostUrl("https://GHOST.INVALID/x")).toBe(true);
    expect(isGhostUrl("https://techcrunch.com/story")).toBe(false);
    expect(isGhostUrl("not a url")).toBe(false);
  });

  it("extracts a body long enough to clear the prefilter floor", () => {
    const html = ghostArticleHtml({
      title: "Ghost Probe Labs raises $12 million Series A (abc12345)",
      publishedAt: new Date("2026-08-24T20:00:00Z"),
    });
    const extracted = extractFromHtml(html, "https://ghost.invalid/probe/rit_x");
    expect(extracted).not.toBeNull();
    expect(extracted!.charCount).toBeGreaterThan(500);
    expect(extracted!.title.toLowerCase()).toContain("raises");
  });
});

describe("ghost inject → fetch → filter", () => {
  let tdb: TestDb;
  let deps: {
    db: Db;
    registry: SourceRegistry;
    router: LlmRouter;
    storage: LocalStorage;
  };

  beforeAll(async () => {
    isolateConfig();
    tdb = await createTestDb();
    const normalized = normalizeExecuteShape(tdb.db) as unknown as Db;
    deps = {
      db: normalized,
      registry: new SourceRegistry(normalized),
      router: new LlmRouter(normalized, makeProvider()),
      storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
    };
  });

  afterAll(async () => {
    if (tdb) await tdb.destroy();
  });

  it("inserts a raw item, short-circuits fetch, and keeps through the mock filter", async () => {
    const queued: Array<{ queue: string; data: object }> = [];
    const ghost = await injectGhostNews(deps.db, async (queue, data) => {
      queued.push({ queue, data });
    });
    expect(queued).toEqual([{ queue: "fetch-article", data: { rawItemId: ghost.rawItemId } }]);

    const [raw] = await deps.db.select().from(rawItems).where(eq(rawItems.id, ghost.rawItemId)).limit(1);
    expect(raw?.discoveredVia).toBe("manual");
    expect(isGhostUrl(raw!.url)).toBe(true);

    const traces = await deps.db.select().from(pipelineTraces);
    expect(traces.some((t) => t.refId === ghost.rawItemId && t.node === "raw")).toBe(true);

    const { articleId } = await handleFetchArticle(deps, ghost.rawItemId);
    expect(articleId).toMatch(/^art_/);

    const [art] = await deps.db.select().from(articles).where(eq(articles.id, articleId!)).limit(1);
    expect(art?.publisherDomain).toBe("ghost.invalid");
    expect(art?.noiseStage).toBe("pending");
    expect((art?.extractedTextChars ?? 0)).toBeGreaterThan(500);

    const { waiting } = await handleFilterArticle(deps, articleId!);
    expect(waiting).toBe(true);
  });
});

describe("POST /v1/exoskeleton/ghost", () => {
  let tdb: TestDb;
  let app: FastifyInstance;
  const queued: string[] = [];

  beforeAll(async () => {
    isolateConfig();
    tdb = await createTestDb();
    const db = normalizeExecuteShape(tdb.db) as unknown as Db;
    app = buildApiApp({
      db,
      registry: new SourceRegistry(db),
      kb: new EntityKb(db),
      router: new LlmRouter(db, makeProvider()),
      storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
      enqueue: async (queue, data) => {
        queued.push(queue);
        void data;
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (tdb) await tdb.destroy();
  });

  it("returns 202 and enqueues fetch-article without an API key", async () => {
    queued.length = 0;
    const res = await app.inject({ method: "POST", url: "/v1/exoskeleton/ghost" });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: boolean; rawItemId: string; title: string };
    expect(body.ok).toBe(true);
    expect(body.rawItemId).toMatch(/^rit_/);
    expect(body.title).toMatch(/Ghost Probe Labs raises/);
    expect(queued).toEqual(["fetch-article"]);
  });

  it("returns 503 when enqueue is missing", async () => {
    const db = normalizeExecuteShape(tdb.db) as unknown as Db;
    const solo = buildApiApp({
      db,
      registry: new SourceRegistry(db),
      kb: new EntityKb(db),
      router: new LlmRouter(db, makeProvider()),
      storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
    });
    await solo.ready();
    const res = await solo.inject({ method: "POST", url: "/v1/exoskeleton/ghost" });
    expect(res.statusCode).toBe(503);
    await solo.close();
  });
});
