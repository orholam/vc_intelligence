-- NOTE: 0003_company_profiles.sql predates its drizzle snapshot, so this
-- migration re-emits some of its DDL. Every pre-existing statement is guarded
-- (IF NOT EXISTS / DO blocks) so the file is idempotent on databases that
-- already applied 0003. Only `llm_requests` is genuinely new (harness mode).

CREATE TABLE IF NOT EXISTS "entity_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"section" text NOT NULL,
	"payload" jsonb,
	"evidence" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"derived_from" text DEFAULT 'llm' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"model" text,
	"prompt_template_version" text,
	"generated_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"tier" text NOT NULL,
	"system" text NOT NULL,
	"user_prompt" text NOT NULL,
	"response_schema" jsonb,
	"max_output_tokens" integer,
	"article_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "needs_backfill" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "funnel_daily" ADD COLUMN IF NOT EXISTS "profiles_complete" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_profiles_entity_section_key" ON "entity_profiles" USING btree ("entity_id","section");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_profiles_status_idx" ON "entity_profiles" USING btree ("status","stale_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_profiles_entity_idx" ON "entity_profiles" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_requests_claim_idx" ON "llm_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_requests_article_idx" ON "llm_requests" USING btree ("article_id");
