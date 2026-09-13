import { z } from "zod";
import { loadConfigFile } from "./config.js";

// ------------------------------------------------------------- event taxonomy
export const EventTypeDef = z.object({
  id: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
  label: z.string(),
  /** FR-9 fact extraction hook: null means "no structured fact for this type". */
  fact_type: z.enum(["funding_round", "acquisition", "leadership_change", "closure"]).nullable().default(null),
  keywords: z.array(z.string()).default([]),
});

export const EventFamily = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  types: z.array(EventTypeDef),
});

const EventsTaxonomy = z.object({
  $comment: z.string().optional(),
  version: z.string(),
  families: z.array(EventFamily),
});

export type EventsTaxonomy = z.infer<typeof EventsTaxonomy>;
export type EventDef = z.infer<typeof EventTypeDef> & { family: string; family_weight: number };

/** All ~80 event types flattened with family info attached. */
export function getEventsTaxonomy(): EventsTaxonomy {
  return loadConfigFile("taxonomy.events.json", EventsTaxonomy);
}

let flatEventsCache: { version: string; byId: Map<string, EventDef>; list: EventDef[] } | null = null;

export function flattenEventTypes() {
  const tax = getEventsTaxonomy();
  if (!flatEventsCache || flatEventsCache.version !== tax.version) {
    const list: EventDef[] = [];
    for (const fam of tax.families) {
      for (const t of fam.types) {
        list.push({ ...t, family: fam.name, family_weight: fam.weight });
      }
    }
    flatEventsCache = { version: tax.version, byId: new Map(list.map((e) => [e.id, e])), list };
  }
  return flatEventsCache;
}

// ---------------------------------------------------------- industry taxonomy
const IndustriesTaxonomy = z.object({
  $comment: z.string().optional(),
  version: z.string(),
  sectors: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9_]+$/),
      label: z.string(),
      keywords: z.array(z.string()).default([]),
    }),
  ),
});

export type IndustrySector = z.infer<typeof IndustriesTaxonomy>["sectors"][number];

export function getIndustriesTaxonomy() {
  return loadConfigFile("taxonomy.industries.json", IndustriesTaxonomy);
}

// -------------------------------------------------------------------- prompts
export const PromptsSchema = z.object({
  $comment: z.string().optional(),
  version: z.string(),
  templates: z.record(
    z.string(),
    z.object({ v: z.number(), system: z.string(), user: z.string() }),
  ),
});

export type PromptTemplate = { v: number; system: string; user: string };

export function getPrompts() {
  return loadConfigFile("prompts.json", PromptsSchema);
}

/** Lookup a prompt template by stage name; throws on unknown names. */
export function getTemplate(name: string): PromptTemplate {
  const tpl = getPrompts().templates[name];
  if (!tpl) throw new Error(`unknown prompt template: ${name}`);
  return tpl;
}

export function renderPrompt(
  tpl: PromptTemplate,
  vars: Record<string, string>,
): { system: string; user: string; templateVersion: string } {
  let user = tpl.user;
  for (const [k, v] of Object.entries(vars)) {
    user = user.replaceAll(`{{${k}}}`, v);
  }
  return {
    system: tpl.system,
    user,
    // global doc version + per-template v => e.g. "2026.08.1#classify_enrich@1"
    templateVersion: `${getPrompts().version}#${tpl.v}`,
  };
}

