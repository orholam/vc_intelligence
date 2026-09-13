import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { llmCalls, kvState, pipelineEvents } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { getConfig } from "../config.js";
import { getFilters } from "../config-files.js";
import { MockProvider } from "./mock.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { HarnessProvider } from "./harness.js";
import { BudgetDegradedError, type ChatCallOpts, type ChatResult, type LlmProvider } from "./provider.js";
export { BudgetDegradedError };

/**
 * Provider selection:
 *   openai-compatible — path 1: hosted models directly (needs LLM_API_KEY).
 *   harness           — path 2: an external agent answers every completion.
 *   auto              — offer each completion to a connected harness first;
 *                       if nobody claims within LLM_AUTO_CLAIM_WAIT_MS, fall
 *                       back to the hosted key. With no usable key there is
 *                       no mock fallback — claims wait the full harness
 *                       timeout (same as LLM_PROVIDER=harness).
 *   mock              — fully offline deterministic provider (tests/dev).
 */
export function makeProvider(cfg = getConfig(), db?: Db): LlmProvider {
  if (cfg.LLM_PROVIDER === "mock") return new MockProvider();
  if (cfg.LLM_PROVIDER === "harness") return new HarnessProvider(db);
  if (cfg.LLM_PROVIDER === "auto") {
    // No usable hosted key: do not attach MockProvider. A 5s unclaimed
    // window + mock is how waiting-room runs scanned 120 and published 0
    // (mockMustNotPublish). Without a fallback, claims wait the full
    // LLM_HARNESS_TIMEOUT_MS like LLM_PROVIDER=harness.
    return new HarnessProvider(db, {
      fallback: hasUsableHostedKey(cfg)
        ? new OpenAiCompatibleProvider(cfg.LLM_BASE_URL, cfg.LLM_API_KEY)
        : undefined,
    });
  }
  return new OpenAiCompatibleProvider(cfg.LLM_BASE_URL, cfg.LLM_API_KEY);
}

/** Treat placeholder/empty keys as absent so auto falls back to mock, not 401s. */
export function hasUsableHostedKey(cfg: { LLM_API_KEY: string } = getConfig()): boolean {
  const key = cfg.LLM_API_KEY.trim();
  return key.length > 8 && !/^sk-(xxx|test|placeholder)$/i.test(key);
}

/**
 * Explicit `LLM_PROVIDER=mock` is the offline/test path and MAY publish.
 * `auto`/`harness` falling through to MockProvider must NOT publish — that
 * is how 6,470 mock-kept rows landed in production.
 */
export function mockMustNotPublish(cfg = getConfig()): boolean {
  return cfg.LLM_PROVIDER !== "mock";
}

/**
 * Scheduled LLM ticks (company profiles) need an in-process model (hosted API).
 * With `harness` or `auto` without a key, Cursor must drive profiles via the
 * enrich-new-companies skill — do not run hourly ticks that wait 180s and timeout.
 */
export function refuseHarnessWithoutModel(cfg = getConfig()): boolean {
  if (cfg.LLM_PROVIDER === "harness") return true;
  return cfg.LLM_PROVIDER === "auto" && !hasUsableHostedKey(cfg);
}

/** Programmatic offline brains — MockProvider scripts, not real editorial judgment. */
const PROGRAMMATIC_BRAIN_MODELS = new Set([
  "editorial-brain",
  "harness:cursor-agent", // legacy script tag
  "harness:mock-agent",
]);

/**
 * Models that must not drive publish in harness/auto mode.
 * Only `harness:agent` (Cursor agent claim loop) or hosted API model names pass.
 */
export function isMockModelName(model: string | null | undefined): boolean {
  if (!model) return false;
  if (/^mock/i.test(model)) return true;
  if (PROGRAMMATIC_BRAIN_MODELS.has(model)) return true;
  return false;
}

/** Model tag the Cursor agent must use when POSTing harness claim results. */
export function isAgentHarnessModel(model: string | null | undefined): boolean {
  return model === "harness:agent";
}

export interface BudgetStatus {
  month: string;
  spentUsd: number;
  capUsd: number;
  softLimitUsd: number;
  softExceeded: boolean;
  hardExceeded: boolean;
  classifyOnlyMode: boolean;
}

interface CacheEntry {
  at: number;
  spentUsd: number;
}

/**
 * Tiered model router with hard monthly caps and graceful degradation (FR-12,
 * NFR-1): mini for classification/tagging, big for summaries/adjudication.
 * At the soft cap (default 90%) big-tier work is skipped ("classify-only
 * mode"); at the hard cap all LLM work stops. Every call is written to the
 * `llm_calls` ledger with prompt-template version + model id (NFR-9).
 */
