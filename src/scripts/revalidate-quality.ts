import postgres from "postgres";
import fs from "node:fs";
import { getConfig } from "../config.js";
import { isSlopTitle } from "../lib/quality.js";
import { entityNameRejectionReason } from "../lib/quality.js";

/**
 * Re-applies hardened quality rules over the existing corpus:
 *  1. Demotes kept articles whose titles fail the slop/format gates
 *     (audit-preserving: rows stay, indexed views exclude them).
 *  2. Deletes auto-created entities that fail the name-sanitation guard
 *     (FK cascade removes their article links).
 * Idempotent: safe to run repeatedly as rules tighten.
 */

async function mainWrap() {}
void mainWrap;
const sql = postgres(getConfig().DATABASE_URL, { max: 1, onnotice: () => {} });

// ---- load configured format patterns for parity with live prefilter ----
const cfgFilters = JSON.parse(
  fs.readFileSync(new URL("../../config/filters.json", import.meta.url), "utf8"),
) as { prefilter: { non_news_title_patterns: string[] } };

const compilePattern = (rawRx: string): RegExp | null => {
  try {
    const m = /^\(\?([a-z]+)\)/.exec(rawRx);
    return new RegExp(rawRx.slice(m?.[0]?.length ?? 0), m?.[1] ?? undefined);
  } catch {
    return null;
  }
};
const formatPatterns: Array<{ rx: RegExp; source: string }> = cfgFilters.prefilter.non_news_title_patterns
  .map((p) => ({ rx: compilePattern(p), source: p }))
  .filter((p): p is { rx: RegExp; source: string } => p.rx !== null);
const fundingRescue = /\b(rais|fund|series|acquir|merger|ipo)\b/i;

const rows = await sql`
  SELECT id, title, url, publisher_domain FROM articles WHERE noise_stage = 'kept'
`;

let demotedSlop = 0;
let demotedFormat = 0;
const JOB_BOARDS = new Set([
  "builtinsf.com", "builtin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com",
]);
for (const row of rows) {
  // Job-board publishers are never deal-flow news (mirrors live prefilter).
  try {
    const { hostToDomain } = await import("../lib/hash.js");
    if (JOB_BOARDS.has(hostToDomain(new URL(row.url).hostname))) {
      await sql`
        UPDATE articles SET noise_stage='prefilter', noise_score=0.95,
          discard_reason=${"recheck:job_board_domain"}, updated_at=now()
        WHERE id=${row.id}`;
      demotedFormat++;
      continue;
    }
  } catch { /* url parse */ }
  const slop = isSlopTitle(row.title);
  if (slop.slop) {
    await sql`
      UPDATE articles SET noise_stage='llm_filter', noise_score=0.9,
        discard_reason=${"recheck:slop_title"} , updated_at=now()
      WHERE id = ${row.id}`;
    demotedSlop++;
    continue;
  }
  if (!fundingRescue.test(row.title)) {
    for (const p of formatPatterns) {
      if (p.rx.test(row.title)) {
        const reason = "recheck:format:" + p.source.replace(/[()]/g, "");
        await sql`
          UPDATE articles SET noise_stage='prefilter', noise_score=0.85,
            discard_reason=${reason} , updated_at=now()
          WHERE id = ${row.id}`;
        demotedFormat++;
        break;
      }
    }
  }
}

console.log(JSON.stringify({ scanned: rows.length, demoted_slop: demotedSlop, demoted_format: demotedFormat }));

// ---- junk-entity purge under the sanitation guard ----
const ents = await sql`
  SELECT id, canonical_name FROM entities WHERE merged_into IS NULL AND created_by='autocreate'`;
let purged = 0;
for (const e of ents) {
  const reason = entityNameRejectionReason(e.canonical_name);
  if (reason) {
    await sql`DELETE FROM entities WHERE id = ${e.id}`;
    purged++;
    console.log(`  purged "${e.canonical_name}" (${reason})`);
  }
}
console.log(JSON.stringify({ entities_scanned: ents.length, entities_purged: purged }));

// ---- reset resolution state for kept articles left without a primary ----
const reset = await sql`
  UPDATE articles a SET resolved_at=NULL, enriched_at=NULL, updated_at=now()
  WHERE a.noise_stage='kept' AND a.resolved_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM article_entities ae WHERE ae.article_id=a.id AND ae.role='primary')
`;
console.log(JSON.stringify({ articles_needing_reresolve: reset.count }));

// ---- Step 4: title-anchor sweep (legacy-attribution hygiene) ---------------
// Kept articles whose PRIMARY entity is not mentioned in their own headline
// (and never had genuine domain overlap) were resolved under older, looser
// rules: strip poisoned outlink evidence, drop orphan links, queue for the
// BACKFILL_REPROCESS pass to re-resolve under current gates.
const { normalizeName } = await import("../lib/text.js");
const anchoredRows = await sql`
  SELECT a.id, a.title, e.canonical_name, e.aliases,
         COALESCE(ae.evidence->>'domain_overlap','false') AS dom,
         ae.confidence
  FROM articles a
  JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
  JOIN entities e ON e.id=ae.entity_id
  WHERE a.noise_stage='kept'`;
let swept = 0;
for (const r of anchoredRows) {
  // High-confidence adjudicated primaries are trusted.
  if (r.confidence >= 0.75 && r.dom === "true") continue;
  const tNorm = normalizeName(r.title);
  const names = [r.canonical_name, ...(r.aliases ?? [])]
    .filter((a): a is string => Boolean(a) && !a.includes("."))
    .map((n) => normalizeName(n))
    .filter((n) => n.length >= 3);
  if (!names.some((n) => tNorm.includes(n))) {
    await sql`
      UPDATE articles SET resolved_at=NULL, enriched_at=NULL,
        outlink_domains='{}'::text[], updated_at=now()
      WHERE id=${r.id}`;
    swept++;
  }
}
const orphans = await sql`
  DELETE FROM article_entities ae
  USING articles a
  WHERE ae.article_id=a.id AND a.noise_stage='kept' AND a.resolved_at IS NULL`;
console.log(JSON.stringify({ title_anchor_swept: swept, orphan_links_removed: orphans.count }));

await sql.end();
