import postgres from "postgres";
import { politeFetch } from "../ingestion/fetcher.js";

/**
 * Backlog deep-search pass A (SEC registry evidence, free):
 * For every live formd entity with a CIK, pull the EDGAR submissions profile
 * and EVERY recent Form D filing (amendments included):
 *  - identity: state -> country/hq_city, standard SIC -> industry tag,
 *    formerNames.from -> founded_year approximation, later IPO/tickers
 *  - funding: parse totalAmountSold/totalOfferingAmount per D accession into
 *    accepted facts (`formd:<accession>`), then roll up totalRaisedUsd /
 *    lastFundingDate from the full fact set (idempotent recompute).
 *
 * Evidence only — stage inference happens in a separate documented pass.
 * Idempotent: processed entities carry `edgar:subscan` in source_refs;
 * unquantifiable filings get payload.amount_checked=true (enrich-formd convention).
 * Polite: ~300ms between requests (EDGAR fair-use).
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR",
  "PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR","GU","VI",
]);

/** Standard EDGAR SIC (submissions.json `sic`) -> taxonomy sector id. */
export const SIC_MAP: Array<[RegExp, string]> = [
  [/^(10|12|13|14)\d{2}$/, "oil_gas_mining"],
  [/^28[3-6]\d$|^5122$/, "biotech_pharma"],
  [/^384\d$|^385\d$|^80[0-8]\d$/, "healthtech"],
  [/^3812$/, "govtech_defense"],
  [/^367\d$/, "semiconductors"],
  [/^357\d$|^3[66]\d{2}$/, "consumer_electronics"],
  [/^737\d$/, "saas_enterprise"],
  [/^73[349]\d$/, "professional_services"],
  [/^6[01]\d{2}$|^6712$/, "banking_lending"],
  [/^62\d{2}$|^6770$/, "capital_markets"],
  [/^6[34]\d{2}$/, "insurance_insurtech"],
  [/^(27|48|78|79)\d{2}$/, "media_entertainment"],
  [/^58\d{2}$/, "restaurants_delivery"],
[/^(20|21|22)\d{2}$/, "agtech_food"],
  [/^5[3-7]\d{2}$|^59\d{2}$/, "retail"],
  [/^596\d$|^5999$/, "ecommerce"],
  [/^65\d{2}$|^6798$/, "proptech_realestate"],
  [/^(42|44|45|47)\d{2}$/, "logistics_supply_chain"],
  [/^37\d{2}$/, "automotive_aerospace"],
  [/^87\d{2}$/, "professional_services"],
  [/^8[36]\d{2}$/, "staffing_workforce"],
  [/^4[69]\d{2}$|^4613$/, "utilities"],
  [/^29\d{2}$/, "oil_gas_mining"],
  [/^28[0-2]\d$|^289\d$/, "chemicals_materials"],
  [/^(23|24|25|3[0-5])\d{2}$/, "manufacturing_industrial"],
  [/^39\d{2}$/, "consumer_electronics"],
];

export function sicToTag(sic: string | undefined | null): string | null {
  if (!sic || !/^\d{4}$/.test(sic)) return null;
  for (const [re, id] of SIC_MAP) if (re.test(sic)) return id;
  return null;
}

function pickTag(html: string, field: string): string | null {
  const m = new RegExp(`<${field}>([^<]+)</${field}>`, "i").exec(html);
  return m ? m[1]?.trim() ?? null : null;
}
function pickFirstSale(html: string): string | null {
  const m = /<dateOfFirstSale>\s*<value>([^<]+)<\/value>/i.exec(html);
  return m ? m[1] ?? null : null;
}

const FUND_TYPE_RE = /(pooled investment fund|hedge fund|venture capital fund|private equity fund)/i;

interface Submissions {
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  category?: string;
  stateOfIncorporation?: string;
  formerNames?: Array<{ name?: string; from?: string; to?: string }>;
  addresses?: {
    business?: { city?: string; stateOrCountryDescription?: string };
    mailing?: { city?: string; stateOrCountryDescription?: string };
  };
  filings?: {
    recent?: {
      form?: string[];
      accessionNumber?: string[];
      filingDate?: string[];
    };
  };
}

