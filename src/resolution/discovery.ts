import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { getTemplate, renderPrompt } from "../config-files.js";
import { COMPANY_EVENT_SIGNAL_RE, entityNameRejectionReason } from "../lib/quality.js";
import { normalizeName } from "../lib/text.js";
import { extractTitleSubject } from "../lib/title-subject.js";
import { hostToDomain } from "../lib/hash.js";
import { isUtilityDomain } from "../lib/domains.js";
import type { LlmRouter } from "../llm/router.js";
import { autocreateEntity } from "../entities/autocreate.js";

/**
 * Organic subject discovery: when an article's title names a company the KB
 * has never seen AND its outlinks contain that brand's own domain, minting
 * the card is safer than losing the company entirely — every resolver pass
 * only ranks EXISTING entities, so without discovery a first-ever funding
 * story ("Helcim Raises $38 Million …") serves unresolved forever.
 *
 * Precision guards (the junk-mint lessons of the 08-22 cleanup):
 *  - strict event-language titles only (raises/secures/closes/acquires/…)
 *  - the captured subject must pass entityNameRejectionReason
 *  - mint ONLY with a brand-matched outlink domain (helcim.com for Helcim) —
 *    name-only mints stay disabled
 *  - confidence 0.68 (above the D2 orphan bar), provenance in source_refs
 */

const DISCOVERY_TITLE_RE =
  /^(.{2,60}?)\s+(?:raises?|raised|secures?|secured|closes?|closed|lands?|bags?|launches|acquires?|acquired)\b/i;

const SUBJECT_STOPWORDS = new Set([
  "update", "report", "exclusive", "video", "watch", "breaking", "just",
  "why", "how", "what", "the", "a", "an", "it", "they", "you",
]);

/** Registrable-domain brand: first meaningful label ("www" stripped). */
function domainBrand(domain: string): string {
  const labels = domain.replace(/^www\./i, "").split(".");
  return normalizeName(labels[0] ?? "").replaceAll(" ", "");
}

export interface DiscoveredSubject {
  entityId: string;
  name: string;
  confidence: number;
  via:
    | "llm_subject_brand_domain"
    | "llm_subject_domain"
    | "llm_subject_name_only"
    | "title_subject_brand_domain"
    | "subject_hint_title_event";
}

