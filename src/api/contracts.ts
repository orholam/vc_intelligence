import { z } from "zod";

/**
 * API v1 wire contracts (FR-18..21). These double as validation at the edge
 * AND the source of the generated OpenAPI 3.1 document (/openapi.json).
 */

export {
  EnrichmentQuery,
  CompanyEnrichmentResponse,
  SECTION_SCHEMAS,
  minimalSectionPayload,
  CodeLabel,
} from "./contracts-enrichment.js";

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export function paginatedEnvelope<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    total: z.number().int(),
    count: z.number().int(),
    offset: z.number().int().min(0),
    data: z.array(item),
  });
}

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

// ------------------------------------------------------------------ FR-18 news
export const NewsQuery = PaginationQuery.extend({
  /** opaque entity id | slug | domain | URL (fetch-and-create via FR-8). */
  company: z.string().min(1),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  /** comma-separated event tags/families matched against all_tags */
  category: z.string().optional(),
  unique_article: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((v) => v === true || v === "true"),
  blacklisted: z.string().optional(), // comma-separated publisher domains to exclude
});

export const ArticleDto = z.object({
  id: z.string(),
  /** primary (subject) company — kept for backward compatibility */
  entity_id: z.string(),
  /** every company this news item relates to, primary first */
  entities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.enum(["primary", "secondary"]),
    }),
  ),
  title: z.string(),
  url: z.string(),
  publisher: z.string(),
  published_date: z.string(),
  language: z.string(),
  ai_summary: z.string().nullable(),
  sentiment: z.enum(["positive", "negative", "neutral"]).nullable(),
  sentiment_score: z.number().nullable(),
  newsworthiness: z.enum(["high", "medium", "low"]).nullable(),
  tags: z.array(z.object({ name: z.string(), is_primary: z.boolean() })),
  industry_primary: z.string().nullable(),
  industry_secondary: z.array(z.string()),
  countries: z.array(z.string()),
  excerpt: z.string(),
  text_available: z.boolean(),
  /** true when this is the earliest kept coverage of its primary entity */
  first_coverage: z.boolean(),
});

export const NewsResponse = paginatedEnvelope(ArticleDto);

export const LatestNewsQuery = PaginationQuery.extend({
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  /** comma-separated event tags/families matched against all_tags */
  category: z.string().optional(),
  unique_article: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((v) => v === true || v === "true"),
  /** filter by primary entity type (e.g. private-only sourcing views) */
  entity_type: z
    .enum(["private", "public", "subsidiary", "person-org", "fund", "other"])
    .optional(),
  /** exact publisher domain (e.g. "techcrunch.com") */
  publisher: z.string().optional(),
  /**
   * launch-surface filter on platform_meta.surface ("okara-launch-library",
   * "hn", …); "press" selects articles with no surface (null platform_meta).
   */
  surface: z.string().optional(),
  /**
   * acquisition-module filter ("rss-feeds" | "gdelt" | "web-search" |
   * "launchmonitor" | "hacker-news" | "direct-ingest") — see
   * /v1/news/sources by_module.
   */
  module: z.string().optional(),
});

export const LatestArticleDto = ArticleDto.extend({
  /** name of the primary company — kept for backward compatibility */
  entity_name: z.string(),
});

export const LatestNewsResponse = paginatedEnvelope(LatestArticleDto);

/** Per-source effectiveness row (c-plan monitoring views). */
export const SourceStatDto = z.object({
  source: z.string(),
  /** kept articles contributed inside the filtered window */
  articles: z.number().int(),
  /** distinct primary companies covered */
  companies: z.number().int(),
  /** ISO timestamp of the most recent article from this source */
  last_published: z.string(),
});

export const SurfaceStatDto = z.object({
  /** platform_meta.surface; "press" for null-surface (rss/gdelt) articles */
  surface: z.string(),
  articles: z.number().int(),
  companies: z.number().int(),
  last_published: z.string(),
});

/** Acquisition-module row — how articles entered the pipeline (c-plan). */
export const ModuleStatDto = z.object({
  module: z.string(),
  articles: z.number().int(),
  /** distinct primary companies covered */
  companies: z.number().int(),
  /** ISO timestamp of the most recent article from this module */
  last_published: z.string(),
});

export const SourceBreakdownResponse = z.object({
  total_articles: z.number().int(),
  total_sources: z.number().int(),
  by_publisher: z.array(SourceStatDto),
  by_surface: z.array(SurfaceStatDto),
  by_module: z.array(ModuleStatDto),
});

