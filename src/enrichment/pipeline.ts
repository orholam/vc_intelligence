import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getFilters, getModels, renderPrompt, getTemplate, flattenEventTypes } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articles } from "../db/schema.js";
import { excerpt } from "../lib/text.js";
import type { LlmRouter } from "../llm/router.js";
import { BudgetDegradedError } from "../llm/router.js";

/**
 * Enrichment pipeline (FR-13..16), all calls through the tiered router
 * (FR-12): one mini-tier call produces taxonomy/sentiment/industry/geo/
 * newsworthiness; the big tier writes 1-2 sentence summaries for high-tier
 * (mandatory) and medium-tier articles while budget permits (FR-16).
 */

const EnrichmentVerdict = z.object({
  primary_tag: z.string().nullable().default(null),
  secondary_tags: z.array(z.string()).default([]),
  sentiment: z.enum(["positive", "negative", "neutral"]),
  sentiment_score: z.number().min(-1).max(1),
  newsworthiness: z.enum(["high", "medium", "low"]),
  industry_primary: z.string().nullable().default(null),
  industry_secondary: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]),
});

const SummaryOut = z.object({ summary: z.string() });

/** Per-keeper summary after the batch audit (only mandated/high-medium survivors). */
export async function writeArticleSummary(
  db: Db,
  router: LlmRouter,
  input: {
    articleId: string;
    title: string;
    body: string;
    entityName: string | null;
    primaryTag: string | null;
  },
): Promise<string | null> {
  const events = flattenEventTypes();
  const stpl = getTemplate("summary");
  const s = renderPrompt(stpl, {
    title: input.title,
    body: excerpt(input.body, 2500),
    entity_name: input.entityName ?? "unknown",
    event_label:
      input.primaryTag && input.primaryTag !== "status.no_event"
        ? events.byId.get(input.primaryTag)?.label ?? ""
        : "",
  });
  try {
    const sres = await router.chatJson(SummaryOut, s.system, s.user, {
      stage: "summary",
      tier: "big",
      promptTemplate: "summary",
      promptTemplateVersion: s.templateVersion,
      articleId: input.articleId,
    });
    if (sres.ok && sres.data.summary.trim()) {
      const aiSummary = sres.data.summary.trim().slice(0, 400);
      await db
        .update(articles)
        .set({ aiSummary, updatedAt: new Date() })
        .where(eq(articles.id, input.articleId));
      return aiSummary;
    }
  } catch (e) {
    if (!(e instanceof BudgetDegradedError)) throw e;
  }
  return null;
}

/**
 * R05 post-enrich completeness contract: an article may serve only when every
 * tier-mandated field is populated. Null is a defect, not a state. Returns the
 * missing-field names; empty array = servable.
 */
export function enrichmentMissingFields(
  a: {
    primaryTag: string | null;
    secondaryTags: string[];
    sentiment: string | null;
    sentimentScore: number | null;
    newsworthiness: string | null;
    industryPrimary: string | null;
    countries: string[];
    aiSummary: string | null;
    excerptText?: string | null;
  },
  mandatorySummaryTiers: string[],
): string[] {
  // R08: the mandated set is config policy (filters.json enrichment.
  // mandated_fields), not hard-coded — see field comment for the countries
  // rationale. primary_tag / industry_primary placeholders (status.no_event,
  // other_diversified) do not satisfy the mandate — they stay missing.
  const mandated = new Set(getFilters().enrichment.mandated_fields);
  const missing: string[] = [];
  // G2 provenance: a servable row must carry a non-empty excerpt — husks
  // created by interrupted fetches (no stored text) must quarantine, not serve.
  if (a.excerptText !== undefined && !a.excerptText?.trim()) missing.push("excerpt_text");
  if (mandated.has("primary_tag") && (!a.primaryTag || a.primaryTag === "status.no_event")) {
    missing.push("primary_tag");
  }
  if (mandated.has("sentiment") && !a.sentiment) missing.push("sentiment");
  if (mandated.has("sentiment_score") && a.sentimentScore == null) missing.push("sentiment_score");
  if (mandated.has("newsworthiness") && !a.newsworthiness) missing.push("newsworthiness");
  if (
    mandated.has("industry_primary") &&
    (!a.industryPrimary || a.industryPrimary === "other_diversified")
  ) {
    missing.push("industry_primary");
  }
  if (mandated.has("countries") && !a.countries.length) missing.push("countries");
  if (
    a.newsworthiness &&
    mandatorySummaryTiers.includes(a.newsworthiness) &&
    !a.aiSummary?.trim()
  ) {
    missing.push("ai_summary");
  }
  return missing;
}

