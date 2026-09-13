ALTER TABLE "articles" ADD COLUMN "fact_id" text;
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "articles_fact_id_idx" ON "articles" USING btree ("fact_id");
--> statement-breakpoint
-- Existing facts listed supporting articles; news records did not point back.
-- One fact per article: prefer an accepted row when several match.
UPDATE articles AS a
SET fact_id = sub.fact_id
FROM (
  SELECT DISTINCT ON (x.aid) x.aid, f.id AS fact_id
  FROM facts f
  CROSS JOIN LATERAL unnest(f.evidence_article_ids) AS x(aid)
  ORDER BY x.aid, (f.status = 'accepted') DESC, f.updated_at DESC
) AS sub
WHERE a.id = sub.aid AND a.fact_id IS NULL;
