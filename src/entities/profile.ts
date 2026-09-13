import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { articleEntities, articles, entityProfiles, entities, facts } from "../db/schema.js";
import {
  getCompanyProfileConfig,
  type CompanyProfileConfig,
  PROFILE_SECTION_IDS,
  type ProfileSectionId,
} from "../config-files.js";
import { getTemplate, renderPrompt } from "../config-files.js";
import { extractFromHtml } from "../ingestion/extract.js";
import { politeFetch } from "../ingestion/fetcher.js";
import type { LlmRouter } from "../llm/router.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { SECTION_SCHEMAS, minimalSectionPayload } from "../api/contracts-enrichment.js";
import { isThinSectionPayload } from "../harness/profile-quality.js";

/**
 * FR-25 akta-parity company profiles.
 *
 * Builds 16-section company profiles (akta.pro Company Data dictionary parity)
 * for every live entity. Evidence-first and budget-guarded:
 *  - deterministic sections are derived from FR-9 accepted facts + FR-7
 *    registry imports (never LLM-invented) and finalize immediately;
 *  - narrative sections go to the LLM in same-tier chunks over an evidence
 *    pack (our kept corpus + polite website crawl + registry), every cited
 *    source URL is validated against the pack (anti-hallucination);
 *  - lifecycle mirrors R05: pending -> complete | failed (parked after
 *    max_attempts); incomplete profiles never serve as complete.
 */

type EntityRow = typeof entities.$inferSelect;
type FactRow = typeof facts.$inferSelect;
type ProfileRow = typeof entityProfiles.$inferSelect;

// ------------------------------------------------------------------ helpers

const ISO2_TO_REGION: Record<string, string> = {
  US: "North America", CA: "North America", MX: "North America",
  BR: "South America", AR: "South America", CL: "South America", CO: "South America",
  GB: "Europe", IE: "Europe", DE: "Europe", FR: "Europe", NL: "Europe", BE: "Europe",
  ES: "Europe", PT: "Europe", IT: "Europe", CH: "Europe", AT: "Europe", SE: "Europe",
  NO: "Europe", DK: "Europe", FI: "Europe", PL: "Europe", CZ: "Europe", RO: "Europe",
  GR: "Europe", EE: "Europe", LV: "Europe", LT: "Europe", HU: "Europe", LU: "Europe",
  IN: "Asia", CN: "Asia", JP: "Asia", KR: "Asia", SG: "Asia", HK: "Asia", TW: "Asia",
  ID: "Asia", MY: "Asia", TH: "Asia", VN: "Asia", PH: "Asia", PK: "Asia", BD: "Asia",
  IL: "Asia", AE: "Asia", SA: "Asia", QA: "Asia", TR: "Asia",
  AU: "Oceania", NZ: "Oceania",
  ZA: "Africa", NG: "Africa", KE: "Africa", EG: "Africa", GH: "Africa",
};

function regionFor(countryIso2?: string | null): string | null {
  if (!countryIso2) return null;
  return ISO2_TO_REGION[countryIso2.toUpperCase()] ?? null;
}

function ymd(d: Date | string | null | undefined): { day: number; month: number; year: number } | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
}

