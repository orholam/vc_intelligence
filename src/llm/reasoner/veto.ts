/**
 * Topical veto classes for the offline reasoning engine (B4/B1 support):
 * non-mission content must be rejected with a SPECIFIC, auditable reason so
 * the discard-reason distribution stays diverse and spot-samplable (§8/B4).
 * Ordered by specificity; first match wins. A strong business signal in the
 * title rescues borderline cases (press releases about layoffs carry slop-ish
 * words but are real events).
 */

export interface Veto {
  /** machine-readable class used as discard/enrichment reason */
  cls: string;
  reason: string;
}

const RULES: Array<{ cls: string; re: RegExp; rescue?: RegExp }> = [
  {
    cls: "jobs_content",
    re: /(we'?re hiring|is hiring|job opening|apply now|apply today|careers? page|view all jobs|join our team|position available|now recruiting)/i,
    rescue: /(layoff|job cuts|workforce reduction|hiring freeze|cuts \d+)/i,
  },
  {
    cls: "events_roundups",
    re: /(webinar[:\s]|podcast episode|newsletter[:\s]|weekly roundup|this week in|top \d+ (startups|companies|apps|tools|ways|tips)|sponsored (post|content)|events calendar|upcoming events|save the date|conference preview|agenda revealed|\blisticle\b|gift guide)/i,
    rescue: /(rais(e[sd]?|ing) \$|acquir\w+|merger|ipo\b|bankrupt|files for)/i,
  },
  {
    cls: "personal_finance",
    re: /(mutual fund sip|sip amount|retirement corpus|epf\b|ppf\b|fcnr\b|nri (talk|guide)|how to save|credit score tips|best credit cards|mortgage rates today|refinance now|student loan forgiveness|401\(k\)|compound interest explained|money market account|high[- ]yield savings)/i,
    rescue: /(\$\s?[\d.,]+\s*(million|billion)|series [a-f]\b|acquir\w+)/i,
  },
  {
    cls: "retail_promo",
    re: /(\d+% off|nearly \d+% off|today-only|deal of the day|on sale (now|today)|yes, you should buy|best .* deals|limited[- ]time (deal|offer)|shop now|discount code)/i,
    rescue: /(rais(e[sd]?|ing) \$|acquir\w+|merger|ipo\b|bankrupt)/i,
  },
  {
    cls: "product_rumor",
    re: /(may get (powerful )?new features|could (soon )?get|reveals? what to expect|rumor mill|expected to (launch|unveil)|leaked specs|ios \d+ reveals)/i,
    rescue: /(rais(e[sd]?|ing) \$|acquir\w+|merger|ipo filed|goes public)/i,
  },
  {
    cls: "markets_commentary",
    re: /(stocks to (watch|buy|sell)|share price target|price target (raised|lowered|cut)|brokerage (raises|cuts|initiates)|etmarkets|sensex|nifty \d+|dow jones (closes|rises|falls)|wall street (week|close)|market wrap|earnings calendar|trading halt|penny stocks|stock splits? explained|premarket (trade|move)s?|sales pitch|opinion could make sense|could make sense for)/i,
    rescue: /(rais(e[sd]?|ing) \$|funding round|acquir\w+|merger|ipo filed|goes public)/i,
  },
  {
    cls: "sports",
    re: /(match report|injured list|box score|power rankings|playoff (picture|berth|seed)|season opener|grand slam|touchdown|goalless|man of the match|transfer window|free agency signing|mvp\b|league table|fixtures? results|beat \w+ \d+-\d+|wins? \d+-\d+ (against|over))/i,
    rescue: /(stadium naming|sponsorship worth|franchise valuation|acquir\w+|merger|rais(e[sd]?|ing) \$)/i,
  },
  {
    cls: "entertainment",
    re: /(red carpet|box office|oscars?|grammys?|emmys?|\bactor\b|\bactress\b|celebrity|dating|breakup|feud|sitcom|reality show|talk show|trailer\b|premiere(d|s)?\b.*\b(film|movie|series)|season \d+ (premiere|finale|returns)|new episodes|streaming series|interview:\s)/i,
    rescue: STRONG_DEAL_RE(),
  },
  {
    cls: "opinion_explainer",
    re: /(^(opinion|analysis|commentary):|\bwhat (is|are) [a-z].{3,60}(explained|\?)|\bevergreen\b|history of (the )?\w+ industry|beginner'?s guide|ultimate guide to|\bwhy (you|everyone) should)/i,
    rescue: STRONG_DEAL_RE(),
  },
  {
    cls: "obituary_crime_local",
    re: /(obituary|passed away (peacefully|at home)|charged with murder|car crash killed|house fire|weather forecast|storm warning|road closure|school district (vote|calendar))\b/i,
    rescue: /(company|corp|inc\.|ltd).{0,30}(acquir|merger|bankrupt)/i,
  },
];

function STRONG_DEAL_RE(): RegExp {
  return /(\$|€|£)\s?[\d.,]+\s*(million|billion|bn\b|m\b)|(series [a-f]|seed|pre-seed) round|rais(e|ed|es|ing)\s+(\$|€|£)?\d|acquir(e|es|ed|ing)|merger\b|ipo\b|appoints?\b|steps down|bankruptcy|chapter 11|data breach/i;
}

/** Classify off-mission content; null = no veto applies. */
export function detectVeto(title: string, lead: string): Veto | null {
  const hay = `${title}\n${lead.slice(0, 600)}`;
  for (const rule of RULES) {
    if (!rule.re.test(hay)) continue;
    if (rule.rescue && rule.rescue.test(`${title}\n${lead.slice(0, 200)}`)) continue;
    return { cls: rule.cls, reason: `offtopic:${rule.cls}` };
  }
  return null;
}
