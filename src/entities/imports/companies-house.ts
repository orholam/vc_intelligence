import { z } from "zod";
import { getConfig } from "../../config.js";
import type { EntityInput } from "../kb.js";
import { importOne, type ImportContext, type ImportOutcome, ProgressLogger } from "./base.js";

/**
 * FR-7 UK Companies House import (free public data API). Basic company
 * profile: name, number, status, incorporation date, registered office,
 * SIC codes. Rate-limit aware: honors Retry-After and stays under the free
 * tier budget; driven by a query list or an operator-supplied CSV of names.
 */

const CH_BASE = "https://api.company-information.service.gov.uk";

const ChSearchResponse = z.object({
  items: z
    .array(
      z.object({
        company_number: z.string(),
        title: z.string(),
        company_status: z.string().optional(),
        company_type: z.string().optional(),
        date_of_creation: z.string().optional(),
        address_snippet: z.string().optional(),
      }),
    )
    .default([]),
});

const ChProfileSchema = z.object({
  company_name: z.string(),
  company_number: z.string(),
  company_status: z.string().optional(),
  type: z.string().optional(),
  date_of_creation: z.string().optional(),
  sic_codes: z.array(z.string()).nullish(),
  registered_office_address: z
    .object({
      premises: z.string().nullish(),
      address_line_1: z.string().nullish(),
      locality: z.string().nullish(),
      postal_code: z.string().nullish(),
      country: z.string().nullish(),
    })
    .nullish(),
  links: z.object({ self: z.string() }).optional(),
});

async function chFetch(path: string, apiKey: string): Promise<Response> {
  for (;;) {
    const res = await fetch(`${CH_BASE}${path}`, {
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "60");
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 300) * 1000));
      continue;
    }
    return res;
  }
}

function mapStatus(status?: string): EntityInput["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "active":
      return "operating";
    case "active — proposal to strike off":
    case "active-proposal-to-strike-off":
      return "unknown";
    case "dissolved":
      return "closed";
    case "liquidation":
    case "insolvency proceedings":
      return "closed";
    default:
      return "operating";
  }
}

function chTypeToEntityType(type?: string): EntityInput["type"] {
  const t = (type ?? "").toUpperCase();
  if (/^PLC/.test(t)) return "public";
  if (/LTD|LIMITED|PRIVATE/.test(t)) return "private";
  return "other";
}

export interface CompaniesHouseImportOptions {
  queries: string[];
  maxResultsPerQuery?: number;
}

export async function importCompaniesHouse(
  ctx: ImportContext,
  opts: CompaniesHouseImportOptions,
): Promise<{ processed: number; outcomes: Record<ImportOutcome, number> }> {
  const apiKey = getConfig().COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error("COMPANIES_HOUSE_API_KEY not configured");
  const progress = new ProgressLogger();
  let processed = 0;

  for (const q of opts.queries) {
    const perQuery = opts.maxResultsPerQuery ?? 50;
    const searchRes = await chFetch(
      `/search/companies?q=${encodeURIComponent(q)}&items_per_page=${perQuery}`,
      apiKey,
    );
    if (!searchRes.ok) throw new Error(`companies house search http ${searchRes.status}`);
    const found = ChSearchResponse.parse(await searchRes.json());

    for (const hit of found.items) {
      // Profile gives SIC codes + structured address; keep request count low by
      // fetching profile only when the search row lacks enough detail.
      let profile: z.infer<typeof ChProfileSchema> | null = null;
      try {
        const pres = await chFetch(`/company/${hit.company_number}`, apiKey);
        if (pres.ok) profile = ChProfileSchema.parse(await pres.json());
      } catch {
        /* fall back to search payload */
      }
      const name = profile?.company_name ?? hit.title;
      const hqCity =
        profile?.registered_office_address?.locality ??
        (hit.address_snippet?.split(",").slice(-2)[0]?.trim() || null);
      const outcome = await importOne(ctx, "companies_house", `uk:${hit.company_number}`, () => ({
        canonicalName: name.slice(0, 160),
        legalName: name,
        website: null,
        aliases: [],
        type: chTypeToEntityType(profile?.type ?? hit.company_type),
        status: mapStatus(profile?.company_status ?? hit.company_status),
        country: "GB",
        hqCity,
        foundedYear: parseYear(profile?.date_of_creation ?? hit.date_of_creation),
        industryTags: (profile?.sic_codes ?? [])
          .slice(0, 3)
          .map(() => "other")
          .filter((t, i, arr) => arr.indexOf(t) === i),
        tickers: [],
        sourceRefs: [`companies-house:${hit.company_number}`],
        confidence: 0.65,
        createdBy: "import:companies_house",
      }));
      progress.add(outcome);
      processed++;
    }
  }
  return { processed, outcomes: progress.snapshot() };
}

function parseYear(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-/.exec(dateStr);
  return m ? Number(m[1]) : null;
}
