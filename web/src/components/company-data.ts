export type Company = {
  id: string;
  canonical_name: string;
  legal_name: string | null;
  website: string | null;
  aliases: string[];
  type: string;
  status: string;
  country: string | null;
  hq_city: string | null;
  founded_year: number | null;
  industry_tags: string[];
  tickers: string[];
  funding_stage: string | null;
  total_raised_usd: number | null;
  last_funding_date: string | null;
  source_refs: string[];
  confidence: number;
  merged_into: string | null;
  derived: {
    article_count_30d: number;
    last_news_date: string | null;
    top_event_types: Array<{ tag: string; count: number }>;
  };
};

export const STAGE_LABELS: Record<string, string> = {
  pre_seed: "Pre-seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
  late_stage: "Late stage",
  public: "Public",
  bootstrapped: "Bootstrapped",
  unknown: "Unknown",
};

export const STAGE_ORDER = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "late_stage",
  "public",
  "bootstrapped",
  "unknown",
];

export function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

// ---------------------------------------------------------------- FR-25 enrichment
export const ENRICHMENT_SECTIONS = [
  "firmographic",
  "location",
  "company_hierarchy",
  "product_offering",
  "industry",
  "financial_estimate",
  "funding_detail",
  "mna_and_investment",
  "business_model",
  "company_assessment",
  "digital_presence",
  "trust_signal",
  "management_profile",
  "strategic_signal",
  "customer_profile",
  "technology",
] as const;

export type EnrichmentSection = (typeof ENRICHMENT_SECTIONS)[number];

export const ENRICHMENT_SECTION_LABELS: Record<EnrichmentSection, string> = {
  firmographic: "Firmographics",
  location: "Location",
  company_hierarchy: "Hierarchy",
  product_offering: "Products",
  industry: "Industry",
  financial_estimate: "Estimates",
  funding_detail: "Funding",
  mna_and_investment: "M&A",
  business_model: "Business model",
  company_assessment: "Assessment",
  digital_presence: "Digital presence",
  trust_signal: "Trust signals",
  management_profile: "Leadership",
  strategic_signal: "Strategic signals",
  customer_profile: "Customers",
  technology: "Technology",
};

export type EnrichmentResponse = {
  company_id: string;
  sections: Partial<Record<EnrichmentSection, Record<string, unknown>>>;
  complete_sections: string[];
  missing_sections: string[];
  generated_at: string | null;
};

export async function fetchEnrichment(id: string): Promise<EnrichmentResponse> {
  const res = await fetch(`/v1/companies/${encodeURIComponent(id)}/enrichment`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as EnrichmentResponse;
}
