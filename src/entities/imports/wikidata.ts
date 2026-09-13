import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { countryLabelToIso2 } from "../../lib/countries.js";
import { normalizeWebsite } from "../kb.js";
import type { CreateEntityInput } from "../kb.js";
import { importOne, type ImportContext, type ImportOutcome, ProgressLogger } from "./base.js";
import { kvState } from "../../db/schema.js";

/**
 * FR-7 Wikidata SPARQL import: business organizations with an official website
 * (P856), industry (P452), HQ/country labels, inception (P571) and tickers
 * (P414/P249). Paged by QID cursor so runs resume; re-runs are idempotent via
 * the entity_imports ledger. Projected yield 500K-2M entities.
 */

const WIKIDATA_INDUSTRY_MAP: Array<[RegExp, string]> = [
  [/\bsoftware\b|\bsaas\b/i, "saas_enterprise"],
  [/\bartificial intelligence\b|\bmachine learning\b/i, "ai_ml"],
  [/\bfintech\b|\bpayments?\b/i, "fintech"],
  [/\bbank(?:ing)?\b/i, "banking_lending"],
  [/\binsurance\b/i, "insurance_insurtech"],
  [/\bpharmaceutical|\bbiotech/i, "biotech_pharma"],
  [/\bsemiconductor|\bchip/i, "semiconductors"],
  [/\btelecom/i, "telecom_networking"],
  [/\be-commerce|online retail/i, "ecommerce"],
  [/\bvideo game|\bgaming/i, "gaming"],
  [/renewable|solar|wind energy/i, "energy_transition"],
  [/\boil and gas|petroleum/i, "oil_gas_mining"],
  [/\bautomotive|motor vehicle/i, "automotive_aerospace"],
  [/\baerospace|space/i, "automotive_aerospace"],
  [/\brailway|rail transport/i, "transportation_infra"],
  [/\bairline|aviation/i, "travel_hospitality"],
  [/\bretail\b/i, "retail"],
  [/\bmedia\b/i, "media_entertainment"],
  [/logistics|shipping/i, "logistics_supply_chain"],
];

function mapIndustry(label: string | null): string {
  if (!label) return "other";
  for (const [rx, id] of WIKIDATA_INDUSTRY_MAP) if (rx.test(label)) return id;
  return "other";
}

const SparqlRow = z.object({
  item: z.string(),
  label: z.string().nullish(),
  website: z.string().nullish(),
  industryLabel: z.string().nullish(),
  legalName: z.string().nullish(),
  countryLabel: z.string().nullish(),
  hqLabel: z.string().nullish(),
  inception: z.string().nullish(),
  ticker: z.string().nullish(),
});
type SparqlRow = z.infer<typeof SparqlRow>;

export interface WikidataImportOptions {
  limit?: number;
  batchSize?: number;
}

export async function importWikidata(
  ctx: ImportContext,
  opts: WikidataImportOptions = {},
): Promise<{ processed: number; outcomes: Record<ImportOutcome, number> }> {
  const progress = new ProgressLogger();
  let cursor = await loadCursor(ctx);
  let processed = 0;
  const batch = opts.batchSize ?? 600;

  while (processed < (opts.limit ?? Infinity)) {
    const size = Math.min(batch, Math.max(1, (opts.limit ?? Infinity) - processed));
    const rows = await runSparqlPage(cursor, size);
    if (!rows.length) break;

    for (const row of rows) {
      const qid = row.item.split("/").pop() ?? row.item;
      const outcome = await importOne(ctx, "wikidata", qid, () => buildInput(row));
      progress.add(outcome);
      processed++;
    }
    const lastQid = rows[rows.length - 1]!.item.split("/").pop()!;
    cursor = qidNumber(lastQid);
    await saveCursor(ctx, cursor);
    if (rows.length < size) break;
  }
  return { processed, outcomes: progress.snapshot() };
}

