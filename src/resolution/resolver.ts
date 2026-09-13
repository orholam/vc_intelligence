import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getFilters, renderPrompt, getTemplate } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articleEntities, articles } from "../db/schema.js";
import { extractCountries } from "../lib/countries.js";
import { entityNameRejectionReason, isGenericFundingAlias, TICKER_STOPWORDS } from "../lib/quality.js";
import { normalizeName } from "../lib/text.js";
import type { LlmRouter } from "../llm/router.js";
import { autocreateEntity } from "../entities/autocreate.js";
import { generateCandidates, type Candidate } from "./candidates.js";

/**
 * FR-11 resolver (the namesake problem). Deterministic evidence first
 * (alias strength, domain overlap, ticker coherence, country coherence,
 * prominence prior); LLM adjudication ONLY for multi-candidate or low-margin
 * cases, grounded on profile cards. Output: primary + secondaries with
 * confidence + evidence trail; unconfident matches drop out of entity-indexed
 * views while the article stays in the raw store.
 */

const Adjudication = z.object({
  matches: z
    .array(
      z.object({
        candidate_index: z.number().int(),
        role: z.enum(["primary", "secondary"]).default("primary"),
        confidence: z.number().min(0).max(1),
        evidence: z.string().default(""),
      }),
    )
    .default([]),
});

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  scores: Record<string, string | number | boolean | undefined>;
  domainOverlap: boolean;
}

export interface Resolution {
  primaryEntityId?: string;
  primaryConfidence?: number;
  primaryEvidence?: Record<string, unknown>;
  secondaries: Array<{ entityId: string; confidence: number }>;
  adjudicated: boolean;
  mentions: string[];
}

export interface ResolveInput {
  title: string;
  lead: string;
  outlinkDomains: string[];
  /** batch_audit subject_name or title grammar — used when KB match fails. */
  subjectHint?: string | null;
}