/**
 * Publisher topical hints: last-resort industry evidence for articles whose
 * text carries no sector keywords and which resolved to no entity priors.
 * Evidence class: the publisher's editorial focus (registry topics), not the
 * article text — always weaker than text/entity evidence, applied only when
 * those are absent.
 */
const PUBLISHER_SECTOR_HINTS: Record<string, string> = {
  "techcrunch.com": "ai_ml",
  "venturebeat.com": "ai_ml",
  "theinformation.com": "saas_enterprise",
  "sifted.eu": "saas_enterprise",
  "siliconangle.com": "cloud_infra",
  "readwrite.com": "consumer_internet",
  "fintechfuture.com": "fintech",
  "finextra.com": "banking_lending",
  "americanbanker.com": "banking_lending",
  "paymentsdive.com": "payments",
  "bankingdive.com": "banking_lending",
  "healthcaredive.com": "healthtech",
  "biopharmadive.com": "biotech_pharma",
  "medtechdive.com": "medtech_devices",
  "educationdive.com": "edtech",
  "constructiondive.com": "manufacturing_industrial",
  "utilitydive.com": "utilities",
  "spacedive.com": "automotive_aerospace",
  "spacenews.com": "automotive_aerospace",
  "arstechnica.com": "consumer_electronics",
  "engadget.com": "consumer_electronics",
  "theverge.com": "consumer_electronics",
  "wired.com": "consumer_internet",
  "eu-startups.com": "saas_enterprise",
  "tech.eu": "saas_enterprise",
  "techinasia.com": "consumer_internet",
  "restofworld.org": "consumer_internet",
  "inc42.com": "consumer_internet",
  "entrackr.com": "fintech",
  "wamda.com": "consumer_internet",
  "disrupt-africa.com": "fintech",
  "siliconrepublic.com": "saas_enterprise",
  "hackernews.ycombinator.com": "devtools",
};

export function publisherSectorHint(publisherDomain: string): string | null {
  const d = publisherDomain.toLowerCase().replace(/^www\./, "");
  return PUBLISHER_SECTOR_HINTS[d] ?? null;
}

export interface EnrichInput {
  articleId: string;
  title: string;
  body: string;
  publisherDomain: string;
  sourceTier: number | null;
}

export interface EnrichOutput {
  primaryTag: string | null;
  secondaryTags: string[];
  allTags: string[];
  sentiment: "positive" | "negative" | "neutral" | null;
  sentimentScore: number | null;
  newsworthiness: "high" | "medium" | "low" | null;
  industryPrimary: string | null;
  industrySecondary: string[];
  countries: string[];
  aiSummary: string | null;
  degraded: boolean;
}