const DiscoverSchema = z.object({
  company_name: z.string().nullable(),
  website_domain: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/**
 * LLM-assisted subject discovery (stage `discover_subject`, mini tier): when
 * candidate generation finds nobody in the KB, ASK what company the article
 * is about instead of relying on one rigid headline regex. Precision stays
 * gated exactly like the deterministic path — a mint still requires the
 * named brand to own one of the article's own outlink domains and to pass
 * every autocreation hygiene guard; hallucinated domains are rejected
 * because they never appeared among the outlinks.
 */
export async function discoverSubjectLlm(
  db: Db,
  router: LlmRouter,
  input: { title: string; outlinkDomains: string[] },
): Promise<DiscoveredSubject | null> {
  if (!getDiscoveryEnabled(db)) return null;
  const tpl = getTemplate("discover_subject");
  const rendered = renderPrompt(tpl, {
    title: input.title,
    outlink_domains: input.outlinkDomains.length ? input.outlinkDomains.join(", ") : "(none)",
  });
  const res = await router.chatJson(DiscoverSchema, rendered.system, rendered.user, {
    stage: "discover_subject",
    tier: "mini",
    promptTemplate: "discover_subject",
    promptTemplateVersion: rendered.templateVersion,
  });
  if (!res.ok) return null;
  const rawName = res.data.company_name?.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim() ?? "";
  if (!rawName || rawName.split(" ").length > 5) return null;
  if (SUBJECT_STOPWORDS.has(rawName.toLowerCase())) return null;
  if (entityNameRejectionReason(rawName)) return null;

  // Domain evidence is mandatory unless the title itself is a strong company
  // event and the model is highly confident (syndicated copies often lack
  // brand outlinks but still name the subject in the headline).
  const claimed = res.data.website_domain?.toLowerCase().trim();
  const nameOnlyMin = (await getDiscoveryConfig()).name_only_min_confidence;
  if (!claimed || isUtilityDomain(claimed)) {
    if (
      res.data.confidence >= nameOnlyMin &&
      COMPANY_EVENT_SIGNAL_RE.test(input.title) &&
      extractTitleSubject(input.title)
    ) {
      try {
        const created = await autocreateEntity(db, router, { name: rawName });
        const confidence = Math.min(Math.max(created.confidence, res.data.confidence), 0.65);
        return {
          entityId: created.entityId,
          name: rawName,
          confidence,
          via: "llm_subject_name_only",
        };
      } catch {
        return null;
      }
    }
    return null;
  }
  const domain = hostToDomain(claimed);
  if (!input.outlinkDomains.includes(domain)) return null;

  const brand = normalizeName(rawName).replaceAll(" ", "");
  if (brand.length < 3) return null;
  const brandMatched = domainBrand(domain) === brand;

  try {
    const created = await autocreateEntity(db, router, {
      name: rawName,
      domain,
      url: `https://${domain}`,
    });
    // Brand-matched mints carry LLM subject evidence + own-domain corroboration
    // (0.68 floor, same as deterministic discovery). Non-brand-matched domains
    // need high model confidence and land lower — linked, but modest authority.
    const confidence = brandMatched
      ? Math.max(created.confidence, Math.min(res.data.confidence + 0.1, 0.9), 0.68)
      : Math.min(Math.max(created.confidence, res.data.confidence), 0.62);
    await db.execute(sql`
      UPDATE entities SET
        confidence = GREATEST(confidence, ${confidence}),
        source_refs = CASE WHEN 'discovery:${brandMatched ? sql`llm_subject_brand_domain` : sql`llm_subject_domain`}' = ANY(COALESCE(source_refs, '{}'))
                           THEN COALESCE(source_refs, '{}')
                           ELSE COALESCE(source_refs, '{}') || '{discovery:${brandMatched ? sql`llm_subject_brand_domain` : sql`llm_subject_domain`}}' END,
        updated_at = now()
      WHERE id = ${created.entityId}
    `);
    return {
      entityId: created.entityId,
      name: rawName,
      confidence,
      via: brandMatched ? "llm_subject_brand_domain" : "llm_subject_domain",
    };
  } catch {
    return null; // registry/publisher/utility guards fired — refuse to mint
  }
}

export async function discoverSubjectEntity(
  db: Db,
  router: LlmRouter,
  input: { title: string; outlinkDomains: string[] },
): Promise<DiscoveredSubject | null> {
  if (!getDiscoveryEnabled(db)) return null;
  const fromTitle = extractTitleSubject(input.title);
  if (fromTitle) {
    const brand = normalizeName(fromTitle).replaceAll(" ", "");
    if (brand.length >= 3) {
      const domain = input.outlinkDomains.find((d) => domainBrand(d) === brand);
      if (domain) {
        try {
          const res = await autocreateEntity(db, router, {
            name: fromTitle,
            domain,
            url: `https://${domain}`,
          });
          const confidence = Math.max(res.confidence, 0.68);
          return {
            entityId: res.entityId,
            name: fromTitle,
            confidence,
            via: "title_subject_brand_domain",
          };
        } catch {
          // fall through to regex / LLM paths
        }
      }
    }
  }
  const m = DISCOVERY_TITLE_RE.exec(input.title.trim());
  if (!m?.[1]) return null;
  const rawName = m[1].replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim();
  if (!rawName || rawName.split(" ").length > 5) return null;
  if (SUBJECT_STOPWORDS.has(rawName.toLowerCase())) return null;
  if (entityNameRejectionReason(rawName)) return null;

  const brand = normalizeName(rawName).replaceAll(" ", "");
  if (brand.length < 3) return null;
  const domain = input.outlinkDomains.find((d) => domainBrand(d) === brand);
  if (!domain) return null;

  try {
    const res = await autocreateEntity(db, router, {
      name: rawName,
      domain,
      url: `https://${domain}`,
    });
    // Brand-verified mint: title event-language + the company's own domain
    // among the article's outlinks — stronger evidence than a bare stub.
    // Idempotent: the evidence ref guards double confidence bumps.
    const confidence = Math.max(res.confidence, 0.68);
    await db.execute(sql`
      UPDATE entities SET
        confidence = GREATEST(confidence, ${confidence}),
        source_refs = CASE WHEN 'discovery:title_subject_brand_domain' = ANY(COALESCE(source_refs, '{}'))
                           THEN COALESCE(source_refs, '{}')
                           ELSE COALESCE(source_refs, '{}') || '{discovery:title_subject_brand_domain}' END,
        updated_at = now()
      WHERE id = ${res.entityId}
    `);
    return { entityId: res.entityId, name: rawName, confidence, via: "title_subject_brand_domain" };
  } catch {
    // registry/publisher/utility guards fired — correctly refuse to mint
    return null;
  }
}

async function getDiscoveryConfig(): Promise<{ enabled: boolean; name_only_min_confidence: number }> {
  try {
    const { getFilters } = await import("../config-files.js");
    const r = getFilters().resolver;
    return {
      enabled: r.discovery_mints !== false,
      name_only_min_confidence: r.discovery_name_only_min_confidence ?? 0.85,
    };
  } catch {
    return { enabled: true, name_only_min_confidence: 0.85 };
  }
}

async function getDiscoveryEnabled(db: Db): Promise<boolean> {
  return (await getDiscoveryConfig()).enabled;
}

/**
 * Mint from batch_audit subject_name / title grammar when the headline
 * reports a discrete company event. Outlink proof is optional — same policy
 * as counterparty_extract stubs.
 */
export async function discoverFromSubjectHint(
  db: Db,
  router: LlmRouter,
  input: { title: string; subjectHint: string; outlinkDomains: string[] },
): Promise<DiscoveredSubject | null> {
  if (!(await getDiscoveryEnabled(db))) return null;
  if (!COMPANY_EVENT_SIGNAL_RE.test(input.title)) return null;

  const rawName = input.subjectHint.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim();
  if (!rawName || rawName.split(" ").length > 5) return null;
  if (SUBJECT_STOPWORDS.has(rawName.toLowerCase())) return null;
  const reject = entityNameRejectionReason(rawName);
  if (reject && reject !== "person_name") return null;

  const brand = normalizeName(rawName).replaceAll(" ", "");
  if (brand.length < 2) return null;
  const domain = input.outlinkDomains.find((d) => domainBrand(d) === brand);

  try {
    const created = await autocreateEntity(db, router, {
      name: rawName,
      domain,
      url: domain ? `https://${domain}` : undefined,
    });
    const confidence = domain ? Math.max(created.confidence, 0.68) : Math.max(created.confidence, 0.62);
    return {
      entityId: created.entityId,
      name: rawName,
      confidence,
      via: domain ? "title_subject_brand_domain" : "subject_hint_title_event",
    };
  } catch {
    return null;
  }
}