async function main(): Promise<void> {
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 500);
  const sleepMs = Number(process.argv.find((a) => a.startsWith("--sleep="))?.split("=")[1] ?? 300);
  const shard = process.argv.find((a) => a.startsWith("--shard="))?.split("=")[1] ?? "";
  const shardParts = shard ? shard.split("/").map(Number) : [0, 1];
  const shardIdx = shardParts[0] ?? 0;
  const shardMod = shardParts[1] ?? 1;

  const targets = await sql`
    SELECT id, canonical_name, registry_ids->>'sec_cik' AS cik
    FROM entities
    WHERE merged_into IS NULL AND created_by = 'formd'
      AND registry_ids ? 'sec_cik'
      AND NOT ('edgar:subscan' = ANY(source_refs))
      AND COALESCE(type,'private') <> 'fund'
      AND (${shardMod} = 1 OR abs(hashtext(id)) % ${shardMod} = ${shardIdx})
    ORDER BY id ${process.argv.includes("--desc") ? sql`DESC` : sql`ASC`}
    LIMIT ${limitArg}`;
  console.log(`[edgar-submissions] targets: ${targets.length}`);

  let metaFilled = 0;
  let publicPromoted = 0;
  let factsQuantified = 0;
  let factsCreated = 0;
  let kbRolledUp = 0;
  let failures = 0;

  for (const [i, t] of targets.entries()) {
    const cik = String(t.cik).padStart(10, "0");
    try {
      const res = await politeFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        accept: "application/json",
        skipRobots: true,
      });
      if (res.status === 404) {
        await sql`UPDATE entities SET source_refs = source_refs || ARRAY['edgar:subscan']::text[], updated_at = now() WHERE id = ${t.id}`;
        continue;
      }
      if (res.status !== 200) {
        failures++;
        continue;
      }
      const sub = JSON.parse(res.body) as Submissions;

      // ---- identity metadata (never overwrite existing values) ----------
      const addr = sub.addresses?.business ?? sub.addresses?.mailing ?? {};
      const st = (addr.stateOrCountryDescription ?? "").toUpperCase().trim();
      const isUs = US_STATES.has(st);
      const city = (addr.city ?? "").trim();
      const sicTag = sicToTag(sub.sic);
      let founded: number | null = null;
      for (const fn of sub.formerNames ?? []) {
        if (fn.from && /^\d{4}/.test(fn.from)) {
          const y = Number(fn.from.slice(0, 4));
          if (y >= 1600 && y <= new Date().getFullYear() && (founded === null || y < founded)) founded = y;
        }
      }
      if (isUs || city || founded !== null || sicTag) {
        const meta = await sql`
          UPDATE entities SET
            country = COALESCE(country, ${isUs ? "US" : null}::text),
            hq_city = COALESCE(hq_city, NULLIF(${city}, '')),
            founded_year = COALESCE(founded_year, ${founded}),
            industry_tags = CASE WHEN ${sicTag}::text IS NOT NULL AND NOT (${sicTag}::text = ANY(industry_tags))
              THEN industry_tags || ARRAY[${sicTag}]::text[] ELSE industry_tags END,
            updated_at = now()
          WHERE id = ${t.id}
          RETURNING 1`;
        if (meta.count) metaFilled++;
      }

      // Later public listing: tickers on EDGAR mean listed equity now.
      const tickers = (sub.tickers ?? []).filter(Boolean).slice(0, 4);
      if (tickers.length) {
        const pub = await sql`
          UPDATE entities SET type = 'public',
            tickers = CASE WHEN COALESCE(array_length(tickers,1),0) = 0 THEN ${tickers}::text[] ELSE tickers END,
            updated_at = now()
          WHERE id = ${t.id} AND COALESCE(type,'private') = 'private'
          RETURNING 1`;
        if (pub.count) publicPromoted++;
      }

      // ---- Form D filings: quantify every accession we know --------------
      const forms = sub.filings?.recent?.form ?? [];
      const accs = sub.filings?.recent?.accessionNumber ?? [];
      const dAccs: string[] = [];
      for (let k = 0; k < Math.min(forms.length, accs.length); k++) {
        if ((forms[k] ?? "") === "D") dAccs.push(String(accs[k]));
        if (dAccs.length >= 8) break; // newest 8 D filings is plenty for KB depth
      }

      for (const acc of dAccs) {
        const existing = await sql`
          SELECT id, payload FROM facts
          WHERE entity_id = ${t.id} AND dedup_key = ${`formd:${acc}`} LIMIT 1`;
        if (existing.length && Number(existing[0]?.payload.amount_usd_est ?? 0) > 0) continue;
        if (existing.length && existing[0]?.payload.amount_checked === true) continue;

        const accNoDash = acc.replaceAll("-", "");
        const idxRes = await politeFetch(
          `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accNoDash}/index.json`,
          { accept: "application/json", skipRobots: true },
        );
        if (idxRes.status !== 200) continue;
        const files = ((JSON.parse(idxRes.body) as { directory?: { item?: Array<{ name?: string }> } })
          .directory?.item ?? []).map((f) => f.name ?? "");
        const xmlName = files.find((n) => n.endsWith(".xml") && !n.startsWith("ix?"));
        if (!xmlName) continue;
        await new Promise((r) => setTimeout(r, sleepMs));
        const docRes = await politeFetch(
          `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accNoDash}/${xmlName}`,
          { accept: "application/xml,text/xml", skipRobots: true },
        );
        if (docRes.status !== 200) continue;
        const xml = docRes.body;
        const soldRaw = pickTag(xml, "totalAmountSold") ?? "";
        const offeringRaw = pickTag(xml, "totalOfferingAmount") ?? "";
        const amount =
          Number(soldRaw.replaceAll(",", "")) || Number(offeringRaw.replaceAll(",", "")) || 0;
        const firstSale = pickFirstSale(xml);
        const industryGroupType = pickTag(xml, "industryGroupType") ?? "";
        const isFund = FUND_TYPE_RE.test(industryGroupType);

        if (isFund) {
          await sql`UPDATE entities SET type = 'fund', updated_at = now() WHERE id = ${t.id} AND type='private'`;
        }

        const payload: Record<string, unknown> = { amount_checked: true };
        if (amount > 0) {
          payload.amount_usd_est = amount;
          payload.amount_basis = soldRaw ? "sold" : "offered";
        }
        if (firstSale && /^\d{4}-\d{2}-\d{2}$/.test(firstSale)) payload.event_date = firstSale;
        if (industryGroupType) payload.industry_group_type = industryGroupType;

        if (existing.length) {
          await sql`
            UPDATE facts SET payload = payload || ${sql.json(payload as never)}, updated_at = now()
            WHERE id = ${existing[0]!.id}`;
        } else {
          await sql`
            INSERT INTO facts (id, entity_id, type, payload, status, evidence_article_ids,
                               distinct_publishers, best_source_tier, dedup_key, promoted_at)
            VALUES ('fct_s' || substr(md5(random()::text), 1, 20), ${t.id}, 'funding_round',
                    ${sql.json(payload as never)}, 'accepted', '{}', 1, 1, ${`formd:${acc}`}, now())
            ON CONFLICT (dedup_key) DO NOTHING`;
        }
        if (amount > 0 && !isFund) {
          if (existing.length) factsQuantified++;
          else factsCreated++;
        }
      }

      // ---- idempotent KB rollup from the full accepted-formd fact set -----
      const roll = await sql`
        SELECT COALESCE(SUM((payload->>'amount_usd_est')::bigint), 0)::bigint AS total,
               MAX(NULLIF(payload->>'event_date','')) AS latest
        FROM facts
        WHERE entity_id = ${t.id} AND status='accepted' AND type='funding_round'
          AND dedup_key LIKE 'formd:%' AND COALESCE((payload->>'amount_usd_est')::bigint,0) > 0`;
      const total = Number(roll[0]?.total ?? 0);
      const latest = (roll[0]?.latest as string | null) ?? null;
      if (total > 0) {
        await sql`
          UPDATE entities SET
            total_raised_usd = GREATEST(COALESCE(total_raised_usd, 0), ${total}),
            last_funding_date = COALESCE(${latest}::timestamptz, last_funding_date),
            updated_at = now()
          WHERE id = ${t.id}`;
        kbRolledUp++;
      }

      await sql`
        UPDATE entities SET source_refs = source_refs || ARRAY['edgar:subscan']::text[], updated_at = now()
        WHERE id = ${t.id} AND NOT ('edgar:subscan' = ANY(source_refs))`;
    } catch (e) {
      failures++;
      if (failures <= 5) console.warn(`  ${t.canonical_name}: ${(e as Error).message.slice(0, 120)}`);
    }
    if ((i + 1) % 25 === 0) console.log(`[edgar-submissions] ${i + 1}/${targets.length}`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  console.log(
    `[edgar-submissions] done: meta=${metaFilled}, publics=${publicPromoted}, ` +
      `facts_quantified=${factsQuantified}, facts_created=${factsCreated}, kb=${kbRolledUp}, fail=${failures}`,
  );
  await sql.end();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
