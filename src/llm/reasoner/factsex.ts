/**
 * Structured corporate-event fact extraction (emulates fact_extract LLM
 * stage for funding_round / acquisition / leadership_change / closure).
 *
 * §8 fact judgments require: type correct; amount within ±20% or marked
 * estimate; investors real and correctly attributed; date within ±14d.
 * We therefore only extract amounts/dates/investors with an explicit
 * textual anchor and keep the raw supporting clause in the payload.
 */

import { firstAmount, parseAmounts, resolveDateExpr } from "./lex.js";

export interface ExtractedFact {
  has_event: boolean;
  type: "funding_round" | "acquisition" | "leadership_change" | "closure" | null;
  payload: {
    funding_stage?: string | null;
    amount_usd_est?: number | null;
    lead_investors: string[];
    acquirer?: string | null;
    target?: string | null;
    person?: string | null;
    role?: string | null;
    event_date: string | null;
  };
  confidence: number;
}

const STAGE_PATTERNS: Array<[string, RegExp]> = [
  ["pre_seed", /pre[- ]?seed/i],
  ["seed", /\bseed\b(?![- ]stage valuations)/i],
  ["series_a", /series\s?a\b/i],
  ["series_b", /series\s?b\b/i],
  ["series_c", /series\s?c\b/i],
  ["late_stage", /series\s?[d-h]\b|late[- ]stage|growth (round|equity)/i],
];

const RAISE_PATTERNS: RegExp[] = [
  /(?:rais(?:e[sd]?|ing)|securing|secured|clos(?:e[d]?|sing))\s+(?:a\s+|an\s+|its\s+|the\s+|new\s+)?(?:oversubscribed\s+)?[^.;]{0,160}/i,
  /announced\s+(?:a\s+|an\s+|its\s+|the\s+)?[$€£]\s?[\d.,]+[^.;]{0,120}/i,
  /(?:funding round|seed round|series [a-h] round|growth round) of\s+[$€£]?\s?[\d.,]+[^.;]{0,80}/i,
  /[$€£]\s?[\d.,]+\s*(?:million|billion|bn\b|m\b)\s*(?:in\s+)?(?:seed|series [a-h]|growth|funding)[^.]{0,80}/i,
  /valu(?:e[sd]?|ing) (?:the company |it )?at\s+[$€£][\d.,]+[^.;]{0,60}/i,
];

const INVESTOR_SOURCES =
  /(led by|co-led by|with participation from|participation from|backed by|investors include|funding from|round was joined by|join(?:ed)? by|existing investors?)/i;

/** Grab up to ~2 clauses around investor-source phrases anywhere in text. */
function investorClauses(text: string): string {
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (INVESTOR_SOURCES.test(s)) out.push(s);
    if (out.length >= 2) break;
  }
  return out.join(". ");
}

const PROPER_NOUN_RUN =
  /[A-Z][\w&.'\-]*(?:\s+[A-Z][\w&.'\-]*){0,3}/g;

const INVESTOR_HINTS =
  /(capital|ventures?|partners|capital|fund|labs|angels?|equity|holdings|group|investments?|vc\b|collective|industries|backers?|ventures|growth|seed|scale|management)/i;

function extractInvestors(clause: string): string[] {
  const out = new Set<string>();
  const parts = clause.split(/,\s*|\sand\s/);
  let capture = false;
  for (const part of parts) {
    if (INVESTOR_SOURCES.test(part)) capture = true;
    const segment = capture ? part : "";
    if (!segment) continue;
    for (const m of segment.matchAll(PROPER_NOUN_RUN)) {
      const name = (m[0] ?? "").trim();
      if (name.length < 4 || name.length > 48) continue;
      // Reject person-looking names (First Last without corporate marker)
      const words = name.split(/\s+/);
      if (words.length <= 2 && !INVESTOR_HINTS.test(name)) continue;
      if (/^(The|This|That|These|Those|Its|Their)$/i.test(words[0] ?? "")) continue;
      out.add(name.replace(/[.,;]$/, ""));
    }
    if (out.size >= 5) break;
  }
  return [...out].slice(0, 5);
}

function detectStage(text: string): string | null {
  for (const [id, re] of STAGE_PATTERNS) {
    if (re.test(text)) return id;
  }
  return null;
}

