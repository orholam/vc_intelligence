import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../../config.js";
import { importOne, type ImportContext, type ImportOutcome, ProgressLogger } from "./base.js";
import { entityImports } from "../../db/schema.js";

/**
 * FR-7 SEC EDGAR import (open data): company_tickers.json for the US public
 * filer universe (CIK, ticker, name) + optional per-issuer enrichment via the
 * submissions API (SIC -> sector tag, state, fiscal year end).
 * Idempotent via entity_imports ledger keyed on CIK.
 */

const TICKERS_FILE_URL = "https://www.sec.gov/files/company_tickers.json";

const TickersFileSchema = z.record(
  z.string(),
  z.object({
    cik_str: z.number(),
    ticker: z.string(),
    title: z.string(),
  }),
);

const SubmissionsSchema = z.object({
  sicDescription: z.string().nullish(),
  ein: z.string().nullish(),
  stateOfIncorporation: z.string().nullish(),
  tickers: z.array(z.string()).default([]),
  exchanges: z.array(z.string()).default([]),
  formerNames: z
    .array(z.object({ name: z.string(), from: z.string(), to: z.string() }))
    .nullish(),
});

const SIC_TO_SECTOR: Array<[RegExp, string]> = [
  [/services-prepackaged software/i, "saas_enterprise"],
  [/computer programming|data processing|information retrieval/i, "devtools"],
  [/\bbiotech|\bpharmaceutical|in vitro diagnostics/i, "biotech_pharma"],
  [/medical|surgical|dental|orthopedic/i, "medtech_devices"],
  [/semiconductors|printed circuit|electron tubes/i, "semiconductors"],
  [/bank|credit agency|savings institution/i, "banking_lending"],
  [/insurance/i, "insurance_insurtech"],
  [/investment advice|investment banking|security/i, "capital_markets"],
  [/oil and gas|petroleum|crude/i, "oil_gas_mining"],
  [/electric|gas distribution|water supply/i, "utilities"],
  [/communications|telephone|radio\/tv/i, "telecom_networking"],
  [/air transportation|transportation services|railroad|water transport/i, "logistics_supply_chain"],
  [/\bretail\b|department|grocery|food stores/i, "retail"],
  [/wholesale/i, "ecommerce"],
  [/hospital|nursing|health care facility/i, "healthtech"],
  [/metal|machinery|industrial inorganic/i, "manufacturing_industrial"],
  [/chemicals/i, "chemicals_materials"],
  [/aircraft|missiles|space/i, "automotive_aerospace"],
  [/motor vehicles|auto/i, "automotive_aerospace"],
  [/hotels|hotels &amp; motels/i, "travel_hospitality"],
  [/eating places|food service/i, "restaurants_delivery"],
  [/entertainment|motion picture|amusement/i, "media_entertainment"],
];

function sicToSector(sic?: string | null): string {
  if (!sic) return "other";
  for (const [rx, id] of SIC_TO_SECTOR) if (rx.test(sic)) return id;
  return "other";
}

export interface EdgarImportOptions {
  /** Fetch submissions detail for at most N issuers this run (rate-limited API). */
  enrichLimit?: number;
}

export async function importEdgar(
  ctx: ImportContext,
  opts: EdgarImportOptions = {},
): Promise<{ processed: number; enriched: number; outcomes: Record<ImportOutcome, number> }> {
  const ua = getConfig().EDGAR_USER_AGENT;
  const progress = new ProgressLogger();
  const res = await fetch(TICKERS_FILE_URL, {
    headers: { "user-agent": ua },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`edgar http ${res.status}`);
  const parsed = TickersFileSchema.parse(await res.json());

  let processed = 0;
  let enriched = 0;
  for (const entry of Object.values(parsed)) {
    const cik = String(entry.cik_str).padStart(10, "0");
    const outcome = await importOne(ctx, "edgar", `cik:${cik}`, () => ({
      canonicalName: entry.title.slice(0, 160),
      legalName: entry.title,
      website: null,
      aliases: [],
      type: "public" as const,
      status: "operating" as const,
      country: "US",
      industryTags: [],
      tickers: [entry.ticker],
      sourceRefs: [`edgar:cik:${cik}`],
      registryIds: { sec_cik: cik },
      confidence: 0.85,
      createdBy: "import:edgar",
    }));
    progress.add(outcome);
    processed++;

    if (opts.enrichLimit && enriched < opts.enrichLimit) {
      const didEnrich = await enrichFromSubmissions(ctx, cik, ua);
      if (didEnrich) enriched++;
    }
  }
  return { processed, enriched, outcomes: progress.snapshot() };
}

async function enrichFromSubmissions(ctx: ImportContext, cik: string, ua: string): Promise<boolean> {
  try {
    // Only enrich issuers already imported by the base pass.
    const [ledger] = await ctx.db
      .select()
      .from(entityImports)
      .where(and(eq(entityImports.source, "edgar"), eq(entityImports.externalId, `cik:${cik}`)))
      .limit(1);
    if (!ledger?.entityId) return false;

    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "user-agent": ua },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    const sub = SubmissionsSchema.parse(await res.json());
    await importOne(ctx, "edgar", `cik:${cik}`, () => ({
      canonicalName: "", // unused on update path; importOne hashes full payload
      legalName: null,
      website: null,
      aliases: (sub.formerNames ?? []).map((f) => f.name),
      type: "public",
      status: "operating",
      country: "US",
      hqCity: null,
      foundedYear: null,
      industryTags: [sicToSector(sub.sicDescription ?? undefined)].filter((t) => t !== "other"),
      tickers: sub.tickers.slice(0, 4),
      sourceRefs: [`edgar:cik:${cik}`],
      confidence: 0.9,
      createdBy: "import:edgar",
    }));
    // Politeness: submissions API allows ~10 req/s; stay well under.
    await new Promise((r) => setTimeout(r, 150));
    return true;
  } catch {
    return false;
  }
}