/** Corpus-wide business stats for the /latest monitoring view. */
export const NewsStatsResponse = z.object({
  /** canonical companies tracked: live, baseline-complete, excl. funds/person-orgs (matches /v1/companies/search default) */
  total_entities: z.number().int(),
  /** kept articles across the whole corpus */
  total_news: z.number().int(),
  /** kept articles published in the last 24 hours */
  news_24h: z.number().int(),
  /** tracked companies mentioned in at least one kept article */
  covered_entities: z.number().int(),
  /** watchlist companies driving GDELT queries */
  monitored_entities: z.number().int(),
  /** distinct publishers with at least one kept article */
  total_publishers: z.number().int(),
  /** company count per funding stage ("unknown" includes null); canonical set only */
  by_funding_stage: z.array(z.object({ stage: z.string(), count: z.number().int() })),
});

/** State-of-the-index aggregates for the /latest signal-pulse panel. */
export const NewsOverviewQuery = z.object({
  /** trailing window length in days, ending today (UTC) */
  days: z.coerce.number().int().min(7).max(90).default(30),
  /** how many top primary event tags to return */
  topic_limit: z.coerce.number().int().min(5).max(50).default(15),
});

export const NewsOverviewResponse = z.object({
  /** the window actually served (== days query param) */
  days: z.number().int(),
  /**
   * kept articles per UTC day over the window, deduped like the /latest feed
   * default (one article per story cluster) so totals line up with the feed.
   */
  volume: z.array(
    z.object({
      /** bucket day, YYYY-MM-DD */
      date: z.string(),
      /** kept articles published that day (deduped) */
      total: z.number().int(),
      high: z.number().int(),
      medium: z.number().int(),
      low: z.number().int(),
    }),
  ),
  /** current noise-stage snapshot of the WHOLE article index (incl. non-kept). */
  lifecycle: z.array(z.object({ stage: z.string(), count: z.number().int() })),
  /** top primary event tags (funding.series_a, product.launch, …) over the window. */
  topics: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});

// ------------------------------------------------------------- FR-19 companies
export const CompanyCard = z.object({
  id: z.string(),
  canonical_name: z.string(),
  legal_name: z.string().nullable(),
  website: z.string().nullable(),
  aliases: z.array(z.string()),
  type: z.string(),
  status: z.string(),
  country: z.string().nullable(),
  hq_city: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  industry_tags: z.array(z.string()),
  tickers: z.array(z.string()),
  funding_stage: z.string().nullable(),
  total_raised_usd: z.number().nullable(),
  last_funding_date: z.string().nullable(),
  source_refs: z.array(z.string()),
  confidence: z.number(),
  merged_into: z.string().nullable(),
  derived: z.object({
    article_count_30d: z.number().int(),
    last_news_date: z.string().nullable(),
    top_event_types: z.array(z.object({ tag: z.string(), count: z.number().int() })),
  }),
});

export const CompanySearchQuery = PaginationQuery.extend({
  q: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  entity_type: z
    .enum(["private", "public", "subsidiary", "person-org", "fund", "other"])
    .optional(),
  /** comma-separated funding stages, e.g. "seed,series_a" */
  funding_stage: z.string().optional(),
  /** C0 venture band: E0 (basement) → E3 (swarm). Filters the banded set only. */
  venture_band: z.enum(["E0", "E1", "E2", "E3"]).optional(),
});

export const CompanySearchResponse = paginatedEnvelope(CompanyCard);

export const CompanyGrowthQuery = z.object({
  /** bucket size for the cumulative KB-compilation series */
  granularity: z.enum(["day", "week", "month"]).default("month"),
  /** number of buckets to return, ending at the current one */
  buckets: z.coerce.number().int().min(2).max(400).default(12),
});

export const CompanyGrowthResponse = z.object({
  granularity: z.enum(["day", "week", "month"]),
  /** canonical companies tracked (matches /v1/companies/search default) */
  total: z.number().int(),
  points: z.array(
    z.object({
      /** bucket start date, YYYY-MM-DD */
      date: z.string(),
      /** companies first added during this bucket */
      added: z.number().int(),
      /** running total through this bucket */
      cumulative: z.number().int(),
    }),
  ),
});

export const CompanyIndustriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export const CompanyIndustriesResponse = z.object({
  /** canonical companies tracked overall (matches /v1/companies/search default) */
  total_companies: z.number().int(),
  /** canonical companies carrying at least one industry tag */
  total_classified: z.number().int(),
  industries: z.array(
    z.object({
      /** normalized industry slug, e.g. "ai_ml" */
      industry: z.string(),
      count: z.number().int(),
    }),
  ),
});

