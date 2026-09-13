import postgres from "postgres";
import { politeFetch } from "../ingestion/fetcher.js";

/**
 * Form D primary-doc enrichment (free SEC EDGAR archives):
 *  - fetch each accepted formd fact's filing index
 *  - locate the primary_doc XML, parse totalOfferingAmount /
 *    offeringSalesAmount / firstSaleDate / industryGroup
 *  - back the fact payload with the REAL offered/sold amount and update the
 *    entity KB (totalRaisedUsd, lastFundingDate) — turning registry-only
 *    cards into E2-grade validated evidence where amounts qualify.
 *
 * Idempotent: facts whose payload already carries amount_usd_est are skipped.
 * Polite: 1 req per ~350ms (EDGAR fair-use), UA set by fetcher.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

const INDUSTRY_MAP: Record<string, string> = {
  "0100": "agtech_food",
  "0200": "oil_gas_mining",
  "1000": "oil_gas_mining",
  "1400": "proptech_realestate",
  "1500": "fashion_apparel",
  "1600": "manufacturing_industrial",
  "2000": "restaurants_delivery",
  "3100": "manufacturing_industrial",
  "3200": "manufacturing_industrial",
  "3300": "manufacturing_industrial",
  "3400": "manufacturing_industrial",
  "3500": "manufacturing_industrial",
  "3600": "consumer_electronics",
  "3700": "consumer_electronics",
  "3800": "manufacturing_industrial",
  "3900": "transportation_infra",
  "4000": "logistics_supply_chain",
  "4400": "telecom_networking",
  "4500": "telecom_networking",
  "4700": "professional_services",
  "4800": "restaurants_delivery",
  "5000": "retail",
  "5100": "ecommerce",
  "5200": "retail",
  "5300": "retail",
  "5400": "retail",
  "5500": "retail",
  "5600": "retail",
  "5700": "retail",
  "5800": "saas_enterprise",
  "5900": "retail",
  "6000": "banking_lending",
  "6100": "banking_lending",
  "6200": "capital_markets",
  "6300": "capital_markets",
  "6400": "insurance_insurtech",
  "6500": "insurance_insurtech",
  "6700": "capital_markets",
  "7000": "travel_hospitality",
  "7200": "professional_services",
  "7300": "professional_services",
  "7800": "media_entertainment",
  "7900": "media_entertainment",
  "8000": "healthtech",
  "8200": "staffing_workforce",
  "8700": "professional_services",
  "8900": "media_entertainment",
};

function pickTag(html: string, field: string): string | null {
  const m = new RegExp(`<${field}>([^<]+)</${field}>`, "i").exec(html);
  return m ? (m[1] ?? null) : null;
}

/** dateOfFirstSale nests its value: <dateOfFirstSale><value>YYYY-MM-DD</value></dateOfFirstSale> */
function pickFirstSale(html: string): string | null {
  const m = /<dateOfFirstSale>\s*<value>([^<]+)<\/value>/i.exec(html);
  return m ? (m[1] ?? null) : null;
}

const FUND_TYPE_RE = /(pooled investment fund|hedge fund|venture capital fund|private equity fund)/i;

