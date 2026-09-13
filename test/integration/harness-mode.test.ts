import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import { llmRequests, llmCalls } from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import {
  HarnessProvider,
  claimNextHarnessRequest,
  submitHarnessResult,
  expireStaleHarnessRequests,
  type HarnessRequestPayload,
} from "../../src/llm/harness.js";
import { registerInternalLlmRoutes } from "../../src/api/routes/internal.js";
import { LlmRouter } from "../../src/llm/router.js";
import { resetConfigCache } from "../../src/config.js";
import { MockProvider } from "../../src/llm/mock.js";
import type { AppDeps } from "../../src/api/deps.js";

/**
 * Path-2 (harness) mode: completions delegated to an external agent over the
 * llm_requests queue + internal claim/result API. Offline via PGlite.
 */

let tdb: TestDb;
let db: Db;

const EchoSchema = z.object({
  verdict: z.boolean(),
  score: z.number(),
});

const OPTS = { stage: "noise_filter", tier: "mini" as const };

async function pendingRow(id: string) {
  const [row] = await db.select().from(llmRequests).where(eq(llmRequests.id, id)).limit(1);
  return row;
}

beforeAll(async () => {
  isolateConfig();
  tdb = await createTestDb();
  db = tdb.db as unknown as Db;
});

afterAll(async () => {
  await tdb.destroy();
});

describe("harness provider queue mechanics", () => {
  it("resolves a completion answered by the harness and validates the contract", async () => {
    const provider = new HarnessProvider(db, { timeoutMs: 5000 });
    const pending = provider.chatJson(EchoSchema, "sys", "user prompt", OPTS);

    const claimed = await waitForClaim();
    expect(claimed.stage).toBe("noise_filter");
    expect(claimed.tier).toBe("mini");
    expect((claimed.response_schema as Record<string, unknown>).properties).toBeTruthy();

    // Double-claim must not hand the same work out twice.
    expect(await claimNextHarnessRequest(normalized())).toBeNull();

    const accepted = await submitHarnessResult(normalized(), claimed.id, {
      ok: true,
      data: { verdict: true, score: 0.9 },
      model: "test-agent",
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(accepted).toBe(true);
    expect(await submitHarnessResult(normalized(), claimed.id, { ok: false, error: "late" })).toBe(false);

    const res = await pending;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ verdict: true, score: 0.9 });
    expect(res.model).toBe("harness:test-agent");
    expect(res.costUsd).toBe(0);
  });

  it("rejects contract-violating payloads and marks the request failed", async () => {
    const provider = new HarnessProvider(db, { timeoutMs: 5000 });
    const pending = provider.chatJson(EchoSchema, "sys", "u", OPTS);
    const claimed = await waitForClaim();
    await submitHarnessResult(normalized(), claimed.id, { ok: true, data: { verdict: "yes" } });

    const res = await pending;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("failed contract");
    expect((await pendingRow(claimed.id))?.status).toBe("failed");
  });

  it("propagates harness error envelopes", async () => {
    const provider = new HarnessProvider(db, { timeoutMs: 5000 });
    const pending = provider.chatJson(EchoSchema, "sys", "u", OPTS);
    const claimed = await waitForClaim();
    await submitHarnessResult(normalized(), claimed.id, { ok: false, error: "context overflow" });

    const res = await pending;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("context overflow");
  });

  it("times out fail-open instead of wedging the pipeline", async () => {
    const provider = new HarnessProvider(db, { timeoutMs: 1300 });
    const res = await provider.chatJson(EchoSchema, "sys", "u", OPTS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("harness_timeout");
    const rows = await db.select().from(llmRequests);
    const last = rows[rows.length - 1]!;
    expect(last.status).toBe("expired");
  });

  it("reaper expires stale claims so crashed workers never leak work", async () => {
    const provider = new HarnessProvider(db, { timeoutMs: 60000 });
    const pending = provider.chatJson(EchoSchema, "sys", "u", OPTS);
    const claimed = await waitForClaim();
    void pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 80)); // age past the 50ms reaper cutoff
    const n = await expireStaleHarnessRequests(normalized(), 25);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await pendingRow(claimed.id))?.status).toBe("expired");
  });
});

describe("LlmRouter integration over the harness path", () => {
  it("writes a normal llm_calls ledger row for a harness answer", async () => {
    const router = new LlmRouter(db, new HarnessProvider(db, { timeoutMs: 5000 }));
    const pending = router.chatJson(EchoSchema, "sys", "ledger u", { ...OPTS, articleId: null });
    const claimed = await waitForClaim();
    await submitHarnessResult(normalized(), claimed.id, { ok: true, data: { verdict: false, score: 0.1 }, model: "claude-x" });

    const res = await pending;
    expect(res.ok).toBe(true);
    const all = await db.select().from(llmCalls).orderBy(llmCalls.id);
    const mine = all.filter((r) => r.stage === "noise_filter").at(-1);
    expect(mine?.ok).toBe(true);
    expect(mine?.model).toBe("harness:claude-x");
    expect(mine?.costUsd).toBe(0);
  });
});

