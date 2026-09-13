-- FR-25 akta-parity company profiles: one row per (entity, profile section).
-- Sections mirror akta.pro's Company Data dictionary (16 sections / 74 fields);
-- payloads are evidence-cited JSONB shaped by the zod contracts in
-- src/api/contracts-enrichment.ts. Status lifecycle mirrors R05 semantics:
-- pending -> complete | failed (parked after max_attempts, drained by ops).
CREATE TABLE "entity_profiles" (
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_profiles_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_profiles_entity_section_key" ON "entity_profiles" USING btree ("entity_id","section");--> statement-breakpoint
CREATE INDEX "entity_profiles_status_idx" ON "entity_profiles" USING btree ("status","stale_at");--> statement-breakpoint
CREATE INDEX "entity_profiles_entity_idx" ON "entity_profiles" USING btree ("entity_id");--> statement-breakpoint
ALTER TABLE "funnel_daily" ADD COLUMN "profiles_complete" integer DEFAULT 0 NOT NULL;