export const CompanyMixQuery = z.object({
  /** how many top countries to return */
  country_limit: z.coerce.number().int().min(5).max(50).default(10),
});

export const CompanyMixResponse = z.object({
  /** canonical companies tracked overall (matches /v1/companies/search default) */
  total: z.number().int(),
  /** C0 venture-band mix over the banded subset; "unbanded" = never banded */
  by_venture_band: z.array(z.object({ band: z.string(), count: z.number().int() })),
  /** HQ country mix, largest first; "unknown" = no country on record */
  by_country: z.array(z.object({ country: z.string(), count: z.number().int() })),
  /** entity-type mix (private/public/subsidiary/other) */
  by_type: z.array(z.object({ type: z.string(), count: z.number().int() })),
});

// ------------------------------------------------------------------- FR-20 ListGen
export const ListGenRequest = z.object({
  query: z.string().min(3).max(2000),
  limit: z.number().int().min(1).max(200).default(50),
});

export const InterpretedFilters = z.object({
  sectors: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]),
  funding_stage: z.array(z.string()).default([]),
  founded_after: z.number().int().nullable().default(null),
  founded_before: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  exclude_keywords: z.array(z.string()).default([]),
  signals: z.array(z.string()).default([]),
});

export const ListCompany = CompanyCard.extend({
  relevance_score: z.number(),
  recent_signals: z.array(
    z.object({
      headline: z.string(),
      url: z.string(),
      published_date: z.string(),
      tag: z.string().nullable(),
    }),
  ),
});

export const ListGenResponse = z.object({
  count: z.number().int(),
  companies: z.array(ListCompany),
  interpreted_filters: InterpretedFilters,
});

// ------------------------------------------------- FR-9 serving: structured events
export const EventsQuery = PaginationQuery.extend({
  /** comma-separated event types: funding_round,acquisition,leadership_change,closure */
  type: z.string().optional(),
  /** filter by primary entity type */
  entity_type: z
    .enum(["private", "public", "subsidiary", "person-org", "fund", "other"])
    .optional(),
  /** comma-separated funding stages matched against payload.funding_stage */
  stage: z.string().optional(),
  country: z.string().length(2).optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
});

export const EventEvidenceArticle = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  publisher: z.string(),
  published_date: z.string(),
});

export const EventDto = z.object({
  id: z.string(),
  type: z.string(),
  entity_id: z.string(),
  entity_name: z.string(),
  entity_website: z.string().nullable(),
  entity_type: z.string(),
  status: z.enum(["operating", "active", "acquired", "closed", "unknown"]),
  /** fact promotion status: accepted = multi-publisher verified, proposed = single-source */
  fact_status: z.enum(["accepted", "proposed"]),
  country: z.string().nullable(),
  funding_stage: z.string().nullable(),
  amount_usd_est: z.number().nullable(),
  lead_investors: z.array(z.string()),
  event_date: z.string().nullable(),
  distinct_publishers: z.number().int(),
  best_source_tier: z.number().int().nullable(),
  evidence_articles: z.array(EventEvidenceArticle),
  promoted_at: z.string().nullable(),
  created_at: z.string(),
});

export const EventsResponse = paginatedEnvelope(EventDto);

