import { z } from "zod";
import { getFilters, renderPrompt, getTemplate } from "../config-files.js";
import { excerpt } from "../lib/text.js";
import type { LlmRouter } from "../llm/router.js";

const NoiseVerdict = z.object({
  is_company_news: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(""),
});

export interface LlmFilterResult {
  kept: boolean;
  confidence: number;
  reason: string;
  degraded?: boolean;
}

/**
 * Stage (b) of FR-5: LLM binary classifier — "genuine company-relevant news?".
 * Runs on the mini tier; degrades to KEEP when the budget breaker blocks the
 * call (better to over-retain than lose recall; prefilter already cut junk).
 */
export async function llmNoiseFilter(
  router: LlmRouter,
  input: { title: string; body: string; publisher: string },
): Promise<LlmFilterResult> {
  const tpl = getTemplate("noise_filter");
  const cfg = getFilters().llm_filter;
  const { system, user, templateVersion } = renderPrompt(tpl, {
    title: input.title,
    publisher: input.publisher,
    body: excerpt(input.body, cfg.prompt_max_chars),
  });

  let result;
  try {
    result = await router.chatJson(NoiseVerdict, system, user, {
      stage: "noise_filter",
      tier: "mini",
      promptTemplate: "noise_filter",
      promptTemplateVersion: templateVersion,
    });
  } catch (e) {
    // Budget degradation path (NFR-1): keep item, mark degraded.
    return {
      kept: true,
      confidence: 0.5,
      reason: `filter_degraded:${(e as Error).constructor.name}`,
      degraded: true,
    };
  }
  if (!result.ok) {
    // Provider failure: retain rather than discard on unknown quality.
    return { kept: true, confidence: 0.5, reason: `filter_error:${result.error.slice(0, 80)}` };
  }
  const v = result.data;
  const keep = v.is_company_news && v.confidence >= cfg.keep_threshold;
  return { kept: keep, confidence: v.confidence, reason: v.reason };
}
