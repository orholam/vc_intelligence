import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Intelligence service schema.
 *
 * Conventions:
 *  - Primary keys are opaque prefixed ids ("art_", "ent_", "src_", ...) generated app-side
 *    (ULID-derived, see src/lib/ulid.ts) so they are stable across renames (FR-6 AC).
 *  - Enum-ish columns are text typed at the TS boundary via `$type<...>()`; allowed values
 *    live in src/lib/enums.ts and are enforced by zod contracts, keeping migrations light.
 *  - Embeddings are fixed-width vectors (EMBEDDING_DIM=256, see README "Changing embedding
 *    dimension") used only for story clustering (FR-17).
 */

// ---------------------------------------------------------------- sources (FR-1)
export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    publisher: text("publisher").notNull(),
    feedUrl: text("feed_url").notNull(),
    tier: integer("tier").notNull().$type<1 | 2 | 3>(),
    country: text("country"),
    defaultLanguage: text("default_language").notNull().default("en"),
    topics: text("topics").array().notNull().default(sql`'{}'::text[]`),
    active: boolean("active").notNull().default(true),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    etag: text("etag"),
    lastModified: text("last_modified"),
    failureStreak: integer("failure_streak").notNull().default(0),
    lastError: text("last_error"),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sources_feed_url_key").on(t.feedUrl),
    index("sources_next_poll_idx").on(t.nextPollAt),
  ],
);

// -------------------------------------------------------------- raw items (FR-2/FR-3 dedup)
export const rawItems = pgTable(
  "raw_items",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "set null" }),
    discoveredVia: text("discovered_via").notNull().$type<"rss" | "gdelt" | "search" | "manual">(),
    url: text("url").notNull(),
    urlHash: text("url_hash").notNull(),
    guidHash: text("guid_hash"),
    title: text("title"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    gdeltMeta: jsonb("gdelt_meta").$type<GdeltMeta | null>(),
    rawPayload: jsonb("raw_payload"),
    fetchState: text("fetch_state").notNull().default("pending").$type<"pending" | "fetched" | "failed">(),
    fetchAttempts: integer("fetch_attempts").notNull().default(0),
    fetchError: text("fetch_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Content-hash dedup at ingestion (FR-2 AC: zero duplicate raw items).
    uniqueIndex("raw_items_url_hash_key").on(t.urlHash),
    uniqueIndex("raw_items_guid_hash_key").on(t.guidHash),
    index("raw_items_fetch_state_idx").on(t.fetchState),
  ],
);

export interface GdeltMeta {
  seendate?: string;
  sourceDomain?: string;
  language?: string;
  socialimage?: string;
  domain?: string;
  [k: string]: unknown;
}