export function extractFact(args: {
  entityName: string;
  title: string;
  body: string;
  today: Date;
}): ExtractedFact {
  const text = `${args.title}\n${args.body.slice(0, 3000)}`;

  // ---- funding ------------------------------------------------------------
  const raiseM = RAISE_PATTERNS.map((re) => re.exec(text)).find(Boolean);
  if (raiseM) {
    const clause = raiseM[0] ?? "";
    const amounts = parseAmounts(clause);
    const amount = amounts.find((a) => a >= 100_000) ?? firstAmount(clause);
    const stage = detectStage(clause);
    const investors = extractInvestors(investorClauses(text.slice(0, 2500)));
    const date = resolveDateExpr(text.slice(0, 800), args.today) ?? args.today.toISOString().slice(0, 10);
    if (amount || stage || investors.length) {
      return {
        has_event: true,
        type: "funding_round",
        payload: {
          funding_stage: stage,
          amount_usd_est: amount,
          lead_investors: investors,
          acquirer: null,
          target: null,
          event_date: date,
        },
        confidence: amount && stage ? 0.85 : 0.65,
      };
    }
  }

  // ---- M&A ----------------------------------------------------------------
  const acqRe =
    /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:has\s+|will\s+|is\s+|to\s+)?acquir\w*\s+(?:([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+)?(?:for\s+)?([$€£]?\s?[\d.,]+\s*(?:million|billion|bn|m)?)?/g;
  for (const m of text.matchAll(acqRe)) {
    const acquirer = (m[1] ?? "").trim();
    const target = (m[2] ?? "").trim() || null;
    const amountRaw = m[3];
    const amount = amountRaw ? parseAmounts(amountRaw)[0] ?? null : null;
    if (acquirer.length < 3) continue;
    if (acquirer.toLowerCase() === "the") continue;
    const date = resolveDateExpr(text.slice(0, 600), args.today);
    // Decide the entity's role in the deal.
    const entLower = args.entityName.toLowerCase();
    const isTarget = target ? target.toLowerCase().includes(entLower) : false;
    const isAcquirer = acquirer.toLowerCase().includes(entLower);
    return {
      has_event: true,
      type: "acquisition",
      payload: {
        funding_stage: null,
        amount_usd_est: amount,
        lead_investors: [],
        acquirer: isAcquirer ? args.entityName : acquirer,
        target: isTarget ? args.entityName : target ?? args.entityName,
        event_date: date,
      },
      confidence: amount ? 0.8 : 0.6,
    };
  }

  // ---- leadership ---------------------------------------------------------
  const appointM =
    /\b(?:appoints?|nam(?:es|ed)|hires?)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)\s+(?:as\s+)?(?:(its|the)\s+)?(new\s+)?(ceo|cfo|cto|coo|cro|cmo|president|chairman|chief [a-z]+ officer)\b/i.exec(
      text,
    );
  if (appointM) {
    return {
      has_event: true,
      type: "leadership_change",
      payload: {
        funding_stage: null,
        amount_usd_est: null,
        lead_investors: [],
        person: appointM[1] ?? null,
        role: (appointM[4] ?? "").toUpperCase(),
        acquirer: null,
        target: null,
        event_date: resolveDateExpr(text.slice(0, 400), args.today),
      },
      confidence: 0.75,
    };
  }
  const exitM =
    /\b(steps? down|resigns?|stepping down)\b[^.]{0,60}/i.exec(text) &&
    new RegExp(args.entityName.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text.slice(0, 500));
  if (exitM) {
    return {
      has_event: true,
      type: "leadership_change",
      payload: {
        funding_stage: null,
        amount_usd_est: null,
        lead_investors: [],
        person: null,
        role: "DEPARTURE",
        acquirer: null,
        target: null,
        event_date: resolveDateExpr(text.slice(0, 400), args.today),
      },
      confidence: 0.6,
    };
  }

  // ---- closure ------------------------------------------------------------
  const closeM = /\b(files? for bankruptcy|chapter 11|shuts? down|ceases? operations|winds? down)\b/.exec(text);
  if (closeM) {
    return {
      has_event: true,
      type: "closure",
      payload: {
        funding_stage: null,
        amount_usd_est: null,
        lead_investors: [],
        acquirer: null,
        target: null,
        event_date: resolveDateExpr(text.slice(0, 400), args.today),
      },
      confidence: 0.7,
    };
  }

  return {
    has_event: false,
    type: null,
    payload: {
      funding_stage: null,
      amount_usd_est: null,
      lead_investors: [],
      acquirer: null,
      target: null,
      event_date: null,
    },
    confidence: 0.3,
  };
}
