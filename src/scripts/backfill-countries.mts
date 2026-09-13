import postgres from "postgres";
import { detectCountries } from "../llm/reasoner/geo.js";
import { makeStorage } from "../storage.js";
import { politeFetch } from "../ingestion/fetcher.js";

/**
 * D3/R06 country backfill for active entities: majority-vote
 * reasoner-geolocation across each entity's kept coverage (title + excerpt),
 * then registrable-TLD inference, then explicit NULL stays NULL (never
 * fabricated). Idempotent: only touches country IS NULL.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", { max: 1, onnotice: () => {} });

const COUNTRY_TLD: Record<string, string> = {
  uk: "GB", de: "DE", fr: "FR", nl: "NL", es: "ES", it: "IT", ie: "IE",
  se: "SE", ch: "CH", at: "AT", pl: "PL", pt: "PT", ee: "EE", in: "IN",
  au: "AU", ca: "CA", br: "BR", za: "ZA", ng: "NG", ke: "KE", sg: "SG",
  jp: "JP", kr: "KR", il: "IL", ae: "AE",
};

async function main(): Promise<void> {
  const ents = await sql`
    SELECT e.id, e.website,
           COALESCE(string_agg(a.title || ' ' || COALESCE(a.excerpt_text,''), ' '), '') AS corpus
    FROM entities e
    JOIN article_entities ae ON ae.entity_id = e.id
    JOIN articles a ON a.id = ae.article_id AND a.noise_stage='kept'
    WHERE e.merged_into IS NULL AND e.country IS NULL
    GROUP BY e.id, e.website`;

  console.log(`[countries] targets: ${ents.length}`);
  let filledText = 0;
  let filledTld = 0;
  const storage = makeStorage();
  for (const e of ents) {
    // Reasoner geo vote across the entity's whole coverage corpus,
    // augmented with ONE full text from object storage (datelines live deep).
    let corpus = String(e.corpus ?? "");
    try {
      const pathRes = await sql`
        SELECT a.extracted_text_path p FROM articles a
        JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
        WHERE ae.entity_id=${e.id} AND a.noise_stage='kept' AND a.extracted_text_path IS NOT NULL
        ORDER BY a.published_at DESC LIMIT 1`;
      if (pathRes.length && pathRes[0]!.p) {
        const full = await storage.get(String(pathRes[0]!.p));
        if (full) corpus += " " + full.slice(0, 8000);
      }
    } catch { /* storage absent for this row */ }
    const votes = new Map<string, number>();
    for (const iso of detectCountries(corpus.slice(0, 14000), "")) {
      votes.set(iso, (votes.get(iso) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 1 && best[0].length === 2) {
      await sql`UPDATE entities SET country=${best[0]}, updated_at=now() WHERE id=${e.id}`;
      filledText++;
      continue;
    }
    const site = String(e.website ?? "").toLowerCase();
    const tld = site.split(".").pop() ?? "";
    let done = false;
    // Homepage evidence: the company's own site names its HQ city/country.
    if (site && !COUNTRY_TLD[tld]) {
      try {
        const hp = await politeFetch(`https://${site}`, { accept: "text/html", skipRobots: false });
        if (hp.status === 200) {
          const text = hp.body.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ");
          const hits = detectCountries(text.slice(0, 6000), text.slice(6000, 14000));
          const hit0: string | undefined = hits[0];
          if (hit0 && hit0.length === 2) {
            await sql`UPDATE entities SET country=${hit0}, updated_at=now() WHERE id=${e.id}`;
            filledTld++;
            done = true;
          }
        }
      } catch { /* unreachable site */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (done) continue;
    if (COUNTRY_TLD[tld]) {
      await sql`UPDATE entities SET country=${COUNTRY_TLD[tld]}, updated_at=now() WHERE id=${e.id}`;
      filledTld++;
    }
  }
  console.log(`[countries] text-vote=${filledText}, tld=${filledTld}, remaining=${ents.length - filledText - filledTld}`);
  await sql.end();
  process.exit(0);
}

void main();
