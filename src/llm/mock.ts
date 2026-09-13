import type { z } from "zod";
import { getIndustriesTaxonomy, priceFor } from "../config-files.js";
import { normalizeName } from "../lib/text.js";
import { heuristicOrganizations } from "../lib/ner-heuristics.js";
import {
  COMPANY_EVENT_SIGNAL_RE,
  entityNameRejectionReason,
  isGenericFundingAlias,
  isSlopTitle,
  TICKER_STOPWORDS,
} from "../lib/quality.js";
import { estimateTokens, type ChatCallOpts, type ChatResult, type LlmProvider } from "./provider.js";
import { classifyArticle, type EntityContext } from "./reasoner/classify.js";
import { detectCountries, detectQueryCountries, GEO_SYNONYMS } from "./reasoner/geo.js";
import { summarizeArticle } from "./reasoner/summary.js";
import { extractFact } from "./reasoner/factsex.js";
import { cutVocabTail, lowerZones, scoreKeywordList, section } from "./reasoner/lex.js";
import { extractTitleSubject, extractAcquisitionTarget } from "../lib/title-subject.js";
import { mockCompanyProfile } from "./reasoner/profile.js";

/**
 * Offline LLM provider (FR-12 / NFR-5) — now backed by the structured
 * reasoning engine in ./reasoner/*. Deterministic, contract-identical with
 * real providers: every stage parses through the same zod schemas.
 */

export { detectCountries };

/** Legacy helper retained for listgen fallback import stability. */
export function sectorIdTokensMatch(query: string, sectorId: string): boolean {
  return sectorId
    .split("_")
    .some((tok) => tok.length >= 2 && query.includes(tok));
}

// ------------------------------------------------------------------- provider

interface MockCandidateLine {
  index: number;
  name: string;
  website: string;
  country: string;
  industries: string;
  aliases: string[];
  tickers: string[];
}