export async function enrichArticle(
  db: Db,
  router: LlmRouter,
  input: EnrichInput,
): Promise<EnrichOutput> {
  const filters = getFilters();
  const { flattenEventTypes, getIndustriesTaxonomy } = await import("../config-files.js");
  const events = flattenEventTypes();
  const sectors = getIndustriesTaxonomy().sectors;

  // Resolved-entity priors sharpen industry/country inference without
  // fabricating text evidence (deterministic join, no LLM).
  const entRows = await db.execute<{
    canonical_name: string;
    industry_tags: string[] | null;
    country: string | null;
    type: string | null;
  }>(sql`
    SELECT e.canonical_name, e.industry_tags, e.country, e.type
    FROM article_entities ae
    JOIN entities e ON e.id = ae.entity_id
    WHERE ae.article_id = ${input.articleId} AND ae.role = 'primary'
    LIMIT 1
  `);
  const ent = entRows[0];
  const entityContext = ent
    ? `\nENTITY CONTEXT:\n- name ${String(ent.canonical_name)};\n- industries ${(ent.industry_tags ?? []).join(", ") || "unknown"};\n- country ${ent.country ?? "unknown"};\n- type ${ent.type ?? "unknown"}\n`
    : "";

  const tpl = getTemplate("classify_enrich");
  const { system, user, templateVersion } = renderPrompt(tpl, {
    title: input.title,
    publisher: input.publisherDomain,
    body: `${excerpt(input.body, 4000)}${entityContext}`,
    event_types: events.list.map((e) => e.id).join(", "),
    sectors: sectors.map((s) => s.id).join(", "),
  });

  const result = await router.chatJson(EnrichmentVerdict, system, user, {
    stage: "classify_enrich",
    tier: "mini",
    promptTemplate: "classify_enrich",
    promptTemplateVersion: templateVersion,
    articleId: input.articleId,
  });

  let degraded = false;
  let verdict: z.infer<typeof EnrichmentVerdict> | null = null;

  if (result.ok) {
    verdict = sanitizeVerdict(result.data, new Set(events.list.map((e) => e.id)), new Set(sectors.map((s) => s.id)));
  } else if (
    result.error.startsWith("BudgetDegradedError") ||
    /budget|cap/i.test(result.error)
  ) {
    degraded = true;
  }

  // Newsworthiness blends model materiality with source tier + entity prominence (FR-14).
  // Articles without a discrete event (primaryTag null) are never list-worthy.
  let newsworthiness = verdict?.newsworthiness ?? null;
  if (verdict && !degraded && verdict.primary_tag == null) {
    newsworthiness = "low";
  } else if (verdict && !degraded) {
    newsworthiness = await blendNewsworthiness(db, input, verdict.primary_tag);
  }

  let aiSummary: string | null = null;
  const summaryMandatory =
    newsworthiness != null &&
    filters.summary.mandatory_tiers.includes(newsworthiness as "high");
  const wantSummary = newsworthiness === "high" || newsworthiness === "medium";
  if (verdict && wantSummary && !degraded) {
    try {
      const stpl = getTemplate("summary");
      const s = renderPrompt(stpl, {
        title: input.title,
        body: excerpt(input.body, 2500),
        entity_name: ent?.canonical_name ?? "unknown",
        event_label:
          verdict.primary_tag && verdict.primary_tag !== "status.no_event"
            ? events.byId.get(verdict.primary_tag)?.label ?? ""
            : "",
      });
      const sres = await router.chatJson(SummaryOut, s.system, s.user, {
        stage: "summary",
        tier: "big",
        promptTemplate: "summary",
        promptTemplateVersion: s.templateVersion,
        articleId: input.articleId,
      });
      if (sres.ok && sres.data.summary.trim()) aiSummary = sres.data.summary.trim().slice(0, 400);
    } catch (e) {
      if (e instanceof BudgetDegradedError) degraded = true; // keep classification (FR-12 AC)
    }
  }
  if (!aiSummary && summaryMandatory && !degraded) {
    // Summary was mandated but the big-tier call did not produce one (provider
    // failure). The R05 validator will quarantine this row for retry — do not
    // silently mark it degraded-complete.
    degraded = true;
  }

  const out: EnrichOutput = {
    primaryTag: verdict?.primary_tag ?? null,
    secondaryTags: verdict?.secondary_tags ?? [],
    allTags: verdict ? unique([verdict.primary_tag, ...verdict.secondary_tags]) : [],
    sentiment: verdict?.sentiment ?? null,
    sentimentScore: verdict?.sentiment_score ?? null,
    newsworthiness,
    industryPrimary: verdict?.industry_primary ?? null,
    industrySecondary: verdict?.industry_secondary ?? [],
    countries: verdict?.countries ?? [],
    aiSummary,
    degraded,
  };
  // Publisher-hint fallback keeps industry fill ≥98% (E2) without inventing
  // text evidence — applied only when text + entity priors came up empty.
  if (!out.industryPrimary) {
    out.industryPrimary = publisherSectorHint(input.publisherDomain);
  }
  // Null stays null: "other_diversified" is not a sector and must not
  // satisfy the R05 publish gate. The waiting room retries until a real
  // industry lands (or the row parks after max_attempts).
  // Countries: when text + entity priors yield nothing, the source registry's
  // home country is the weakest honest signal we hold; otherwise stays [].
  if (!out.countries.length) {
    const srcRows = await db.execute<{ country: string | null }>(sql`
      SELECT s.country FROM sources s JOIN articles a ON a.source_id = s.id
      WHERE a.id = ${input.articleId} LIMIT 1
    `);
    const srcCountry = srcRows[0]?.country ?? null;
    if (srcCountry && /^[A-Z]{2}$/.test(srcCountry)) out.countries = [srcCountry];
  }

  await persistEnrichment(db, input.articleId, out);
  return out;
}