// ------------------------------------------------------------------ entities (FR-6, §6.2)
export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    legalName: text("legal_name"),
    /** Normalized registrable domain, e.g. "acme.ai". Primary join key (§6.2). */
    website: text("website"),
    /** Display-form aliases (denormalized mirror of `aliases` rows for API card). */
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    type: text("type")
      .notNull()
      .default("private")
      .$type<"private" | "public" | "subsidiary" | "person-org" | "fund" | "other">(),
    status: text("status")
      .notNull()
      .default("operating")
      .$type<"operating" | "active" | "acquired" | "closed" | "unknown">(),
    country: text("country"),
    hqCity: text("hq_city"),
    foundedYear: integer("founded_year"),
    industryTags: text("industry_tags").array().notNull().default(sql`'{}'::text[]`),
    tickers: text("tickers").array().notNull().default(sql`'{}'::text[]`),
    // Funding fields populated ONLY by FR-9 signal-derived facts (never bought data).
    fundingStage: text("funding_stage"),
    totalRaisedUsd: bigint("total_raised_usd", { mode: "number" }),
    lastFundingDate: timestamp("last_funding_date", { withTimezone: true }),
    sourceRefs: text("source_refs").array().notNull().default(sql`'{}'::text[]`),
    /**
     * External registry identifiers (c-plan): {"sec_cik": "0001720559",
     * "companies_house": "09876543", "us_state_inc": "DE"}. Strongest
     * disambiguators where press/domain evidence is thin (left-edge entities).
     */
    registryIds: jsonb("registry_ids").$type<Record<string, string>>(),
    confidence: real("confidence").notNull().default(0.5),
    mergedInto: text("merged_into"),
    /**
     * R06 minimum-viable-card gate: entities stay flagged until the backfill
     * worker guarantees the baseline card (domain attempted, country inferred
     * or unknown-flagged, >=1 industry tag, funding_stage non-null, aliases
     * seeded). Flagged entities are excluded from default ListGen/search.
     */
    needsBackfill: boolean("needs_backfill").notNull().default(true),
    /** Watchlist flag driving GDELT queries (FR-3). */
    isMonitored: boolean("is_monitored").notNull().default(false),
    /**
     * C0 venture band derived from DB evidence only (rubric §4): E3 swarm /
     * E2 validated / E1 emerging / E0 basement. Null until first banding run.
     */
    ventureBand: text("venture_band").$type<"E0" | "E1" | "E2" | "E3" | null>(),
    bandedAt: timestamp("banded_at", { withTimezone: true }),
    reviewStatus: text("review_status")
      .notNull()
      .default("reviewed")
      .$type<"auto_created" | "reviewed" | "rejected">(),
    createdBy: text("created_by").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Domain is the primary join key; unique among live (unmerged) entities.
    uniqueIndex("entities_live_website_key")
      .on(t.website)
      .where(sql`merged_into IS NULL AND website IS NOT NULL`),
    index("entities_country_idx").on(t.country),
    index("entities_industry_tags_idx").on(t.industryTags),
    index("entities_tickers_idx").on(t.tickers),
    index("entities_funding_stage_idx").on(t.fundingStage),
    index("entities_monitor_idx").on(t.isMonitored),
    // Registry join keys (c-plan): Form D / Companies House dedup + merge.
    index("entities_registry_cik_idx").on(sql`(registry_ids->>'sec_cik')`),
    index("entities_registry_ch_idx").on(sql`(registry_ids->>'companies_house')`),
    index("entities_created_by_idx").on(t.createdBy),
    index("entities_needs_backfill_idx").on(t.needsBackfill),
    index("entities_canonical_name_trgm_idx").using(
      "gin",
      t.canonicalName.op("gin_trgm_ops"),
    ),
  ],
);

/** Alias table drives candidate generation (FR-6/FR-10). */
export const aliases = pgTable(
  "aliases",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    /** Lowercased, punctuation-stripped form used for matching. */
    aliasNormalized: text("alias_normalized").notNull(),
    kind: text("kind")
      .notNull()
      .default("name")
      .$type<"name" | "former_name" | "ticker" | "domain" | "abbrev">(),
    weight: real("weight").notNull().default(1),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("aliases_normalized_key").on(t.aliasNormalized, t.entityId),
    index("aliases_norm_lookup_idx").on(t.aliasNormalized),
    index("aliases_trgm_idx").using("gin", t.aliasNormalized.op("gin_trgm_ops")),
  ],
);

/** Import ledger making FR-7 re-runs idempotent. */
export const entityImports = pgTable(
  "entity_imports",
  {
    source: text("source")
      .notNull()
      .$type<"wikidata" | "edgar" | "companies_house" | "seed">(),
    externalId: text("external_id").notNull(),
    entityId: text("entity_id").references(() => entities.id, { onDelete: "set null" }),
    payloadHash: text("payload_hash").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("entity_imports_pk").on(t.source, t.externalId)],
);

// ------------------------------------------------------------------ articles (§6.1)
export interface ResolutionEvidence {
  alias?: string;
  domain_overlap?: boolean;
  llm?: "adjudicated" | "not_needed";
  scores?: Record<string, number>;
  notes?: string[];
}