// -------------------------------------------------------------------- FR-21 feed
export const FeedQuery = z.object({
  entities: z.string().min(1), // comma-separated entity ids
  since: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const FeedResponse = z.object({
  events: z.array(
    z.object({
      type: z.literal("article"),
      article: ArticleDto,
    }),
  ),
  next_cursor: z.string().nullable(),
});

// -------------------------------------------------------------- webhooks (FR-21)
export const WebhookSubscriptionCreate = z.object({
  url: z.string().url(),
  entity_ids: z.array(z.string()).min(1).max(500),
});
export const WebhookSubscriptionDto = z.object({
  id: z.string(),
  url: z.string(),
  entity_ids: z.array(z.string()),
  active: z.boolean(),
  created_at: z.string(),
});

// ------------------------------------------------------------ admin: sources FR-1
export const SourceCreate = z.object({
  name: z.string().min(2).max(120),
  publisher: z.string().min(2).max(160),
  feed_url: z.string().url(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  country: z.string().length(2).nullish(),
  default_language: z.string().length(2).default("en"),
  topics: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});
export const SourceUpdate = SourceCreate.partial();
export const SourceDto = z.object({
  id: z.string(),
  name: z.string(),
  publisher: z.string(),
  feed_url: z.string(),
  tier: z.number().int(),
  country: z.string().nullable(),
  default_language: z.string(),
  topics: z.array(z.string()),
  active: z.boolean(),
  last_fetched_at: z.string().nullable(),
  failure_streak: z.number().int(),
  next_poll_at: z.string().nullable(),
});
export const SourcesResponse = paginatedEnvelope(SourceDto);

// ----------------------------------------------------------- admin: entities FR-6
export const EntityCreate = z.object({
  canonical_name: z.string().min(2).max(200),
  legal_name: z.string().nullish(),
  website: z.string().nullish(),
  aliases: z.array(z.string()).default([]),
  type: z.enum(["private", "public", "subsidiary", "person-org", "fund", "other"]).default("private"),
  status: z.enum(["operating", "active", "acquired", "closed", "unknown"]).default("operating"),
  country: z.string().length(2).nullish(),
  hq_city: z.string().nullish(),
  founded_year: z.number().int().nullish(),
  industry_tags: z.array(z.string()).default([]),
  tickers: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  is_monitored: z.boolean().default(false),
});
export const EntityUpdate = z.object({
  canonical_name: z.string().min(2).max(200).optional(),
  legal_name: z.string().nullish(),
  website: z.string().nullish(),
  aliases: z.array(z.string()).optional(),
  type: z.enum(["private", "public", "subsidiary", "person-org", "fund", "other"]).optional(),
  status: z.enum(["operating", "active", "acquired", "closed", "unknown"]).optional(),
  country: z.string().length(2).nullish(),
  hq_city: z.string().nullish(),
  founded_year: z.number().int().nullish(),
  industry_tags: z.array(z.string()).optional(),
  tickers: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  is_monitored: z.boolean().optional(),
});
export const AliasAdd = z.object({ alias: z.string().min(1).max(200) });
export const MergeRequest = z.object({
  source_entity_id: z.string(),
  target_entity_id: z.string(),
});

// ------------------------------------------------------------------ admin keys
export const ApiKeyCreate = z.object({ name: z.string().min(2).max(80) });
export const ApiKeyDto = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  created_at: z.string(),
});

// ------------------------------------------------------------- takedown NFR-7
export const TakedownResponse = z.object({
  removed: z.boolean(),
  url_hash: z.string(),
  note: z.string(),
});

// ---------------------------------------------------------------- observability
export const CostDashboardResponse = z.object({
  budget: z.object({
    month: z.string(),
    spent_usd: z.number(),
    cap_usd: z.number(),
    soft_limit_usd: z.number(),
    classify_only_mode: z.boolean(),
  }),
  stages: z.array(
    z.object({
      stage: z.string(),
      calls: z.number().int(),
      cost_usd: z.number(),
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
    }),
  ),
  blended_article_cost_usd: z.number().nullable(),
  pipeline_volumes: z.object({
    raw_items_24h: z.number().int(),
    kept_articles_24h: z.number().int(),
    discarded_24h: z.number().int(),
    discard_rate_pct: z.number(),
  }),
  /** c-plan alignment KPIs: is the corpus aimed at the magic zone? */
  alignment: z.object({
    private_share_pct_7d: z.number(),
    top10_mention_share_pct_7d: z.number(),
    launch_entities_total: z.number().int(),
  }),
  // ---- R09/G4: degradation is disclosed, never silent --------------------
  degrade_events: z.array(
    z.object({
      kind: z.string(),
      message: z.string(),
      created_at: z.string(),
    }),
  ),
  /** G4 ledger continuity: distinct days with llm_calls rows this month. */
  ledger_days_month: z.number().int(),
  // ---- R13 funnel counters + WoW deviation alerts ------------------------
  funnel_days: z.array(
    z.object({
      day: z.string(),
      raw_items: z.number().int(),
      fetched: z.number().int(),
      extracted: z.number().int(),
      kept: z.number().int(),
      prefilter_discards: z.number().int(),
      llm_discards: z.number().int(),
      quarantined: z.number().int(),
      parked_failures: z.number().int(),
      resolved: z.number().int(),
      enriched: z.number().int(),
      clustered: z.number().int(),
      facts_proposed: z.number().int(),
      facts_accepted: z.number().int(),
      needs_backfill_outstanding: z.number().int(),
      /** FR-25: profile sections completed this day */
      profiles_complete: z.number().int(),
    }),
  ),
  funnel_alerts: z.array(
    z.object({
      stage: z.string(),
      prev7: z.number(),
      last7: z.number(),
      delta_pct: z.number(),
    }),
  ),
  /** R06 backfill queue depth (trends to ~0 weekly). */
  needs_backfill_outstanding: z.number().int(),
});