describe("internal claim/result API", () => {
  it("denies remote callers when HARNESS_KEY is set", async () => {
    process.env.HARNESS_KEY = "sekret";
    resetConfigCache();
    const app = Fastify({ disableRequestLogging: true });
    registerInternalLlmRoutes(app, { db } as unknown as AppDeps);
    await db.insert(llmRequests).values({
      id: "lreq_test_remote",
      stage: "summary",
      tier: "big",
      system: "s",
      userPrompt: "u",
    });
    const denied = await app.inject({
      method: "GET",
      url: "/internal/llm/claim",
      remoteAddress: "10.1.2.3",
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: "/internal/llm/claim",
      headers: { "x-harness-key": "sekret" },
      remoteAddress: "10.1.2.3",
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().request?.id).toBe("lreq_test_remote");
    await app.close();
  });

  it("allows loopback callers when HARNESS_KEY is unset", async () => {
    process.env.HARNESS_KEY = "";
    resetConfigCache();
    const app = Fastify({ disableRequestLogging: true });
    registerInternalLlmRoutes(app, { db } as unknown as AppDeps);
    await db.insert(llmRequests).values({
      id: "lreq_test_loopback",
      stage: "summary",
      tier: "big",
      system: "s",
      userPrompt: "u",
    });
    const res = await app.inject({ method: "GET", url: "/internal/llm/claim", remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().request?.id).toBe("lreq_test_loopback");

    const denied = await app.inject({ method: "GET", url: "/internal/llm/claim", remoteAddress: "10.9.9.9" });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("full round trip over HTTP: insert -> claim -> result -> provider resolves", async () => {
    process.env.HARNESS_KEY = "";
    resetConfigCache();
    const app = Fastify({ disableRequestLogging: true });
    registerInternalLlmRoutes(app, { db } as unknown as AppDeps);

    const provider = new HarnessProvider(db, { timeoutMs: 5000 });
    const pending = provider.chatJson(EchoSchema, "sys", "http u", OPTS);

    const claimRes = await app.inject({ method: "GET", url: "/internal/llm/claim?wait=2", remoteAddress: "127.0.0.1" });
    expect(claimRes.statusCode).toBe(200);
    const req = claimRes.json().request;
    expect(req).not.toBeNull();

    const post = await app.inject({
      method: "POST",
      url: `/internal/llm/${req.id}/result`,
      remoteAddress: "127.0.0.1",
      payload: { ok: true, data: { verdict: true, score: 1 }, model: "gpt-x" },
    });
    expect(post.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: `/internal/llm/${req.id}/result`,
      remoteAddress: "127.0.0.1",
      payload: { ok: true, data: { verdict: true, score: 1 } },
    });
    expect(replay.statusCode).toBe(409);

    const res = await pending;
    expect(res.ok).toBe(true);

    const stats = await app.inject({ method: "GET", url: "/internal/llm/stats", remoteAddress: "127.0.0.1" });
    expect(stats.json().queue.pending).toBe(0);
    await app.close();
  });
});

describe("auto mode (harness-first with fallback)", () => {
  const NoiseSchema = z.object({
    is_company_news: z.boolean(),
    confidence: z.number(),
    reason: z.string(),
  });

  async function drainOutstanding(): Promise<void> {
    await db.delete(llmRequests).where(sql`${llmRequests.status} IN ('pending', 'claimed')`);
  }

  it("falls back to the chained provider when nobody claims within the window", async () => {
    await drainOutstanding();
    const provider = new HarnessProvider(db, {
      timeoutMs: 60_000,
      claimWaitMs: 700,
      fallback: new MockProvider(),
    });
    const res = await provider.chatJson(
      NoiseSchema,
      "sys",
      "MARKER-AUTOFALLBACK-42 TITLE: Acme Robotics raises $12M Series A\nTEXT: Acme Robotics announced Series A funding led by Sequoia.",
      { stage: "noise_filter", tier: "mini" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model).toBe("mock-mini"); // fallback answered, not the harness
    const mine = (await db.select().from(llmRequests))
      .find((r) => r.userPrompt.includes("MARKER-AUTOFALLBACK-42"));
    expect(mine?.status).toBe("expired"); // cancelled request, late claims impossible
  }, 15_000);

  it("commits to the harness once any claim lands, ignoring the short window", async () => {
    await drainOutstanding();
    const provider = new HarnessProvider(db, {
      timeoutMs: 8_000,
      claimWaitMs: 500,
      fallback: new MockProvider(),
    });
    const pending = provider.chatJson(EchoSchema, "sys", "u", OPTS);
    await sleep(150); // claim arrives inside the claim window
    const claimed = await waitForClaim();
    await submitHarnessResult(normalized(), claimed.id, {
      ok: true,
      data: { verdict: true, score: 0.5 },
      model: "slow-agent",
    });
    const res = await pending;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model).toBe("harness:slow-agent");
  }, 15_000);

  it("skips the queue entirely while the agent is busy with earlier work", async () => {
    await drainOutstanding();
    // Simulate an occupied harness: one outstanding claimed request.
    await db.insert(llmRequests).values({
      id: "lreq_busy_probe",
      stage: "summary",
      tier: "big",
      system: "s",
      userPrompt: "u",
      status: "claimed",
      claimedAt: new Date(),
    });
    const provider = new HarnessProvider(db, { claimWaitMs: 500, fallback: new MockProvider() });
    const res = await provider.chatJson(
      NoiseSchema,
      "sys",
      "MARKER-BUSY-7 TITLE: Acme Robotics raises $12M\nTEXT: Series A funding led by Sequoia.",
      { stage: "noise_filter", tier: "mini" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model).toBe("mock-mini"); // instant fallback, no door-wait
    const rows = await db.select().from(llmRequests);
    expect(rows.find((r) => r.userPrompt.includes("MARKER-BUSY-7"))).toBeUndefined(); // never enqueued
    await db.delete(llmRequests).where(eq(llmRequests.id, "lreq_busy_probe"));
  }, 15_000);
});

// ---------------------------------------------------------------- helpers

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function normalized(): Db {
  return normalizeExecuteShape<Db>(db);
}

async function waitForClaim(): Promise<HarnessRequestPayload> {
  for (let i = 0; i < 40; i++) {
    const c = await claimNextHarnessRequest(normalized());
    if (c) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no request became claimable");
}
