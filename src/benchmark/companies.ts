import fs from "node:fs";
import path from "node:path";

/**
 * FR-23: ported benchmark methodology from akta-pro's public
 * benchmark-company-news-retrieval harness (133-company list + window
 * protocol). The list file mirrors their published entities.py with
 * attribution; override by replacing this file or pointing
 * BENCHMARK_COMPANIES_FILE at another JSON with {companies:[...]}.
 */

export interface BenchmarkCompany {
  id: string;
  name: string;
  website: string | null;
  founded_year: number | null;
  hq_city: string | null;
  hq_country_iso3: string | null;
  is_private: boolean | null;
  is_non_us: boolean | null;
}

const ISO3_TO_ISO2: Record<string, string> = {
  USA: "US", JPN: "JP", GBR: "GB", DEU: "DE", FRA: "FR", CHN: "CN", IND: "IN",
  SGP: "SG", KOR: "KR", CAN: "CA", AUS: "AU", BRA: "BR",
  ISR: "IL", SWE: "SE", CHE: "CH", NLD: "NL", ESP: "ES", ITA: "IT", MEX: "MX",
};

export function iso3ToIso2(iso3?: string | null): string | null {
  return ISO3_TO_ISO2[iso3 ?? ""] ?? null;
}

export function loadBenchmarkCompanies(): BenchmarkCompany[] {
  const override = process.env.BENCHMARK_COMPANIES_FILE;
  const file = override ?? path.join(resolveConfigDir(), "benchmark.companies.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { companies?: BenchmarkCompany[] };
  const companies = parsed.companies ?? [];
  if (!companies.length) throw new Error(`no companies loaded from ${file}`);
  return companies;
}

/**
 * Resolve the repo's config/ directory regardless of nesting depth (the
 * one-off "../config vs ../../config" bug class). Walks up from this file
 * until a directory containing config/benchmark.companies.json is found.
 */
function resolveConfigDir(): string {
  if (process.env.INTELLIGENCE_CONFIG_DIR) return process.env.INTELLIGENCE_CONFIG_DIR;
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "config", "benchmark.companies.json");
    if (fs.existsSync(candidate)) return path.join(dir, "config");
    dir = path.dirname(dir);
  }
  return path.resolve("config");
}
