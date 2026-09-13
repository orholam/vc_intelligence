import { z } from "zod";
import { renderPrompt, getTemplate } from "../config-files.js";
import type { LlmRouter } from "../llm/router.js";

/**
 * FR-23 neutral judge: a model from a DIFFERENT family than production
 * (config/models.json tier `judge`) scores every retrieved story for
 * is_real_news / is_about_company / is_in_window, mirroring akta's relevance
 * stage. The web-search validation stage is separate (webcheck.ts).
 */

export const JudgeVerdict = z.object({
  results: z
    .array(
      z.object({
        index: z.number().int(),
        is_real_news: z.boolean(),
        is_about_company: z.boolean(),
        is_in_window: z.boolean(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

export interface StoryToJudge {
  headline: string;
  publishedDate: string;
  url: string;
}

export interface JudgedStory extends StoryToJudge {
  isRealNews: boolean;
  isAboutCompany: boolean;
  isInWindow: boolean;
  reason: string;
}

export async function judgeStories(
  router: LlmRouter,
  companyName: string,
  windowStart: string,
  windowEnd: string,
  stories: StoryToJudge[],
): Promise<JudgedStory[]> {
  if (!stories.length) return [];
  const tpl = getTemplate("judge_story");
  const { system, user, templateVersion } = renderPrompt(tpl, {
    company_name: companyName,
    window_start: windowStart.slice(0, 10),
    window_end: windowEnd.slice(0, 10),
    stories: stories
      .map((s, i) => `${i + 1}. [${s.publishedDate.slice(0, 10)}] ${s.headline} (${s.url})`)
      .join("\n"),
  });

  const res = await router.chatJson(JudgeVerdict, system, user, {
    stage: "judge_story",
    tier: "judge",
    promptTemplate: "judge_story",
    promptTemplateVersion: templateVersion,
  });
  if (!res.ok) {
    // judge unavailable -> mark all unjudged (excluded from precision)
    return stories.map((s) => ({
      ...s,
      isRealNews: false,
      isAboutCompany: false,
      isInWindow: false,
      reason: `judge_error:${res.error.slice(0, 80)}`,
    }));
  }
  const byIdx = new Map((res.data.results ?? []).map((r) => [r.index - 1, r]));
  return stories.map((s, i) => {
    const v = byIdx.get(i);
    return {
      ...s,
      isRealNews: v?.is_real_news ?? false,
      isAboutCompany: v?.is_about_company ?? false,
      isInWindow: v?.is_in_window ?? false,
      reason: v?.reason ?? "missing_verdict",
    };
  });
}
