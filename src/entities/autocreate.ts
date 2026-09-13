import { sql } from "drizzle-orm";
import { z } from "zod";
import { getIndustriesTaxonomy, getTemplate, renderPrompt } from "../config-files.js";
import type { Db } from "../db/index.js";
import { entities } from "../db/schema.js";import { hostToDomain } from "../lib/hash.js";
import { isUtilityDomain } from "../lib/domains.js";
import { MEDIA_OR_AGGREGATOR_RE } from "../lib/quality.js";
import { entityNameRejectionReason } from "../lib/quality.js";
import { excerpt } from "../lib/text.js";
import type { LlmRouter } from "../llm/router.js";
import { extractFromHtml } from "../ingestion/extract.js";
import { fetchWithRetry } from "../ingestion/fetcher.js";
import { EntityKb } from "./kb.js";

/**
 * FR-8 extraction agent: unknown company name/domain/URL -> fetch site ->
 * describe -> create low-confidence entity flagged for review sampling.
 */
const SiteDescription = z.object({
  canonical_name: z.string(),
  description: z.string().default(""),
  industry: z.string().nullable().default(null),
  country_guess: z.string().length(2).nullable().default(null),
  social_links: z.array(z.string()).default([]),
});

export interface AutocreateResult {
  entityId: string;
  created: boolean;
  confidence: number;
}

export async function autocreateEntity(
  db: Db,
  router: LlmRouter,
  input: { name?: string | null; domain?: string | null; url?: string | null },
): Promise<AutocreateResult> {
  const kb = new EntityKb(db);
  const url = input.url ?? (input.domain ? `https://${input.domain}` : null);
  const domain = input.domain ?? (url ? hostToDomain(url) : null);
  if (domain && isUtilityDomain(domain)) {
    throw new Error(`refusing to autocreate entity for utility domain: ${domain}`);
  }
  if (domain && MEDIA_OR_AGGREGATOR_RE.test(domain)) {
    throw new Error(`refusing to autocreate entity for media/aggregator domain: ${domain}`);
  }
  // Companies do not live on non-commercial TLDs (fcc.gov footers, university
  // pages, military sites) — these are always infrastructure/publisher noise.
  if (domain && /\.(gov|edu|mil|int|org)$/i.test(domain)) {
    throw new Error(`refusing to autocreate entity for non-commercial TLD: ${domain}`);
  }
  // News publishers must never become subject companies — check the live
  // source registry, not just script-level guards. (Name-only mints have no
  // domain to correlate, so the guard only applies when one exists.)
  if (domain) {
    const pubHit = await db.execute<{ h: string }>(
      sql`SELECT 1 AS h FROM sources WHERE active = true AND feed_url ILIKE ${"%" + domain + "%"} LIMIT 1`,
    );
    if (pubHit.length > 0) {
      throw new Error(`refusing to autocreate entity for publisher domain: ${domain}`);
    }
  }

  // Existing entity wins — never duplicate the KB.
  if (domain) {
    const existing = await kb.findByWebsite(domain);
    if (existing) return { entityId: existing.id, created: false, confidence: existing.confidence };
  }
  if (!domain && input.name) {
    const existing = await kb.findByExactName(input.name);
    if (existing) return { entityId: existing.id, created: false, confidence: existing.confidence };
  }

  let siteTitle: string | null = null;
  let siteText = "";
  if (url) {
    try {
      const page = await fetchWithRetry(url);
      const extracted = extractFromHtml(page.body, page.finalUrl);
      if (extracted) {
        siteTitle = extracted.title || extracted.ogMetadata["site_name"] || null;
        siteText = `${extracted.title}\n${excerpt(extracted.textContent, 3000)}`;
      }
    } catch {
      // offline / robots-blocked sites still produce a stub entity below
    }
  }

  let described: z.infer<typeof SiteDescription> | null = null;
  if (siteText.length > 40) {
    const tpl = getTemplate("site_describe");
    const { system, user, templateVersion } = renderPrompt(tpl, {
      url: url ?? domain ?? "",
      content: excerpt(siteText, 2500),
      sectors: getIndustriesTaxonomy().sectors.map((s) => s.id).join(", "),
    });
    const res = await router.chatJson(SiteDescription, system, user, {
      stage: "site_describe",
      tier: "big",
      promptTemplate: "site_describe",
      promptTemplateVersion: templateVersion,
    }).catch(() => null);
    if (res?.ok) described = res.data;
  }

  const candidateName =
    input.name?.trim() ||
    described?.canonical_name?.trim() ||
    siteTitle?.trim() ||
    "";
  // Garbage homepage headings must never become entities — fall back to the
  // domain brand, which is always a sane identifier.
  const brandFromDomain = domain
    ? (domain.replace(/^www\./, "").split(".")[0] ?? domain).replace(/[-_]/g, " ")
    : "";
  const canonicalName = !entityNameRejectionReason(candidateName) && candidateName
    ? candidateName
    : entityNameRejectionReason(brandFromDomain)
      ? `brand ${domain ?? "unknown"}`
      : brandFromDomain.charAt(0).toUpperCase() + brandFromDomain.slice(1);

  const industryTags = described?.industry &&
    getIndustriesTaxonomy().sectors.some((s) => s.id === described!.industry)
    ? [described.industry]
    : [];

  const entity = await kb.create(
    {
      canonicalName: (entityNameRejectionReason(canonicalName) ? `${domain ?? "company"} ${Date.now().toString(36)}` : canonicalName).slice(0, 200),
      legalName: null,
      website: domain,
      aliases: [described?.canonical_name ?? "", siteTitle ?? ""]
        .filter((a): a is string => Boolean(a) && !entityNameRejectionReason(a)),
      type: "private",
      status: "operating",
      country: described?.country_guess ?? null,
      hqCity: null,
      foundedYear: null,
      industryTags,
      tickers: [],
      confidence: described ? 0.4 : 0.3,
      isMonitored: false,
      reviewStatus: "auto_created",
      createdBy: "autocreate",
    },
    "autocreate",
  );
  return { entityId: entity.id, created: true, confidence: entity.confidence };
}

/** Review-queue sampler view: recent auto-created entities (FR-8 AC audits). */
export async function reviewQueueSample(db: Db, limit = 50) {
  const { eq } = await import("drizzle-orm");
  return db
    .select()
    .from(entities)
    .where(eq(entities.reviewStatus, "auto_created"))
    .orderBy(entities.createdAt)
    .limit(limit);
}