function buildInput(row: SparqlRow): CreateEntityInput | null {
  if (!row.website) return null;
  const name = row.label ?? row.legalName;
  if (!name || name.length < 2 || name.length > 120) return null;
  let domain: string;
  try {
    domain = normalizeWebsite(row.website);
  } catch {
    return null;
  }
  if (!domain.includes(".")) return null;
  const foundedYear = row.inception ? Number(row.inception.slice(0, 4)) : null;
  return {
    canonicalName: name,
    legalName: row.label ?? null,
    website: domain,
    aliases: [],
    type: "private",
    status: "operating",
    country: countryLabelToIso2(row.countryLabel),
    hqCity: row.hqLabel ?? null,
    foundedYear: foundedYear && foundedYear > 1600 && foundedYear <= new Date().getFullYear() + 1 ? foundedYear : null,
    industryTags: row.industryLabel ? [mapIndustry(row.industryLabel)] : [],
    tickers: row.ticker ? [row.ticker.slice(0, 16)] : [],
    sourceRefs: [`wikidata:${row.item.split("/").pop()}`],
    confidence: 0.6,
    createdBy: "import:wikidata",
  };
}

async function runSparqlPage(afterQid: number, limit: number): Promise<SparqlRow[]> {
  const { getConfig } = await import("../../config.js");
  const endpoint = getConfig().WIKIDATA_SPARQL_ENDPOINT;
  const query = `
SELECT DISTINCT ?item ?label ?industryLabel ?countryLabel ?hqLabel ?inception ?ticker WHERE {
  ?item wdt:P856 ?website .
  ?item wdt:P31/wdt:P279* wd:Q4830453 .
  BIND(xsd:integer(STRAFTER(STR(?item), "http://www.wikidata.org/entity/Q")) AS ?qid)
  FILTER(?qid > ${afterQid})
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label)="en") }
  OPTIONAL { ?item wdt:P452 ?ind . ?ind rdfs:label ?industryLabel FILTER(LANG(?industryLabel)="en") }
  OPTIONAL { ?item wdt:P17 ?countryItem . ?countryItem rdfs:label ?countryLabel FILTER(LANG(?countryLabel)="en") }
  OPTIONAL { ?item wdt:P159 ?hqItem . ?hqItem rdfs:label ?hqLabel FILTER(LANG(?hqLabel)="en") }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item p:P414 ?ex . ?ex pq:P249 ?tickerRaw . BIND(REPLACE(?tickerRaw, "[^A-Za-z0-9.:\\\\-]", "") AS ?ticker) }
}
ORDER BY ?qid
LIMIT ${limit}`;
  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  const res = await fetch(url.toString(), {
    headers: {
      accept: "application/sparql-results+json",
      "user-agent": "CopyrIntelligenceBot/0.1 (entity KB bootstrap; contact@copyr.example)",
    },
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 429 || res.status === 503) throw new Error("wikidata rate limited; retry later");
  if (!res.ok) throw new Error(`wikidata sparql ${res.status}`);
  const json = (await res.json()) as {
    results?: { bindings?: Array<Record<string, { value: string }>> };
  };
  return (json.results?.bindings ?? [])
    .map((b) => ({
      item: b.item?.value ?? "",
      label: b.label?.value,
      industryLabel: b.industryLabel?.value,
      
      countryLabel: b.countryLabel?.value,
      hqLabel: b.hqLabel?.value,
      inception: b.inception?.value,
      ticker: b.ticker?.value,
    }))
    .filter((r) => SparqlRow.safeParse(r).success)
    .map((r) => SparqlRow.parse(r));
}

function qidNumber(qid: string): number {
  return Number(qid.replace(/^Q/, "")) || 0;
}

async function loadCursor(ctx: ImportContext): Promise<number> {
  const rows = await ctx.db.select().from(kvState).where(eq(kvState.key, "import:wikidata:cursor")).limit(1);
  const v = rows[0]?.value as { v?: number } | undefined;
  return Number(v?.v ?? 0);
}

async function saveCursor(ctx: ImportContext, cursor: number): Promise<void> {
  await ctx.db
    .insert(kvState)
    .values({ key: "import:wikidata:cursor", value: { v: cursor } })
    .onConflictDoUpdate({
      target: kvState.key,
      set: { value: { v: cursor }, updatedAt: sql`now()` },
    });
}
