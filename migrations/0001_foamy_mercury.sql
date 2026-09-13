DROP INDEX "aliases_trgm_idx";--> statement-breakpoint
DROP INDEX "entities_canonical_name_trgm_idx";--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "platform_meta" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "registry_ids" jsonb;--> statement-breakpoint
CREATE INDEX "entities_registry_cik_idx" ON "entities" USING btree ((registry_ids->>'sec_cik'));--> statement-breakpoint
CREATE INDEX "entities_registry_ch_idx" ON "entities" USING btree ((registry_ids->>'companies_house'));--> statement-breakpoint
CREATE INDEX "entities_created_by_idx" ON "entities" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "aliases_trgm_idx" ON "aliases" USING gin ("alias_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entities_canonical_name_trgm_idx" ON "entities" USING gin ("canonical_name" gin_trgm_ops);