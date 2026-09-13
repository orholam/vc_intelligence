CREATE TABLE "pipeline_misflags" (
	"id" text PRIMARY KEY NOT NULL,
	"ref_id" text NOT NULL,
	"kind" text DEFAULT 'article' NOT NULL,
	"title" text,
	"terminal_node" text,
	"detail" text,
	"steps" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pipeline_misflags_created_idx" ON "pipeline_misflags" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pipeline_misflags_ref_idx" ON "pipeline_misflags" USING btree ("ref_id");