// -------------------------------------------------------------------- filters
const FiltersSchema = z.object({
  version: z.string(),
  prefilter: z.object({
    min_body_chars: z.number(),
    min_title_chars: z.number(),
    dedup_window_hours: z.number().default(48),
    /**
     * Staleness gate (fetch stage): pages whose own publish date is older
     * than this are never ingested, no matter how freshly GDELT/search
     * resurfaced them — evergreen republications would otherwise flood the
     * published_at-ordered feeds with months-old material.
     */
    max_article_age_days: z.number().default(45),
    /** Tighter window for non-RSS discovery (gdelt/search): an old page-date
     *  there is a resurface by definition, not delayed delivery. */
    max_article_age_days_discovered: z.number().default(3),
    blocked_url_patterns: z.array(z.string()),
    non_news_domains_hint: z.array(z.string()),
    non_news_title_patterns: z.array(z.string()),
    keep_if_funding_signals: z.boolean(),
    /** Event-bearing titles survive thin wire bodies to reach the LLM filter. */
    keep_if_event_title_patterns: z.array(z.string()).default([]),
  }),
  llm_filter: z.object({ keep_threshold: z.number(), prompt_max_chars: z.number() }),
  resolver: z.object({
    primary_min_confidence: z.number(),
    drop_below_confidence: z.number(),
    secondary_min_confidence: z.number(),
    adjudicate_margin: z.number(),
    adjudicate_top_n: z.number(),
    domain_overlap_bonus: z.number(),
    exact_alias_bonus: z.number(),
    mention_alias_bonus: z.number().default(0.06),
    repeat_alias_bonus_cap: z.number().default(0.05),
    partial_alias_bonus: z.number(),
    ticker_match_bonus: z.number(),
    country_mismatch_penalty: z.number(),
    industry_coherence_bonus: z.number(),
    prominence_prior_cap: z.number(),
    adjudicate_weight_det: z.number().default(0.4),
    adjudicate_weight_llm: z.number().default(0.6),
    require_title_or_domain_for_primary: z.boolean().default(true),
    discovery_mints: z.boolean().default(true),
    discovery_name_only_min_confidence: z.number().default(0.85),
    counterparty_links: z.boolean().default(true),
  }),
  clustering: z.object({
    cosine_threshold: z.number(),
    window_hours: z.number(),
    same_entity_gate: z.boolean(),
    cross_entity_cosine: z.number().default(0.95),
  }),
  newsworthiness: z.object({
    high_threshold: z.number(),
    medium_threshold: z.number(),
    source_tier_scores: z.record(z.string(), z.number()),
    prominence_article_count_30d_for_high: z.number().default(5),
    /** c-plan scoring: family weight by primary_tag prefix, keyed "funding","mna",… */
    family_weights: z.record(z.string(), z.number()).default({}),
    default_family_weight: z.number().default(0.5),
    /** fame dampening: public + unwatchlisted entities cap their family weight */
    public_entity_family_cap: z.number().default(0.6),
    /** prominence term = 1 / (1 + count_30d / scale) — fewer articles, higher score */
    prominence_count_scale: z.number().default(4),
    /** A3 intent: multi-publisher event coverage adds up to +corroboration_weight. */
    corroboration_weight: z.number().min(0).max(0.5).default(0.15),
  }),
  summary: z.object({
    mandatory_tiers: z.array(z.enum(["high", "medium", "low"])),
    medium_coverage_target: z.number(),
  }),
  facts: z.object({
    require_two_publishers_or_tier1: z.boolean(),
    min_event_confidence: z.number(),
  }),
  /** R05: bounded quarantine retries before a row parks. */
  enrichment: z
    .object({
      max_attempts: z.number().int().min(1).max(50).default(5),
      /**
       * R08: which fields are tier-mandated is policy, not code. countries
       * defaults OUT — E2 fill scoring excludes it and forcing ISO codes on
       * geography-free articles fabricates evidence.
       */
      mandated_fields: z
        .array(z.enum(["primary_tag", "sentiment", "sentiment_score", "newsworthiness", "industry_primary", "countries"]))
        .default(["primary_tag", "sentiment", "sentiment_score", "newsworthiness", "industry_primary"]),
      $comment: z.string().optional(),
    })
    .default({ max_attempts: 5, mandated_fields: ["primary_tag", "sentiment", "sentiment_score", "newsworthiness", "industry_primary"] }),
  /**
   * Waiting-room harness (manual batched LLM job): how many waiting items one
   * run may scan and how many new companies get the deep firmographics pass.
   */
  harness: z
    .object({
      max_batch: z.number().int().min(1).default(120),
      deep_search_entities: z.number().int().min(0).default(8),
      /** Headlines per part-1 audit call. The pile is one job; this only chunks context. */
      audit_chunk_size: z.number().int().min(1).max(120).default(40),
      $comment: z.string().optional(),
    })
    .default({ max_batch: 120, deep_search_entities: 8, audit_chunk_size: 40 }),
  /** R10: automated source lifecycle thresholds. */
  source_lifecycle: z
    .object({
      prune_failure_streak: z.number().int().min(0).default(10),
      onboard_max_age_hours: z.number().min(1).default(24),
      throttle_min_kept_30d: z.number().int().min(0).default(30),
      throttle_max_discard_rate_pct: z.number().min(1).max(100).default(85),
      $comment: z.string().optional(),
    })
    .default({
      prune_failure_streak: 10,
      onboard_max_age_hours: 24,
      throttle_min_kept_30d: 30,
      throttle_max_discard_rate_pct: 85,
    }),
  budget: z.object({ soft_limit_pct: z.number(), $comment: z.string().optional() }),
  listgen: z.object({
    max_companies_default: z.number(),
    signal_recency_half_life_days: z.number(),
    /** launch-surface entities below this signal score stay out of ListGen (c-plan) */
    launch_entity_min_signal: z.number().default(2),
  }),
  /** Launch-surface ingestion gates (c-plan). Keys: hn, producthunt, github_trending, yc_directory… */
  launch_surfaces: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(false),
        min_points: z.number().optional(),
        min_votes: z.number().optional(),
        /** github_trending: star floor + repo-creation recency window. */
        min_stars: z.number().optional(),
        window_days: z.number().optional(),
        max_age_hours: z.number().optional(),
        token_env: z.string().optional(),
      }),
    )
    .default({}),
  gdelt: z.object({
    poll_minutes: z.number(),
    max_records_per_query: z.number(),
    entity_batch_size: z.number().default(8),
    abort_after_consecutive_429: z.number().default(3),
    fetch_only_allowlisted_or_known_publishers: z.boolean(),
    max_entities_per_poll: z.number().default(400),
    min_query_interval_ms: z.number().default(5500),
  }),
});