export class LlmRouter {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly db: Db,
    private readonly provider: LlmProvider = makeProvider(),
  ) {}

  async monthSpend(): Promise<number> {
    const hit = this.cache.get("month");
    const now = Date.now();
    if (hit && now - hit.at < this.CACHE_TTL_MS) return hit.spentUsd;
    const rows = await this.db.execute<{ total: number }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
      FROM ${llmCalls}
      WHERE created_at >= date_trunc('month', now())
    `);
    const spent = Number(rows[0]?.total ?? 0);
    this.cache.set("month", { at: now, spentUsd: spent });
    return spent;
  }

  private async overrides(): Promise<{ budget_disabled?: boolean }> {
    const rows = await this.db
      .select()
      .from(kvState)
      .where(eq(kvState.key, "router_overrides"))
      .limit(1);
    return (rows[0]?.value ?? {}) as { budget_disabled?: boolean };
  }

  async budgetStatus(): Promise<BudgetStatus> {
    const cfg = getConfig();
    const filters = getFilters();
    const cap = cfg.MONTHLY_BUDGET_USD;
    const softPct = filters.budget.soft_limit_pct ?? cfg.BUDGET_SOFT_LIMIT_PCT;
    const spent = await this.monthSpend();
    const softLimitUsd = (cap * softPct) / 100;
    return {
      month: new Date().toISOString().slice(0, 7),
      spentUsd: Math.round(spent * 1e6) / 1e6,
      capUsd: cap,
      softLimitUsd,
      softExceeded: spent >= softLimitUsd,
      hardExceeded: spent >= cap,
      classifyOnlyMode: spent >= softLimitUsd,
    };
  }

  private async assertBudget(tier: ChatCallOpts["tier"] | "embed"): Promise<void> {
    if ((await this.overrides()).budget_disabled) return;
    const st = await this.budgetStatus();
    if (st.hardExceeded) {
      // R09: degradation is disclosed, never silent — the stop is recorded as
      // an event (once per month) and surfaced on the dashboard + benchmark.
      await recordBudgetEvent(this.db, "budget_stop_hard", st);
      throw new BudgetDegradedError("hard_cap_exhausted");
    }
    const isExpensiveTier = tier === "big" || tier === "judge";
    if (st.classifyOnlyMode && isExpensiveTier) {
      await recordBudgetEvent(this.db, "budget_degrade_soft", st);
      // graceful degradation: keep cheap classification, skip expensive work
      throw new BudgetDegradedError("soft_cap_classify_only");
    }
  }

  async chatJson<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    user: string,
    opts: ChatCallOpts,
  ): Promise<ChatResult<T>> {
    await this.assertBudget(opts.tier);
    let result: ChatResult<T>;
    try {
      result = await this.provider.chatJson(schema, system, user, opts);
    } catch (e) {
      result = {
        ok: false,
        error: (e as Error).message,
        model: "unknown",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    }
    try {
      await this.db.insert(llmCalls).values({
        id: opaqueId("llm"),
        stage: opts.stage,
        tier: opts.tier,
        model: result.model,
        promptTemplate: opts.promptTemplate ?? null,
        promptTemplateVersion: opts.promptTemplateVersion ?? null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        latencyMs: Math.round(result.latencyMs),
        articleId: opts.articleId ?? null,
        ok: result.ok,
        error: result.ok ? null : result.error.slice(0, 500),
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "failed to write llm_calls ledger row");
    }
    return result;
  }

  async embed(
    inputs: string[],
    opts: { stage: string; articleId?: string | null },
  ): Promise<{ ok: true; vectors: number[][] } | { ok: false; error: string }> {
    await this.assertBudget("embed");
    const res = await this.provider.embed(inputs, { stage: opts.stage });
    if (!res.ok) {
      await this.safeLog(opts.stage, "embed", false, res.error, 0, 0, 0, opts.articleId ?? null);
      return { ok: false, error: res.error };
    }
    await this.safeLog(
      opts.stage,
      "embed",
      true,
      null,
      res.costUsd,
      res.inputTokens,
      0,
      opts.articleId ?? null,
      res.model,
    );
    const expected = getConfig().EMBEDDING_DIM;
    if (res.vectors[0] && res.vectors[0].length !== expected) {
      return {
        ok: false,
        error: `embedding dimension mismatch: provider returned ${res.vectors[0].length}, DB column expects ${expected}`,
      };
    }
    return { ok: true, vectors: res.vectors };
  }

  private async safeLog(
    stage: string,
    tier: "mini" | "big" | "judge" | "embed",
    ok: boolean,
    error: string | null,
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
    articleId: string | null,
    model = "unknown",
    template?: { name?: string; version?: string },
  ): Promise<void> {
    try {
      await this.db.insert(llmCalls).values({
        id: opaqueId("llm"),
        stage,
        tier,
        model,
        promptTemplate: template?.name ?? null,
        promptTemplateVersion: template?.version ?? null,
        inputTokens,
        outputTokens,
        costUsd,
        articleId,
        ok,
        error: error?.slice(0, 500) ?? null,
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "llm_calls ledger insert failed");
    }
  }
}

/**
 * R09/G4: budget degrade/stop transitions land in `pipeline_events` exactly
 * once per kind+month (unique dedup key), so a degraded month is always
 * disclosed on the dashboard and in the benchmark artifact.
 */
export async function recordBudgetEvent(
  db: Db,
  kind: "budget_degrade_soft" | "budget_stop_hard" | "budget_recovered",
  st: Pick<BudgetStatus, "month" | "spentUsd" | "capUsd">,
): Promise<void> {
  const dedupKey = `${kind}:${st.month}`;
  await db
    .insert(pipelineEvents)
    .values({
      id: opaqueId("pev"),
      kind,
      dedupKey,
      message:
        `${kind} for ${st.month}: spent $${st.spentUsd.toFixed(2)} of $${st.capUsd.toFixed(2)} cap`,
      metadata: { month: st.month, spent_usd: st.spentUsd, cap_usd: st.capUsd },
    })
    .onConflictDoNothing({ target: pipelineEvents.dedupKey });
}

/** Recent pipeline events for the dashboard / benchmark disclosure (R09). */
export async function recentPipelineEvents(db: Db, limit = 10) {
  const rows = await db.execute<{
    kind: string;
    message: string;
    created_at: string;
  }>(sql`
    SELECT kind, message, created_at FROM pipeline_events
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return rows.map((r) => ({
    kind: r.kind,
    message: r.message,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

/** G4 ledger-continuity probe: distinct days with LLM calls this month. */
export async function ledgerDaysThisMonth(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(DISTINCT date_trunc('day', created_at))::int AS n
    FROM llm_calls WHERE created_at >= date_trunc('month', now())
  `);
  return Number(rows[0]?.n ?? 0);
}

/** Per-stage cost breakdown for the weekly dashboard (NFR-4). */export async function stageCostBreakdown(db: Db): Promise<
  Array<{ stage: string; calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>
> {
  const rows = await db.execute<{
    stage: string;
    calls: number;
    cost: number;
    in_toks: number;
    out_toks: number;
  }>(sql`
    SELECT stage,
           COUNT(*)::int AS calls,
           COALESCE(SUM(cost_usd), 0)::float8 AS cost,
           COALESCE(SUM(input_tokens), 0)::int AS in_toks,
           COALESCE(SUM(output_tokens), 0)::int AS out_toks
    FROM llm_calls
    WHERE created_at >= date_trunc('month', now())
    GROUP BY stage
    ORDER BY cost DESC
  `);
  return rows.map((r) => ({
    stage: r.stage,
    calls: Number(r.calls),
    cost_usd: Number(r.cost),
    input_tokens: Number(r.in_toks),
    output_tokens: Number(r.out_toks),
  }));
}

/** Blended $/article over enriched articles this month (FR-12 AC). */
export async function blendedArticleCost(db: Db): Promise<number | null> {
  const rows = await db.execute<{ articles: number; cost: number }>(sql`
    SELECT COUNT(DISTINCT a.id)::int AS articles, COALESCE(SUM(l.cost_usd), 0)::float8 AS cost
    FROM articles a
    JOIN llm_calls l ON l.article_id = a.id
    WHERE a.enriched_at IS NOT NULL
      AND a.enriched_at >= date_trunc('month', now())
  `);
  const r = rows[0];
  if (!r || !r.articles) return null;
  return r.cost / r.articles;
}

export const RouterOverridesSchema = z.object({ budget_disabled: z.boolean().optional() });
export async function setRouterOverride(db: Db, value: { budget_disabled?: boolean }) {
  await db
    .insert(kvState)
    .values({ key: "router_overrides", value })
    .onConflictDoUpdate({ target: kvState.key, set: { value, updatedAt: sql`now()` } });
}
