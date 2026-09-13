import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Db } from "../db/index.js";
import { llmRequests } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { estimateTokens, type ChatCallOpts, type ChatResult, type LlmProvider } from "./provider.js";
import { MockProvider } from "./mock.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

const POLL_INTERVAL_MS = 400;

export interface HarnessRequestPayload {
  id: string;
  stage: string;
  tier: "mini" | "big" | "judge";
  system: string;
  user: string;
  response_schema: unknown;
  max_output_tokens: number | null;
  article_id: string | null;
  created_at: string;
  /** From the live process, not .env.local comments. */
  llm_provider: string;
  /** Ms the waiter will block after enqueue (180_000 in harness; 5_000 only if auto has a real key fallback). */
  answer_timeout_ms: number;
  /** True only when unclaimed auto requests fall through to a hosted/mock fallback. */
  mock_fallback: boolean;
}

/** Shape a harness must POST back to /internal/llm/:id/result. */
export const HarnessResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
    raw: z.string().optional(),
    model: z.string().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1), model: z.string().optional() }),
]);
export type HarnessResult = z.infer<typeof HarnessResultSchema>;

/**
 * Path-2 provider (LLM_PROVIDER=harness): instead of calling a hosted model,
 * completions are written to the `llm_requests` work queue and answered by an
 * external agent harness over the internal claim/result API. Zod contracts,
 * prompt templates and the llm_calls ledger are enforced identically to the
 * OpenAI-compatible path; only the brain is swapped.
 *
 * Embeddings stay hosted by default (agents cannot produce coherent semantic
 * vectors); without a usable key the deterministic local bag-of-features
 * fallback keeps clustering functional at lexical quality.
 */
export class HarnessProvider implements LlmProvider {
  private readonly db: Db;
  private readonly timeoutMs: number;
  private readonly claimWaitMs: number;
  private readonly fallback?: LlmProvider;
  private lazyDb?: Db;
  private embedDelegate?: OpenAiCompatibleProvider;
  private readonly localEmbeds = new MockProvider();

  constructor(
    db?: Db,
    opts?: { timeoutMs?: number; claimWaitMs?: number; fallback?: LlmProvider },
  ) {
    const cfg = getConfig();
    this.timeoutMs = opts?.timeoutMs ?? cfg.LLM_HARNESS_TIMEOUT_MS;
    this.claimWaitMs = opts?.claimWaitMs ?? cfg.LLM_AUTO_CLAIM_WAIT_MS;
    this.fallback = opts?.fallback;
    if (db) {
      this.db = db;
    } else {
      // Scripts call makeProvider() without a db; open our own lazily-used pool.
      this.lazyDb = createDb(cfg.DATABASE_URL);
      this.db = this.lazyDb;
    }
    if (cfg.LLM_HARNESS_HOSTED_EMBED && cfg.LLM_API_KEY) {
      this.embedDelegate = new OpenAiCompatibleProvider(cfg.LLM_BASE_URL, cfg.LLM_API_KEY);
    }
  }

  async close(): Promise<void> {
    const client = (this.lazyDb as unknown as { $client?: { end(): Promise<void> } } | undefined)?.$client;
    await client?.end();
  }

