CREATE TABLE "funnel_daily" (
	"day" text PRIMARY KEY NOT NULL,
	"raw_items" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"extracted" integer DEFAULT 0 NOT NULL,
	"kept" integer DEFAULT 0 NOT NULL,
	"prefilter_discards" integer DEFAULT 0 NOT NULL,
	"llm_discards" integer DEFAULT 0 NOT NULL,
	"quarantined" integer DEFAULT 0 NOT NULL,
	"parked_failures" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"enriched" integer DEFAULT 0 NOT NULL,
	"clustered" integer DEFAULT 0 NOT NULL,
	"facts_proposed" integer DEFAULT 0 NOT NULL,
	"facts_accepted" integer DEFAULT 0 NOT NULL,
	"needs_backfill_outstanding" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"dedup_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"event" text NOT NULL,
	"reason" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "excerpt_text" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "excerpt_text" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "enrich_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "needs_backfill" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "venture_band" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "banded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_events_dedup_key" ON "pipeline_events" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "source_events_source_idx" ON "source_events" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "source_events_event_idx" ON "source_events" USING btree ("event");--> statement-breakpoint
CREATE INDEX "entities_needs_backfill_idx" ON "entities" USING btree ("needs_backfill");