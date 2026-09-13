/**
 * Cohort triage: pull the next N un-hand-covered eligible entities and split:
 *  - SHELLS (no website/articles AND only registry/fact evidence): run the
 *    vetted deterministic finalize directly.
 *  - EVIDENCE (site meta or corpus coverage): emit compact digest to stdout
 *    for hand-authoring (.dbg/profile-cohort.json + sites scrape).
 * Usage: tsx src/scripts/profile-triage.mts <N>
 */
import fs from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { opaqueId } from "../lib/ulid.js";
import { entityProfiles } from "../db/schema.js";


function hasContent(p: Record<string, unknown> | null | undefined): boolean {
  if (!p) return false;
  return Object.values(p).some((v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return hasContent(v as Record<string, unknown>);
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  });
}

resetConfigCache();
const db = createDb(getConfig().DATABASE_URL, { max: 5 });
const N = Number(process.argv[2] ?? 60);

const due = await db.execute<{ id: string }>(sql`
  SELECT e.id FROM entities e
  WHERE e.merged_into IS NULL AND e.needs_backfill = false
    AND e.type NOT IN ('fund','person-org')
    AND NOT EXISTS (SELECT 1 FROM entity_profiles ep WHERE ep.entity_id = e.id AND ep.model = 'ox-alpha')
    AND NOT EXISTS (SELECT 1 FROM entity_profiles ep WHERE ep.entity_id = e.id AND ep.last_error LIKE 'parked:%')
    AND NOT EXISTS (SELECT 1 FROM entity_profiles ep WHERE ep.entity_id = e.id AND ep.derived_from IN ('facts','registry') AND ep.status='complete')
  ORDER BY e.is_monitored DESC, e.confidence DESC, e.updated_at DESC
  LIMIT ${N}
`);

const shells: string[] = [];
const evidenceIds: string[] = [];
const digest: Record<string, unknown>[] = [];

for (const { id } of due) {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT canonical_name, legal_name, website, aliases, type, status, country, hq_city,
           founded_year, industry_tags, tickers, funding_stage, registry_ids
    FROM entities WHERE id = ${id}`);
  const r = rows[0]!;
  const factRows = await db.execute<Record<string, unknown>>(sql`
    SELECT type, payload, distinct_publishers, created_at FROM facts
    WHERE entity_id=${id} AND status='accepted' ORDER BY created_at DESC LIMIT 8`);
  const artRows = await db.execute<Record<string, unknown>>(sql`
    SELECT a.title, a.excerpt_text, a.publisher_domain, a.published_at, a.url, a.primary_tag
    FROM articles a JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
    WHERE ae.entity_id=${id} AND a.noise_stage='kept' AND a.published_at >= now() - interval '365 days'
    ORDER BY a.published_at DESC LIMIT 5`);
  const e = {
    id,
    canonical_name: r.canonical_name, legal_name: r.legal_name, website: r.website,
    aliases: r.aliases, type: r.type, status: r.status, country: r.country,
    hq_city: r.hq_city, founded_year: r.founded_year, industry_tags: r.industry_tags,
    tickers: r.tickers, funding_stage: r.funding_stage, registry_ids: r.registry_ids,
    facts: factRows.map((f) => ({ t: f.type, p: f.payload, pub: f.distinct_publishers,
      at: new Date(String(f.created_at)).toISOString().slice(0, 10) })),
    articles: artRows.map((a) => ({ title: a.title, x: String(a.excerpt_text ?? "").slice(0, 300),
      dom: a.publisher_domain, at: a.published_at ? new Date(String(a.published_at)).toISOString().slice(0, 10) : null,
      url: a.url, tag: a.primary_tag })),
  };
  const hasPublicFootprint = Boolean(e.website) || e.articles.length > 0;
  if (hasPublicFootprint) { evidenceIds.push(id); digest.push(e); }
  else shells.push(id);
}

// shells → deterministic finalize inline (same logic as profile-shell-finalize)
const { deriveDeterministicSection, DETERMINISTIC_FINALIZE } = await import("../entities/profile.js");
const { entities, facts } = await import("../db/schema.js");
let shellRows = 0;
for (const id of shells) {
  const [e] = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!e || e.mergedInto || e.needsBackfill) continue;
  const factRows = await db.select().from(facts)
    .where(and(eq(facts.entityId, id), eq(facts.status, "accepted")));
  for (const section of DETERMINISTIC_FINALIZE) {
    const base = deriveDeterministicSection(section, e, factRows);
    if (!hasContent(base)) continue;
    await db.insert(entityProfiles).values({
      id: opaqueId("prf"), entityId: id, section, payload: base as Record<string, unknown>,
      status: "complete", derivedFrom: factRows.length > 0 ? "facts" : "registry",
      generatedAt: new Date(), staleAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    }).onConflictDoNothing();
    shellRows += 1;
  }
}

fs.writeFileSync(".dbg/profile-cohort.json", JSON.stringify(digest));
console.log(JSON.stringify({ pulled: due.length, shellsFinalized: shells.length, shellRows, evidenceForAuthoring: evidenceIds.length }));
process.exit(0);