async function main(): Promise<void> {
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 400);
  const offsetArg = Number(process.argv.find((a) => a.startsWith("--offset="))?.split("=")[1] ?? 0);
  const targets = await sql`
    SELECT f.id AS fact_id, f.entity_id, f.payload,
           e.registry_ids->>'sec_cik' AS cik,
           REPLACE(f.dedup_key, 'formd:', '') AS accession
    FROM facts f JOIN entities e ON e.id = f.entity_id
    WHERE f.status='accepted' AND f.type='funding_round'
      AND f.dedup_key LIKE 'formd:%'
      AND COALESCE((f.payload->>'amount_usd_est')::bigint, 0) = 0
      AND COALESCE((f.payload->>'amount_checked')::boolean, false) = false
      AND e.registry_ids ? 'sec_cik'
      AND e.merged_into IS NULL
      -- Funds identified on a previous pass: never re-fetch their XML.
      AND COALESCE(e.type, 'private') <> 'fund'
    LIMIT ${limitArg} OFFSET ${offsetArg}
  `;
  console.log(`[enrich-formd] targets: ${targets.length}`);

  let enrichedFacts = 0;
  let kbUpdated = 0;
  let failures = 0;
  const failLog: string[] = [];
  for (const [i, t] of targets.entries()) {
    const cik = String(t.cik);
    const accRaw = String(t.accession);
    const accNoDash = accRaw.replaceAll("-", "");
    try {
      const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/index.json`;
      const idxRes = await politeFetch(idxUrl, { accept: "application/json", skipRobots: true });
      if (idxRes.status !== 200) {
        failures++;
        continue;
      }
      const idx = JSON.parse(idxRes.body) as { directory?: { item?: Array<{ name?: string }> } };
      const files = idx.directory?.item ?? [];
      const xmlName = files
        .map((f) => f.name ?? "")
        .find((n) => n.endsWith(".xml") && !n.startsWith("ix?"));
      if (!xmlName) {
        failures++;
        continue;
      }
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${xmlName}`;
      const docRes = await politeFetch(docUrl, { accept: "application/xml,text/xml", skipRobots: true });
      if (docRes.status !== 200) {
        failures++;
        continue;
      }
      const xml = docRes.body;
      // Real Form D schema (2013+): amounts live in <offeringSalesAmounts>,
      // sold amount is <totalAmountSold>, offering total may be "Indefinite".
      const totalOffering = pickTag(xml, "totalOfferingAmount") ?? "";
      const soldRaw = pickTag(xml, "totalAmountSold") ?? "";
      const amountRaw =
        Number(soldRaw.replaceAll(",", "")) || Number(totalOffering.replaceAll(",", "")) || 0;
      const firstSale = pickFirstSale(xml);
      const industryGroupType = pickTag(xml, "industryGroupType") ?? "";
      const isFund = FUND_TYPE_RE.test(industryGroupType);
      if (!amountRaw && !isFund) {
        // Nothing usable: flag so future passes skip the re-fetch (the
        // target query excludes facts already carrying amount_checked).
        await sql`
          UPDATE facts SET payload = payload || jsonb_build_object('amount_checked', true), updated_at = now()
          WHERE id = ${t.fact_id}`;
        continue;
      }
      if (isFund) {
        // Pooled investment funds are NOT operating companies: mark the card
        // so ListGen/search surfaces exclude them from company results.
        await sql`
          UPDATE entities SET type = 'fund', updated_at = now()
          WHERE id = ${t.entity_id} AND type = 'private'`;
        continue;
      }
      // Form D amounts are exact dollars; keep as-is (already USD).
      // NOTE: every param inside jsonb_build_object needs an explicit cast —
      // untyped params make PG throw "could not determine data type".
      await sql`
        UPDATE facts SET payload = payload || jsonb_build_object(
          'amount_usd_est', ${amountRaw}::bigint,
          'amount_basis', ${soldRaw ? "sold" : "offered"}::text,
          'industry_group_type', ${industryGroupType}::text
        ), updated_at = now()
        WHERE id = ${t.fact_id}`;
      enrichedFacts++;
      // KB rollup: add to totalRaised (once per fact via this idempotent pass)
      void INDUSTRY_MAP;
      const kb = await sql`
        UPDATE entities SET
          total_raised_usd = COALESCE(total_raised_usd, 0) + ${amountRaw},
          last_funding_date = COALESCE(
            CASE WHEN COALESCE(${firstSale}, '') ~ '^\d{4}-\d{2}-\d{2}$'
              THEN ${firstSale}::timestamptz END, last_funding_date),
          updated_at = now()
        WHERE id = ${t.entity_id} RETURNING 1`;
      kbUpdated += kb.count;
    } catch (e) {
      if (failLog.length < 5) failLog.push(`${t.accession}: ${(e as Error).message.slice(0, 100)}`);
      failures++;
    }
    if ((i + 1) % 50 === 0) console.log(`[enrich-formd] ${i + 1}/${targets.length}`);
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(
    `[enrich-formd] done: facts=${enrichedFacts}, kb=${kbUpdated}, fail=${failures}` +
    (failLog.length ? `\n  sample failures:\n  ${failLog.join("\n  ")}` : ""),
  );
  await sql.end();
  process.exit(0);
}

void main();
