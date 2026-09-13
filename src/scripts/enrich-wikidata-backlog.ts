import postgres from "postgres";
import { hostToDomain } from "../lib/hash.js";

/**
 * Backlog deep-search pass B (Wikidata identity evidence, free):
 * For live entities still at funding_stage='unknown' outside the formd cohort,
 * resolve the company on Wikidata and fill ONLY null identity fields:
 *   P856 official website -> website (+domain alias), P571 inception ->
 *   founded_year, P495/P17 -> country, P159 HQ -> nothing (free text).
 *
 * Conservative matching: a candidate qualifies only when its normalized label
 * equals the canonical name OR its P856 domain equals the card's domain.
 * Humans / disambiguation pages / works are rejected via P31.
 * Provenance: source_refs gains `wikidata:<QID>`; idempotent by construction
 * (only fills NULLs, marker-free re-runs are no-ops).
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

const UA =
  process.env.FETCH_USER_AGENT ??
  "CopyrIntelligenceBot/0.1 (+https://copyr.example/intelligence-bot; contact@copyr.example)";

const COUNTRY_QID: Record<string, string> = {
  Q30: "US", Q145: "GB", Q183: "DE", Q142: "FR", Q38: "IT", Q29: "ES", Q55: "NL",
  Q34: "SE", Q20: "NO", Q33: "FI", Q35: "DK", Q39: "CH", Q40: "AT", Q31: "BE",
  Q32: "LU", Q36: "PL", Q212: "UA", Q159: "RU", Q148: "CN", Q17: "JP", Q884: "KR",
  Q881: "VN", Q252: "ID", Q668: "IN", Q928: "NG", Q878: "AE", Q843: "PK",
  Q155: "BR", Q16: "CA", Q408: "AU", Q664: "NZ", Q334: "SG", Q801: "IL", Q43: "TR",
  Q114: "KE", Q117: "GH", Q115: "QA", Q846: "QA",
};

/** Non-organization classes seen on name-colliding items (bands, works, pages). */
const REJECT_P31 = new Set([
  "Q5", // human
  "Q4167410", "Q4161410", "Q17365644", // disambiguation / meta pages
  "Q13406463", "Q101352", // group of structures / family name
  "Q215380", // musical ensemble
  "Q11424", "Q5398426", "Q482994", "Q134556", "Q7366", // film / tv / album / single / song
  "Q7889", // video game
  "Q3331189", "Q70542", // version, edition
]);

function snakId(c: unknown): string | null {
  const v = (c as { mainsnak?: { datavalue?: { value?: unknown } } })?.mainsnak?.datavalue?.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "id" in (v as Record<string, unknown>)) {
    return String((v as { id: string }).id);
  }
  return typeof v === "string" ? v : String(v);
}

function firstClaimValue(ent: EntityClaims, pid: string): string | null {
  const snaks = ent.claims?.[pid] ?? [];
  return snakId(snaks[0]);
}

interface SearchHit { id?: string }
interface EntityClaims {
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\b(inc|llc|ltd|limited|plc|corp|corporation|co|company|gmbh|holdings|the|group)\b/g, "").replace(/[^a-z0-9]/g, "");
}

