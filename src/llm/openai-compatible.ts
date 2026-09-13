import { z } from "zod";
import { getModels, priceFor } from "../config-files.js";
import { estimateTokens, type ChatCallOpts, type ChatResult, type LlmProvider } from "./provider.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const UsageShape = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .optional();

const CompletionResponse = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }).passthrough())
    .min(1),
  usage: UsageShape,
});

const EmbeddingResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional() }).optional(),
});

function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

async function fetchWithRetry(url: string, init: RequestInit, tries = 2): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`upstream ${res.status}`);
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("llm fetch failed");
}

/** Minimal OpenAI-compatible client (chat completions + embeddings). */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private modelFor(tier: ChatCallOpts["tier"]): string {
    const m = getModels().tiers;
    switch (tier) {
      case "big":
        return m.big.model;
      case "judge":
        return m.judge.model;
      default:
        return m.mini.model;
    }
  }

  async chatJson<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    user: string,
    opts: ChatCallOpts,
  ): Promise<ChatResult<T>> {
    const model = this.modelFor(opts.tier);
    const started = Date.now();
    const body = {
      model,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxOutputTokens ?? 1200,
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ] satisfies ChatMessage[],
    };
    const baseUsage = { model, latencyMs: Date.now() - started };
    try {
      const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: `llm http ${res.status}: ${text.slice(0, 300)}`,
          ...baseUsage,
          latencyMs: Date.now() - started,
          inputTokens: estimateTokens(system + user),
          outputTokens: 0,
          costUsd: 0,
        };
      }
      const parsed = CompletionResponse.parse(await res.json());
      const raw = parsed.choices[0]?.message?.content ?? "";
      const inputTokens =
        parsed.usage?.prompt_tokens ?? estimateTokens(system + user);
      const outputTokens = parsed.usage?.completion_tokens ?? estimateTokens(raw);
      let data: T;
      try {
        data = schema.parse(JSON.parse(raw));
      } catch (e) {
        return {
          ok: false,
          error: `invalid llm json: ${(e as Error).message.slice(0, 200)}; raw=${raw.slice(0, 200)}`,
          model,
          latencyMs: Date.now() - started,
          inputTokens,
          outputTokens,
          costUsd: costUsd(model, inputTokens, outputTokens),
        };
      }
      return {
        ok: true,
        data,
        raw,
        model,
        latencyMs: Date.now() - started,
        inputTokens,
        outputTokens,
        costUsd: costUsd(model, inputTokens, outputTokens),
      };
    } catch (e) {
      return {
        ok: false,
        error: (e as Error).message,
        model,
        latencyMs: Date.now() - started,
        inputTokens: estimateTokens(system + user),
        outputTokens: 0,
        costUsd: 0,
      };
    }
  }

  async embed(
    inputs: string[],
    _opts: { stage: string },
  ): Promise<
    | { ok: true; vectors: number[][]; model: string; inputTokens: number; costUsd: number }
    | { ok: false; error: string }
  > {
    const model = getModels().tiers.embed.model;
    const dims = getModels().tiers.embed.dimensions;
    try {
      const res = await fetchWithRetry(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, input: inputs, dimensions: dims }),
      });
      if (!res.ok) {
        return { ok: false, error: `embeddings http ${res.status}` };
      }
      const parsed = EmbeddingResponse.parse(await res.json());
      const inputTokens = parsed.usage?.prompt_tokens ?? estimateTokens(inputs.join("\n"));
      return {
        ok: true,
        vectors: parsed.data.map((d) => d.embedding),
        model,
        inputTokens,
        costUsd: costUsd(model, inputTokens, 0),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
