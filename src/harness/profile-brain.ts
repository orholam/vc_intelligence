import type { ProfileSectionId } from "../config-files.js";
import { getIndustriesTaxonomy } from "../config-files.js";
import { minimalSectionPayload } from "../api/contracts-enrichment.js";
import { scoreKeywordList, lowerZones } from "../llm/reasoner/lex.js";
import { cleanCrawlText, isFundingHeadline, isHeroSpam } from "./profile-quality.js";

/**
 * Evidence-driven company_profile answers for harness mode (no hosted key).
 * Each section is filled from distinct evidence slices — never paste the same
 * homepage hero into product, GTM, technology, and firmographics.
 */
export function answerProfileClaim(user: string): { sections: Record<string, unknown> } {
  const name = /^COMPANY:\s*(.+?)\s*\(/m.exec(user)?.[1]?.trim() ?? null;
  const domainRaw = /^COMPANY:.*\(([^)]*)\)/m.exec(user)?.[1]?.trim() ?? "";
  const website = domainRaw && domainRaw !== "unknown" ? domainRaw : null;

  const sectionLine = /Build ONLY these sections:\s*(.+)/.exec(user)?.[1] ?? "";
  const requested = sectionLine
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ProfileSectionId[];

  const evidence = extractEvidence(user);
  const entityCtx = parseEntityBlock(user);
  const sections: Record<string, unknown> = {};

  for (const section of requested) {
    sections[section] = buildSection(section, { name, website, entityCtx }, evidence);
  }
  return { sections };
}

interface EntityCtx {
  industryTags: string[];
  fundingStage: string | null;
  country: string | null;
}

interface Evidence {
  news: Array<{ date: string; publisher: string; title: string; body: string; url: string }>;
  web: Array<{ url: string; text: string }>;
  facts: Array<{ type: string; payload: string }>;
}

function parseEntityBlock(user: string): EntityCtx {
  const m = /\[entity\]\s*([^\n]+)/.exec(user);
  if (!m) return { industryTags: [], fundingStage: null, country: null };
  const line = m[1];
  const tags = /industry_tags=([^;]+)/.exec(line)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const fundingStage = /funding_stage=([^;]+)/.exec(line)?.[1]?.trim() ?? null;
  const country = /country=([^;]+)/.exec(line)?.[1]?.trim() ?? null;
  return { industryTags: tags, fundingStage, country };
}

function extractEvidence(user: string): Evidence {
  const news: Evidence["news"] = [];
  const web: Evidence["web"] = [];
  const facts: Evidence["facts"] = [];

  const newsRe =
    /\[news\]\s*(\d{4}-\d{2}-\d{2})\s+([^\s—]+)\s*—\s*([^\n]+)\n([\s\S]*?)(?=\n\[|\nEVIDENCE|\nALLOWED|$)/g;
  let m: RegExpExecArray | null;
  while ((m = newsRe.exec(user))) {
    const titleLine = m[3]?.trim() ?? "";
    const urlMatch = /\((https?:\/\/[^)]+)\)\s*$/.exec(titleLine);
    const title = urlMatch ? titleLine.slice(0, urlMatch.index).trim() : titleLine;
    news.push({
      date: m[1] ?? "",
      publisher: m[2] ?? "",
      title,
      body: (m[4] ?? "").trim(),
      url: urlMatch?.[1] ?? "",
    });
  }

  const webRe = /\[web\]\s*(https?:\/\/[^\n]+)\n([\s\S]*?)(?=\n\[|\nEVIDENCE|\nALLOWED|$)/g;
  while ((m = webRe.exec(user))) {
    web.push({ url: m[1]?.trim() ?? "", text: cleanCrawlText(m[2] ?? "") });
  }

  const factRe = /\[fact:([^\]]+)\]\s*(\{[\s\S]*?\})/g;
  while ((m = factRe.exec(user))) {
    facts.push({ type: m[1] ?? "", payload: m[2] ?? "" });
  }

  return { news, web, facts };
}

function firstSentences(text: string, max = 2): string {
  const t = stripLeadingSlogans(text.replace(/\s+/g, " ").trim());
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(" ").slice(0, 500);
}

/** Drop glued homepage eye-catchers before the real company sentence. */
function stripLeadingSlogans(text: string): string {
  return text
    .replace(/^(Applied AI for the enterprise[.!]?\s*)+/i, "")
    .replace(/^(Trusted by leading enterprises[^.!?]*[.!]?\s*)+/i, "")
    .replace(/^(Solving the problems that move the business[.!]?\s*)+/i, "")
    .trim();
}

