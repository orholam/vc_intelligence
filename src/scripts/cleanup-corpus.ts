import { entityNameRejectionReason } from "../lib/quality.js";
import postgres from "postgres";

const sql = postgres("postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

// ---- 1) Exact-title syndication dedup across the whole kept corpus ----------
// Within a 48h window, keep the EARLIEST copy (wire origin), demote later
// duplicates as filter-stage discards (audit-preserving).
const dup = await sql`
  WITH ranked AS (
    SELECT id,
           lower(btrim(regexp_replace(title, '\\s+', ' ', 'g'))) AS tkey,
           published_at,
           ROW_NUMBER() OVER (
             PARTITION BY lower(btrim(regexp_replace(title, '\\s+', ' ', 'g'))),
                          date_trunc('day', published_at)
             ORDER BY published_at ASC
           ) AS rn
    FROM articles
    WHERE noise_stage = 'kept'
      AND published_at >= now() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM article_entities ae
        WHERE ae.article_id = articles.id AND ae.role = 'primary' AND ae.confidence >= 0.75
      )
  )
  SELECT id FROM ranked WHERE rn > 1`;
let demotedDupes = 0;
for (const r of dup) {
  await sql`
    UPDATE articles SET noise_stage='llm_filter', noise_score=0.92,
      discard_reason=${"recheck:title_duplicate_syndication"}, updated_at=now()
    WHERE id = ${r.id}`;
  demotedDupes++;
}
console.log(JSON.stringify({ syndicate_duplicates_demoted: demotedDupes }));

// ---- 2) Purge entities failing the hardened name guard ---------------------
const ents = await sql`
  SELECT id, canonical_name FROM entities WHERE merged_into IS NULL`;
let purged = 0;
const keepProtected = new Set<string>();
for (const e of ents) {
  const reason = entityNameRejectionReason(e.canonical_name);
  if (reason && !keepProtected.has(e.id)) {
    await sql`DELETE FROM entities WHERE id = ${e.id}`;
    purged++;
    if (purged <= 25) console.log(`  purged "${e.canonical_name}" (${reason})`);
  }
}
console.log(JSON.stringify({ entities_scanned: ents.length, entities_purged: purged }));

// ---- 3) Orphaned resolutions -> queue for re-resolution --------------------
const res = await sql`
  UPDATE articles a SET resolved_at=NULL, enriched_at=NULL, updated_at=now()
  WHERE a.noise_stage='kept' AND a.resolved_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM article_entities ae WHERE ae.article_id=a.id AND ae.role='primary')`;
console.log(JSON.stringify({ queued_for_reresolve: res.count }));

await sql.end();