function parseCandidates(block: string): MockCandidateLine[] {
  const out: MockCandidateLine[] = [];
  for (const line of block.split("\n")) {
    const m =
      /^\s*\[(\d+)\]\s*([^|\n]+)\s*\|\s*([^|\n]*)\|\s*([^|\n]*)\|\s*([^|\n]*)\|\s*(?:aliases?:?\s*)?([^\n]*?)(?:\s*\|\s*tickers?:?\s*([^\n]*))?$/i.exec(
        line,
      );
    if (!m) continue;
    out.push({
      index: Number(m[1] ?? 0),
      name: (m[2] ?? "").trim(),
      website: (m[3] ?? "").replace(/^website\s*/i, "").trim(),
      country: (m[4] ?? "").trim(),
      industries: (m[5] ?? "").trim(),
      aliases: (m[6] ?? "")
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
      tickers: (m[7] ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    });
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?${}()|[\]\\]/g, "\\$&");

export class MockProvider implements LlmProvider {
  async chatJson<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    user: string,
    opts: ChatCallOpts,
  ): Promise<ChatResult<T>> {
    const model = opts.stage === "judge" ? "mock-judge" : `mock-${opts.tier}`;
    const inputTokens = estimateTokens(system + user);
    let data: unknown;
    switch (opts.stage) {
      case "noise_filter":
        data = this.noiseFilter(user);
        break;
      case "ner_lite":
        data = this.nerLite(user);
        break;
      case "adjudicate":
        data = this.adjudicate(user);
        break;
      case "discover_subject":
        data = this.discoverSubject(user);
        break;
      case "counterparty_extract":
        data = this.counterparties(user);
        break;
      case "classify_enrich":
        data = this.classifyEnrich(user);
        break;
      case "batch_audit":
        data = this.batchAudit(user);
        break;
      case "summary":
        data = this.summary(user);
        break;
      case "fact_extract":
        data = this.factExtract(user);
        break;
      case "site_describe":
        data = this.siteDescribe(user);
        break;
      case "company_profile":
        data = mockCompanyProfile(user);
        break;
      case "listgen_interpret":
        data = this.listgenInterpret(user);
        break;
      case "judge_story":
        data = this.judgeStory(user);
        break;
      case "webcheck_validate":
        data = { supported: !/snippets:\s*\(?none\)?/i.test(user), reason: "lexical snippet check" };
        break;
      default:
        throw new Error(`MockProvider: unknown stage "${opts.stage}"`);
    }
    const outputTokens = estimateTokens(JSON.stringify(data));
    const p = priceFor(model);
    const costUsd = (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
    return {
      ok: true,
      data: schema.parse(data),
      raw: JSON.stringify(data),
      model,
      latencyMs: 1,
      inputTokens,
      outputTokens,
      costUsd,
    };
  }

  // ------------------------------------------------------------ noise filter
  private noiseFilter(user: string): unknown {
    const title = section(user, "TITLE:", ["PUBLISHER:", "TEXT:", "EVENT_TYPES"]);
    const body = section(user, "TEXT:", []);
    const lead = body.slice(0, 600);

    // Granular non-news format markers keep discard reasons diverse (B4).
    const fmt =
      /webinar[:\s]|podcast episode|newsletter[:\s]|weekly roundup|this week in|sponsored|events calendar|job alert/i.exec(
        title,
      );
    if (fmt) {
      return {
        is_company_news: false,
        confidence: 0.92,
        reason: `nonnews:${(fmt[0] ?? "marker").toLowerCase().replaceAll(/\W+/g, "_").slice(0, 24)}`,
      };
    }
    const slop = isSlopTitle(title);
    if (slop.slop) {
      return { is_company_news: false, confidence: 0.93, reason: "slop_title:entertainment" };
    }
    // Subject-event policy v4: market commentary/list columns never qualify,
    // so the commentary veto runs BEFORE the (now broader) subject-event test —
    // otherwise v4 earnings vocabulary would keep "earnings calendar" roundups.
    const hay = `${title}\n${lead}`;
    if (
      /(stocks to watch|price target|market wrap|earnings calendar|mutual fund|weekly market|sector update|sales pitch|opinion could make sense)/i.test(
        hay,
      )
    ) {
      return { is_company_news: false, confidence: 0.9, reason: "offtopic:markets_commentary" };
    }
    if (
      /(\d+% off|nearly \d+% off|today-only|deal of the day|on sale (now|today)|yes, you should buy)/i.test(hay)
    ) {
      return { is_company_news: false, confidence: 0.92, reason: "offtopic:retail_promo" };
    }
    if (
      /(may get (powerful )?new features|could (soon )?get|reveals? what to expect|ios \d+ reveals)/i.test(hay)
    ) {
      return { is_company_news: false, confidence: 0.91, reason: "offtopic:product_rumor" };
    }
    // Title or lead must report a discrete company event for SOME subject.
    if (!COMPANY_EVENT_SIGNAL_RE.test(hay)) {
      return {
        is_company_news: false,
        confidence: 0.88,
        reason: "no_subject_event_in_title_or_lead",
      };
    }
    return {
      is_company_news: true,
      confidence: 0.86,
      reason: "company-event anchored in title/lead",
    };
  }

  /**
   * Offline stand-in for the batch_audit stage: reuse per-item noise + classify
   * reasoners so tests stay deterministic, but the harness still issues ONE
   * call per chunk instead of N classify_enrich jobs.
   */
  private batchAudit(user: string): unknown {
    const items: unknown[] = [];
    const blocks = user.split(/### ITEM\s+/);
    for (const block of blocks) {
      const m = /^(\d+)\s*\n/.exec(block);
      if (!m) continue;
      const index = Number(m[1]);
      const titleClean = section(block, "TITLE:", ["LEAD:", "PUBLISHER:"]).trim();
      const publisher = section(block, "PUBLISHER:", ["TITLE:", "LEAD:"]).trim();
      const lead = section(block, "LEAD:", []).trim();
      const nf = this.noiseFilter(`TITLE: ${titleClean}\nPUBLISHER: ${publisher}\nTEXT:\n${lead}`) as {
        is_company_news: boolean;
        reason: string;
      };
      const cl = this.classifyEnrich(`TITLE: ${titleClean}\nPUBLISHER: ${publisher}\nTEXT:\n${lead}`) as {
        primary_tag: string | null;
        secondary_tags: string[];
        sentiment: "positive" | "negative" | "neutral";
        sentiment_score: number;
        newsworthiness: "high" | "medium" | "low";
        industry_primary: string | null;
        industry_secondary: string[];
        countries: string[];
      };
      const orgs = heuristicOrganizations(titleClean);
      // Harness publish requires primary_tag + industry_primary; noise-only keeps
      // would loop forever as enrich_missing in waiting.
      const keep = nf.is_company_news && Boolean(cl.primary_tag);
      const reason = keep
        ? nf.reason
        : nf.is_company_news
          ? "batch_audit:tagless_veto"
          : nf.reason;
      let industryPrimary = cl.industry_primary;
      if (keep && !industryPrimary) {
        industryPrimary = inferIndustryFromEventTag(cl.primary_tag, titleClean, lead);
      }
      items.push({
        index,
        keep,
        reason,
        primary_tag: cl.primary_tag,
        secondary_tags: cl.secondary_tags ?? [],
        sentiment: cl.sentiment,
        sentiment_score: cl.sentiment_score,
        newsworthiness: cl.newsworthiness,
        industry_primary: industryPrimary,
        industry_secondary: cl.industry_secondary ?? [],
        countries: cl.countries ?? [],
        subject_name: (() => {
          const sub =
            extractTitleSubject(titleClean) ??
            orgs.find((o) => !entityNameRejectionReason(o.name))?.name ??
            null;
          return sub && !entityNameRejectionReason(sub) ? sub : null;
        })(),
      });
    }
    return { items };
  }

  // ------------------------------------------------------------------ ner
  private nerLite(user: string): unknown {
    const title = section(user, "TITLE:", ["TEXT:"]);
    const body = section(user, "TEXT:", []);
    const orgs = heuristicOrganizations(`${title}\n${body.slice(0, 2000)}`)
      .slice(0, 12)
      .map((o) => o.name);
    return { organizations: orgs };
  }

  // ---------------------------------------------------------- discover_subject
  /**
   * Lexical stand-in for the discover_subject prompt: best org candidate from
   * the title, paired with an outlink domain whose brand matches it. Mirrors
   * the real contract {company_name, website_domain, confidence}.
   */
  private discoverSubject(user: string): unknown {
    const title = section(user, "TITLE:", ["OUTBOUND-LINK DOMAINS:"]);
    const outlinksRaw = section(user, "OUTBOUND-LINK DOMAINS:", []);
    const domains = outlinksRaw
      .split(/[\s,]+/)
      .map((t) => t.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase())
      .filter((d) => d.includes("."));
    const titleSubject = extractTitleSubject(title);
    const orgs = heuristicOrganizations(title).filter(
      (o) => !entityNameRejectionReason(o.name),
    );
    const tryOrg = (name: string) => {
      const brand = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (brand.length < 3) return null;
      const domain = domains.find((d) => {
        const labels = d.replace(/^www\./, "").split(".");
        const label = (labels[0] ?? "").replace(/[^a-z0-9]/g, "");
        return label === brand || (brand.startsWith(label) && label.length >= 4);
      });
      if (!domain) return null;
      return { company_name: name, website_domain: domain, confidence: 0.72 };
    };
    if (titleSubject) {
      const hit = tryOrg(titleSubject);
      if (hit) return hit;
    }
    for (const o of orgs) {
      const hit = tryOrg(o.name);
      if (hit) return hit;
    }
    return { company_name: null, website_domain: null, confidence: 0.1 };
  }

  private counterparties(user: string): unknown {
    const title = section(user, "Title:", ["\n\n", "Text:"]);
    const body = section(user, "Text:", ["\n\nList every"]);
    const hay = `${title}\n${body}`.slice(0, 2000);
    const target = extractAcquisitionTarget(title);
    const companies = heuristicOrganizations(hay)
      .filter((o) => o.name.length >= 3 && o.name.split(" ").length <= 5)
      .filter((o) => !entityNameRejectionReason(o.name))
      .slice(0, 5)
      .map((o) => ({ name: o.name, role: "other" as const }));
    if (target && !companies.some((c) => normalizeName(c.name) === normalizeName(target))) {
      companies.unshift({ name: target, role: "acquired" });
    }
    return { companies: companies.slice(0, 5) };
  }

  // -------------------------------------------------------------- adjudicate
  private adjudicate(user: string): unknown {    const title = section(user, "Title:", ["Text excerpt:"]);
    const body = section(user, "Text excerpt:", ["Publisher domain:", "Outbound link domains:", "CANDIDATES"]);
    const outlinksRaw = section(user, "Outbound link domains:", ["CANDIDATES"]);
    const outlinkDomains = outlinksRaw
      .toLowerCase()
      .split(/[ ,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = parseCandidates(section(user, "CANDIDATES", [])).filter(
      (c) => !entityNameRejectionReason(c.name),
    );
    const normTitle = normalizeName(title);
    const normBody = normalizeName(body);
    const titleWords = new Set(normTitle.split(/\s+/));

    const scored = candidates.map((c) => {
      let score = 0;
      let firstPos = Number.MAX_SAFE_INTEGER;
      let anchoredTitle = false;

      const nameEntries = [
        { n: normalizeName(c.name), isTicker: false },
        ...c.aliases.map((a) => ({ n: normalizeName(a), isTicker: false })),
        ...c.tickers
          .filter((t) => !TICKER_STOPWORDS.has(t.toLowerCase()))
          .map((t) => ({ n: t.toLowerCase(), isTicker: true })),
      ].filter((x) => x.n.length >= 3);
      // Generic funding vocabulary in a candidate name can only be matched by
      // accident ("Series" vs "…raises $12M Series A"): cap it below the bar.
      const genericCandidate =
        isGenericFundingAlias(normalizeName(c.name)) ||
        c.aliases.some((a) => isGenericFundingAlias(normalizeName(a)));

      // Strongest single name signal wins (weak variants must not stack).
      let bestSignal = 0;
      for (const { n, isTicker } of nameEntries) {
        const escaped = escapeRe(n);
        const re = new RegExp(isTicker ? `\\b${escaped}\\b` : escaped);
        const titleHit = re.test(normTitle);
        if (titleHit) {
          // Word-boundary match scores higher than substring containment:
          // "AI" inside "OpenAI" is not evidence FOR candidate "AI".
          const boundary = new RegExp(`\\b${escaped}\\b`).test(normTitle);
          let s = boundary && !isTicker ? 0.6 : 0.35;
          // Multi-token alias anchoring most of the headline is stronger.
          const tokens = n.split(/\s+/).filter(Boolean);
          if (tokens.length >= 2 && tokens.filter((t) => titleWords.has(t)).length / tokens.length >= 0.5) {
            s = Math.max(s, 0.7);
          }
          bestSignal = Math.max(bestSignal, s);
          anchoredTitle = anchoredTitle || boundary;
          firstPos = Math.min(firstPos, normTitle.indexOf(n));
        } else if (re.test(normBody)) {
          bestSignal = Math.max(bestSignal, isTicker ? 0.15 : 0.25);
        }
      }
      score += bestSignal;
      if (genericCandidate) score = Math.min(score, 0.2);

      // Domain overlap: exact registrable-domain hit between article links
      // and the candidate website is near-conclusive subject evidence.
      const domain = c.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
      if (domain && !isPublisherHost(domain)) {
        if (outlinkDomains.some((d) => d === domain || d.endsWith(`.${domain}`))) score += 0.35;
      }
      // Publisher-host candidates ("techcrunch" as a company) are demoted.
      void anchoredTitle;
      return {
        index: c.index,
        score: Math.min(score, 0.97),
        pos: firstPos,
        anchoredTitle,
        evidence: "reasoner: lexical+domain+position",
      };
    });

    scored.sort((a, b) => b.score - a.score || a.pos - b.pos);
    // Grammatical-subject tie-break among equal top scores.
    const topScore = scored[0]?.score ?? 0;
    let tieRank = 0;
    for (const s of scored) {
      if (s.score === topScore && s.score > 0) s.score = Math.max(0, s.score - 0.02 * tieRank++);
    }
    scored.sort((a, b) => b.score - a.score);
    const matches = scored
      .filter((s) => {
        if (s.score < 0.55) return false;
        // Body-only weak hits must not become primary subject matches.
        if (!s.anchoredTitle && s.score < 0.7) return false;
        return true;
      })
      .map((s, i) => ({
        candidate_index: s.index,
        role: i === 0 ? ("primary" as const) : ("secondary" as const),
        confidence: Number(s.score.toFixed(2)),
        evidence: s.evidence,
      }));
    return { matches };
  }

  // --------------------------------------------------------- classify_enrich
  private classifyEnrich(user: string): unknown {
    const title = section(user, "TITLE:", ["PUBLISHER:", "TEXT:"]);
    const publisher = section(user, "PUBLISHER:", ["TEXT:"]);
    let body = section(user, "TEXT:", []);
    body = cutVocabTail(body);
    // Entity priors are metadata, never scorable article text.
    body = body.split(/\nENTITY CONTEXT:/)[0] ?? "";

    const entityCtx: EntityContext = parseEntityContext(user);

    const verdict = classifyArticle({ title, publisher, body, entity: entityCtx });
    const countries = detectCountries(title, body);
    // Entity home-country prior when the text names no geography.
    if (!countries.length && entityCtx.country && entityCtx.country !== "unknown") {
      countries.push(entityCtx.country);
    }
    return { ...verdict, countries: countries.length ? countries : verdict.countries };
  }

  // ----------------------------------------------------------------- summary
  private summary(user: string): unknown {
    const title = section(user, "TITLE:", ["TEXT:"]);
    let body = section(user, "TEXT:", []);
    // Never let rendered instruction text ("Rules:", "Return JSON:") leak
    // into extractive output — cut at the first such marker.
    body = (body.split(/\nRules:/)[0] ?? "").split(/\nReturn JSON:/)[0] ?? "";
    const entity = section(user, "ENTITY:", ["EVENT:", "TITLE:"]).trim() || null;
    const eventLabel = section(user, "EVENT:", ["TITLE:", "TEXT:"]).trim() || null;
    return { summary: summarizeArticle({ title, body, entityName: entity, eventLabel }) };
  }

  // ------------------------------------------------------------ fact_extract
  private factExtract(user: string): unknown {
    const entityName = section(user, "PRIMARY company (", [")"]);
    const title = section(user, "TITLE:", ["TEXT:"]);
    let body = section(user, "TEXT:", []);
    body = cutVocabTail(body);
    const todayStr = section(user, "TODAY:", ["TITLE:", "TEXT:"]).trim();
    const today = todayStr && !Number.isNaN(Date.parse(todayStr)) ? new Date(todayStr) : new Date();
    const f = extractFact({ entityName, title, body, today });
    return {
      has_event: f.has_event,
      type: f.type,
      payload: {
        funding_stage: f.payload.funding_stage ?? null,
        amount_usd_est: f.payload.amount_usd_est ?? null,
        lead_investors: f.payload.lead_investors ?? [],
        acquirer: f.payload.acquirer ?? null,
        target: f.payload.target ?? null,
        person: f.payload.person ?? null,
        role: f.payload.role ?? null,
        event_date: f.payload.event_date ?? null,
      },
    };
  }

  // ------------------------------------------------------------ site_describe
  private siteDescribe(user: string): unknown {
    const url = section(user, "homepage content for ", ["]:"]) || "";
    const content = section(user, ":\n", []) || user;
    const domain = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    // og:site_name / <title> patterns beat heuristic spans for canonical name.
    const ogSite = /og:site_name["'\s:=]+([^"'>\n]{2,60})/i.exec(content)?.[1]?.trim();
    const titleTag = /(?:^|\n)\s*(.{2,60})\s*[|·]\s*(?:official|home|website)/i.exec(content)?.[1]?.trim();
    const firstHeading: string | undefined =
      ogSite ??
      titleTag ??
      /(?:^|\n)([A-Z][A-Za-z0-9&.'\- ]{2,48})\s+(?:is|builds|helps|provides|offers|develops)/.exec(content)?.[1] ??
      heuristicOrganizations(content)[0]?.name ??
      domain.split(".")[0] ??
      "unknown";
    const sectors = getIndustriesTaxonomy().sectors;
    let industry: string | null = null;
    let bestScore = 0;
    for (const sec of sectors) {
      const lowerContent = content.toLowerCase();
      let s = 0;
      for (const kw of sec.keywords) {
        if (lowerContent.includes(kw.toLowerCase())) s += kw.includes(" ") ? 2 : 1;
      }
      if (s > bestScore) {
        bestScore = s;
        industry = sec.id;
      }
    }
    return {
      canonical_name: firstHeading.trim(),
      description: content.slice(0, 200),
      industry,
      country_guess: detectCountries(content.slice(0, 800), "")[0] ?? null,
      social_links: [
        ...content.matchAll(/https?:\/\/(?:www\.)?(linkedin\.com|twitter\.com|x\.com)\/[\w\-./]+/g),
      ]
        .slice(0, 5)
        .map((m) => m[0]),
    };
  }

  // -------------------------------------------------------- listgen_interpret
  private listgenInterpret(user: string): unknown {
    const query = section(user, "Request:", ["Allowed sectors"]).trim();
    const q = query.toLowerCase();
    const allowedSectors = section(user, "Allowed sectors (ids):", ["Allowed funding stages"])
      .split(/[\s,]+/)
      .filter(Boolean);
    const sectors = new Set<string>();
    const geoHits = new Set<string>();
    for (const [syn, isos] of Object.entries(GEO_SYNONYMS)) {
      if (q.includes(syn)) for (const iso of isos) geoHits.add(iso);
    }
    const textCountries = detectQueryCountries(query);

    for (const sec of getIndustriesTaxonomy().sectors) {
      if (allowedSectors.length && !allowedSectors.includes(sec.id)) continue;
      if (
        q.includes(sec.label.toLowerCase()) ||
        sec.keywords.some((kw) => q.includes(kw.toLowerCase())) ||
        q.includes(sec.id.replaceAll("_", " ")) ||
        sectorIdTokensMatch(q, sec.id)
      ) {
        sectors.add(sec.id);
      }
    }
    const fundingStage: string[] = [];
    if (/pre-?seed/.test(q)) fundingStage.push("pre_seed");
    if (/\bseed\b/.test(q)) fundingStage.push("seed");
    if (/series\s*a/.test(q)) fundingStage.push("series_a");
    if (/series\s*b/.test(q)) fundingStage.push("series_b");
    if (/series\s*c/.test(q)) fundingStage.push("series_c");
    if (/late[- ]stage|growth/.test(q)) fundingStage.push("late_stage");
    if (/early[- ]stage/.test(q) && !fundingStage.length) fundingStage.push("pre_seed", "seed");
    const countries = [...new Set([...textCountries, ...geoHits])];
    const foundedAfter = /founded (?:after|since) (\d{4})/.exec(q)?.[1];
    const foundedBefore = /founded (?:before|prior to) (\d{4})/.exec(q)?.[1];
    const signals: string[] = [];
    if (/rais|fund/.test(q)) signals.push("raised_recently");
    if (/hir/.test(q)) signals.push("hiring");
    if (/expand|entering|international/.test(q)) signals.push("expanding");
    if (/distress|struggl|layoff|shut/.test(q)) signals.push("distress");
    if (/acquiring|buying|roll-?up/.test(q)) signals.push("acquiring");

    // Keywords come ONLY from quoted phrases: mapping bare topic words into
    // name-ILIKE filters emptied result sets ("biotech" matched no company
    // NAMES) — sector/stage/geo/signals vocabulary carries topic intent.
    const keywords = new Set<string>();
    for (const m of query.matchAll(/"([^"]{3,30})"/g)) {
      if (m[1]) keywords.add(m[1].toLowerCase());
    }

    return {
      sectors: [...sectors],
      countries,
      funding_stage: [...new Set(fundingStage)],
      founded_after: foundedAfter ? Number(foundedAfter) : null,
      founded_before: foundedBefore ? Number(foundedBefore) : null,
      keywords: [...keywords].slice(0, 8),
      exclude_keywords: [],
      signals,
    };
  }

  // --------------------------------------------------------------- judge_story
  private judgeStory(user: string): unknown {
    const company = section(user, 'company "', ['"']);
    const windowStart = section(user, "window ", [".."]).trim();
    const windowEnd = section(user, "..", ["."]).replace(/[^\dT:Z\-]/g, "").slice(0, 24).trim();
    const storiesBlock = section(user, "one per line):", []).trim();
    const results: unknown[] = [];
    // Distinctive-token weighting: "Palantir Technologies" is about Palantir
    // even when the headline omits the generic suffix. Generic corporate
    // words carry 0.3 weight; distinctive tokens carry 1.0.
    const GENERIC_NAME_TOKENS = new Set([
      "technologies", "technology", "group", "holdings", "inc", "corp",
      "corporation", "company", "foundation", "labs", "systems",
      "solutions", "industries", "platforms", "ventures", "partners",
    ]);
    const companyNorm = normalizeName(company);
    const companyTokens = companyNorm.split(/\s+/).filter((w) => w.length > 2);
    const weights = companyTokens.map((t) => (GENERIC_NAME_TOKENS.has(t) ? 0.3 : 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    for (const line of storiesBlock.split("\n")) {
      const m = /^\s*(\d+)\.\s*(?:\[(\d{4}-\d{2}-\d{2})[^\]]*\])?\s*(.*)$/.exec(line);
      if (!m) continue;
      const headline = m[3] ?? "";
      const dateStr = m[2];
      const headNorm = normalizeName(headline);
      let hitWeight = 0;
      companyTokens.forEach((tok, i) => {
        if (headNorm.includes(tok)) hitWeight += weights[i] ?? 1;
      });
      const about =
        totalWeight > 0 && hitWeight / totalWeight >= 0.6 &&
        !/\b(vs\.?|versus|rival|competitor)\b/i.test(headline);
      let inWindow = true;
      if (dateStr) {
        const t = Date.parse(dateStr);
        if (!Number.isNaN(t)) {
          const ws2 = Date.parse(windowStart);
          const we = Date.parse(windowEnd);
          if (!Number.isNaN(ws2) && !Number.isNaN(we)) inWindow = t >= ws2 && t <= we;
        }
      }
      results.push({
        index: Number(m[1]),
        is_real_news: headline.length > 18 && !/undefined|\bnan\b|null/i.test(headline),
        is_about_company: about,
        is_in_window: inWindow,
        reason: "reasoner judge: weighted-token subject test",
      });
    }
    return { results };
  }

  async embed(
    inputs: string[],
    _opts: { stage: string },
  ): Promise<
    | { ok: true; vectors: number[][]; model: string; inputTokens: number; costUsd: number }
    | { ok: false; error: string }
  > {
    // Hybrid hashed bag: word unigrams+bigrams and character trigrams.
    // Word features give semantic-ish overlap; char trigrams catch syndication
    // truncation. Deterministic (FNV-1a), L2-normalized.
    const dims = 256;
    const vecs = inputs.map((text) => {
      const v = new Float64Array(dims);
      const addFeature = (feat: string, weight: number): void => {
        let h = 2166136261;
        for (let j = 0; j < feat.length; j++) {
          h ^= feat.charCodeAt(j);
          h = Math.imul(h, 16777619);
        }
        const vi = Math.abs(h) % dims;
        v[vi] = (v[vi] ?? 0) + weight;
      };
      const clean = ` ${text.toLowerCase().replaceAll(/[^a-z0-9\s]/g, " ").replaceAll(/\s+/g, " ").trim()} `;
      const words = clean.split(" ").filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        addFeature(`w:${words[i]}`, 1.4);
        if (i + 1 < words.length) addFeature(`b:${words[i]}_${words[i + 1]}`, 0.8);
      }
      for (let i = 0; i < clean.length - 2; i++) addFeature(`c:${clean.slice(i, i + 3)}`, 0.45);
      let norm = 0;
      for (let i = 0; i < dims; i++) norm += (v[i] ?? 0) ** 2;
      norm = Math.sqrt(norm) || 1;
      return Array.from(v, (x) => x / norm);
    });
    const inputTokens = estimateTokens(inputs.join("\n"));
    const p = priceFor("text-embedding-3-small");
    return {
      ok: true,
      vectors: vecs,
      model: "reasoner-hybrid-256",
      inputTokens,
      costUsd: (inputTokens / 1e6) * p.input,
    };
  }
}

/** Coarse sector guess when classify kept an event tag but no industry. */
function inferIndustryFromEventTag(
  tag: string | null,
  title = "",
  lead = "",
): string | null {
  if (!tag) return null;
  // Funding news is about the subject company — never stamp capital_markets.
  if (tag.startsWith("funding.")) {
    const zones = lowerZones(title, lead);
    const sectors = getIndustriesTaxonomy().sectors;
    const scored = sectors
      .map((sec) => ({ sec, score: scoreKeywordList(zones, sec.keywords) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.score > 0) return scored[0]!.sec.id;
    return "saas_enterprise";
  }
  if (tag.startsWith("mna.")) return "saas_enterprise";
  if (tag.startsWith("product.")) return "saas_enterprise";
  if (tag.startsWith("legal.")) return "legaltech";
  if (tag.startsWith("partnership.")) return "saas_enterprise";
  if (tag.startsWith("leadership.")) return "saas_enterprise";
  if (tag.startsWith("risk.")) return "saas_enterprise";
  if (tag.startsWith("expansion.")) return "saas_enterprise";
  return "saas_enterprise";
}

/** Publisher hosts are never candidate companies' own domains. */
function isPublisherHost(domain: string): boolean {
  return /^(www\.)?(techcrunch|venturebeat|theverge|businesswire|prnewswire|globenewswire|reuters|bloomberg|nytimes|wsj|bbc|cnbc|engadget|wired|forbes|bloomberg|slashdot)\./.test(
    domain,
  );
}

/** Parse the ENTITY CONTEXT block rendered by the enrichment pipeline. */
function parseEntityContext(user: string): EntityContext {
  const block = section(user, "ENTITY CONTEXT:", ["EVENT_TYPES", "TITLE:"]);
  if (!block) return {};
  const name = /= name ([^;\n]*)/.exec(block)?.[1]?.trim() || null;
  const industries = /= industries ([^;\n]*)/.exec(block)?.[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
  const country = /= country ([^;\n]*)/.exec(block)?.[1]?.trim() || null;
  const type = /= type ([^;\n]*)/.exec(block)?.[1]?.trim() || null;
  return { name, industries, country, type };
}
