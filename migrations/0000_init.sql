CREATE TABLE "aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"alias" text NOT NULL,
	"alias_normalized" text NOT NULL,
	"kind" text DEFAULT 'name' NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rate_limit_per_min" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "article_entities" (
	"article_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"role" text NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" text PRIMARY KEY NOT NULL,
	"raw_item_id" text,
	"source_id" text,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"publisher_domain" text NOT NULL,
	"title" text NOT NULL,
	"byline" text,
	"published_at" timestamp with time zone NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"extracted_text_path" text,
	"extracted_text_chars" integer,
	"extracted_text_hash" text,
	"excerpt_text" text,
	"outlink_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"og_metadata" jsonb,
	"noise_stage" text DEFAULT 'pending' NOT NULL,
	"noise_score" real,
	"discard_reason" text,
	"primary_tag" text,
	"secondary_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"all_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"sentiment" text,
	"sentiment_score" real,
	"newsworthiness" text,
	"industry_primary" text,
	"industry_secondary" text[] DEFAULT '{}'::text[] NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"ai_summary" text,
	"story_cluster_id" text,
	"embedding" vector(256),
	"is_cluster_representative" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"enriched_at" timestamp with time zone,
	"clustered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"config" jsonb,
	"metrics" jsonb,
	"report_path" text,
	"raw_storage_path" text,
	"llm_cost_usd" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "domain_lists" (
	"domain" text PRIMARY KEY NOT NULL,
	"list" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_name" text NOT NULL,
	"legal_name" text,
	"website" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"type" text DEFAULT 'private' NOT NULL,
	"status" text DEFAULT 'operating' NOT NULL,
	"country" text,
	"hq_city" text,
	"founded_year" integer,
	"industry_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"tickers" text[] DEFAULT '{}'::text[] NOT NULL,
	"funding_stage" text,
	"total_raised_usd" bigint,
	"last_funding_date" timestamp with time zone,
	"source_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"merged_into" text,
	"is_monitored" boolean DEFAULT false NOT NULL,
	"review_status" text DEFAULT 'reviewed' NOT NULL,
	"created_by" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_imports" (
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_id" text,
	"payload_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"evidence_article_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"distinct_publishers" integer DEFAULT 1 NOT NULL,
	"best_source_tier" integer,
	"dedup_key" text NOT NULL,
	"rejected_reason" text,
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gdelt_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kv_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"tier" text NOT NULL,
	"model" text NOT NULL,
	"prompt_template" text,
	"prompt_template_version" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"article_id" text,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text,
	"discovered_via" text NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"guid_hash" text,
	"title" text,
	"published_at" timestamp with time zone,
	"gdelt_meta" jsonb,
	"raw_payload" jsonb,
	"fetch_state" text DEFAULT 'pending' NOT NULL,
	"fetch_attempts" integer DEFAULT 0 NOT NULL,
	"fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"publisher" text NOT NULL,
	"feed_url" text NOT NULL,
	"tier" integer NOT NULL,
	"country" text,
	"default_language" text DEFAULT 'en' NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"etag" text,
	"last_modified" text,
	"failure_streak" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" text PRIMARY KEY NOT NULL,
	"primary_entity_id" text,
	"representative_article_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"article_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"entity_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_entities" ADD CONSTRAINT "article_entities_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_entities" ADD CONSTRAINT "article_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_imports" ADD CONSTRAINT "entity_imports_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_primary_entity_id_entities_id_fk" FOREIGN KEY ("primary_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_representative_article_id_articles_id_fk" FOREIGN KEY ("representative_article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aliases_normalized_key" ON "aliases" USING btree ("alias_normalized","entity_id");--> statement-breakpoint
CREATE INDEX "aliases_norm_lookup_idx" ON "aliases" USING btree ("alias_normalized");--> statement-breakpoint
CREATE INDEX "aliases_trgm_idx" ON "aliases" USING gin ("alias_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "article_entities_pk" ON "article_entities" USING btree ("article_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_entities_one_primary" ON "article_entities" USING btree ("article_id") WHERE role = 'primary';--> statement-breakpoint
CREATE INDEX "article_entities_entity_idx" ON "article_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_url_hash_key" ON "articles" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX "articles_published_at_idx" ON "articles" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "articles_noise_stage_idx" ON "articles" USING btree ("noise_stage");--> statement-breakpoint
CREATE INDEX "articles_all_tags_idx" ON "articles" USING btree ("all_tags");--> statement-breakpoint
CREATE INDEX "articles_story_cluster_idx" ON "articles" USING btree ("story_cluster_id");--> statement-breakpoint
CREATE INDEX "articles_publisher_domain_idx" ON "articles" USING btree ("publisher_domain");--> statement-breakpoint
CREATE INDEX "articles_newsworthiness_idx" ON "articles" USING btree ("newsworthiness");--> statement-breakpoint
CREATE INDEX "articles_primary_tag_idx" ON "articles" USING btree ("primary_tag");--> statement-breakpoint
CREATE INDEX "articles_countries_idx" ON "articles" USING btree ("countries");--> statement-breakpoint
CREATE INDEX "articles_industry_primary_idx" ON "articles" USING btree ("industry_primary");--> statement-breakpoint
CREATE INDEX "articles_embedding_hnsw_idx" ON "articles" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "entities_live_website_key" ON "entities" USING btree ("website") WHERE merged_into IS NULL AND website IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entities_country_idx" ON "entities" USING btree ("country");--> statement-breakpoint
CREATE INDEX "entities_industry_tags_idx" ON "entities" USING btree ("industry_tags");--> statement-breakpoint
CREATE INDEX "entities_tickers_idx" ON "entities" USING btree ("tickers");--> statement-breakpoint
CREATE INDEX "entities_funding_stage_idx" ON "entities" USING btree ("funding_stage");--> statement-breakpoint
CREATE INDEX "entities_monitor_idx" ON "entities" USING btree ("is_monitored");--> statement-breakpoint
CREATE INDEX "entities_canonical_name_trgm_idx" ON "entities" USING gin ("canonical_name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "entity_imports_pk" ON "entity_imports" USING btree ("source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facts_dedup_key" ON "facts" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "facts_entity_status_idx" ON "facts" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_article_idx" ON "llm_calls" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_items_url_hash_key" ON "raw_items" USING btree ("url_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_items_guid_hash_key" ON "raw_items" USING btree ("guid_hash");--> statement-breakpoint
CREATE INDEX "raw_items_fetch_state_idx" ON "raw_items" USING btree ("fetch_state");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_feed_url_key" ON "sources" USING btree ("feed_url");--> statement-breakpoint
CREATE INDEX "sources_next_poll_idx" ON "sources" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "stories_primary_entity_idx" ON "stories" USING btree ("primary_entity_id");--> statement-breakpoint
CREATE INDEX "webhook_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at");