  async chatJson<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    user: string,
    opts: ChatCallOpts,
  ): Promise<ChatResult<T>> {
    // Auto-mode admission control: the agent answers sequentially (~20s/job),
    // so a second waiter can never be claimed in time — it would only burn
    // the claim window and stall its pipeline worker. If ANY request is
    // already outstanding, defer straight to the fallback.
    const started = Date.now();
    if (this.fallback && (await this.harnessBusy())) {
      return this.runFallback(schema, system, user, opts, started);
    }

    const id = opaqueId("lreq");
    const modelBase = "harness-agent";
    try {
      await this.db.insert(llmRequests).values({
        id,
        stage: opts.stage,
        tier: opts.tier,
        system,
        userPrompt: user,
        responseSchema: zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>,
        maxOutputTokens: opts.maxOutputTokens ?? null,
        articleId: opts.articleId ?? null,
        createdAt: new Date(),
      });
    } catch (e) {
      return fail(modelBase, started, `harness queue insert failed: ${(e as Error).message}`, estimateTokens(system + user));
    }

    // Auto mode: hold the door open briefly for a harness to claim the job;
    // once ANY claim lands we commit to the full timeout. Nobody stepping up
    // within claimWaitMs cancels the request and defers to the fallback.
    const fullDeadline = started + this.timeoutMs;
    const claimDeadline = this.fallback
      ? Math.min(started + this.claimWaitMs, fullDeadline)
      : fullDeadline;
    let sawClaim = false;
    try {
      while (Date.now() < fullDeadline) {
        const [row] = await this.db
          .select({ status: llmRequests.status, result: llmRequests.result })
          .from(llmRequests)
          .where(eq(llmRequests.id, id))
          .limit(1);
        if (!row) return fail(modelBase, started, "harness request row vanished");
        if (row.status === "done" || row.status === "failed") {
          return await this.consumeResult(id, row.result, schema, system, user, started);
        }
        if (row.status === "expired") {
          return fail(modelBase, started, "harness_timeout", estimateTokens(system + user));
        }
        if (row.status === "claimed") sawClaim = true;
        if (!sawClaim && Date.now() >= claimDeadline) {
          await this.cancelUnclaimed(id);
          return await this.runFallback(schema, system, user, opts, started);
        }
        await sleep(POLL_INTERVAL_MS);
      }
      await this.expire(id);
      return fail(modelBase, started, `harness_timeout after ${Math.round(this.timeoutMs / 1000)}s`, estimateTokens(system + user));
    } catch (e) {
      await this.expire(id).catch(() => {});
      return fail(modelBase, started, `harness wait failed: ${(e as Error).message}`, estimateTokens(system + user));
    }
  }

  /** Validate + adopt a harness-written result row (shared happy path). */
  private async consumeResult<T>(
    id: string,
    rawResult: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    user: string,
    started: number,
  ): Promise<ChatResult<T>> {
    const parsed = HarnessResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      await this.markFailed(id, "unparseable harness result envelope");
      return fail("harness-agent", started, "unparseable harness result envelope", estimateTokens(system + user));
    }
    if (!parsed.data.ok) {
      return {
        ok: false,
        error: `harness error: ${parsed.data.error.slice(0, 300)}`,
        model: parsed.data.model ? `harness:${parsed.data.model}` : "harness-agent",
        latencyMs: Date.now() - started,
        inputTokens: estimateTokens(system + user),
        outputTokens: 0,
        costUsd: 0,
      };
    }
    const checked = schema.safeParse(parsed.data.data);
    if (!checked.success) {
      const msg = `harness payload failed contract: ${checked.error.issues[0]?.message ?? "invalid"}`;
      await this.markFailed(id, msg);
      return fail("harness-agent", started, msg, estimateTokens(system + user));
    }
    const raw = parsed.data.raw ?? JSON.stringify(parsed.data.data);
    return {
      ok: true,
      data: checked.data,
      raw,
      model: parsed.data.model ? `harness:${parsed.data.model}` : "harness-agent",
      latencyMs: Date.now() - started,
      inputTokens: parsed.data.input_tokens ?? estimateTokens(system + user),
      outputTokens: parsed.data.output_tokens ?? estimateTokens(raw),
      costUsd: 0, // harness-side cost; service ledger records $0 (NFR-1)
    };
  }

  private async runFallback<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    user: string,
    opts: ChatCallOpts,
    started: number,
  ): Promise<ChatResult<T>> {
    if (!this.fallback) {
      return fail("harness-agent", started, "no harness claimed the request", estimateTokens(system + user));
    }
    try {
      return await this.fallback.chatJson(schema, system, user, opts);
    } catch (e) {
      return fail(this.fallbackModelName(), started, `fallback failed: ${(e as Error).message}`, estimateTokens(system + user));
    }
  }

  private fallbackModelName(): string {
    return this.fallback instanceof MockProvider ? "mock-fallback" : "fallback-provider";
  }

  async embed(
    inputs: string[],
    opts: { stage: string },
  ): Promise<
    | { ok: true; vectors: number[][]; model: string; inputTokens: number; costUsd: number }
    | { ok: false; error: string }
  > {
    if (this.embedDelegate) {
      try {
        const hosted = await this.embedDelegate.embed(inputs, opts);
        if (hosted.ok) return hosted;
        logger.warn({ err: hosted.error }, "hosted embed unavailable in harness mode; using local fallback");
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "hosted embed threw in harness mode; using local fallback");
      }
    }
    return this.localEmbeds.embed(inputs, opts);
  }

  /** True when any request is still outstanding (agent occupied or about to be). */
  private async harnessBusy(): Promise<boolean> {
    const rows = await this.db
      .select({ id: llmRequests.id })
      .from(llmRequests)
      .where(sql`${llmRequests.status} IN ('pending', 'claimed')`)
      .limit(1);
    return rows.length > 0;
  }

  private async expire(id: string): Promise<void> {
    await this.db
      .update(llmRequests)
      .set({ status: "expired", completedAt: new Date() })
      .where(eq(llmRequests.id, id));
  }

  /** Auto-mode give-up: only unclaimed rows may be cancelled (no race with a claim). */
  private async cancelUnclaimed(id: string): Promise<void> {
    const now = new Date();
    await this.db.execute(sql`
      UPDATE llm_requests SET status = 'expired', completed_at = ${now.toISOString()}
      WHERE id = ${id} AND status = 'pending'
    `);
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(llmRequests)
      .set({
        status: "failed",
        completedAt: new Date(),
        result: { ok: false, error: error.slice(0, 500) },
      })
      .where(eq(llmRequests.id, id));
  }
}

