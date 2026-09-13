CREATE TABLE "pipeline_journeys" (
	"id" text PRIMARY KEY NOT NULL,
	"ref_id" text NOT NULL,
	"terminal_node" text NOT NULL,
	"title" text,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_journeys_ref_terminal_key" ON "pipeline_journeys" USING btree ("ref_id","terminal_node");--> statement-breakpoint
CREATE INDEX "pipeline_journeys_created_idx" ON "pipeline_journeys" USING btree ("created_at");
