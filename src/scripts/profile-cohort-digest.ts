import fs from "node:fs";
import { resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";

/**
 * Dumps authoring digests for the top due-profile entities:
 * card fields + accepted facts + recent kept corpus excerpts + homepage
 * meta/social scrape. Output: .dbg/profile-cohort.json
 */
resetConfigCache();
const db = createDb(getConfig().DATABASE_URL, { max: 5 });

const due = await db.execute<{ id: string }>(sql`
  WITH prof AS (
    SELECT entity_id,
           COUNT(*) FILTER (WHERE status = 'complete'
             AND section = ANY(ARRAY['firmographic','location','industry','funding_detail','mna_and_investment','management_profile','product_offering','business_model','customer_profile','technology']::text[])
             AND (stale_at IS NULL OR stale_at > now())) AS fresh_complete,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed_n
    FROM entity_profiles GROUP BY entity_id
  )
  SELECT e.id
  FROM entities e LEFT JOIN prof ON prof.entity_id = e.id
  WHERE e.merged_into IS NULL AND e.needs_backfill = false
    AND e.type NOT IN ('fund','person-org')
    AND COALESCE(prof.failed_n,0) = 0
    AND NOT EXISTS (SELECT 1 FROM entity_profiles ep WHERE ep.entity_id = e.id AND ep.model = 'ox-alpha')
    AND NOT EXISTS (SELECT 1 FROM entity_profiles ep WHERE ep.entity_id = e.id AND ep.last_error LIKE 'parked:%')
    AND COALESCE(prof.fresh_complete,0) < 10
  ORDER BY e.is_monitored DESC, e.confidence DESC, e.updated_at DESC
  LIMIT ${Number(process.argv[2] ?? 40)}
`);
console.error(`cohort: ${due.length}`);

const out = [];
for (const { id } of due) {
  const [e] = await db.execute<Record<string, unknown>>(sql`
    SELECT id, canonical_name, legal_name, website, aliases, type, status, country, hq_city,
           founded_year, industry_tags, tickers, funding_stage, total_raised_usd,
           last_funding_date, registry_ids, confidence, is_monitored
    FROM entities WHERE id = ${id}
  `);
  const factRows = await db.execute<Record<string, unknown>>(sql`
    SELECT type, payload, distinct_publishers, best_source_tier, created_at
    FROM facts WHERE entity_id = ${id} AND status = 'accepted'
    ORDER BY created_at DESC LIMIT 12
  `);
  const artRows = await db.execute<Record<string, unknown>>(sql`
    SELECT a.title, a.excerpt_text, a.publisher_domain, a.published_at, a.url, a.primary_tag
    FROM articles a JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    WHERE ae.entity_id = ${id} AND a.noise_stage = 'kept'
      AND a.published_at >= now() - interval '365 days'
    ORDER BY a.published_at DESC LIMIT 8
  `);
  out.push({
    ...e,
    facts: factRows.map((f) => ({
      t: f.type,
      p: f.payload,
      pub: f.distinct_publishers,
      at: new Date(String(f.created_at)).toISOString().slice(0, 10),
    })),
    articles: artRows.map((a) => ({
      title: a.title,
      x: String(a.excerpt_text ?? "").slice(0, 320),
      dom: a.publisher_domain,
      at: a.published_at ? new Date(String(a.published_at)).toISOString().slice(0, 10) : null,
      url: a.url,
      tag: a.primary_tag,
    })),
  });
}

fs.mkdirSync(".dbg", { recursive: true });
fs.writeFileSync(".dbg/profile-cohort.json", JSON.stringify(out, null, 1));
console.error(`wrote .dbg/profile-cohort.json (${out.length} entities)`);
process.exit(0);