export const articles = pgTable(
  "articles",
  {
    id: text("id").primaryKey(), // art_<ulid>
    rawItemId: text("raw_item_id").references(() => rawItems.id, { onDelete: "set null" }),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    urlHash: text("url_hash").notNull(),
    publisherDomain: text("publisher_domain").notNull(),
    title: text("title").notNull(),
    byline: text("byline"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    language: text("language").notNull().default("en"),
    /** Object-storage ref of extracted full text (internal only, NFR-8). */
    extractedTextPath: text("extracted_text_path"),
    extractedTextChars: integer("extracted_text_chars"),
    extractedTextHash: text("extracted_text_hash"),
    /**
     * Precomputed ≤400-char excerpt served by the API (NFR-8 external policy).
     * NOT NULL per rubric gate G2: every servable article carries provenance.
     */
    excerptText: text("excerpt_text").notNull().default(""),
    /** Outbound link hosts/domains kept as resolution evidence (FR-10). */
    outlinkDomains: text("outlink_domains").array().notNull().default(sql`'{}'::text[]`),
    ogMetadata: jsonb("og_metadata").$type<Record<string, string> | null>(),

    // Filtering: noise_stage records final outcome incl. discard stage.
    // "waiting": passed every programmatic gate and parked in the waiting
    // room until a harness run performs the batched LLM pass (corrections,
    // new-company deep search, card updates) and publishes survivors.
    // "llm_filter" now means the HARNESS judged it irrelevant (batch discard).
    // "quarantined" is legacy (pre-harness R05 drain); no longer written.
    noiseStage: text("noise_stage")
      .notNull()
      .default("pending")
      .$type<"pending" | "prefilter" | "llm_filter" | "kept" | "quarantined" | "waiting">(),
    noiseScore: real("noise_score"),
    discardReason: text("discard_reason"),
    /** Bounded quarantine retries (R05): drain worker gives up after N. */
    enrichAttempts: integer("enrich_attempts").notNull().default(0),

    // Enrichment (FR-13..16).
    primaryTag: text("primary_tag"),
    secondaryTags: text("secondary_tags").array().notNull().default(sql`'{}'::text[]`),
    allTags: text("all_tags").array().notNull().default(sql`'{}'::text[]`),
    sentiment: text("sentiment").$type<"positive" | "negative" | "neutral">(),
    sentimentScore: real("sentiment_score"),
    newsworthiness: text("newsworthiness").$type<"high" | "medium" | "low">(),
    industryPrimary: text("industry_primary"),
    industrySecondary: text("industry_secondary").array().notNull().default(sql`'{}'::text[]`),
    countries: text("countries").array().notNull().default(sql`'{}'::text[]`),
    aiSummary: text("ai_summary"),
    /** Structured fact this news record points at (funding, M&A, …). Null when untyped. FK in SQL. */
    factId: text("fact_id"),

    // Clustering (FR-17).
    storyClusterId: text("story_cluster_id"),
    embedding: vector("embedding", { dimensions: 256 }),
    isClusterRepresentative: boolean("is_cluster_representative").notNull().default(false),

    /**
     * Side-channel ingestion metadata (c-plan): launch-surface attention
     * (`surface`, votes, rank…) or deferred Form D data (`formd`). Null for
     * press-derived articles.
     */
    platformMeta: jsonb("platform_meta").$type<{
      surface?: string;
      votes?: number;
      points?: number;
      rank?: number;
      external_url?: string | null;
      formd?: { accession: string; fileDate: string | null; cik: string };
      [k: string]: unknown;
    } | null>(),

    // Pipeline bookkeeping.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    clusteredAt: timestamp("clustered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("articles_url_hash_key").on(t.urlHash),
    index("articles_published_at_idx").on(t.publishedAt.desc()),
    index("articles_noise_stage_idx").on(t.noiseStage),
    index("articles_all_tags_idx").on(t.allTags),
    index("articles_story_cluster_idx").on(t.storyClusterId),
    index("articles_publisher_domain_idx").on(t.publisherDomain),
    index("articles_newsworthiness_idx").on(t.newsworthiness),
    index("articles_primary_tag_idx").on(t.primaryTag),
    index("articles_fact_id_idx").on(t.factId),
    index("articles_countries_idx").on(t.countries),
    index("articles_industry_primary_idx").on(t.industryPrimary),
    index("articles_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/** Resolution output (FR-11): primary + secondary mentions w/ evidence trail. */
export const articleEntities = pgTable(
  "article_entities",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<"primary" | "secondary">(),
    confidence: real("confidence").notNull(),
    evidence: jsonb("evidence").$type<ResolutionEvidence>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One primary per article; secondaries unique per pair.
    uniqueIndex("article_entities_pk").on(t.articleId, t.entityId),
    uniqueIndex("article_entities_one_primary")
      .on(t.articleId)
      .where(sql`role = 'primary'`),
    index("article_entities_entity_idx").on(t.entityId),
  ],
);

// ------------------------------------------------------------- story clusters (FR-17)
export const stories = pgTable(
  "stories",
  {
    id: text("id").primaryKey(),
    primaryEntityId: text("primary_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    representativeArticleId: text("representative_article_id").references(() => articles.id, {
      onDelete: "set null",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    articleCount: integer("article_count").notNull().default(1),
  },
  (t) => [index("stories_primary_entity_idx").on(t.primaryEntityId)],
);

// ------------------------------------------------------- signal-derived facts (FR-9)
export const facts = pgTable(
  "facts",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    type: text("type")
      .notNull()
      .$type<"funding_round" | "acquisition" | "leadership_change" | "closure" | "product_launch">(),
    payload: jsonb("payload")
      .notNull()
      .$type<{
        funding_stage?: string;
        amount_usd_est?: number;
        lead_investors?: string[];
        acquirer?: string;
        target?: string;
        person?: string;
        role?: string;
        event_date?: string;
      }>(),
    status: text("status").notNull().default("proposed").$type<"proposed" | "accepted" | "rejected">(),
    evidenceArticleIds: text("evidence_article_ids").array().notNull().default(sql`'{}'::text[]`),
    distinctPublishers: integer("distinct_publishers").notNull().default(1),
    bestSourceTier: integer("best_source_tier"),
    /** Dedup key: entity + normalized type/payload so re-processing never duplicates. */
    dedupKey: text("dedup_key").notNull(),
    rejectedReason: text("rejected_reason"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("facts_dedup_key").on(t.dedupKey),
    index("facts_entity_status_idx").on(t.entityId, t.status),
  ],
);

// ------------------------------------------------------------------- API keys (auth)
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** SHA-256 of the raw key; raw shown once at creation (NFR-6 hashed at rest). */
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    active: boolean("active").notNull().default(true),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(60),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_key").on(t.keyHash)],
);

// ------------------------------------------------------------------------- webhooks (FR-21)
export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: text("id").primaryKey(),
  apiKeyId: text("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  entityIds: text("entity_ids").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    articleId: text("article_id").references(() => articles.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "delivered" | "failed">(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("webhook_due_idx").on(t.nextAttemptAt)],
);

// ------------------------------------------- akta-parity company profiles (FR-25)
/**
 * One row per (entity, profile section). Section payloads mirror akta.pro's
 * Company Data dictionary (16 sections / 74 fields) and are shaped by the zod
 * contracts in src/api/contracts-enrichment.ts. Every complete row carries its
 * evidence source URLs — no uncited fields leave the building.
 */
export const entityProfiles = pgTable(
  "entity_profiles",
  {
    id: text("id").primaryKey(), // prf_<ulid>
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    section: text("section").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    /** Cited evidence for the payload; URLs only from the evidence pack. */
    evidence: jsonb("evidence").$type<{ sources: string[] } | null>(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "complete" | "failed">(),
    /** How the payload was produced: llm | facts (FR-9) | registry (FR-7). */
    derivedFrom: text("derived_from").notNull().default("llm").$type<"llm" | "facts" | "registry">(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    model: text("model"),
    promptTemplateVersion: text("prompt_template_version"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /** Refresh deadline; stale sections re-enter the profiling queue. */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("entity_profiles_entity_section_key").on(t.entityId, t.section),
    index("entity_profiles_status_idx").on(t.status, t.staleAt),
    index("entity_profiles_entity_idx").on(t.entityId),
  ],
);

// --------------------------------------------------- LLM call ledger (FR-12, NFR-4/9)
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    stage: text("stage").notNull(),
    tier: text("tier").notNull().$type<"mini" | "big" | "embed" | "judge">(),
    model: text("model").notNull(),
    promptTemplate: text("prompt_template"),
    promptTemplateVersion: text("prompt_template_version"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms"),
    articleId: text("article_id"),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_calls_created_idx").on(t.createdAt),
    index("llm_calls_article_idx").on(t.articleId),
  ],
);

// ------------------------------------------------- harness LLM work queue (path-2)
/**
 * Pending LLM completions delegated to an external agent harness (LLM_PROVIDER
 * = "harness"). The service inserts a request row and waits; the harness
 * claims via GET /internal/llm/claim and answers via POST /internal/llm/:id/
 * result. Postgres-backed so api/worker process splits and restarts work;
 * rows expire instead of wedging the pipeline (same fail-open semantics as
 * budget degradation).
 */
export const llmRequests = pgTable(
  "llm_requests",
  {
    id: text("id").primaryKey(), // lreq_<ulid>
    stage: text("stage").notNull(),
    tier: text("tier").notNull().$type<"mini" | "big" | "judge">(),
    system: text("system").notNull(),
    userPrompt: text("user_prompt").notNull(),
    /** JSON Schema of the expected response object (zod-derived). */
    responseSchema: jsonb("response_schema"),
    maxOutputTokens: integer("max_output_tokens"),
    articleId: text("article_id"),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "claimed" | "done" | "failed" | "expired">(),
    /** {ok:true,data,raw?,model?} | {ok:false,error} written by the harness. */
    result: jsonb("result"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_requests_claim_idx").on(t.status, t.createdAt),
    index("llm_requests_article_idx").on(t.articleId),
  ],
);

// --------------------------------------------------------------- benchmark runs (FR-23)
export const benchmarkRuns = pgTable("benchmark_runs", {
  id: text("id").primaryKey(),
  period: text("period").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  config: jsonb("config"),
  metrics: jsonb("metrics"),
  reportPath: text("report_path"),
  rawStoragePath: text("raw_storage_path"),
  llmCostUsd: doublePrecision("llm_cost_usd").notNull().default(0),
  status: text("status").notNull().default("running").$type<"running" | "done" | "failed">(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// --------------------------------------------- GDELT config & domain quality (FR-3)
export const domainLists = pgTable("domain_lists", {
  domain: text("domain").primaryKey(),
  list: text("list").notNull().$type<"allow" | "block">(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gdeltQueries = pgTable("gdelt_queries", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  active: boolean("active").notNull().default(true),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
});

/** Generic runtime state (circuit breaker overrides, cursors, etc.). */
export const kvState = pgTable("kv_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * R09/R10 audit trail is covered by `pipeline_events` (budget degradation,
 * quarantine spikes) and `source_events` (lifecycle transitions) below.
 */

// --------------------------------------------- funnel counters (R13 observability)
export const funnelDaily = pgTable("funnel_daily", {
  /** UTC day (YYYY-MM-DD). One row per day; upserted idempotently. */
  day: text("day").primaryKey(),
  rawItems: integer("raw_items").notNull().default(0),
  fetched: integer("fetched").notNull().default(0),
  extracted: integer("extracted").notNull().default(0),
  kept: integer("kept").notNull().default(0),
  prefilterDiscards: integer("prefilter_discards").notNull().default(0),
  llmDiscards: integer("llm_discards").notNull().default(0),
  quarantined: integer("quarantined").notNull().default(0),
  parkedFailures: integer("parked_failures").notNull().default(0),
  resolved: integer("resolved").notNull().default(0),
  enriched: integer("enriched").notNull().default(0),
  clustered: integer("clustered").notNull().default(0),
  factsProposed: integer("facts_proposed").notNull().default(0),
  factsAccepted: integer("facts_accepted").notNull().default(0),
  needsBackfillOutstanding: integer("needs_backfill_outstanding").notNull().default(0),
  /** FR-25: profile sections completed this day. */
  profilesComplete: integer("profiles_complete").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ------------------------------------------- source lifecycle audit (R10)
export const sourceEvents = pgTable(
  "source_events",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    event: text("event")
      .notNull()
      .$type<
        | "onboard_ok"
        | "onboard_unhealthy"
        | "throttled"
        | "tier_demoted"
        | "pruned"
        | "reactivated"
      >(),
    reason: text("reason"),
    actor: text("actor").notNull().default("system"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_events_source_idx").on(t.sourceId, t.createdAt),
    index("source_events_event_idx").on(t.event),
  ],
);

// ------------------------------- pipeline events (R09 budget degradation, G4)
export const pipelineEvents = pgTable(
  "pipeline_events",
  {
    id: text("id").primaryKey(),
    kind: text("kind")
      .notNull()
      .$type<"budget_degrade_soft" | "budget_stop_hard" | "budget_recovered" | "quarantine_spike">(),
    message: text("message").notNull(),
    /** Dedup key so a state transition is recorded once per month/kind. */
    dedupKey: text("dedup_key").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pipeline_events_dedup_key").on(t.dedupKey)],
);

// -------------------------- exoskeleton live item traces (ops console only)
/**
 * One row per item-per-stage movement, written fire-and-forget by the pipeline
 * handlers so the /exoskeleton console can animate INDIVIDUAL items moving
 * through the engine. Ephemeral telemetry: rows self-clean after a couple of
 * hours and are never used for serving decisions.
 */
export const pipelineTraces = pgTable(
  "pipeline_traces",
  {
    id: text("id").primaryKey(),
    /** Diagram node the item arrived at ("fetch", "waiting_room", …). */
    node: text("node").notNull(),
    /** The moving item's opaque id (rit_/art_/fct_…). */
    refId: text("ref_id").notNull(),
    kind: text("kind").notNull().$type<"raw" | "article" | "fact">(),
    label: text("label"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pipeline_traces_created_idx").on(t.createdAt),
    index("pipeline_traces_ref_idx").on(t.refId),
  ],
);

/**
 * Completed item journeys (exoskeleton Live Pipeline): ONE package per item,
 * assembled when it reaches a terminal bucket (failure, discard, waiting
 * room, harness discard, winner). The console animates the whole packaged
 * path on receipt — there is no history replay and no per-hop streaming.
 */
export const pipelineJourneys = pgTable(
  "pipeline_journeys",
  {
    id: text("id").primaryKey(), // jrn_<ulid>
    /** Stable item id across the whole journey (raw-item id when present). */
    refId: text("ref_id").notNull(),
    terminalNode: text("terminal_node").notNull(),
    title: text("title"),
    /** Ordered steps: [{ node, ts, label?, detail? }, …]. */
    steps: jsonb("steps")
      .notNull()
      .$type<Array<{ node: string; ts: string; label?: string | null; detail?: string | null }>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pipeline_journeys_ref_terminal_key").on(t.refId, t.terminalNode),
    index("pipeline_journeys_created_idx").on(t.createdAt),
  ],
);

/**
 * Operator miscategorization flags (exoskeleton Live Pipeline): a human
 * disagreeing with an item's terminal verdict ("this shouldn't have been
 * discarded", "this shouldn't have been kept") marks it here. DOES NOT
 * self-clean like traces — it is the durable review trail that survives
 * the 2h journey retention, so a flagged item is re-inspectable (steps
 * snapshot included) long after its package expired.
 */
export const pipelineMisflags = pgTable(
  "pipeline_misflags",
  {
    id: text("id").primaryKey(), // mfl_<ulid>
    /** Stable item id across its journey (raw-item id when present). */
    refId: text("ref_id").notNull(),
    kind: text("kind").notNull().default("article").$type<"raw" | "article" | "fact">(),
    /** Title snapshot at flag time (journeys self-clean; this survives). */
    title: text("title"),
    /** Terminal bucket the item was in when flagged ("harness_discards", …). */
    terminalNode: text("terminal_node"),
    /** The "why" shown in the feed at flag time (terminal step detail). */
    detail: text("detail"),
    /** Journey steps snapshot so the verdict is re-inspectable later. */
    steps: jsonb("steps").$type<
      Array<{ node: string; ts: string; label?: string | null; detail?: string | null }> | null
    >(),
    /** Free-text reason the operator disagrees with the verdict. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pipeline_misflags_created_idx").on(t.createdAt),
    index("pipeline_misflags_ref_idx").on(t.refId),
  ],
);