async function persistEnrichment(db: Db, articleId: string, out: EnrichOutput): Promise<void> {
  await db
    .update(articles)
    .set({
      primaryTag: out.primaryTag,
      secondaryTags: out.secondaryTags,
      allTags: out.allTags,
      sentiment: out.sentiment,
      sentimentScore: out.sentimentScore,
      newsworthiness: out.newsworthiness,
      industryPrimary: out.industryPrimary,
      industrySecondary: out.industrySecondary,
      countries: out.countries,
      aiSummary: out.aiSummary,
      enrichedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(articles.id, articleId));
}

function sanitizeVerdict(
  v: z.infer<typeof EnrichmentVerdict>,
  validEvents: Set<string>,
  validSectors: Set<string>,
): z.infer<typeof EnrichmentVerdict> {
  // Null stays null: no-event articles must not receive a fabricated tag.
  // Invalid ids are dropped rather than mapped to a "closest" family —
  // fabricating `product.update_release` for unknown output was a major
  // precision bug (FR-13 revision: prefer null over wrong).
  const primaryTag = v.primary_tag && validEvents.has(v.primary_tag) ? v.primary_tag : null;
  const secondaryTags = v.secondary_tags.filter((t) => validEvents.has(t)).slice(0, 3);
  return {
    ...v,
    primary_tag: primaryTag,
    secondary_tags: secondaryTags.filter((t) => t !== primaryTag),
    industry_primary: v.industry_primary && validSectors.has(v.industry_primary) ? v.industry_primary : null,
    industry_secondary: v.industry_secondary.filter((s) => validSectors.has(s)).slice(0, 2),
    countries: [...new Set(v.countries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 4),
    sentiment_score: Math.max(-1, Math.min(1, v.sentiment_score)),
  };
}

/**
 * c-plan scoring (filters.json newsworthiness.$comment):
 *   score = family_weight*0.5 + source_tier_score*0.2 + prominence*0.2 + exclusivity*0.1
 *
 * - family_weight: primary_tag prefix → investor-materiality weight
 * - fame dampening: public + unwatchlisted entities cap their family weight;
 *   prominence term shrinks as the entity's 30d article count grows
 * - exclusivity: first kept coverage of the entity scores full marks
 *
 * Deterministic (no LLM): also used by scripts/rescore-newsworthiness.ts to
 * bring legacy kept articles onto the current formula.
 */
export interface NewsworthinessRescoreInput {
  articleId: string;
  sourceTier: number | null;
}

export async function blendNewsworthiness(
  db: Db,
  input: NewsworthinessRescoreInput,
  primaryTag: string | null,
): Promise<"high" | "medium" | "low"> {
  const cfg = getFilters().newsworthiness;

  const famKey = primaryTag ? (primaryTag.split(".")[0] ?? "") : "";
  let family =
    cfg.family_weights?.[famKey] ?? cfg.default_family_weight;

  // Resolution runs before enrichment; primary entity drives entity-aware terms.
  const entRows = await db.execute<Record<string, unknown>>(sql`
    SELECT e.id, e.type, e.is_monitored
    FROM article_entities ae
    JOIN entities e ON e.id = ae.entity_id
    WHERE ae.article_id = ${input.articleId} AND ae.role = 'primary'
    LIMIT 1
  `);
  const ent = entRows[0];

  let prominenceTerm = 0.5; // neutral prior when entity unknown
  let exclusivity = 0;
  if (ent) {
    const isPublic = String(ent.type) === "public";
    const monitored = Boolean(ent.is_monitored);
    if (isPublic && !monitored) {
      family = Math.min(family, cfg.public_entity_family_cap);
    }    const stat = await db.execute<{ cnt: number; older: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE a.published_at >= now() - interval '30 days')::int AS cnt,
        COUNT(*) FILTER (
          WHERE a.published_at < (SELECT published_at FROM articles WHERE id = ${input.articleId})
        )::int AS older
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      WHERE ae.entity_id = ${String(ent.id)}
        AND a.noise_stage = 'kept'
        AND a.id <> ${input.articleId}
    `);
    const count30d = Number(stat[0]?.cnt ?? 0);
    const olderCount = Number(stat[0]?.older ?? 0);
    prominenceTerm = 1 / (1 + count30d / Math.max(1, cfg.prominence_count_scale));
    exclusivity = olderCount === 0 ? 1 : 0;
  }

  const tierScore = cfg.source_tier_scores[String(input.sourceTier ?? 3)] ?? cfg.source_tier_scores["3"]!;
  // Corroboration term (A3 intent): an event covered by multiple independent
  // publishers is materially stronger than a single-outlet report.
  const corrRows = await db.execute<{ pubs: number }>(sql`
    SELECT COUNT(DISTINCT a.publisher_domain)::int AS pubs
    FROM articles a
    WHERE a.story_cluster_id = (SELECT story_cluster_id FROM articles WHERE id = ${input.articleId})
      AND a.noise_stage = 'kept'
      AND a.id <> ${input.articleId}
      AND a.published_at >= now() - interval '14 days'
  `);
  const corroboration =
    Math.min(2, Math.max(0, Number(corrRows[0]?.pubs ?? 0) - 1)) / 2 *
    (cfg.corroboration_weight ?? 0);
  const score = family * 0.5 + tierScore * 0.2 + prominenceTerm * 0.2 + exclusivity * 0.1 +
    corroboration;
  return score >= cfg.high_threshold ? "high" : score >= cfg.medium_threshold ? "medium" : "low";
}

function unique(arr: Array<string | null>): string[] {
  return [...new Set(arr.filter((x): x is string => Boolean(x)))];
}

/**
 * FR-16 regeneration guard: a stored summary is reused while the extracted
 * text hash is unchanged, so re-enrichment never pays for regeneration.
 */
export function summaryIsCurrent(article: {
  aiSummary: string | null;
  extractedTextHash: string | null;
  currentTextHash?: string | null;
}): boolean {
  if (!article.aiSummary) return false;
  if (!article.currentTextHash) return true;
  return article.extractedTextHash === article.currentTextHash;
}

export function modelInfoForDiagnostics() {
  return getModels().tiers;
}
