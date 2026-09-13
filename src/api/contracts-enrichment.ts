import { z } from "zod";
import type { ProfileSectionId } from "../config-files.js";

/**
 * FR-25 akta-parity company profile section schemas.
 *
 * Field names/types mirror akta.pro's public Company Data dictionary
 * (16 sections / 74 L2 fields) so downstream consumers get the same shape.
 * Design rules:
 *  - every leaf is nullable or defaulted: partial evidence must still validate;
 *  - enum-ish values ride as plain strings at the wire (allowed vocabularies
 *    live in config/company-profile.json field_hints, R08);
 *  - `source` arrays carry evidence URLs; the sanitizer drops anything that is
 *    not part of the entity's evidence pack (anti-hallucination guard).
 */

const Str = z.string().nullable();
const Num = z.number().nullable();
const Int = z.number().int().nullable();

export const CodeLabel = z.object({ code: z.string().nullable(), label: z.string().nullable() });
export const DateYMD = z.object({
  day: Int.nullable().default(null),
  month: Int.nullable().default(null),
  year: Int.nullable().default(null),
});
const Sources = z.array(z.string()).default([]);

// ------------------------------------------------------------------ firmographic
export const FirmographicSection = z.object({
  name: Str.default(null),
  legal_name: Str.default(null),
  website: Str.default(null),
  company_type: Str.default(null), // Private|Public|Subsidiary|Nonprofit|Government
  founded_year: Int.default(null),
  company_description: Str.default(null),
  company_description_short: Str.default(null),
  operating_status: CodeLabel.nullable().default(null), // operating|acquired|shut_down
  ownership_category: CodeLabel.nullable().default(null),
  headcount_range: Str.default(null),
  website_screenshot: Str.default(null),
});