function titleCaseStage(stage?: string | null): string | null {
  if (!stage) return null;
  const s = stage.trim();
  if (!s || s === "unknown") return null;
  return s
    .split(/[\s_]+/)
    .map((w) => (w === "and" ? "and" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function clampStr(v: unknown, max = 4000): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** True when a payload carries at least one non-null/non-empty field. */
function hasContent(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  return Object.values(payload).some((v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return hasContent(v as Record<string, unknown>);
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  });
}

/** Deep merge: LLM values win when non-null; deterministic floor fills gaps. */
function deepMergeProfile(
  floor: Record<string, unknown>,
  llm: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...floor };
  for (const [k, v] of Object.entries(llm)) {
    const base = out[k];
    if (v === null || v === undefined) continue; // prefer existing floor over null
    if (
      base && typeof base === "object" && !Array.isArray(base) &&
      v && typeof v === "object" && !Array.isArray(v)
    ) {
      out[k] = deepMergeProfile(base as Record<string, unknown>, v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.length > 0 ? v : (base ?? v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ------------------------------------------------------- deterministic sections

export const DETERMINISTIC_FINALIZE: ReadonlySet<ProfileSectionId> = new Set([
  "location",
  "company_hierarchy",
  "funding_detail",
  "mna_and_investment",
  "management_profile",
]);

function ownershipCategory(e: EntityRow): { code: string; label: string } | null {
  if (e.type === "public" || (e.tickers?.length ?? 0) > 0) {
    return { code: "public", label: "Public" };
  }
  const stage = (e.fundingStage ?? "").toLowerCase();
  if (["pre_seed", "seed", "series_a", "series_b", "series_c", "late_stage"].includes(stage)) {
    return { code: "venture_backed", label: "Venture Backed" };
  }
  if ((e.totalRaisedUsd ?? 0) > 0) return { code: "venture_backed", label: "Venture Backed" };
  if (stage === "bootstrapped") return { code: "bootstrapped", label: "Bootstrapped" };
  return null;
}

function operatingStatus(e: EntityRow): { code: string; label: string } | null {
  switch (e.status) {
    case "operating":
    case "active":
      return { code: "operating", label: "Operating" };
    case "acquired":
      return { code: "acquired", label: "Acquired" };
    case "closed":
      return { code: "shut_down", label: "Shut Down" };
    default:
      return null;
  }
}

function companyTypeLabel(e: EntityRow): string | null {
  switch (e.type) {
    case "public":
      return "Public";
    case "subsidiary":
      return "Subsidiary";
    case "private":
      return "Private";
    default:
      return null;
  }
}

/**
 * Deterministic section payloads derived ONLY from DB evidence (FR-7 registry
 * rows + FR-9 accepted facts). No LLM, no invention — nulls stay null.
 */
export function deriveDeterministicSection(
  section: ProfileSectionId,
  e: EntityRow,
  factRows: FactRow[],
): Record<string, unknown> {
  const minimal = minimalSectionPayload(section, { name: e.canonicalName, website: e.website });
  switch (section) {
    case "firmographic":
      return {
        ...minimal,
        name: e.canonicalName,
        legal_name: e.legalName,
        website: e.website,
        company_type: companyTypeLabel(e),
        founded_year: e.foundedYear,
        operating_status: operatingStatus(e),
        ownership_category: ownershipCategory(e),
      };
    case "location": {
      const country = e.country ? e.country.toUpperCase() : null;
      const hq =
        e.hqCity || country
          ? { city: e.hqCity, country: country ? iso3ish(country) : null, region: regionFor(country) }
          : null;
      return { ...minimal, hq };
    }
    case "company_hierarchy": {
      const subs = factRows
        .filter((f) => f.type === "acquisition")
        .map((f) => ({
          name: f.payload.target ?? f.payload.acquirer ?? null,
          business_focus: null,
          acquired_on: ymd(f.payload.event_date ?? f.createdAt),
          relationship_type: { code: "wholly_owned", label: "Wholly Owned" },
          type: { code: "acquired_brand_retained", label: "Acquired Brand Retained" },
        }))
        .filter((s) => s.name);
      return { ...minimal, subsidiaries: subs };
    }
    case "funding_detail": {
      const rounds = factRows
        .filter((f) => f.type === "funding_round")
        .map((f) => {
          const investors = (f.payload.lead_investors ?? []).map((n) => ({
            name: n,
            type: { code: "private", label: "Private" },
            lead_investor: true,
          }));
          return {
            round: (() => {
              const label = titleCaseStage(f.payload.funding_stage);
              return label ? { code: (label ?? "").toLowerCase().replace(/\s+/g, "_"), label } : null;
            })(),
            amount_usd: f.payload.amount_usd_est ?? null,
            date: ymd(f.payload.event_date ?? f.createdAt),
            pre_money_valuation: null,
            investors,
            total_investors: investors.length || null,
            id: f.id,
            news: [] as Array<{ publisher: string | null; title: string | null; url: string | null }>,
          };
        })
        .sort((a, b) => JSON.stringify(b.date).localeCompare(JSON.stringify(a.date)));
      const investorMap = new Map<string, { name: string; rounds: Set<string> }>();
      for (const r of rounds) {
        const label = r.round?.label ?? "Unknown";
        for (const inv of r.investors) {
          if (!inv.name) continue;
          const hit = investorMap.get(inv.name) ?? { name: inv.name, rounds: new Set<string>() };
          hit.rounds.add(label);
          investorMap.set(inv.name, hit);
        }
      }
      const stageLabel = titleCaseStage(e.fundingStage);
      const totalFromFacts = rounds.reduce((sum, r) => sum + (r.amount_usd ?? 0), 0);
      return {
        ...minimal,
        funding_overview:
          stageLabel || e.lastFundingDate || e.totalRaisedUsd != null || totalFromFacts > 0
            ? {
                funding_stage: stageLabel
                  ? { code: (e.fundingStage ?? "").toLowerCase(), label: stageLabel }
                  : null,
                last_funding_date: ymd(e.lastFundingDate),
                total_funding_usd: e.totalRaisedUsd ?? (totalFromFacts > 0 ? totalFromFacts : null),
              }
            : null,
        funding_rounds: rounds,
        investors: [...investorMap.values()].map((i) => ({
          name: i.name,
          type: { code: "private", label: "Private" },
          website: null,
          rounds_participated: [...i.rounds],
        })),
      };
    }
    case "mna_and_investment": {
      const mna = factRows
        .filter((f) => f.type === "acquisition")
        .filter((f) => (f.payload.acquirer ?? "").toLowerCase() === e.canonicalName.toLowerCase())
        .map((f) => ({
          acquiree: { name: f.payload.target ?? null, uuid: null, website: null },
          acquisition_type: { code: "acquisition", label: "Acquisition" },
          announced_date: ymd(f.payload.event_date ?? f.createdAt),
          completed_date: null,
          amount_usd: f.payload.amount_usd_est ?? null,
          status: "complete",
          id: f.id,
          news: [],
        }));
      return { ...minimal, mna };
    }
    case "management_profile": {
      const profiles = factRows
        .filter((f) => f.type === "leadership_change")
        .map((f) => ({
          name: f.payload.person ?? null,
          designation: f.payload.role ?? null,
          designation_category: categoryForRole(f.payload.role),
          overview: null,
          profile_commentary: null,
          previous_companies: [] as string[],
          start_date: ymd(f.payload.event_date ?? f.createdAt),
          source: [] as string[],
        }))
        .filter((p) => p.name)
        // dedupe by person+designation (facts may repeat across coverage)
        .filter((p, i, arr) =>
          arr.findIndex((q) => q.name === p.name && q.designation === p.designation) === i);
      return { ...minimal, number_of_profiles: profiles.length, profiles };
    }
    default:
      return minimal;
  }
}

function categoryForRole(role?: string | null): string | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (/\b(ceo|chief executive|co-?founder|founder)\b/.test(r)) {
    return /\bfounder\b/.test(r) && !/\bceo\b/.test(r) ? "Co-founder" : "Chief Executive Officer";
  }
  if (/\bc[tod]o\b|chief \w+ officer/.test(r)) return "CXO";
  if (/\bvp\b|vice president/.test(r)) return "VP";
  if (/\bdirector\b/.test(r)) return "Director";
  if (/\bhead of\b/.test(r)) return "Head of Department";
  if (/board|chair/.test(r)) return "Board Member";
  return null;
}

/** ISO-2 → naive ISO-3 for the common codes; passthrough otherwise. */
function iso3ish(iso2: string): string {
  const map: Record<string, string> = {
    US: "USA", GB: "GBR", DE: "DEU", FR: "FRA", NL: "NLD", ES: "ESP", IT: "ITA",
    SE: "SWE", NO: "NOR", DK: "DNK", FIN: "FIN", CH: "CHE", AT: "AUT", IE: "IRL",
    CA: "CAN", AU: "AUS", NZ: "NZL", IN: "IND", SG: "SGP", JP: "JPN", KR: "KOR",
    BR: "BRA", MX: "MEX", IL: "ISR", AE: "ARE", PL: "POL", PT: "PRT", BE: "BEL",
  };
  return map[iso2.toUpperCase()] ?? iso2;
}

// -------------------------------------------------------------- evidence pack

export interface EvidencePack {
  blocks: string[];
  sources: string[];
}

/**
 * Assemble the evidence pack: registry identifiers, accepted facts, recent kept
 * corpus coverage, plus an optional robots-aware crawl of the company site
 * (same politeness rules as fetch-article).
 */
export async function buildEvidencePack(
  db: Db,
  e: EntityRow,
  factRows: FactRow[],
  cfg: CompanyProfileConfig,
  opts: { crawl: boolean },
): Promise<EvidencePack> {
  const blocks: string[] = [];
  const sources: string[] = [];

  if (e.registryIds && Object.keys(e.registryIds).length > 0) {
    blocks.push(
      `[registry] ${Object.entries(e.registryIds)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
  }

  blocks.push(
    `[entity] industry_tags=${(e.industryTags ?? []).join(",") || "none"}; funding_stage=${e.fundingStage ?? "unknown"}; country=${e.country ?? "unknown"}; name=${e.canonicalName}`,
  );

  for (const f of factRows.slice(0, 40)) {
    blocks.push(
      `[fact:${f.type}] ${JSON.stringify(f.payload)} (publishers=${f.distinctPublishers}, seen=${f.createdAt.toISOString().slice(0, 10)})`,
    );
  }

  const since = new Date(Date.now() - cfg.corpus.window_days * 24 * 3600 * 1000);
  const newsRows = await db
    .select({
      url: articles.url,
      title: articles.title,
      excerpt: articles.excerptText,
      publisher: articles.publisherDomain,
      publishedAt: articles.publishedAt,
    })
    .from(articleEntities)
    .innerJoin(articles, eq(articles.id, articleEntities.articleId))
    .where(
      and(
        eq(articleEntities.entityId, e.id),
        eq(articleEntities.role, "primary"),
        eq(articles.noiseStage, "kept"),
        gte(articles.publishedAt, since),
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .limit(cfg.corpus.articles);

  for (const n of newsRows) {
    sources.push(n.url);
    blocks.push(
      `[news] ${n.publishedAt.toISOString().slice(0, 10)} ${n.publisher} — ${n.title} (${n.url})\n${clampStr(n.excerpt, cfg.corpus.excerpt_chars) ?? ""}`,
    );
  }

  if (opts.crawl && cfg.crawl.enabled && cfg.crawl.max_pages > 0 && e.website) {
    const base = `https://${e.website}`;
    let pages = 0;
    for (const path of cfg.crawl.paths) {
      if (pages >= cfg.crawl.max_pages) break;
      const url = `${base}${path}`;
      try {
        const page = await politeFetch(url, { timeoutMs: cfg.crawl.timeout_ms });
        if (page.status >= 400) continue;
        const extracted = extractFromHtml(page.body, page.finalUrl);
        const text = extracted?.textContent ?? "";
        if (extracted && extracted.charCount >= 80) {
          pages += 1;
          sources.push(page.finalUrl);
          blocks.push(`[web] ${page.finalUrl}\n${text.slice(0, cfg.crawl.max_chars_per_page)}`);
        }
      } catch (err) {
        logger.debug(
          { err: (err as Error).message, url },
          "profile crawl skipped (robots/timeout/error)",
        );
      }
    }
  }

  return { blocks: blocks.slice(0, 60), sources: [...new Set(sources)].slice(0, 60) };
}

// ------------------------------------------------------------------ sanitizer

/** Recursively drop any `source` URL that is not part of the evidence pack. */
function stripDisallowedSources(node: unknown, allowed: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) stripDisallowedSources(item, allowed);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj["source"])) {
    obj["source"] = (obj["source"] as unknown[]).filter(
      (u) => typeof u === "string" && allowed.has(u),
    );
  }
  for (const v of Object.values(obj)) stripDisallowedSources(v, allowed);
}

/**
 * Validate an LLM payload against the section schema and confine citations to
 * the evidence pack. Returns null when the payload is unusable (prefer-pending
 * over wrong — the row retries or parks like R05).
 */
export function sanitizeSectionPayload(
  section: ProfileSectionId,
  data: unknown,
  allowedSources: string[],
): Record<string, unknown> | null {
  const result = SECTION_SCHEMAS[section].safeParse(data);
  if (!result.success) return null;
  const payload = result.data as Record<string, unknown>;
  stripDisallowedSources(payload, new Set(allowedSources));
  return payload;
}

const ChunkResponse = z.object({
  sections: z.record(z.string(), z.unknown()),
});

// ------------------------------------------------------------------ generation

async function upsertRow(
  db: Db,
  entityId: string,
  section: ProfileSectionId,
  patch: Partial<typeof entityProfiles.$inferInsert>,
): Promise<void> {
  const set = Object.keys(patch).length ? patch : { updatedAt: new Date() };
  const values = {
    id: opaqueId("prf"),
    entityId,
    section,
    updatedAt: new Date(),
    ...patch,
  };
  await db
    .insert(entityProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: [entityProfiles.entityId, entityProfiles.section],
      set,
    });
}

export interface ProfileRunResult {
  entityId: string;
  finalized: ProfileSectionId[];
  completed: ProfileSectionId[];
  failedNow: ProfileSectionId[];
  pending: ProfileSectionId[];
  skipped?: "entity_not_eligible" | "budget_hard" | "budget_soft_big_tier_only";
}

/**
 * Produce/refresh all enabled profile sections for one entity. Idempotent:
 * placeholder upserts use unique(entity_id,section); complete-and-fresh rows
 * are never reworked until stale_at passes.
 */
export async function generateEntityProfile(
  db: Db,
  router: LlmRouter,
  entityId: string,
  opts: { crawl?: boolean } = {},
): Promise<ProfileRunResult> {
  const cfg = getCompanyProfileConfig();
  const [e] = await db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
  if (!e || e.mergedInto || e.needsBackfill) {
    return {
      entityId,
      finalized: [],
      completed: [],
      failedNow: [],
      pending: [],
      skipped: "entity_not_eligible",
    };
  }
  const factRows = await db
    .select()
    .from(facts)
    .where(and(eq(facts.entityId, entityId), eq(facts.status, "accepted")))
    .orderBy(desc(facts.createdAt));

  let existing = await db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityId));
  let have = new Map(existing.map((r) => [r.section, r]));

  // 1) ensure placeholders for every enabled section (idempotent)
  for (const section of cfg.sections) {
    if (!have.has(section)) {
      await upsertRow(db, entityId, section, {});
    }
  }
  existing = await db.select().from(entityProfiles).where(eq(entityProfiles.entityId, entityId));
  have = new Map(existing.map((r) => [r.section, r]));
  const fresh = (r: ProfileRow) =>
    r.status === "complete" && (!r.staleAt || r.staleAt.getTime() > Date.now());

  // evidence URLs accumulated from deterministic derivations (fact article ids)
  const detSources = new Set<string>();
  const factArticleIds = [...new Set(factRows.flatMap((f) => f.evidenceArticleIds ?? []))];
  if (factArticleIds.length) {
    const urlRows = await db
      .select({ url: articles.url })
      .from(articles)
      .where(inArray(articles.id, factArticleIds));
    for (const r of urlRows) detSources.add(r.url);
  }

  // 2) deterministic pass
  const finalized: ProfileSectionId[] = [];
  const needsLlm: ProfileSectionId[] = [];
  const stillPendingEarly: ProfileSectionId[] = [];
  for (const section of cfg.sections) {
    const row = have.get(section)!;
    if (fresh(row)) continue;
    const base = deriveDeterministicSection(section, e, factRows);
    if (DETERMINISTIC_FINALIZE.has(section) && hasContent(base)) {
      await upsertRow(db, entityId, section, {
        payload: base,
        status: "complete",
        derivedFrom: factRows.length > 0 ? "facts" : "registry",
        evidence: { sources: [...detSources].slice(0, 50) },
        generatedAt: new Date(),
        staleAt: new Date(Date.now() + cfg.refresh_days * 24 * 3600 * 1000),
        lastError: null,
      });
      finalized.push(section);
    } else {
      const emptyBackoff =
        row.lastError === "empty_payload_kept_pending" &&
        row.staleAt &&
        row.staleAt.getTime() > Date.now();
      if (emptyBackoff) {
        stillPendingEarly.push(section);
        continue;
      }
      // store the floor so partial data survives LLM failure, keep pending
      if (!row.payload && hasContent(base)) {
        await upsertRow(db, entityId, section, { payload: base });
      }
      needsLlm.push(section);
    }
  }

  if (needsLlm.length === 0) {
    return { entityId, finalized, completed: [], failedNow: [], pending: stillPendingEarly };
  }

  // 3) budget guard (R09 analog): hard cap stops; soft cap allows mini only
  const st = await router.budgetStatus();
  if (st.hardExceeded) {
    return { entityId, finalized, completed: [], failedNow: [], pending: [...stillPendingEarly, ...needsLlm], skipped: "budget_hard" };
  }
  const tierAllowed = (tier: "mini" | "big") => !(st.classifyOnlyMode && tier === "big");

  // 4) evidence pack once for all LLM sections
  const pack = await buildEvidencePack(db, e, factRows, cfg, {
    crawl: opts.crawl ?? true,
  });

  // group into same-tier chunks honoring sections_per_call
  const groups: ProfileSectionId[][] = [];
  for (const section of needsLlm) {
    const tier = cfg.section_tiers[section] ?? "mini";
    const last = groups[groups.length - 1];
    const lastHead = last?.[0];
    const lastTier = lastHead ? cfg.section_tiers[lastHead] ?? "mini" : null;
    if (last && lastTier === tier && last.length < cfg.sections_per_call) last.push(section);
    else groups.push([section]);
  }

  const tpl = getTemplate("company_profile");
  const completed: ProfileSectionId[] = [];
  const failedNow: ProfileSectionId[] = [];
  const stillPending: ProfileSectionId[] = [];

  for (const group of groups) {
    const groupHead = group[0]!;
    const tier = cfg.section_tiers[groupHead] ?? "mini";
    if (!tierAllowed(tier)) {
      stillPending.push(...group);
      continue;
    }
    const rendered = renderPrompt(tpl, {
      company_name: e.canonicalName,
      company_domain: e.website ?? "unknown",
      today: new Date().toISOString().slice(0, 10),
      section_names: group.join(", "),
      section_hints: group.map((s) => `${s}: ${cfg.field_hints[s] ?? ""}`).join("\n"),
      evidence: pack.blocks.join("\n\n").slice(0, 30000) || "(no evidence available)",
      allowed_sources: pack.sources.map((u, i) => `[${i}] ${u}`).join("\n") || "(none)",
    });
    const call = await router.chatJson(ChunkResponse, rendered.system, rendered.user, {
      stage: "company_profile",
      tier,
      promptTemplate: "company_profile",
      promptTemplateVersion: rendered.templateVersion,
      articleId: null,
    });

    if (!call.ok) {
      // Contract miss (e.g. `{product_offering:…}` instead of `{sections:{…}}`).
      // Count the attempt on this group only and stop this pass so we do not
      // re-issue the same company 8 more times while the brain repeats itself.
      for (const section of group) {
        const row = (
          await db
            .select()
            .from(entityProfiles)
            .where(and(eq(entityProfiles.entityId, entityId), eq(entityProfiles.section, section)))
            .limit(1)
        )[0];
        if (!row) continue;
        const attempts = row.attempts + 1;
        const parked = attempts >= cfg.max_attempts;
        await upsertRow(db, entityId, section, {
          attempts,
          status: parked ? "failed" : "pending",
          lastError: parked ? `parked_max_attempts:${call.error}` : call.error,
        });
        (parked ? failedNow : stillPending).push(section);
      }
      const rest = groups.slice(groups.indexOf(group) + 1).flat();
      stillPending.push(...rest);
      break;
    }

    for (const section of group) {
      const row = (await db.select().from(entityProfiles).where(and(eq(entityProfiles.entityId, entityId), eq(entityProfiles.section, section))).limit(1))[0];
      if (!row) continue;
      const raw = call.data?.sections?.[section] ?? null;
      const sanitized = raw ? sanitizeSectionPayload(section, raw, pack.sources) : null;
      const miss = !sanitized;
      const attempts = row.attempts + (miss ? 1 : 0);

      if (sanitized) {
        const floor = (row.payload ?? {}) as Record<string, unknown>;
        const merged = deepMergeProfile(floor, sanitized);
        if (!hasContent(merged)) {
          // Schema-valid empty arrays are not a profile. Stay pending until
          // a later run with real evidence; backoff so mock ticks do not loop.
          await upsertRow(db, entityId, section, {
            payload: merged,
            status: "pending",
            derivedFrom: "llm",
            model: call.model,
            promptTemplateVersion: rendered.templateVersion,
            generatedAt: new Date(),
            staleAt: new Date(Date.now() + cfg.refresh_days * 24 * 3600 * 1000),
            attempts: 0,
            lastError: "empty_payload_kept_pending",
          });
          stillPending.push(section);
        } else {
          const thinReason = isThinSectionPayload(section, merged);
          if (thinReason) {
            await upsertRow(db, entityId, section, {
              payload: merged,
              status: "pending",
              derivedFrom: "llm",
              model: call.model,
              promptTemplateVersion: rendered.templateVersion,
              generatedAt: new Date(),
              staleAt: new Date(Date.now() + cfg.refresh_days * 24 * 3600 * 1000),
              attempts: 0,
              lastError: thinReason,
            });
            stillPending.push(section);
          } else {
            await upsertRow(db, entityId, section, {
              payload: merged,
              status: "complete",
              derivedFrom: "llm",
              evidence: { sources: pack.sources.slice(0, 50) },
              model: call.model,
              promptTemplateVersion: rendered.templateVersion,
              generatedAt: new Date(),
              staleAt: new Date(Date.now() + cfg.refresh_days * 24 * 3600 * 1000),
              attempts: 0,
              lastError: null,
            });
            completed.push(section);
          }
        }
      } else {
        const error = call.ok ? `invalid_payload_schema:${section}` : call.error;
        const parked = attempts >= cfg.max_attempts;
        await upsertRow(db, entityId, section, {
          attempts,
          status: parked ? "failed" : "pending",
          lastError: parked ? `parked_max_attempts:${error}` : error,
        });
        (parked ? failedNow : stillPending).push(section);
      }
    }
  }

  const bigTierSkipped = stillPending.some((s) => (cfg.section_tiers[s] ?? "mini") === "big");
  return {
    entityId,
    finalized,
    completed,
    failedNow,
    pending: [...stillPendingEarly, ...stillPending],
    skipped:
      st.classifyOnlyMode && bigTierSkipped ? "budget_soft_big_tier_only" : undefined,
  };
}

// ------------------------------------------------------------------ selection

/**
 * Entities due for profiling: live, baseline-complete (R06), company-like, no
 * parked failures, and missing at least one mandated fresh section. Watchlist
 * and high-confidence first ("all live entities" scope per product decision).
 */
export async function dueProfileEntities(db: Db, limit: number): Promise<string[]> {
  const cfg = getCompanyProfileConfig();
  const mandatedArray = sql.raw(
    `ARRAY[${cfg.mandated_sections.map((s) => `'${s}'`).join(",")}]::text[]`,
  );
  const rows = await db.execute<{ id: string }>(sql`
    WITH prof AS (
      SELECT entity_id,
             COUNT(*) FILTER (WHERE status = 'complete'
               AND section = ANY(${mandatedArray})
               AND (stale_at IS NULL OR stale_at > now())) AS fresh_complete,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed_n
      FROM entity_profiles
      GROUP BY entity_id
    )
    SELECT e.id
    FROM entities e
    LEFT JOIN prof ON prof.entity_id = e.id
    WHERE e.merged_into IS NULL
      AND e.needs_backfill = false
      AND e.type NOT IN ('fund', 'person-org')
      AND COALESCE(prof.failed_n, 0) = 0
      AND COALESCE(prof.fresh_complete, 0) < ${cfg.mandated_sections.length}
    ORDER BY e.is_monitored DESC, e.confidence DESC, e.updated_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => String(r.id));
}

/** Progress snapshot for probes/dashboard. */
export async function profileProgress(db: Db): Promise<{
  eligible_entities: number;
  entities_with_complete_profiles: number;
  sections_complete: number;
  sections_pending: number;
  sections_failed: number;
}> {
  const cfg = getCompanyProfileConfig();
  const mandatedArray = sql.raw(
    `ARRAY[${cfg.mandated_sections.map((s) => `'${s}'`).join(",")}]::text[]`,
  );
  const eligible = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM entities
    WHERE merged_into IS NULL AND needs_backfill = false AND type NOT IN ('fund','person-org')
  `);
  const counts = await db.execute<{
    complete: number;
    pending: number;
    failed: number;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'complete')::int AS complete,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
    FROM entity_profiles
  `);
  // entities where ALL mandated sections are complete
  const fullRows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM (
      SELECT entity_id FROM entity_profiles
      WHERE status = 'complete' AND section = ANY(${mandatedArray})
      GROUP BY entity_id
      HAVING COUNT(DISTINCT section) = ${cfg.mandated_sections.length}
    ) x
  `);
  return {
    eligible_entities: Number(eligible[0]?.n ?? 0),
    entities_with_complete_profiles: Number(fullRows[0]?.n ?? 0),
    sections_complete: Number(counts[0]?.complete ?? 0),
    sections_pending: Number(counts[0]?.pending ?? 0),
    sections_failed: Number(counts[0]?.failed ?? 0),
  };
}

/** Serving read: complete section payloads for the API (+missing list). */
export async function readEntityProfile(
  db: Db,
  entityId: string,
  requested: ProfileSectionId[],
): Promise<{
  sections: Record<string, Record<string, unknown>>;
  completeSections: string[];
  missingSections: string[];
  generatedAt: string | null;
}> {
  const rows = await db
    .select()
    .from(entityProfiles)
    .where(and(eq(entityProfiles.entityId, entityId), eq(entityProfiles.status, "complete")));
  const sections: Record<string, Record<string, unknown>> = {};
  let generatedAt: Date | null = null;
  for (const r of rows) {
    if (!requested.includes(r.section as ProfileSectionId)) continue;
    if (r.payload) sections[r.section] = r.payload;
    if (r.generatedAt && (!generatedAt || r.generatedAt > generatedAt)) generatedAt = r.generatedAt;
  }
  const completeSections = requested.filter((s) => sections[s]);
  return {
    sections,
    completeSections,
    missingSections: requested.filter((s) => !sections[s]),
    generatedAt: generatedAt ? generatedAt.toISOString() : null,
  };
}

export { PROFILE_SECTION_IDS };
export type { ProfileSectionId };