/** Company what-they-do blurb from a funding article (strip the raise clause). */
function productBlurbFromNews(text: string): string | null {
  if (!text.trim()) return null;
  const cleaned = firstSentences(text, 2);
  if (!cleaned || isHeroSpam(cleaned)) return null;
  const beforeRaise = cleaned.split(/\b(?:has\s+)?(?:raised|raises|secured|closed)\b/i)[0]?.trim() ?? "";
  if (beforeRaise.length > 28) {
    return `${beforeRaise.replace(/[,\s;:]+$/, "")}.`;
  }
  return isFundingHeadline(cleaned) ? null : cleaned;
}

function productNews(ev: Evidence): Evidence["news"] {
  return ev.news.filter((n) => !isFundingHeadline(n.title));
}

function fundingNews(ev: Evidence): Evidence["news"] {
  return ev.news.filter((n) =>
    isFundingHeadline(n.title) ||
    /raised|raises|funding|series [a-e]|seed round|million|valuation/i.test(`${n.title} ${n.body}`),
  );
}

function inferIndustries(corpus: string, entityTags: string[]): { primary: string; keywords: string[] } {
  const zones = lowerZones("", corpus.slice(0, 4000));
  const sectors = getIndustriesTaxonomy().sectors;
  const scored = sectors
    .map((sec) => ({ sec, score: scoreKeywordList(zones, sec.keywords) }))
    .sort((a, b) => b.score - a.score);

  // Subject-company signals beat incidental words ("workforce" ≠ healthcare).
  const SUBJECT_SIGNALS: Array<{ id: string; re: RegExp; weight: number }> = [
    { id: "cybersecurity", re: /\b(fraud prevention|identity verification|background screen|credential verif|synthetic identity|deepfake)\b/i, weight: 6 },
    { id: "hrtech", re: /\b(workforce|hr tech|hiring|payroll|recruiting|employee monitor)\b/i, weight: 5 },
    { id: "legaltech", re: /\b(compliance|regtech|background check|credential)\b/i, weight: 4 },
    { id: "saas_enterprise", re: /\b(enterprise saas|b2b platform|workflow software)\b/i, weight: 3 },
    { id: "ai_ml", re: /\b(artificial intelligence|machine learning|generative ai|ai-powered)\b/i, weight: 4 },
  ];
  let bestId = scored[0]?.score > 0 ? scored[0].sec.id : "saas_enterprise";
  let bestScore = scored[0]?.score ?? 0;
  for (const sig of SUBJECT_SIGNALS) {
    if (sig.re.test(corpus)) {
      const adj = sig.weight;
      if (adj > bestScore) {
        bestScore = adj;
        bestId = sig.id;
      }
    }
  }
  if (entityTags.length && !entityTags.includes("unclassified")) {
    bestId = entityTags[0]!;
  }
  const keywords = scored
    .filter((s) => s.score > 0)
    .slice(0, 5)
    .map((s) => s.sec.label.toLowerCase());
  return { primary: bestId, keywords };
}

function parseFunding(text: string): {
  stage: string | null;
  amountUsd: number | null;
  roundLabel: string | null;
} {
  const series = text.match(/\bseries\s+([a-e])\b/i);
  const seed = /\bseed\s+(round|funding)\b/i.test(text);
  const raised =
    text.match(/\brais(?:e[sd]?|ing)\s+\$?\s*([\d.]+)\s*(million|billion|m|b)\b/i) ??
    text.match(/\$\s*([\d.]+)\s*(million|billion|m|b)\b/i) ??
    text.match(/\$?([\d.]+)\s*(million|billion|m|b)\s+(in\s+)?(funding|round)/i);
  let amountUsd: number | null = null;
  if (raised) {
    const n = Number(raised[1]);
    const unit = raised[2].toLowerCase();
    amountUsd = unit.startsWith("b") ? n * 1e9 : n * 1e6;
  }
  let stage: string | null = null;
  let roundLabel: string | null = null;
  if (series) {
    stage = `series_${series[1]!.toLowerCase()}`;
    roundLabel = `Series ${series[1]!.toUpperCase()}`;
  } else if (seed) {
    stage = "seed";
    roundLabel = "Seed";
  }
  return { stage, amountUsd, roundLabel };
}

function extractProductLines(webText: string): string[] {
  const lines = webText
    .split(/(?<=[.!?])\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 20 && l.length < 200);
  return lines
    .filter((l) => /\b(screen|monitor|verify|prevent|platform|solution|software|API|integration)\b/i.test(l))
    .slice(0, 5);
}

