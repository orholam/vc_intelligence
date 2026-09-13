CREATE TABLE "pipeline_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"node" text NOT NULL,
	"ref_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pipeline_traces_created_idx" ON "pipeline_traces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pipeline_traces_ref_idx" ON "pipeline_traces" USING btree ("ref_id");