async function api<T>(action: string, params: Record<string, string>): Promise<T | null> {
  const url = `https://www.wikidata.org/w/api.php?format=json&action=${action}&${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 2000);
  const targets = await sql`
    SELECT id, canonical_name, website FROM entities
    WHERE merged_into IS NULL AND funding_stage IN ('unknown')
      AND created_by NOT IN ('formd', 'import:edgar')
      AND NOT ('wikidata' = ANY(source_refs))
    ORDER BY confidence DESC NULLS LAST, canonical_name ASC
    LIMIT ${limitArg}`;
  console.log(`[wikidata-backlog] targets: ${targets.length}`);

  let resolved = 0;
  let filled = 0;

  for (const [i, t] of targets.entries()) {
    try {
      const search = await api<{ search?: SearchHit[] }>("wbsearchentities", {
        search: t.canonical_name, language: "en", type: "item", limit: "5",
      });
      const ids = (search?.search ?? []).map((h) => h.id).filter(Boolean) as string[];
      if (!ids.length) {
        await sql`UPDATE entities SET source_refs = source_refs || ARRAY['wikidata']::text[] WHERE id = ${t.id} AND NOT ('wikidata' = ANY(source_refs))`;
        continue;
      }
      const details = await api<{ entities?: Record<string, EntityClaims> }>("wbgetentities", {
        ids: ids.slice(0, 5).join("|"), props: "claims|labels",
      });
      const wanted = normName(t.canonical_name);
      const wantDomain = t.website ? hostToDomain(t.website) : null;

      let chosen: { qid: string; site: string | null; founded: number | null; country: string | null } | null = null;
      for (const [qid, ent] of Object.entries(details?.entities ?? {})) {
        const p31 = (ent.claims?.P31 ?? []).map((c) => snakId(c));
        if (p31.some((x) => x && REJECT_P31.has(x))) continue;
        const label = normName(String((ent as { labels?: { en?: { value?: string } } }).labels?.en?.value ?? ""));
        const siteRaw = firstClaimValue(ent, "P856");
        const site = siteRaw ? hostToDomain(siteRaw) : null;
        const labelMatch = wanted.length >= 4 && label === wanted;
        const domainMatch = wantDomain !== null && site !== null && site === wantDomain;
        if (!labelMatch && !domainMatch) continue;
        // Positive org-signal requirement guards label-only collisions:
        // a real company item carries a site, inception, country, or founders.
        const inception = firstClaimValue(ent, "P571");
        const hasOrgSignal =
          site !== null ||
          inception !== null ||
          firstClaimValue(ent, "P495") !== null ||
          (ent.claims?.P112?.length ?? 0) > 0;
        if (!hasOrgSignal) continue;
        const fy = inception ? Number(inception.replace(/^\+/, "").slice(0, 4)) : null;
        const cq = firstClaimValue(ent, "P495") ?? firstClaimValue(ent, "P17");
        const country = cq ? COUNTRY_QID[cq] ?? null : null;
        chosen = { qid, site, founded: fy && fy >= 1600 && fy <= new Date().getFullYear() ? fy : null, country };
        if (domainMatch) break; // strongest identity signal wins
      }

      if (chosen) {
        const upd = await sql`
          UPDATE entities SET
            website = COALESCE(website, ${chosen.site}),
            founded_year = COALESCE(founded_year, ${chosen.founded}),
            country = COALESCE(country, ${chosen.country}),
            source_refs = source_refs || ARRAY[${`wikidata:${chosen.qid}`}]::text[],
            updated_at = now()
          WHERE id = ${t.id} AND (
            (${chosen.site}::text IS NOT NULL AND website IS NULL)
            OR (${chosen.founded}::int IS NOT NULL AND founded_year IS NULL)
            OR (${chosen.country}::text IS NOT NULL AND country IS NULL)
          )
          RETURNING 1`;
        if (upd.count) filled++;
        resolved++;
      } else {
        await sql`UPDATE entities SET source_refs = source_refs || ARRAY['wikidata']::text[] WHERE id = ${t.id} AND NOT ('wikidata' = ANY(source_refs))`;
      }
    } catch (e) {
      if ((e as Error).message.length > 0) {
        console.warn(`  ${t.canonical_name}: ${(e as Error).message.slice(0, 140)}`);
      }
      // per-entity isolation; retryable next run (no marker written on throw)
    }
    if ((i + 1) % 50 === 0) console.log(`[wikidata-backlog] ${i + 1}/${targets.length}`);
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`[wikidata-backlog] done: resolved=${resolved}, fields_filled=${filled}`);
  await sql.end();
  process.exit(0);
}

void main();
