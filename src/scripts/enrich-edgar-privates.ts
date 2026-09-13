import postgres from "postgres";
import { politeFetch } from "../ingestion/fetcher.js";

/**
 * Curated-private Form D lookups via SEC EDGAR full-text search (free):
 *   1. EFTS query restricted to Form D -> candidate filings for the name
 *   2. exact display-name match; parse each candidate's primary_doc.xml
 *   3. keep the LARGEST offering since 2019 as the company's evidenced raise
 *   4. accepted funding_round fact (`efts:<accession>`) + KB rollup
 *
 * Everything is signal-derived from regulator filings (NG1/NG4 intact).
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

function pickTag(html: string, field: string): string | null {
  const m = new RegExp(`<${field}>([^<]+)</${field}>`, "i").exec(html);
  return m ? (m[1] ?? null) : null;
}
function pickFirstSale(html: string): string | null {
  const m = /<dateOfFirstSale>\s*<value>([^<]+)<\/value>/i.exec(html);
  return m ? (m[1] ?? null) : null;
}

interface EftsHit {
  _id?: string;
  adsh?: string;
  _source?: { ciks?: string[]; display_names?: string[]; file_date?: string | string[] };
}

interface Best {
  cik: string;
  accession: string;
  amount: number;
  basis: string;
  firstSale: string | null;
}

async function eftsFormDBest(name: string): Promise<Best | null> {
  const q = encodeURIComponent(`"${name.replace(/[^\w\s'-]/g, "").trim()}"`);
  const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=D`;
  const res = await politeFetch(url, { accept: "application/json", skipRobots: true });
  if (res.status !== 200) return null;
  const parsed = JSON.parse(res.body) as { hits?: { hits?: EftsHit[] } };
  const strip = (s: string): string =>
    s.toLowerCase()
      .replace(/\(cik[^)]*\)/g, "") // EFTS appends " (CIK 0000000000)" to display names
      .replace(/\b(inc|llc|ltd|limited|plc|corp|corporation|co|company|gmbh|holdings|the|group|lp)\b/g, "")
      .replace(/[^a-z0-9]/g, "").trim();
  const wanted = strip(name);

  const candidates: Array<{ cik: string; accession: string }> = [];
  for (const hit of parsed.hits?.hits ?? []) {
    const fdRaw = hit._source?.file_date;
    const fileDate = Array.isArray(fdRaw) ? (fdRaw[0] ?? "") : (fdRaw ?? "");
    if (fileDate && fileDate < "2015-01-01") continue; // pre-2015 filings rarely reflect current rounds
    const displayName = strip(hit._source?.display_names?.[0] ?? "");
    // Exact identity only: prefix matching attached wrong companies
    // (Aurora x N, Stripe Milton LLC). Collisions on identical stripped
    // names remain possible but are rare and provenance-disclosed.
    if (!wanted || displayName !== wanted) continue;
    const cik = hit._source?.ciks?.[0];
    const acc = hit.adsh ?? hit._id?.split(":")[0];
    if (!cik || !acc || typeof acc !== "string") continue;
    candidates.push({ cik, accession: acc });
    if (candidates.length >= 4) break;
  }

  let best: Best | null = null;
  for (const cand of candidates) {
    const accNoDash = cand.accession.replaceAll("-", "");
    try {
      const idxRes = await politeFetch(
        `https://www.sec.gov/Archives/edgar/data/${cand.cik}/${accNoDash}/index.json`,
        { accept: "application/json", skipRobots: true },
      );
      if (idxRes.status !== 200) continue;
      const files = ((JSON.parse(idxRes.body) as { directory?: { item?: Array<{ name?: string }> } })
        .directory?.item ?? []).map((f) => f.name ?? "");
      const xmlName = files.find((nm) => nm.endsWith(".xml"));
      if (!xmlName) continue;
      const doc = await politeFetch(
        `https://www.sec.gov/Archives/edgar/data/${cand.cik}/${accNoDash}/${xmlName}`,
        { accept: "application/xml,text/xml", skipRobots: true },
      );
      if (doc.status !== 200) continue;
      // Prefer actually-sold amounts; "Indefinite" offerings parse to 0.
      const soldRaw = pickTag(doc.body, "totalAmountSold") ?? "";
      const offeringRaw = pickTag(doc.body, "totalOfferingAmount") ?? "";
      const amount =
        Number(soldRaw.replaceAll(",", "")) || Number(offeringRaw.replaceAll(",", "")) || 0;
      const firstSale = pickFirstSale(doc.body);
      if (amount > (best?.amount ?? 0)) {
        best = {
          cik: cand.cik,
          accession: cand.accession,
          amount,
          basis: soldRaw ? "sold" : "offered",
          firstSale,
        };
      }
    } catch {
      // per-candidate isolation
    }
  }
  return best;
}

async function main(): Promise<void> {
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 120);
  const targets = await sql`
    SELECT id, canonical_name FROM entities
    WHERE merged_into IS NULL AND created_by IN ('import:seed','manual')
      AND COALESCE(type,'private') NOT IN ('fund','public')
      AND COALESCE(array_length(tickers,1),0) = 0
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = entities.id AND f.status='accepted')
    ORDER BY confidence DESC NULLS LAST, canonical_name ASC
    LIMIT ${limitArg}`;
  console.log(`[edgar-privates] targets: ${targets.length}`);

  let enriched = 0;
  let notFound = 0;
  let failures = 0;

  for (const [i, t] of targets.entries()) {
    let stage = "efts";
    try {
      const hit = await eftsFormDBest(String(t.canonical_name));
      if (!hit) {
        notFound++;
        continue;
      }
      stage = "db";
      // Meaningful private rounds only: sub-$1M offerings are noise for the KB.
      if (hit.amount < 1_000_000) continue;

      const ts = hit.firstSale && /^\d{4}-\d{2}-\d{2}$/.test(hit.firstSale) ? hit.firstSale : null;
        const payload: Record<string, unknown> = {
          amount_usd_est: hit.amount,
          amount_basis: hit.basis,
          ...(ts ? { event_date: ts } : {}),
        };
        await sql.begin(async (tx) => {
          await tx`
          UPDATE entities SET
            registry_ids = COALESCE(registry_ids, jsonb_build_object('sec_cik', ${hit.cik}::text)),
            total_raised_usd = GREATEST(COALESCE(total_raised_usd, 0), ${hit.amount}::bigint),
            last_funding_date = COALESCE(${ts}::timestamptz, last_funding_date),
            source_refs = source_refs || ARRAY[${`edgar:cik:${hit.cik}`}::text],
            updated_at = now()
          WHERE id = ${t.id}`;
          await tx`
          INSERT INTO facts (id, entity_id, type, payload, status, evidence_article_ids,
                             distinct_publishers, best_source_tier, dedup_key, promoted_at)
          VALUES ('fct_e' || substr(md5(random()::text), 1, 20), ${t.id}, 'funding_round',
                  ${tx.json(payload as never)}, 'accepted', '{}', 1, 1,
                  ${`efts:${hit.accession}`}, now())
          ON CONFLICT (dedup_key) DO NOTHING`;
        });
      enriched++;
    } catch (e) {
      console.warn(`${t.canonical_name} [${stage}]: ${(e as Error).message.slice(0, 80)}`);
      failures++;
    }
    if ((i + 1) % 25 === 0) console.log(`[edgar-privates] ${i + 1}/${targets.length}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[edgar-privates] done: enriched=${enriched} notFound=${notFound} fail=${failures}`);
  await sql.end();
  process.exit(0);
}

void main();
