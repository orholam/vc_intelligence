import type { z } from "zod";

export type LlmTier = "mini" | "big" | "embed" | "judge";

export interface ChatCallOpts {
  /** Logical pipeline stage, used for cost accounting (NFR-4). */
  stage: string;
  tier: Exclude<LlmTier, "embed">;
  /** Prompt template name + version for reproducibility (NFR-9). */
  promptTemplate?: string;
  promptTemplateVersion?: string;
  articleId?: string | null;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  latencyMs: number;
}

export interface ChatSuccess<T> extends Usage {
  ok: true;
  data: T;
  raw: string;
}

export interface ChatFailure extends Usage {
  ok: false;
  error: string;
}

export type ChatResult<T> = ChatSuccess<T> | ChatFailure;

/** Thrown by the ROUTER (not provider) when budget policy blocks a call (NFR-1). */
export class BudgetDegradedError extends Error {
  readonly reason: "soft_cap_classify_only" | "hard_cap_exhausted";
  constructor(reason: "soft_cap_classify_only" | "hard_cap_exhausted") {
    super(
      reason === "soft_cap_classify_only"
        ? "LLM monthly spend crossed soft limit; big-tier work degraded"
        : "LLM monthly hard cap exhausted",
    );
    this.reason = reason;
  }
}

/**
 * Provider-abstracted model access (FR-12): any OpenAI-compatible backend,
 * plus a fully offline deterministic mock for tests/dev.
 */
export interface LlmProvider {
  /** JSON-mode chat completion validated against a zod schema. */
  chatJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, system: string, user: string, opts: ChatCallOpts): Promise<ChatResult<T>>;
  /** Batch embeddings. */
  embed(inputs: string[], opts: { stage: string }): Promise<
    | { ok: true; vectors: number[][]; model: string; inputTokens: number; costUsd: number }
    | { ok: false; error: string }
  >;
}

/** Rough token estimate when a backend omits usage (chars/4 heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