function fail(model: string, started: number, error: string, inputTokens = 0): ChatResult<never> {
  return {
    ok: false,
    error,
    model,
    latencyMs: Date.now() - started,
    inputTokens,
    outputTokens: 0,
    costUsd: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ coordinator

/**
 * postgres-js returns arrays from execute(); PGlite returns {rows}.
 * Normalize here so every caller (api routes, scripts, tests) gets one shape.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

/**
 * Atomically claim the oldest pending request (FOR UPDATE SKIP LOCKED so
 * concurrent harness workers never double-claim).
 */
export async function claimNextHarnessRequest(db: Db): Promise<HarnessRequestPayload | null> {
  const rows = rowsOf<HarnessRequestPayload & Record<string, unknown>>(await db.execute(sql`
    UPDATE llm_requests SET status = 'claimed', claimed_at = now()
    WHERE id = (
      SELECT id FROM llm_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, stage, tier, system, user_prompt AS "user",
              response_schema AS "response_schema", max_output_tokens AS "max_output_tokens",
              article_id AS "article_id", created_at
  `));
  const r = rows[0];
  if (!r) return null;
  const cfg = getConfig();
  const key = cfg.LLM_API_KEY.trim();
  const usableKey = key.length > 8 && !/^sk-(xxx|test|placeholder)$/i.test(key);
  return {
    id: String(r.id),
    stage: String(r.stage),
    tier: r.tier as "mini" | "big" | "judge",
    system: String(r.system),
    user: String(r.user),
    response_schema: r.response_schema,
    max_output_tokens: r.max_output_tokens == null ? null : Number(r.max_output_tokens),
    article_id: r.article_id == null ? null : String(r.article_id),
    created_at: new Date(r.created_at as string | Date).toISOString(),
    llm_provider: cfg.LLM_PROVIDER,
    answer_timeout_ms: cfg.LLM_HARNESS_TIMEOUT_MS,
    mock_fallback: cfg.LLM_PROVIDER === "auto" && usableKey,
  };
}

/** Write a harness answer; only unresolved rows transition (idempotent). */
export async function submitHarnessResult(db: Db, id: string, result: HarnessResult): Promise<boolean> {
  const status = result.ok ? "done" : "failed";
  const rows = rowsOf<{ id: string }>(await db.execute(sql`
    UPDATE llm_requests SET status = ${status}, result = ${JSON.stringify(result)}::jsonb, completed_at = now()
    WHERE id = ${id} AND status IN ('pending', 'claimed')
    RETURNING id
  `));
  return rows.length > 0;
}

/** Reaper: requests stuck claimed/pending past 2x timeout can never resolve. */
export async function expireStaleHarnessRequests(db: Db, timeoutMs: number): Promise<number> {
  const cutoffMs = timeoutMs * 2;
  const rows = rowsOf<{ id: string }>(await db.execute(sql`
    UPDATE llm_requests SET status = 'expired', completed_at = now()
    WHERE status IN ('pending', 'claimed') AND created_at < now() - (${cutoffMs} * interval '1 millisecond')
    RETURNING id
  `));
  return rows.length;
}

export async function harnessQueueStats(db: Db): Promise<{
  pending: number;
  claimed: number;
  expired24h: number;
}> {
  const rows = rowsOf<{ pending: number; claimed: number; expired: number }>(await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
      COUNT(*) FILTER (WHERE status = 'expired' AND completed_at > now() - interval '24 hours')::int AS expired
    FROM llm_requests
  `));
  const r = rows[0];
  return {
    pending: Number(r?.pending ?? 0),
    claimed: Number(r?.claimed ?? 0),
    expired24h: Number(r?.expired ?? 0),
  };
}
