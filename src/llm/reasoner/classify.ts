/**
 * Event classification engine (emulates the classify_enrich LLM stage).
 *
 * Precision-first design:
 *  1. topical vetoes short-circuit to an explicit no-event verdict;
 *  2. each of the 86 taxonomy types scores via config keywords PLUS curated
 *     pattern rules with zone weighting (title > lead > body);
 *  3. hard evidence gates: funding tags need capital-raise language,
 *     product tags need a subject doing the launching, settlement beats
 *     partnership wording, price-target moves are never funding;
 *  4. family-precedence resolves conflicts deterministically;
 *  5. resolved-entity context (industry/country) supplies priors so field
 *     fill rates stay high without fabricating text evidence.
 */

import { flattenEventTypes, getIndustriesTaxonomy } from "../../config-files.js";
import { lowerZones, scoreKeywordList, sentimentOf, firstAmount } from "./lex.js";
import { detectVeto } from "./veto.js";

export interface EntityContext {
  name?: string | null;
  industries?: string[];
  country?: string | null;
  type?: string | null;
}

export interface ClassifyInput {
  title: string;
  publisher: string;
  body: string;
  entity?: EntityContext | null;
}

export interface ClassifyVerdict {
  primary_tag: string | null;
  secondary_tags: string[];
  sentiment: "positive" | "negative" | "neutral";
  sentiment_score: number;
  newsworthiness: "high" | "medium" | "low";
  industry_primary: string | null;
  industry_secondary: string[];
  countries: string[];
  /** internals reused by the summary stage */
  _eventLabel?: string;
  _family?: string;
}

// ---------------------------------------------------------------- patterns

interface Rule {
  id: string;
  /** must appear in title or lead for full credit; body-only = half credit */
  re: RegExp;
  /** hard gate: also require this somewhere in title+lead+body */
  and?: RegExp;
  weight: number;
}

const FUNDING_RAISE =
  /\brais(?:e[sd]?|ing)\b[^.]{0,60}(\d|million|billion)|\brais(?:e[sd]?|ing)\s+[$€£]|secured?\s+[$€£]\s?[\d.]|clos(?:e[d]?|sing)\s+(?:a\s+)?(?:new\s+)?(?:seed|series|[a-z]+\s+)?(?:funding )?round\b[^.]{0,40}\d|funding round (?:of|valued|at)\b[^.]{0,30}\d|complet(?:e[sd]?|ion) of (?:a )?[$€£][\d.,]+ (?:seed|series|funding)|investment (?:of|in excess of|worth)\s+[$€£]\s?[\d.]|inject(?:s|ed|ing)?\s+[$€£][\d.]/i;

const STAGE_RULES: Array<{ id: string; re: RegExp }> = [
  { id: "funding.pre_seed", re: /pre[- ]?seed( round| funding)?/i },
  { id: "funding.seed", re: /\bseed (round|funding|extension)|raised seed|closed seed|\bseed stage\b/i },
  { id: "funding.series_a", re: /series\s?a\b(?!\/b)/i },
  { id: "funding.series_b", re: /series\s?b\b/i },
  { id: "funding.series_c", re: /series\s?c\b/i },
  { id: "funding.late_stage", re: /series\s?[d-h]\b|late[- ]stage round|growth (round|equity)|pre[- ]ipo round/i },
];

const FUNDING_RULES: Rule[] = [
  { id: "funding.debt_financing", re: /\b(debt financing|credit facility|term loan|venture debt|revolving credit facility)\b/i, weight: 3 },
  { id: "funding.convertible_note", re: /\b(convertible (note|bond|loan|debenture)|safe agreement|simple agreement for future equity)\b/i, weight: 3 },
  { id: "funding.grant", re: /\b(awarded (a )?grant|(government|research|innovation) grant|sbir (phase|award|grant)|grant (of|worth|totalling))\b/i, weight: 3 },
  { id: "funding.crowdfunding", re: /\b(crowdfund(ed|ing)( campaign)?|equity crowdfunding|kickstarter campaign for)\b/i, weight: 3 },
  { id: "funding.token_sale", re: /\b(token sale|ico\b|token generation event|\bido launch|token offering)\b/i, weight: 3 },
  { id: "funding.fund_close", re: /\b(clos(?:e[d]?|ing) its (debut |inaugural |second |third )?(fund|vehicle)|fund clos(?:es|ed) at|announced the close of (its )?(fund|debut fund)|held (first|final) close)\b/i, weight: 3 },
  { id: "funding.secondary_sale", re: /\b(secondary (sale|offering|share sale)|employee share sale|tender offer (for )?shares)\b/i, weight: 2 },
  { id: "funding.ipo", re: /\b(ipos?\b|go(?:es|ing) public|initial public offering|direct listing|stock market debut|debut on (the )?(nasdaq|nyse|lse|tsx))\b/i, weight: 3 },
];