function buildSection(
  section: ProfileSectionId,
  ctx: { name: string | null; website: string | null; entityCtx: EntityCtx },
  ev: Evidence,
): Record<string, unknown> {
  const base = minimalSectionPayload(section, ctx);
  const webAbout = cleanCrawlText(
    ev.web.find((w) => /\/about/i.test(w.url))?.text ??
      ev.web.find((w) => /\/$|\.com\/?$/i.test(w.url))?.text ??
      ev.web[0]?.text ??
      "",
  );
  const newsProduct = productNews(ev);
  const newsFunding = fundingNews(ev);
  const corpus = [webAbout, ...ev.news.map((n) => `${n.title} ${n.body}`)].join("\n");
  const { primary: industryId, keywords } = inferIndustries(corpus, ctx.entityCtx.industryTags);

  switch (section) {
    case "firmographic": {
      const fromWeb = webAbout.length > 80 ? firstSentences(webAbout, 3) : "";
      const newsLead =
        newsFunding[0]?.body ||
        newsFunding[0]?.title ||
        newsProduct[0]?.body ||
        newsProduct[0]?.title ||
        "";
      const fromNews = firstSentences(newsLead || "", 3);
      // News prose beats homepage hero mush when available.
      const newsBeatsWeb =
        !!fromNews &&
        (/raised|raises|is an?\b|platform|company|startup/i.test(fromNews) ||
          isHeroSpam(fromWeb) ||
          !fromWeb ||
          fromWeb.length < 60);
      const desc = newsBeatsWeb
        ? fromNews
        : fromWeb && !isHeroSpam(fromWeb)
          ? fromWeb
          : fromNews || fromWeb || null;
      const short = desc ? firstSentences(desc, 1) : null;
      const founded = corpus.match(/\bfounded\s+(?:in\s+)?(\d{4})\b/i)?.[1];
      const publicCo = /\b(public company|nasdaq|nyse|listed on)\b/i.test(corpus);
      const acquired = /\bacquired by\b/i.test(corpus);
      const raised = newsFunding.length > 0 || parseFunding(corpus).amountUsd;
      return {
        ...base,
        name: ctx.name,
        legal_name: ctx.name,
        website: ctx.website ? `https://${ctx.website}` : null,
        company_type: publicCo ? "Public" : "Private",
        founded_year: founded ? Number(founded) : null,
        company_description: desc || null,
        company_description_short: short || null,
        operating_status: acquired
          ? { code: "acquired", label: "Acquired" }
          : { code: "operating", label: "Operating" },
        ownership_category: publicCo
          ? { code: "public", label: "Public" }
          : raised
            ? { code: "venture_backed", label: "Venture backed" }
            : { code: "private", label: "Private" },
      };
    }

    case "product_offering": {
      const productLines = extractProductLines(webAbout).filter((l) => !isHeroSpam(l));
      const webProse = webAbout ? firstSentences(webAbout, 2) : "";
      const webCore = webProse && !isHeroSpam(webProse) ? firstSentences(webProse, 1) : null;
      const newsBlurb = productBlurbFromNews(
        newsProduct[0]?.body ||
          newsProduct[0]?.title ||
          newsFunding[0]?.body ||
          newsFunding[0]?.title ||
          "",
      );
      const core = productLines[0] ?? webCore ?? newsBlurb;
      const launches = newsProduct
        .filter((n) => /launch|unveil|introduc|release|new\b/i.test(n.title))
        .slice(0, 4);
      return {
        ...base,
        core_offering: core,
        product_overview: webCore ? firstSentences(webProse, 2) : newsBlurb,
        differentiator: productLines[1] ?? null,
        product_and_service: [
          ...productLines.slice(0, 3).map((line) => ({
            name: firstSentences(line, 1).slice(0, 80),
            description: line,
            category: null,
            url: null,
            image_url: null,
            source: ctx.website ? [`https://${ctx.website}`] : [],
          })),
          ...launches.map((n) => ({
            name: n.title.slice(0, 120),
            description: n.body.slice(0, 300) || null,
            category: null,
            url: n.url || null,
            image_url: null,
            source: n.url ? [n.url] : [n.publisher],
          })),
        ].slice(0, 6),
      };
    }

    case "funding_detail": {
      const hay = newsFunding.map((n) => `${n.title} ${n.body}`).join("\n") + "\n" + corpus;
      const parsed = parseFunding(hay);
      const rounds = newsFunding.slice(0, 3).map((n) => {
        const p = parseFunding(`${n.title} ${n.body}`);
        const [y, mo, d] = n.date.split("-").map(Number);
        return {
          round: p.roundLabel
            ? { code: p.stage ?? "unknown_round", label: p.roundLabel }
            : p.amountUsd
              ? { code: "unknown_round", label: "Growth round" }
              : null,
          amount_usd: p.amountUsd,
          date: { day: d, month: mo, year: y },
          pre_money_valuation: null,
          investors: [],
          total_investors: 0,
          id: null,
          news: [{ publisher: n.publisher, title: n.title, url: n.url }],
        };
      });
      const stageCode = parsed.stage ?? ctx.entityCtx.fundingStage ?? "unknown_round";
      const stageLabel =
        parsed.roundLabel ??
        (stageCode === "unknown" || stageCode === "unknown_round" ? "Growth round" : stageCode);
      return {
        funding_overview: {
          funding_stage: { code: stageCode, label: stageLabel },
          last_funding_date: rounds[0]?.date ?? null,
          total_funding_usd: parsed.amountUsd ?? rounds[0]?.amount_usd ?? null,
        },
        funding_rounds: rounds,
        investors: [],
      };
    }

    case "location": {
      const us =
        ctx.entityCtx.country === "US" ||
        /\b(US|United States|America)\b/i.test(corpus) ||
        /\.com\b/.test(ctx.website ?? "");
      return {
        hq: us ? { city: null, country: "USA", region: "North America" } : null,
        market_served: { is_global: /\bglobal\b/i.test(corpus), markets: [] },
        offices: [],
      };
    }

    case "customer_profile": {
      const icpHint = /\b(enterprise|employers?|hr teams?|businesses|developers|consumers)\b/i.exec(corpus);
      const useCase = newsProduct[0]?.body ? firstSentences(newsProduct[0].body, 2) : null;
      return {
        segment: icpHint
          ? [
              {
                title: icpHint[0],
                description: useCase,
                type: /\bB2B\b/i.test(corpus) ? "B2B" : "B2C",
                source: [],
              },
            ]
          : [],
        icp: icpHint
          ? [
              {
                profile: `Organizations needing ${firstSentences(webAbout || corpus, 1)}`,
                target_buyer: icpHint[0],
                buyer_persona: null,
                firmographic_size: null,
                geography: ctx.entityCtx.country ?? null,
                industry_vertical: industryId,
                pain_points: [],
                primary_use_case: useCase,
                purchase_trigger: null,
                source: [],
              },
            ]
          : [],
      };
    }

    case "business_model": {
      const gtm = /\bB2B\b/i.test(corpus) ? "B2B" : /\bB2C\b/i.test(corpus) ? "B2C" : "B2B";
      const motion = webAbout
        ? firstSentences(webAbout, 1)
        : firstSentences(newsProduct[0]?.body ?? "", 1);
      const revenueHint = /\b(subscription|saas|per-seat|usage-based|enterprise license)\b/i.exec(corpus);
      return {
        gtm_type: gtm,
        gtm_motion: motion ? [{ description: motion, type: gtm, source: [] }] : [],
        revenue_model: revenueHint
          ? [{ title: revenueHint[0], description: motion, type: revenueHint[0].toLowerCase(), source: [] }]
          : [{ title: "Software revenue", description: motion, type: "subscription", source: [] }],
        marketing_channels: [],
        distribution_channels: [],
        cost_components: [],
        pricing_details: [],
      };
    }

    case "technology": {
      const ai = /\b(AI|artificial intelligence|machine learning|deepfake|synthetic identity)\b/i.test(corpus);
      const caps = extractProductLines(webAbout).filter((l) =>
        /\b(AI|API|monitor|verify|screen|fraud|identity)\b/i.test(l),
      );
      return {
        is_technology_focussed: true,
        api_detail: /\bAPI\b/i.test(corpus)
          ? { has_api: true, has_mcp: null, docs_url: null, sdk_language: [], description: caps[0] ?? null }
          : null,
        integration: [],
        ai_capability: ai
          ? caps.slice(0, 3).map((c) => ({ type: "AI", description: c, source: [] }))
          : [],
        ai_maturity: null,
        app_detail: null,
        feature: caps.slice(0, 4).map((c) => ({ name: firstSentences(c, 1).slice(0, 60), description: c, source: [] })),
      };
    }

    case "industry": {
      const sec = getIndustriesTaxonomy().sectors.find((s) => s.id === industryId);
      return {
        keyword: keywords,
        industry: [{ code: industryId.slice(0, 8), label: sec?.label ?? industryId, is_primary: true }],
        naics: [],
        sic: [],
      };
    }

    case "mna_and_investment": {
      const mnaNews = ev.news.filter((n) => /acqui|merger|buy|purchase/i.test(`${n.title} ${n.body}`));
      return {
        mna: mnaNews.slice(0, 2).map((n) => ({
          acquiree: {
            name: ctx.name ?? n.title,
            uuid: null,
            website: ctx.website ? `https://${ctx.website}` : null,
          },
          acquisition_type: { code: "acquisition", label: "Acquisition" },
          announced_date: (() => {
            const [y, mo, d] = n.date.split("-").map(Number);
            return { day: d, month: mo, year: y };
          })(),
          completed_date: null,
          amount_usd: null,
          status: "pending",
          id: null,
          news: [{ publisher: n.publisher, title: n.title, url: n.url }],
        })),
        investment: [],
      };
    }

    case "management_profile":
      return base;

    default:
      return base;
  }
}