// ---------------------------------------------------------------------- location
export const LocationSection = z.object({
  hq: z
    .object({ city: Str.default(null), country: Str.default(null), region: Str.default(null) })
    .nullable()
    .default(null),
  market_served: z
    .object({
      is_global: z.boolean().nullable().default(null),
      markets: z
        .array(
          z.object({
            country: Str.default(null),
            region: Str.default(null),
            source: Sources,
          }),
        )
        .default([]),
    })
    .nullable()
    .default(null),
  offices: z
    .array(
      z.object({
        city: Str.default(null),
        country: Str.default(null),
        type: CodeLabel.nullable().default(null),
        description: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
});

// ------------------------------------------------------------- company_hierarchy
export const CompanyHierarchySection = z.object({
  subsidiaries: z
    .array(
      z.object({
        name: Str.default(null),
        business_focus: Str.default(null),
        acquired_on: DateYMD.nullable().default(null),
        relationship_type: CodeLabel.nullable().default(null),
        type: CodeLabel.nullable().default(null),
      }),
    )
    .default([]),
});

// -------------------------------------------------------------- product_offering
export const ProductOfferingSection = z.object({
  brand: z
    .array(z.object({ name: Str.default(null), description: Str.default(null), source: Sources }))
    .default([]),
  core_offering: Str.default(null),
  differentiator: Str.default(null),
  functional_benefit: Str.default(null),
  problem_solved: Str.default(null),
  quantifiable_outcome: z.array(z.string()).default([]),
  product_overview: Str.default(null),
  product_and_service: z
    .array(
      z.object({
        name: Str.default(null),
        category: Str.default(null),
        description: Str.default(null),
        url: Str.default(null),
        image_url: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
});

// ---------------------------------------------------------------------- industry
export const IndustrySection = z.object({
  keyword: z.array(z.string()).default([]),
  industry: z
    .array(
      z.object({
        code: Str.default(null),
        label: Str.default(null),
        is_primary: z.boolean().nullable().default(null),
      }),
    )
    .default([]),
  naics: z.array(CodeLabel).default([]),
  sic: z.array(CodeLabel).default([]),
  product_category: Str.default(null),
});

// ------------------------------------------------------------ financial_estimate
export const FinancialEstimateSection = z.object({
  revenue_estimate: CodeLabel.nullable().default(null),
  valuation_estimate: CodeLabel.nullable().default(null),
});

// ---------------------------------------------------------------- funding_detail
const RoundInvestor = z.object({
  name: Str.default(null),
  type: CodeLabel.nullable().default(null),
  lead_investor: z.boolean().nullable().default(null),
});
const NewsRef = z.object({ publisher: Str.default(null), title: Str.default(null), url: Str.default(null) });
export const FundingDetailSection = z.object({
  funding_overview: z
    .object({
      funding_stage: CodeLabel.nullable().default(null),
      last_funding_date: DateYMD.nullable().default(null),
      total_funding_usd: Num.default(null),
    })
    .nullable()
    .default(null),
  funding_rounds: z
    .array(
      z.object({
        round: CodeLabel.nullable().default(null),
        amount_usd: Num.default(null),
        date: DateYMD.nullable().default(null),
        pre_money_valuation: Num.default(null),
        investors: z.array(RoundInvestor).default([]),
        total_investors: Int.default(null),
        id: Str.default(null),
        news: z.array(NewsRef).default([]),
      }),
    )
    .default([]),
  investors: z
    .array(
      z.object({
        name: Str.default(null),
        type: CodeLabel.nullable().default(null),
        website: Str.default(null),
        rounds_participated: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

// ------------------------------------------------------------- mna_and_investment
const MaEntry = z.object({
  acquiree: z
    .object({ name: Str.default(null), uuid: Str.default(null), website: Str.default(null) })
    .nullable()
    .default(null),
  acquisition_type: CodeLabel.nullable().default(null),
  announced_date: DateYMD.nullable().default(null),
  completed_date: DateYMD.nullable().default(null),
  amount_usd: Num.default(null),
  status: Str.default(null), // complete | pending
  id: Str.default(null),
  news: z.array(NewsRef).default([]),
});
export const MnaAndInvestmentSection = z.object({
  mna: z.array(MaEntry).default([]),
  investment: z.array(MaEntry).default([]),
});

// ----------------------------------------------------------------- business_model
export const BusinessModelSection = z.object({
  gtm_motion: z
    .array(z.object({ description: Str.default(null), type: Str.default(null), source: Sources }))
    .default([]),
  revenue_model: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        type: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  marketing_channels: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        stage: Str.default(null),
        source: Sources,
        type: Str.default(null),
      }),
    )
    .default([]),
  distribution_channels: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        scope: Str.default(null),
        target_buyer: Str.default(null),
        source: Sources,
        type: Str.default(null),
      }),
    )
    .default([]),
  cost_components: z.array(z.string()).default([]),
  pricing_details: z
    .array(
      z.object({
        description: Str.default(null),
        model: Str.default(null),
        notes: Str.default(null),
        billing_cadence: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  gtm_type: Str.default(null), // B2B | B2C | BOTH
  offering_type: CodeLabel.nullable().default(null),
});

// ------------------------------------------------------------- company_assessment
const HeadlineDetail = z.object({
  headline: Str.default(null),
  details: Str.default(null),
  source: Sources,
});
export const CompanyAssessmentSection = z.object({
  market_position: Str.default(null),
  strengths: z.array(HeadlineDetail).default([]),
  weakness: z.array(HeadlineDetail).default([]),
  competitive_moat: z
    .array(z.object({ type: Str.default(null), details: Str.default(null) }))
    .default([]),
  key_risks: z.array(HeadlineDetail).default([]),
  key_highlights: z.array(HeadlineDetail).default([]),
  customer_concentration: z
    .object({ classification: Str.default(null), details: Str.default(null) })
    .nullable()
    .default(null),
  peers: z
    .array(
      z.object({
        name: Str.default(null),
        description: Str.default(null),
        type: Str.default(null),
      }),
    )
    .default([]),
});

// -------------------------------------------------------------- digital_presence
export const DigitalPresenceSection = z.object({
  social_media_profiles: z
    .array(z.object({ platform: Str.default(null), url: Str.default(null) }))
    .default([]),
});

// ------------------------------------------------------------------ trust_signal
export const TrustSignalSection = z.object({
  compliance: z
    .array(
      z.object({
        class: CodeLabel.nullable().default(null),
        name: CodeLabel.nullable().default(null),
        description: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  regulatory_updates: z
    .array(
      z.object({
        title: Str.default(null),
        type: Str.default(null),
        description: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  awards: z
    .array(
      z.object({
        title: Str.default(null),
        body: Str.default(null),
        type: Str.default(null),
        description: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  ip: z
    .array(
      z.object({
        title: Str.default(null),
        type: Str.default(null),
        status: Str.default(null),
        description: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
});

// ------------------------------------------------------------ management_profile
export const ManagementProfileSection = z.object({
  number_of_profiles: Int.default(null),
  profiles: z
    .array(
      z.object({
        name: Str.default(null),
        designation: Str.default(null),
        designation_category: Str.default(null),
        overview: Str.default(null),
        profile_commentary: Str.default(null),
        previous_companies: z.array(z.string()).default([]),
        start_date: DateYMD.nullable().default(null),
        source: Sources,
      }),
    )
    .default([]),
});

// -------------------------------------------------------------- strategic_signal
export const StrategicSignalSection = z.object({
  scale_indicator: z
    .array(
      z.object({
        type: Str.default(null),
        value: Str.default(null),
        description: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  partnership: z
    .array(
      z.object({
        name: Str.default(null),
        description: Str.default(null),
        type: Str.default(null),
        strategic_tier: Str.default(null),
        announced_on: DateYMD.nullable().default(null),
        source: Sources,
      }),
    )
    .default([]),
  recent_move: z
    .array(
      z.object({
        type: Str.default(null),
        description: Str.default(null),
        date: DateYMD.nullable().default(null),
        source: Sources,
      }),
    )
    .default([]),
  leadership_change: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        type: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  expansion_highlight: z
    .array(z.object({ type: Str.default(null), description: Str.default(null) }))
    .default([]),
});

// --------------------------------------------------------------- customer_profile
export const CustomerProfileSection = z.object({
  segment: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        type: Str.default(null),
        is_primary: z.boolean().nullable().default(null),
        pain_point_addressed: Str.default(null),
        use_case: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  icp: z
    .array(
      z.object({
        profile: Str.default(null),
        target_buyer: Str.default(null),
        buyer_persona: Str.default(null),
        firmographic_size: Str.default(null),
        geography: Str.default(null),
        industry_vertical: Str.default(null),
        pain_points: z.array(z.string()).default([]),
        primary_use_case: Str.default(null),
        purchase_trigger: Str.default(null),
        sales_cycle_length: Str.default(null),
        sales_motion: Str.default(null),
        buying_structure: Str.default(null),
        evidence_proof_points: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  select_customer: z
    .array(
      z.object({
        name: Str.default(null),
        industry: Str.default(null),
        use_case: Str.default(null),
        type: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
});

// --------------------------------------------------------------------- technology
export const TechnologySection = z.object({
  is_technology_focussed: z.boolean().nullable().default(null),
  api_detail: z
    .object({
      has_api: z.boolean().nullable().default(null),
      has_mcp: z.boolean().nullable().default(null),
      docs_url: Str.default(null),
      sdk_language: z.array(z.string()).default([]),
      description: Str.default(null),
    })
    .nullable()
    .default(null),
  integration: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        type: Str.default(null),
        source: Sources,
      }),
    )
    .default([]),
  ai_capability: z
    .array(z.object({ type: Str.default(null), description: Str.default(null), source: Sources }))
    .default([]),
  ai_maturity: z
    .object({
      scale: Int.default(null),
      label: Str.default(null),
      description: Str.default(null),
    })
    .nullable()
    .default(null),
  app_detail: z
    .object({ has_app: z.boolean().nullable().default(null), app_url: Str.default(null) })
    .nullable()
    .default(null),
  feature: z
    .array(
      z.object({
        title: Str.default(null),
        description: Str.default(null),
        differentiator: CodeLabel.nullable().default(null),
        source: Sources,
      }),
    )
    .default([]),
  core_technology: Str.default(null),
});

/** Registry of per-section validators, keyed by config section id. */
export const SECTION_SCHEMAS = {
  firmographic: FirmographicSection,
  location: LocationSection,
  company_hierarchy: CompanyHierarchySection,
  product_offering: ProductOfferingSection,
  industry: IndustrySection,
  financial_estimate: FinancialEstimateSection,
  funding_detail: FundingDetailSection,
  mna_and_investment: MnaAndInvestmentSection,
  business_model: BusinessModelSection,
  company_assessment: CompanyAssessmentSection,
  digital_presence: DigitalPresenceSection,
  trust_signal: TrustSignalSection,
  management_profile: ManagementProfileSection,
  strategic_signal: StrategicSignalSection,
  customer_profile: CustomerProfileSection,
  technology: TechnologySection,
} as const satisfies Record<ProfileSectionId, z.ZodTypeAny>;

/**
 * Minimal valid payload for a section (used by the offline MockProvider and as
 * the deterministic floor when the LLM returns nothing usable). Filled only
 * from caller-supplied facts — never invented.
 */
export function minimalSectionPayload(
  section: ProfileSectionId,
  ctx: { name?: string | null; website?: string | null },
): Record<string, unknown> {
  const name = ctx.name ?? null;
  const website = ctx.website ?? null;
  switch (section) {
    case "firmographic":
      return { name, website };
    case "location":
      return { hq: null, market_served: null, offices: [] };
    case "company_hierarchy":
      return { subsidiaries: [] };
    case "product_offering":
      return { brand: [], quantifiable_outcome: [], product_and_service: [] };
    case "industry":
      return { keyword: [], industry: [], naics: [], sic: [] };
    case "financial_estimate":
      return { revenue_estimate: null, valuation_estimate: null };
    case "funding_detail":
      return { funding_overview: null, funding_rounds: [], investors: [] };
    case "mna_and_investment":
      return { mna: [], investment: [] };
    case "business_model":
      return {
        gtm_motion: [],
        revenue_model: [],
        marketing_channels: [],
        distribution_channels: [],
        cost_components: [],
        pricing_details: [],
      };
    case "company_assessment":
      return {
        strengths: [],
        weakness: [],
        competitive_moat: [],
        key_risks: [],
        key_highlights: [],
        peers: [],
      };
    case "digital_presence":
      return { social_media_profiles: [] };
    case "trust_signal":
      return { compliance: [], regulatory_updates: [], awards: [], ip: [] };
    case "management_profile":
      return { number_of_profiles: 0, profiles: [] };
    case "strategic_signal":
      return {
        scale_indicator: [],
        partnership: [],
        recent_move: [],
        leadership_change: [],
        expansion_highlight: [],
      };
    case "customer_profile":
      return { segment: [], icp: [], select_customer: [] };
    case "technology":
      return {
        is_technology_focussed: null,
        api_detail: null,
        integration: [],
        ai_capability: [],
        ai_maturity: null,
        app_detail: null,
        feature: [],
      };
  }
}

// ------------------------------------------------------------------ wire shapes
export const EnrichmentQuery = z.object({
  /** comma-separated subset of the 16 sections; omitted = all enabled */
  sections: z.string().optional(),
});

export const CompanyEnrichmentResponse = z.object({
  company_id: z.string(),
  /** validated per-section payloads keyed by section id (complete rows only) */
  sections: z.record(z.string(), z.unknown()),
  complete_sections: z.array(z.string()),
  missing_sections: z.array(z.string()),
  generated_at: z.string().nullable(),
});