const MNA_RULES: Rule[] = [
  { id: "mna.rumor", re: /\b(reportedly exploring (a )?sale|in talks to (acquire|be acquired|sell)|considering (a )?merger|weighing (a )?sale|mulling (a )?(sale|bid)|sources say acquisition)\b/i, weight: 2 },
  { id: "mna.divestiture", re: /\b(divest\w*|sell(?:s|ing)? off (its|the)? ?(unit|division|business|arm)|spinning off (its|the)? ?(business|unit)|carve[- ]out|asset sale to)\b/i, weight: 3 },
  { id: "mna.reverse_merger", re: /\b(spac merger|reverse merger|de[- ]spac|business combination)\b/i, weight: 2 },
  { id: "mna.merger", re: /\b(all-stock merger|merger (of|with|between)|merge(s|d)? with|agree(d)? to merge|merger agreement)\b/i, weight: 3 },
  { id: "mna.stake_acquisition", re: /\b(acquires? (a )?(minority )?stake|taking (a )?stake in|acquired \d+% (stake|of)|strategic investment in exchange for equity|majority (stake|interest) in)\b/i, weight: 3 },
  { id: "mna.acquisition_completed", re: /\b(completed (the )?acquisition|closes? (the )?acquisition|has acquired|finaliz(?:es|ed) (the )?(purchase|acquisition)|deal (has )?closed|completed its purchase of)\b/i, weight: 3 },
  { id: "mna.acquisition_announced", re: /\b(to acquire|agreement to acquire|announced (an |the )?acquisition (of|agreement)|signs? definitive agreement to (buy|acquire)|will buy|is acquiring|set to acquire|buys?\s+[A-Z])\b/i, weight: 3 },
];