export async function resolveArticle(
  db: Db,
  router: LlmRouter,
  input: ResolveInput & { articleId?: string },
): Promise<Resolution> {
  const cfg = getFilters().resolver;
  const { candidates, mentions } = await generateCandidates(db, input);
  if (!candidates.length) {
    // No KB hits: try batch_audit subject_hint, LLM discovery, then the
    // deterministic title+brand-domain path — syndicated funding copies often
    // lack brand outlinks but still name the subject in the headline.
    if (cfg.discovery_mints !== false) {
      const { discoverSubjectEntity, discoverSubjectLlm, discoverFromSubjectHint } =
        await import("./discovery.js");
      const input_ = { title: input.title, outlinkDomains: input.outlinkDomains };
      const hint =
        input.subjectHint?.trim() ||
        (await import("../lib/title-subject.js")).extractTitleSubject(input.title) ||
        null;
      const hinted =
        hint != null
          ? await discoverFromSubjectHint(db, router, { ...input_, subjectHint: hint }).catch(() => null)
          : null;
      const llmMint = hinted ?? (await discoverSubjectLlm(db, router, input_).catch(() => null));
      const minted = llmMint ?? (await discoverSubjectEntity(db, router, input_));
      if (minted) {
        return {
          primaryEntityId: minted.entityId,
          primaryConfidence: minted.confidence,
          primaryEvidence: { alias: minted.name, discovery: minted.via },
          secondaries: [],
          adjudicated: false,
          mentions,
        };
      }
    }
    return { secondaries: [], adjudicated: false, mentions };
  }

  const text = `${input.title}\n${input.lead}`;
  const textNorm = normalizeName(text);
  const titleNorm = normalizeName(input.title);
  const textCountries = new Set(extractCountries(text, 6));

  // ------------------------------------------------ deterministic scoring pass
  // Precision rule (FR-11 rev): alias evidence is location-weighted. An alias
  // in the TITLE anchors the article to the company; an alias found only in
  // body/lead text is a weak mention (ticker modules, market roundups, "other
  // players include X") and must not carry a candidate past the primary bar.
  const scored: ScoredCandidate[] = candidates.map((c) => {
    const e = c.entity;
    let score = 0.1; // base prior
    const scores: ScoredCandidate["scores"] = {};

    const aliasesNorm = [e.canonicalName, ...e.aliases]
      .filter((a): a is string => Boolean(a))
      .map(normalizeName)
      .filter((a) => a.length >= 3 && !isGenericFundingAlias(a));
    // Generic funding tokens ("series", "seed"…) never count as evidence, so
    // a company named "Series" cannot ride "…raises $12M Series A" headlines.
    const ma: string | null = c.matchedAlias ?? null;
    const matchedAliasNorm = ma !== null ? normalizeName(ma) : null;
    const matchedGeneric = matchedAliasNorm != null && isGenericFundingAlias(matchedAliasNorm);
    const titleHit =
      !matchedGeneric &&
      matchedAliasNorm !== null &&
      titleNorm.includes(matchedAliasNorm);
    const anyAliasHit =
      !matchedGeneric &&
      (c.sources.some((s) => s === "alias_exact" || s === "alias_fuzzy") ||
        aliasesNorm.some((a) => textNorm.includes(a)));
    if (titleHit && c.sources.includes("alias_exact")) score += cfg.exact_alias_bonus;
    else if (titleHit) score += Math.max(cfg.exact_alias_bonus * 0.6, cfg.partial_alias_bonus);
    else if (anyAliasHit) score += cfg.mention_alias_bonus;

    const tickerHit =
      e.tickers.length > 0 &&
      e.tickers.some(
        (t) =>
          !TICKER_STOPWORDS.has(t.toLowerCase()) &&
          new RegExp(`\\b${escapeRegExp(t)}\\b`, "i").test(input.title),
      );
    if (tickerHit) score += cfg.ticker_match_bonus;

    const domainOverlap = Boolean(e.website && input.outlinkDomains.includes(e.website));
    // Domain overlap corroborates alias/ticker/title evidence at full weight,
    // but ALONE it is weak: publisher sidebars embed links to apple.com on
    // unrelated market columns. Cap the domain-only contribution well below
    // the primary bar so a bare outbound link cannot manufacture an entity.
    const hasAliasEvidence = titleHit || anyAliasHit || tickerHit;
    if (domainOverlap) score += hasAliasEvidence ? cfg.domain_overlap_bonus : Math.min(cfg.domain_overlap_bonus, 0.15);

    if (e.country && textCountries.size > 0 && !textCountries.has(e.country)) {
      score -= cfg.country_mismatch_penalty;
    }

    // prominence prior capped small so big companies don't swallow namesakes
    score += Math.min(e.confidence * 0.08, cfg.prominence_prior_cap);

    // repeated alias occurrences as weak corroboration, capped low
    const aliasHits = aliasesNorm.filter((a) => textNorm.includes(a)).length;
    score += Math.min(Math.max(0, aliasHits - 1) * 0.02, cfg.repeat_alias_bonus_cap);

    scores.alias = titleHit ? "title" : anyAliasHit ? "body" : "none";
    scores.domain_overlap = domainOverlap ? 1 : 0;
    scores.ticker = tickerHit ? 1 : 0;

    return { candidate: c, score: clamp01(score), scores, domainOverlap };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  const second = scored[1];
  const margin = second ? top.score - second.score : 1;

  let adjudicated = false;
  let ranked = scored.map((s) => ({ ...s }));

  // Adjudicate when the margin between leaders is thin OR when no candidate
  // clears the primary bar deterministically — including single-candidate
  // cases, which previously fell through on alias presence alone.
  const needsAdjudication =
    (scored.length >= 2 && margin < cfg.adjudicate_margin) ||
    top.score < cfg.primary_min_confidence;

  if (needsAdjudication) {
    adjudicated = true;
    const matches = await adjudicate(router, input, scored.slice(0, cfg.adjudicate_top_n));
    if (matches) {
      ranked = blendAdjudication(ranked, matches, cfg);
      ranked.sort((a, b) => b.score - a.score);
    }
  }

  const best = ranked[0]!;
  const resolution: Resolution = { secondaries: [], adjudicated, mentions };

  // Primary gates — every rejection path falls through to subject discovery
  // at the tail: an unresolved article whose title names a brand-matched
  // unknown company must still mint a card instead of losing the company.
  let primaryAssigned = false;
  if (best.score >= cfg.drop_below_confidence) {
    // Primary gate: title-anchored alias, domain overlap, or a confident LLM
    // adjudication must support the match — never body mentions alone.
    const llmConf = Number(best.scores.llm_adjudication ?? 0);
    const subjectEvidence =
      best.scores.alias === "title" || best.domainOverlap || llmConf >= cfg.primary_min_confidence;
    // A below-bar score needs corroboration beyond raw confidence. Domain
    // overlap ALONE is not enough — publisher sidebars embed links to
    // apple.com et al., which must not rescue a finance column into an
    // "Apple article". Require alias evidence or a strong adjudication.
    const corroborated =
      best.scores.alias !== "none" || llmConf >= cfg.primary_min_confidence;
    const belowBar = best.score < cfg.primary_min_confidence && !corroborated;
    const gatesPass =
      !(cfg.require_title_or_domain_for_primary && !subjectEvidence) && !belowBar;
    if (gatesPass) {
      primaryAssigned = true;
      resolution.primaryEntityId = best.candidate.entity.id;
      resolution.primaryConfidence = Number(best.score.toFixed(3));
      resolution.primaryEvidence = {
        alias: best.candidate.matchedAlias ?? undefined,
        domain_overlap: best.domainOverlap || undefined,
        llm: adjudicated ? ("adjudicated" as const) : ("not_needed" as const),
        scores: best.scores,
      };

      for (const m of ranked.slice(1)) {
        if (m.score >= cfg.secondary_min_confidence) {
          resolution.secondaries.push({
            entityId: m.candidate.entity.id,
            confidence: Number(m.score.toFixed(3)),
          });
        }
      }
    }
  }
  if (!primaryAssigned) {
    // No existing candidate anchored as subject: the title may still name a
    // never-before-seen company (first-ever coverage). Ask an LLM pass first
    // ("what company is this about?") — it catches subjects the rigid
    // headline regex misses — then fall back to the deterministic mint.
    // Both paths gate on brand-owned outlink domains + hygiene guards.
    const { discoverSubjectEntity, discoverSubjectLlm, discoverFromSubjectHint } = await import(
      "./discovery.js"
    );
    const input_ = {
      title: input.title,
      outlinkDomains: input.outlinkDomains,
    };
    const hint =
      input.subjectHint?.trim() ||
      (await import("../lib/title-subject.js")).extractTitleSubject(input.title) ||
      null;
    const hinted =
      hint != null
        ? await discoverFromSubjectHint(db, router, { ...input_, subjectHint: hint }).catch(() => null)
        : null;
    const llmMint = hinted ?? (await discoverSubjectLlm(db, router, input_).catch(() => null));
    const minted = llmMint ?? (await discoverSubjectEntity(db, router, input_));
    if (minted) {
      resolution.primaryEntityId = minted.entityId;
      resolution.primaryConfidence = minted.confidence;
      resolution.primaryEvidence = { alias: minted.name, discovery: minted.via };
    }
  }
  await linkCounterparties(db, router, input, resolution);
  return resolution;
}

// ------------------------------------------------------- counterparty links
// M&A / funding / partnership coverage names MORE than one operating company
// ("Gamma acquires … startup Lica"), but subject discovery mints exactly one
// card and the KB matcher only ranks entities that already exist — so the
// acquired/invested-in party stayed invisible forever. One mini-tier pass per
// article lists every OPERATING company named in the text; each is linked to
// the article (existing card) or minted as a low-confidence stub (new name).
// Hygiene still applies (entityNameRejectionReason, ≤5 words), but outlink-
// domain proof is NOT required here: an acquired startup almost never owns an
// outlink in its acquirer's coverage.
const Counterparties = z.object({
  companies: z
    .array(
      z.object({
        name: z.string().min(2),
        role: z
          .enum(["acquirer", "acquired", "investor", "investee", "partner", "other"])
          .default("other"),
      }),
    )
    .max(6)
    .default([]),
});

const COUNTERPARTY_MAX = 4;

/** VC/PE sellers and fund names are rarely feed subjects on investee-centric stories. */
function isInvestorSideName(name: string): boolean {
  const n = name.trim();
  return /\b(capital|ventures?|partners|advisors?|asset management|private equity|holdings)\b/i.test(n);
}

async function linkCounterparties(
  db: Db,
  router: LlmRouter,
  input: ResolveInput,
  resolution: Resolution,
): Promise<void> {
  if (getFilters().resolver.counterparty_links === false) return;
  let named: z.infer<typeof Counterparties>["companies"] = [];
  try {
    const res = await router.chatJson(
      Counterparties,
      "You extract OPERATING COMPANY names from news text. Return only real businesses (companies with products, customers or staff) - never people, places, product names, funds, law firms, government bodies, universities or news publishers. Order by prominence, max 5. Empty list when none.",
      `Title: ${input.title}\n\nText: ${input.lead.slice(0, 1200)}\n\nList every operating company named, with its role in the event.`,
      { stage: "counterparty_extract", tier: "mini" },
    );
    if (!res.ok) return;
    // Mock fallback output is lexical noise (people names, sentence
    // fragments) — never let it mint or link KB entries. Only a real brain
    // (harness agent or hosted model) earns counterparty trust.
    if (/mock/i.test(res.model)) return;
    named = res.data.companies;
  } catch {
    return; // budget breaker / provider failure - resolution stands as-is
  }

  const linked = new Set<string>(
    [resolution.primaryEntityId, ...resolution.secondaries.map((s) => s.entityId)].filter(
      (v): v is string => Boolean(v),
    ),
  );
  let added = 0;
  for (const c of named) {
    if (added >= COUNTERPARTY_MAX) break;
    const rawName = c.name.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim();
    if (!rawName || rawName.split(" ").length > 5) continue;
    if (normalizeName(rawName).length < 3) continue;
    if (entityNameRejectionReason(rawName)) continue;
    if (isInvestorSideName(rawName) && c.role !== "acquired" && c.role !== "investee") continue;
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL AND (canonical_name ILIKE ${rawName} OR ${rawName} = ANY(aliases))
      LIMIT 1
    `);
    let entityId = existing[0]?.id ?? null;
    let role = "other";
    if (!entityId) {
      try {
        const stub = await autocreateEntity(db, router, { name: rawName });
        entityId = stub.entityId;
        role = c.role;
        await db.execute(sql`
          UPDATE entities SET
            confidence = GREATEST(confidence, 0.55),
            source_refs = CASE WHEN 'counterparty:${sql.raw(role)}' = ANY(COALESCE(source_refs, '{}'))
                               THEN COALESCE(source_refs, '{}')
                               ELSE COALESCE(source_refs, '{}') || '{counterparty:${sql.raw(role)}}' END,
            updated_at = now()
          WHERE id = ${entityId}
        `);
      } catch {
        continue; // hygiene guards refused the mint
      }
    }
    if (!entityId || linked.has(entityId)) continue;
    linked.add(entityId);
    resolution.secondaries.push({ entityId, confidence: 0.6 });
    added += 1;
  }
}

/** Persist resolution output (FR-11 output contract). */
export async function persistResolution(
  db: Db,
  articleId: string,
  resolution: Resolution,
): Promise<void> {
  await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
  if (resolution.primaryEntityId && resolution.primaryConfidence != null) {
    await db
      .insert(articleEntities)
      .values({
        articleId,
        entityId: resolution.primaryEntityId,
        role: "primary",
        confidence: resolution.primaryConfidence,
        evidence: resolution.primaryEvidence ?? null,
      })
      .onConflictDoNothing();
  }
  for (const sec of resolution.secondaries) {
    if (sec.entityId === resolution.primaryEntityId) continue;
    await db
      .insert(articleEntities)
      .values({
        articleId,
        entityId: sec.entityId,
        role: "secondary",
        confidence: sec.confidence,
        evidence: { llm: resolution.adjudicated ? "adjudicated" : "not_needed" },
      })
      .onConflictDoNothing();
  }
  const linkedAny =
    Boolean(resolution.primaryEntityId) || resolution.secondaries.length > 0;
  await db
    .update(articles)
    .set({ resolvedAt: linkedAny ? new Date() : null, updatedAt: new Date() })
    .where(eq(articles.id, articleId));
}

// ------------------------------------------------------------ LLM adjudication
async function adjudicate(
  router: LlmRouter,
  input: ResolveInput,
  shortlist: ScoredCandidate[],
): Promise<z.infer<typeof Adjudication>["matches"] | null> {
  const tpl = getTemplate("adjudicate");
  const cards = shortlist.map((s, i) => {
    const e = s.candidate.entity;
    const tickers = e.tickers.length ? ` | tickers: ${e.tickers.join(", ")}` : "";
    return `[${i}] ${e.canonicalName} | website ${e.website ?? "unknown"} | ${e.country ?? "?"} | ${e.industryTags.join("/") || "?"} | aliases: ${e.aliases.slice(0, 6).join(", ")}${tickers}`;
  });
  const { system, user, templateVersion } = renderPrompt(tpl, {
    title: input.title,
    body: input.lead.slice(0, 1200),
    publisher_domain: "(unknown)",
    outlink_domains: input.outlinkDomains.slice(0, 20).join(", ") || "(none)",
    candidates: cards.join("\n"),
  });

  try {
    const res = await router.chatJson(Adjudication, system, user, {
      stage: "adjudicate",
      tier: "big",
      promptTemplate: "adjudicate",
      promptTemplateVersion: templateVersion,
    });
    if (!res.ok) return null;
    return res.data.matches;
  } catch {
    // budget breaker or provider failure -> deterministic ranking stands
    return null;
  }
}

function blendAdjudication(
  deterministic: ScoredCandidate[],
  matches: NonNullable<Awaited<ReturnType<typeof adjudicate>>>,
  cfg: ReturnType<typeof getFilters>["resolver"],
): ScoredCandidate[] {
  const out: ScoredCandidate[] = deterministic.map((d, i) => {
    const m = matches.find((x) => x.candidate_index === i);
    if (!m) return d;
    const blended = clamp01(
      d.score * cfg.adjudicate_weight_det + m.confidence * cfg.adjudicate_weight_llm,
    );
    const scored: ScoredCandidate = {
      ...d,
      score: blended,
      scores: { ...d.scores, llm_adjudication: m.confidence, llm_evidence: m.evidence },
    };
    return scored;
  });
  return out;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