export type FiltersConfig = z.infer<typeof FiltersSchema>;
export function getFilters(): FiltersConfig {
  return loadConfigFile("filters.json", FiltersSchema);
}

// ------------------------------------------------- FR-25 company profile policy
export const PROFILE_SECTION_IDS = [
  "firmographic",
  "location",
  "company_hierarchy",
  "product_offering",
  "industry",
  "financial_estimate",
  "funding_detail",
  "mna_and_investment",
  "business_model",
  "company_assessment",
  "digital_presence",
  "trust_signal",
  "management_profile",
  "strategic_signal",
  "customer_profile",
  "technology",
] as const;

export type ProfileSectionId = (typeof PROFILE_SECTION_IDS)[number];

const CompanyProfileSchema = z.object({
  $comment: z.string().optional(),
  version: z.string(),
  sections: z.array(z.enum(PROFILE_SECTION_IDS)),
  mandated_sections: z.array(z.enum(PROFILE_SECTION_IDS)),
  section_tiers: z.record(z.enum(PROFILE_SECTION_IDS), z.enum(["mini", "big"])),
  sections_per_call: z.number().int().min(1).max(8),
  refresh_days: z.number().int().min(7),
  max_entities_per_tick: z.number().int().min(1).max(500),
  max_attempts: z.number().int().min(1).max(20),
  corpus: z.object({
    articles: z.number().int().min(0).max(100),
    window_days: z.number().int().min(1).max(3650),
    excerpt_chars: z.number().int().min(100).max(4000),
  }),
  crawl: z.object({
    enabled: z.boolean(),
    paths: z.array(z.string()),
    max_pages: z.number().int().min(0).max(10),
    max_chars_per_page: z.number().int().min(200).max(20000),
    timeout_ms: z.number().int().min(1000).max(30000),
    $comment: z.string().optional(),
  }),
  field_hints: z.record(z.enum(PROFILE_SECTION_IDS), z.string()),
});

export type CompanyProfileConfig = z.infer<typeof CompanyProfileSchema>;

export function getCompanyProfileConfig(): CompanyProfileConfig {
  return loadConfigFile("company-profile.json", CompanyProfileSchema);
}

// --------------------------------------------------------------------- models
const ModelsSchema = z.object({
  version: z.string(),
  tiers: z.object({
    mini: z.object({ model: z.string(), purpose: z.string() }),
    big: z.object({ model: z.string(), purpose: z.string() }),
    judge: z.object({ model: z.string(), purpose: z.string() }),
    embed: z.object({ model: z.string(), dimensions: z.number(), purpose: z.string() }),
  }),
  pricing_per_1m_tokens: z.record(
    z.string(),
    z.object({ input: z.number(), output: z.number() }),
  ),
});

export type ModelsConfig = z.infer<typeof ModelsSchema>;

export function getModels(): ModelsConfig {
  const cfg = loadConfigFile("models.json", ModelsSchema);
  // env overrides (deployment-level choice of specific models)
  const env = process.env;
  return {
    ...cfg,
    tiers: {
      mini: { ...cfg.tiers.mini, model: env.MODEL_MINI ?? cfg.tiers.mini.model },
      big: { ...cfg.tiers.big, model: env.MODEL_BIG ?? cfg.tiers.big.model },
      judge: { ...cfg.tiers.judge, model: env.MODEL_JUDGE ?? cfg.tiers.judge.model },
      embed: { ...cfg.tiers.embed, model: env.MODEL_EMBED ?? cfg.tiers.embed.model },
    },
  };
}

export function priceFor(model: string): { input: number; output: number } {
  const m = getModels();
  return m.pricing_per_1m_tokens[model] ?? { input: 1.0, output: 2.0 };
}