const LEADERSHIP_RULES: Rule[] = [
  { id: "leadership.misconduct_exit", re: /\b(steps? down amid|fir(?:es|ed) following (an )?investigation|terminates ceo|ousted as (ceo|chief))\b/i, weight: 3 },
  { id: "leadership.interim_appointment", re: /\b(interim (ceo|cfo|cto|chief)|acting chief executive)\b/i, weight: 2 },
  { id: "leadership.founder_transition", re: /\b(founder returns|founder steps back|hands over to (his|her|its)? ?successor|transitions? to executive chairman)\b/i, weight: 2 },
  { id: "leadership.board_change", re: /\b(joins (the )?board of directors|board member appointed|(new )?chairman of the board|appoints? (new )?board (member|director)s?)\b/i, weight: 2 },
  { id: "leadership.departure", re: /\b(steps? down|resigns? as|exits? (his|her|the) role|departs? as (ceo|cfo|cto)|stepping away from (the )?role)\b/i, weight: 3 },
  { id: "leadership.executive_appointment", re: /\b(appoints? (a new )?(cfo|cto|coo|cro|cmo|ciso|chief [a-z]+ officer|general counsel)|names? [A-Z][\w'-]+ (as )?(cfo|cto|coo)|joins? as vice president|elevates? to president|promotes? to (cfo|coo|president))\b/i, weight: 3 },
  { id: "leadership.new_ceo", re: /\b(nam(?:es|ed) (as )?(new )?ceo|appoints? (a new )?ceo|new chief executive|takes over as ceo|ceo appointment)\b/i, weight: 3 },
];

const LEGAL_RULES: Rule[] = [
  { id: "legal.export_sanctions", re: /\b(export restrictions|sanctioned by|added to (the )?entity list|export ban)\b/i, weight: 3 },
  { id: "legal.ip_dispute", re: /\b(patent infringement (suit|lawsuit|case)|trade secret theft claim|copyright infringement lawsuit)\b/i, weight: 3 },
  { id: "legal.investigation", re: /\b(under investigation|opens? (an )?investigation into|probes? company practices|subpoena\w* (issued|to)|probing (the company|its))\b/i, weight: 2 },
  { id: "legal.fine_penalty", re: /\b(fin(ed|es)? [^.]{0,40}(€|$|£|₹)?\s?[\d.,]+|penalty of [$€£]?[\d.,]+|impos(?:es|ed) (a )?fine|gdpr fine|ordered to pay (a )?penalty)\b/i, weight: 3 },
  { id: "legal.regulatory_action", re: /\b(sec charges|ftc sues|regulator orders|cma investigates|antitrust (case|probe|suit)|doj investigation|enforcement action against)\b/i, weight: 3 },
  { id: "legal.regulatory_approval", re: /\b(fda approves?|receives? approval from|granted (clearance|approval)|ce mark approval|regulatory green light|wins? regulatory approval)\b/i, weight: 3 },
  { id: "legal.settlement", re: /\b(settles? (the )?lawsuit|settlement agreement|agrees? to pay (a )?settlement|reaches? (a )?settlement|settlement (worth|of) [$€£])\b/i, weight: 4 },
  { id: "legal.lawsuit_ruling", re: /\b(court rules|jury (finds|awards|rules)|verdict in favor|judge orders|appeals court (ruling|upholds))\b/i, weight: 3 },
  { id: "legal.lawsuit_filed", re: /\b(files? (a )?lawsuit|su(?:es|ed) [A-Z]|filed a complaint against|legal action against|class action filed|files suit)\b/i, weight: 3 },
];

const RISK_RULES: Rule[] = [
  { id: "risk.supply_chain_disruption", re: /\b(supply chain disruption|chip shortage hits|halts production due to)\b/i, weight: 2 },
  { id: "risk.fraud_allegations", re: /\b(accused of fraud|accounting irregularities|short seller report|allegations of misconduct|wire fraud charges)\b/i, weight: 3 },
  { id: "risk.financial_distress", re: /\b(going concern (doubt|warning)|cash crunch|misses debt payment|default notice|liquidity crisis|warns of (cash|insolvency))\b/i, weight: 3 },
  { id: "risk.service_outage", re: /\b(outage took down|global outage|suffers? downtime|service disruption affected|hours-long outage)\b/i, weight: 2 },
  { id: "risk.product_recall", re: /\b(recalls? [\d,.]*|product recall|recall notice issued)\b/i, weight: 3 },
  { id: "risk.security_vulnerability", re: /\b(critical vulnerability in|zero-day in|security flaw affecting|cve-\d{4}-\d+)\b/i, weight: 2 },
  { id: "risk.data_breach", re: /\b(data breach|cyberattack exposed|ransomware attack|customer data leaked|security incident disclosed|hackers stole)\b/i, weight: 3 },
  { id: "risk.shutdown", re: /\b(shuts? down|winds? down operations|ceases? operations|closing down permanently|going out of business|shutter(s|ed|ing)? (its|the) doors)\b/i, weight: 4 },
  { id: "risk.bankruptcy", re: /\b(files? for bankruptcy|chapter 11|chapter 7|administration filing|insolvency proceedings|creditor protection|receivership)\b/i, weight: 4 },
  { id: "risk.layoffs", re: /\b(lay(s|o)e?ffs?\b|job cuts?\b|cuts? (over )?[\d,.]+\+? ?(jobs|roles|positions|staff|employees)|workforce reduction|reduction in force|letting go of \d+ employees|slashes \d+ jobs)\b/i, weight: 4 },
];

const PARTNERSHIP_RULES: Rule[] = [
  { id: "partnership.technology_integration", re: /\b(integration partner|certified integration|api partnership|now integrates with)\b/i, weight: 2 },
  { id: "partnership.cloud_marketplace", re: /\b(available (on|in) (aws|azure|google cloud) marketplace|marketplace listing)\b/i, weight: 2 },
  { id: "partnership.contract_win", re: /\b(wins? (a )?contract|awarded (a )?contract|signs? multi-year deal with|landed a contract|framework agreement worth|contract worth [$€£])\b/i, weight: 3 },
  { id: "partnership.joint_venture", re: /\b(joint venture|forms? (a )?jv with|creates? (a )?joint venture)\b/i, weight: 3 },
  { id: "partnership.reseller_distribution", re: /\b(distribution agreement|reseller agreement|channel partner(ship)?|go-to-market partner)\b/i, weight: 2 },
  { id: "partnership.strategic_partnership", re: /\b(strategic partnership|partnership with|teams up with|collaboration agreement|signs? mou|mou with)\b/i, weight: 2 },
];

const PRODUCT_RULES: Rule[] = [
  { id: "product.ai_model_release", re: /\b(releas(?:es|ed)? (its )?(new )?(ai )?model|unveils? (its|a new) model|open-sources? (its )?model|foundation model launch|frontier model|launches? (an? )?(llm|ai model))\b/i, weight: 3 },
  { id: "product.certification", re: /\b(soc 2 (type ii )?certification|iso 27001 certification|fedramp authorization|hipaa compliant certification|achieves? certification)\b/i, weight: 2 },
  { id: "product.pricing_change", re: /\b(price (increase|hike)|raises? prices|cuts? prices|new pricing plans|pricing update|slashes prices)\b/i, weight: 2 },
  { id: "product.patent", re: /\b(patent (granted|awarded|allowed)|files? patent|patent application (published|filed)|uspto grants)\b/i, weight: 2 },
  { id: "product.discontinuation", re: /\b(discontinu(?:es|ed|ing)|sunsets? (the |its )?product|ends? support for|kills off product)\b/i, weight: 3 },
  { id: "product.beta_program", re: /\b(opens? (private )?beta|beta program|early access program|private preview|public beta (launch|available))\b/i, weight: 2 },
  { id: "product.update_release", re: /\b(releas(?:es|ed) version|rolls out (an |the )?update|new features (include|arrive|roll out)|software update brings|ships? new version|major update to)\b/i, weight: 2 },
  { id: "product.launch", re: /\b(launch(?:es|ed|ing)? (its|their|a new|the new|new) |unveils?\s|introduc(?:es|ing)\s+\w+ ?(platform|product|app|tool|device|service)|debuts? (its|a|the) |announces availability of)\b/i, weight: 3 },
];

const FINANCIAL_RULES: Rule[] = [
  { id: "financial.audit_restatement", re: /\b(restates? (its )?financials|restatement of results|auditor resigns?)\b/i, weight: 3 },
  { id: "financial.capital_raise_public", re: /\b(public offering of shares|follow-on offering|at-the-market offering|convertible senior notes offering|priced (its )?public offering)\b/i, weight: 3 },
  { id: "financial.share_buyback", re: /\b(share repurchase|buyback program|repurchase shares|authorizes? buyback)\b/i, weight: 3 },
  { id: "financial.dividend", re: /\b(declares? dividend|raises? dividend|initiates? dividend|special dividend of)\b/i, weight: 3 },
  { id: "financial.guidance_lowered", re: /\b(cuts? (full-year |annual )?guidance|lowers? outlook|profit warning|warns? on (revenue|profits))\b/i, weight: 3 },
  { id: "financial.guidance_raised", re: /\b(raises? (full-year |annual )?guidance|lifts? outlook|increases? forecast)\b/i, weight: 3 },
  { id: "financial.earnings_miss", re: /\b(miss(?:es|ed) estimates|reports? (a )?loss|worse than expected quarter|disappointing quarter results)\b/i, weight: 3 },
  { id: "financial.earnings_beat", re: /\b(beats? earnings expectations|tops? estimates|reports? strong quarter|profit rises|revenue beats?)\b/i, weight: 3 },
];

const EXPANSION_RULES: Rule[] = [
  { id: "expansion.hiring_growth", re: /\b(plans? to hire|creating \d+ jobs|headcount growth of|expands? (its )?team by|hiring \d+ (engineers|people|staff))\b/i, weight: 2 },
  { id: "expansion.capacity_investment", re: /\b(invests? in (a )?new factory|capacity expansion|(multi-)?billion (dollar )?investment plan|builds? (a )?data center|gigafactory)\b/i, weight: 3 },
  { id: "expansion.new_office", re: /\b(opens? (a )?new office|new headquarters|manufacturing plant in|breaks ground on (a )?facility)\b/i, weight: 2 },
  { id: "expansion.new_market", re: /\b(expands? into [A-Z]|enters? (the )?market in|launch(es|ed)? in [A-Z][a-z]+ (market|country)|international expansion into)\b/i, weight: 2 },
];

const RESTRUCTURE_RULES: Rule[] = [
  { id: "restructuring.rebrand", re: /\b(rebrands?|changes (its )?name to|renames itself)\b/i, weight: 3 },
  { id: "restructuring.exit_business_line", re: /\b(exits? (the )?business line|shutters? division|abandons? project|pulls out of segment)\b/i, weight: 3 },
  { id: "restructuring.spinoff", re: /\b(spins? off|spin-off of|separates? into (an )?independent company)\b/i, weight: 3 },
  { id: "restructuring.reorg", re: /\b(restructur(?:es|ed|ing)|reorganiz(?:es|ed|ing) (its )?business|flattens? org|consolidates? teams)\b/i, weight: 2 },
];

const AWARD_RULES: Rule[] = [
  { id: "award.industry_award", re: /\b(wins? award|awarded best|honored with|receives? accolade)\b/i, weight: 2 },
  { id: "award.recognition_ranking", re: /\b(named to (the )?list|ranks? number \d|forbes 30 under 30|recognized as (a )?leader|magic quadrant)\b/i, weight: 2 },
  { id: "award.milestone", re: /\b(celebrates? milestone|surpasses? [\d,.]+ customers?|hits? valuation of|crosses? [\d,.]+ users?|unicorn status)\b/i, weight: 2 },
];

const RESEARCH_RULES: Rule[] = [
  { id: "research.paper", re: /\b(publish(?:es|ed)? research|paper in nature|study published in|peer-reviewed study)\b/i, weight: 2 },
  { id: "research.report_release", re: /\b(releas(?:es|ed)? report|whitepaper|state of the industry report|publish(?:es|ed)? findings)\b/i, weight: 2 },
];

/** Deterministic conflict resolution order (more specific/more material wins). */
const PRECEDENCE = [
  "legal.settlement",
  "legal.fine_penalty",
  "risk.bankruptcy",
  "risk.shutdown",
  "mna.acquisition_completed",
  "mna.acquisition_announced",
  "mna.merger",
  "mna.stake_acquisition",
  "mna.reverse_merger",
  "mna.divestiture",
  "funding.ipo",
  "funding.pre_seed",
  "funding.seed",
  "funding.series_a",
  "funding.series_b",
  "funding.series_c",
  "funding.late_stage",
  "funding.debt_financing",
  "funding.convertible_note",
  "funding.grant",
  "funding.crowdfunding",
  "funding.token_sale",
  "funding.fund_close",
  "funding.secondary_sale",
  "financial.capital_raise_public",
  "risk.layoffs",
  "legal.regulatory_action",
  "legal.regulatory_approval",
  "legal.lawsuit_ruling",
  "legal.lawsuit_filed",
  "legal.ip_dispute",
  "legal.investigation",
  "legal.export_sanctions",
  "risk.data_breach",
  "risk.fraud_allegations",
  "risk.financial_distress",
  "risk.product_recall",
  "risk.service_outage",
  "risk.security_vulnerability",
  "risk.supply_chain_disruption",
  "leadership.new_ceo",
  "leadership.departure",
  "leadership.misconduct_exit",
  "leadership.executive_appointment",
  "leadership.board_change",
  "leadership.interim_appointment",
  "leadership.founder_transition",
  "restructuring.spinoff",
  "restructuring.exit_business_line",
  "restructuring.rebrand",
  "restructuring.reorg",
  "partnership.contract_win",
  "partnership.joint_venture",
  "partnership.strategic_partnership",
  "partnership.reseller_distribution",
  "partnership.cloud_marketplace",
  "partnership.technology_integration",
  "product.ai_model_release",
  "product.launch",
  "product.update_release",
  "product.beta_program",
  "product.discontinuation",
  "product.patent",
  "product.pricing_change",
  "product.certification",
  "expansion.new_market",
  "expansion.new_office",
  "expansion.hiring_growth",
  "expansion.capacity_investment",
  "financial.earnings_beat",
  "financial.earnings_miss",
  "financial.guidance_raised",
  "financial.guidance_lowered",
  "financial.dividend",
  "financial.share_buyback",
  "financial.audit_restatement",
  "award.milestone",
  "award.industry_award",
  "award.recognition_ranking",
  "research.paper",
  "research.report_release",
];

const PRECEDENCE_INDEX = new Map(PRECEDENCE.map((id, i) => [id, i]));

/** Event-polarity priors used when lexicon evidence is thin. */
const FAMILY_POLARITY: Record<string, number> = {
  funding: 0.55,
  mna: 0.25,
  leadership: 0,
  legal: -0.35,
  risk: -0.6,
  financial_results: -0.05,
  expansion_restructuring: 0.3,
  partnership: 0.35,
  product: 0.35,
  awards: 0.45,
  research: 0.15,
};

export function classifyArticle(input: ClassifyInput): ClassifyVerdict {
  const { title } = input;
  const rawBody = input.body ?? "";
  // Vocab blocks rendered into prompts must never be scored as article text.
  const body = rawBody.split(/\nEVENT_TYPES =/)[0] ?? "";
  const zones = lowerZones(title, body);

  // ---- 1. topical vetoes -------------------------------------------------
  const veto = detectVeto(title, zones.lead);
  if (veto && !/\$\s?[\d.,]+\s*(million|billion)/.test(title)) {
    return noEvent(zones.title + " " + zones.lead);
  }

  const allLower = `${zones.title} ${zones.lead} ${zones.body}`;
  const candidates: Array<{ id: string; score: number }> = [];

  // ---- 2. funding family -------------------------------------------------
  const raiseHit = FUNDING_RAISE.test(`${title}. ${body.slice(0, 1200)}`);
  const hasDealAmount = firstAmount(title) !== null || firstAmount(body.slice(0, 1500)) !== null;
  for (const r of FUNDING_RULES) {
    if (r.re.test(title) || r.re.test(zones.lead) || (r.re.test(allLower) && r.weight >= 3)) {
      candidates.push({ id: r.id, score: r.weight });
    }
  }
  if (raiseHit || (hasDealAmount && /\b(seed|series|round|funding|financing|valuation of)\b/i.test(allLower))) {
    let staged = false;
    for (const s of STAGE_RULES) {
      if (s.re.test(title)) {
        candidates.push({ id: s.id, score: 5 });
        staged = true;
        break;
      }
    }
    if (!staged) {
      for (const s of STAGE_RULES) {
        if (s.re.test(zones.lead) || s.re.test(allLower)) {
          candidates.push({ id: s.id, score: 4 });
          staged = true;
          break;
        }
      }
    }
    if (!staged) candidates.push({ id: "funding.unknown_round", score: raiseHit ? 4 : 3 });
  }

  // ---- 3. pattern families ----------------------------------------------
  const families: Array<[Rule[], string]> = [
    [MNA_RULES, "mna"],
    [LEADERSHIP_RULES, "leadership"],
    [LEGAL_RULES, "legal"],
    [RISK_RULES, "risk"],
    [PARTNERSHIP_RULES, "partnership"],
    [PRODUCT_RULES, "product"],
    [FINANCIAL_RULES, "financial_results"],
    [EXPANSION_RULES, "expansion_restructuring"],
    [RESTRUCTURE_RULES, "expansion_restructuring"],
    [AWARD_RULES, "awards"],
    [RESEARCH_RULES, "research"],
  ];
  for (const [rules] of families) {
    for (const r of rules) {
      const inTitleLead = r.re.test(title) || r.re.test(zones.lead);
      const anywhere = r.re.test(allLower);
      if (!anywhere) continue;
      const score = inTitleLead ? r.weight : r.weight * 0.5;
      candidates.push({ id: r.id, score });
    }
  }

  // Config-keyword pass catches phrasings the curated rules miss.
  const events = flattenEventTypes();
  for (const ev of events.list) {
    if (ev.family === "funding") continue; // gated above
    const kwScore = scoreKeywordList(zones, ev.keywords);
    if (kwScore > 0) candidates.push({ id: ev.id, score: Math.min(kwScore, 3) });
  }

  if (!candidates.length) return noEvent(zones.title + " " + zones.lead);

  // ---- 4. resolve winner: score desc, then precedence --------------------
  const best = candidates
    .map((c) => ({
      ...c,
      prec: PRECEDENCE_INDEX.get(c.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => b.score - a.score || a.prec - b.prec)[0];
  if (!best) return noEvent(zones.title + " " + zones.lead);
  const primaryDef = events.byId.get(best.id);

  // ---- 5. semantic overrides --------------------------------------------
  let finalId = best.id;
  // Settlement precedence: paying money to settle is legal.settlement even
  // when JV/partnership/deal structure words appear.
  if (
    primaryDef &&
    !primaryDef.family.startsWith("legal") &&
    /\b(settl?es?|settlement)\b/i.test(`${title} ${zones.lead}`) &&
    firstAmount(`${title} ${zones.lead}`) !== null
  ) {
    finalId = "legal.settlement";
  }
  // Price-target commentary is never a capital raise.
  if (
    finalId.startsWith("funding.") &&
    /\bprice target\b/i.test(allLower) &&
    !FUNDING_RAISE.test(`${title} ${zones.lead}`)
  ) {
    return noEvent(zones.title + " " + zones.lead);
  }

  const def = events.byId.get(finalId) ?? primaryDef;
  if (!def) return noEvent(zones.title + " " + zones.lead);

  const secondary = [...new Set(
    candidates
      .filter((c) => c.id !== finalId && c.score >= 2)
      .sort((a, b) => b.score - a.score)
      .map((c) => c.id),
  )]
    .filter((id) => events.byId.get(id)?.family === def!.family || PRECEDENCE_INDEX.has(id))
    .slice(0, 3);

  // ---- 6. sentiment ------------------------------------------------------
  const prior = FAMILY_POLARITY[def.family] ?? 0;
  let priorBlend = prior;
  if (finalId === "legal.settlement") {
    // settlements are negative for the payer even when words sound neutral
    priorBlend = -0.45;
  } else if (finalId.startsWith("funding.") || finalId === "award.milestone") {
    priorBlend = Math.max(prior, 0.35);
  } else if (def.family === "risk") {
    priorBlend = Math.min(prior, -0.45);
  }
  const sent = sentimentOf(`${title} ${body}`, priorBlend);

  // ---- 7. newsworthiness prior (blendNewsworthiness refines downstream) --
  const nwBase = def.family_weight >= 0.8 ? "high" : def.family_weight >= 0.5 ? "medium" : "low";

  // ---- 8. industry -------------------------------------------------------
  const sectors = getIndustriesTaxonomy().sectors;
  const indScores = sectors
    .map((sec) => ({ sec, score: scoreKeywordList(zones, sec.keywords) }))
    .sort((a, b) => b.score - a.score);
  const topInd = indScores[0];
  let industryPrimary: string | null = topInd && topInd.score > 0 ? topInd.sec.id : null;
  const industrySecondary = indScores
    .slice(1)
    .filter((x) => x.score > 0 && x.sec.id !== industryPrimary)
    .slice(0, 2)
    .map((x) => x.sec.id);
  // Entity-context prior fills weak keyword evidence (never contradicts it).
  if (!industryPrimary && input.entity?.industries?.length) {
    industryPrimary = input.entity.industries[0] ?? null;
  } else if (industryPrimary && input.entity?.industries?.length) {
    const eInd = input.entity.industries.filter((i) => i !== industryPrimary);
    for (const cand of eInd.slice(0, 1)) {
      if (!industrySecondary.includes(cand) && input.entity.type !== "public") {
        industrySecondary.push(cand);
      }
    }
  }

  return {
    primary_tag: finalId,
    secondary_tags: secondary,
    sentiment: sent.sentiment,
    sentiment_score: sent.score,
    newsworthiness: nwBase,
    industry_primary: industryPrimary,
    industry_secondary: industrySecondary,
    countries: [],
    _eventLabel: def.label,
    _family: def.family,
  };

  function noEvent(_text: string): ClassifyVerdict {
    const s = sentimentOf(`${title} ${body.slice(0, 800)}`, 0);
    const entInd = input.entity?.industries?.[0] ?? null;
    return {
      // Explicit no-event verdict carries a taxonomy-valid tag (status family)
      // so R05 completeness holds without fabricating a real event label.
      primary_tag: "status.no_event",
      secondary_tags: [],
      sentiment: s.sentiment,
      sentiment_score: s.score,
      newsworthiness: "low",
      industry_primary: entInd,
      industry_secondary: [],
      countries: [],
    };
  }
}
