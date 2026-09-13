import { z } from "zod";
import { getIndustriesTaxonomy, getTemplate, renderPrompt } from "../config-files.js";
import type { LlmRouter } from "../llm/router.js";
import { sectorIdTokensMatch } from "../llm/mock.js";

/**
 * FR-20 stage 1: natural language -> structured filters (zod-validated).
 * Always echoed back to the client as `interpreted_filters`.
 */

export const InterpretedFilters = z.object({
  sectors: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]),
  funding_stage: z.array(z.enum(["pre_seed", "seed", "series_a", "series_b", "series_c", "late_stage", "unknown"])).default([]),
  founded_after: z.number().int().nullable().default(null),
  founded_before: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  exclude_keywords: z.array(z.string()).default([]),
  signals: z
    .array(z.enum(["raised_recently", "hiring", "expanding", "distress", "acquiring"]))
    .default([]),
});
export type InterpretedFilters = z.infer<typeof InterpretedFilters>;

export async function interpretQuery(router: LlmRouter, query: string): Promise<InterpretedFilters> {
  const tpl = getTemplate("listgen_interpret");
  const sectors = getIndustriesTaxonomy().sectors.map((s) => s.id).join(", ");
  const { system, user, templateVersion } = renderPrompt(tpl, {
    query,
    sectors,
  });

  // Budget degradation on listgen falls back to a lexical interpretation so
  // the endpoint keeps working in classify-only mode.
  try {
    const res = await router.chatJson(InterpretedFilters, system, user, {
      stage: "listgen_interpret",
      tier: "big",
      promptTemplate: "listgen_interpret",
      promptTemplateVersion: templateVersion,
    });
    if (res.ok) return sanitize(res.data);
  } catch {
    /* fall through to lexical */
  }
  return lexicalFallback(query);
}

function sanitize(filters: InterpretedFilters): InterpretedFilters {
  const valid = new Set(getIndustriesTaxonomy().sectors.map((s) => s.id));
  return {
    ...filters,
    sectors: filters.sectors.filter((s) => valid.has(s)).slice(0, 8),
    countries: [...new Set(filters.countries.map((c) => c.toUpperCase()))]
      .filter((c) => /^[A-Z]{2}$/.test(c))
      .slice(0, 10),
    keywords: filters.keywords
      .map((k) => k.toLowerCase())
      .filter((k) => !/\b(rais\w*|fund\w*|acquir\w*|buy\w*|hir\w*|expand\w*|recently)\b/.test(k))
      .slice(0, 8),
    exclude_keywords: filters.exclude_keywords.slice(0, 5).map((k) => k.toLowerCase()),
    founded_after:
      filters.founded_after && filters.founded_after > 1900 && filters.founded_after <= 2100
        ? filters.founded_after
        : null,
    founded_before:
      filters.founded_before && filters.founded_before > 1900 && filters.founded_before <= 2100
        ? filters.founded_before
        : null,
  };
}

/** Deterministic lexical fallback used when the big tier is unavailable. */
export function lexicalFallback(query: string): InterpretedFilters {
  const q = query.toLowerCase();
  const sectors = new Set<string>();
  for (const sec of getIndustriesTaxonomy().sectors) {
    if (
      q.includes(sec.label.toLowerCase()) ||
      q.includes(sec.id.replaceAll("_", " ")) ||
      sectorIdTokensMatch(q, sec.id) ||
      sec.keywords.some((kw) => q.includes(kw.toLowerCase()))
    ) {
      sectors.add(sec.id);
    }
  }
  const stages: InterpretedFilters["funding_stage"] = [];
  if (/pre-?seed/.test(q)) stages.push("pre_seed");
  if (/\bseed\b/.test(q)) stages.push("seed");
  if (/series\s*a/.test(q)) stages.push("series_a");
  if (/series\s*b/.test(q)) stages.push("series_b");
  if (/series\s*c/.test(q)) stages.push("series_c");
  if (/late[- ]stage|growth[- ]stage/.test(q)) stages.push("late_stage");

  const signals: InterpretedFilters["signals"] = [];
  if (/rais|fund/.test(q)) signals.push("raised_recently");
  if (/hir/.test(q)) signals.push("hiring");
  if (/expand/.test(q)) signals.push("expanding");
  if (/distress|struggl|layoff/.test(q)) signals.push("distress");
  if (/acquiring|buying/.test(q)) signals.push("acquiring");

  const signalStop = /\b(rais\w*|fund\w*|acquir\w*|buy\w*|hir\w*|expand\w*|distress\w*|layoff\w*)\b/;
  const keywords = [...q.matchAll(/"([^"]{3,30})"/g)]
    .map((m) => (m[1] ?? "").toLowerCase())
    .filter((k) => !signalStop.test(k));
  return {
    sectors: [...sectors].slice(0, 8),
    countries: [],
    funding_stage: [...new Set(stages)],
    founded_after: Number(/founded (?:after|since) (\d{4})/.exec(q)?.[1] ?? 0) || null,
    founded_before: Number(/founded (?:before|prior to) (\d{4})/.exec(q)?.[1] ?? 0) || null,
    keywords,
    exclude_keywords: [],
    signals,
  };
}
