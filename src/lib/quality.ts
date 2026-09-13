import { normalizeName } from "./text.js";

/**
 * Content-quality guards shared by prefilter, the noise-filter provider,
 * entity creation and discovery channels. Patterns live here (code) while
 * thresholds stay in config/filters.json — the patterns encode *what slop
 * looks like* for a VC deal-flow platform and change rarely.
 */

export const ENTERTAINMENT_TITLE_RE =
  /(interview\s*:|red carpet|trailer\b|premiere\b|box office|oscars?|grammys?|\bemmy(?:-winning|s)?\b|\bactor\b|\bactress\b|\bcast\b.*\bshow\b|season\s+\d+\s+(premiere|finale|returns)|netflix series|streaming series|new episodes|celebrity|opens up (about|to)|on if (he|she)|reflects on (his|her)|gushes|dating|breakup|\bfeud\b|sitcom|reality show|talk show)/i;

/** Weak "company event" signal strong enough to rescue an otherwise-slop headline.
 *  v2 (live-feedback pass): adds insolvency chapters beyond 11 (chapter N,
 *  liquidation, receivership), litigation/regulatory-conflict signals
 *  (lawsuit/sued/antitrust/regulator/subpoena/investigation/probe) so
 *  government-conflict coverage is never pre-killed as celebrity slop, and
 *  bare sales/revenue evidence ("…, sales data suggests"). Prefilter stays a
 *  recall-preserving gate — rescued items still face the LLM noise filter. */
export const STRONG_BUSINESS_SIGNAL_RE =
  /(\$\s?[\d.,]+\s*(million|billion|bn|m\b|k\b)|(€|£)\s?[\d.,]+|(series [a-f]|seed|pre-seed) round|rais(e|ed|es)\s+\$|acquir(e|es|ed)|merger\b|ipo\b|appoints?\s|names?\s+\w+\s+(ceo|cfo|cto)|steps down|files for bankruptcy|chapter \d+|liquidat\w*|receivership|lay(s|o|e)ff|settles?(ment)?\s+\$|fined|data breach|partnership with|\blawsuit\b|\bsu(e|es|ed)\b|antitrust|regulators?|regulatory|subpoena\w*|investigat\w*|\bprobes?\b|\bsales\b|\brevenue\b)/i;

/**
 * Discrete company-event signal for subject gating (noise-filter v4 policy):
 * the headline or lead must itself report something happening to a company.
 * Deliberately excludes bare "fund"/"shares"/"stocks" words so mutual-fund
 * columns and market commentary never qualify.
 *
 * v4 (2026-08 audit of no_subject_event_in_title_or_lead discards): adds the
 * event classes measured as top false-positive sources — earnings results
 * movement, funding via secures/lands/snags/closes+amount, signed deals,
 * expansion/facility milestones, leadership promotes/taps/transitions,
 * dividends/buybacks, guidance cuts, generalized contract/order wins,
 * and bare "announces". Context windows ([^.\n]{0,N}) keep matches inside
 * one sentence; commentary titles are vetoed before this regex in the
 * mock noise filter.
 */
/**
 * Non-mission topics that must never yield event tags even when event-ish
 * words appear ("Apple TV launches new episodes"). Mirrors the classify_enrich
 * prompt's TOPICAL EXCLUSION rule so mock and real LLM share one definition.
 */
export const TOPIC_VETO_RE =
  /(celebrit|red carpet|interview\s*:|tv series|streaming series|season\s+\d|new episodes|box office|oscars?|emmy|grammys?|\bactor\b|\bactress\b|dating\b|engaged\b|wedding|divorce|feud|moon phase|horoscope|mutual fund sip|sip amount|retirement corpus|epf\b|fcnr\b|nri talk|etmarkets|sensex|nifty\b|share price target|stocks that saw|injured list|box score|power rankings|is hiring|job opening|apply now)/i;

export const COMPANY_EVENT_SIGNAL_RE =
  /(rais(e[sd]?|ing)\b|funding round|closed? (a |an )?(seed|series|[a-z]+ round)|series [a-f]\b|acquir(e[sd]?|ing|er)\b|\bmerger\b|merges?\b|\bipo\b|go(es)? public|launch(e[sd]?|ing)?\b|unveils?\b|introduc(e|es|ing)\b|debuts?\b|reveal(s|ed)?\b|appoint(s|ed)?\b|names? \w+ (as )?(ceo|cfo|cto|coo|president)|steps? down|resigns?\b|lay(s|o)e?ffs?\b|job cuts?|cuts? (over )?[\d,.]+\+? ?(jobs|roles|positions|staff)|recall(ed|s)?\b|lawsuit|su(es|ed)\b|settle(s|ment|d)?\b|fined?\b|penalt(y|ies)|bankrupt\w*|chapter \d+|liquidat\w*|receivership|shuts? down|winds? down|ceases? operations|data breach|cyberattack|ransomware|outage|partnership with|invest(s|ed|ing)? (\$|[0-9]|in )|investment (in|of|into)|acquisition|divest\w*|spins? off|sells?\b|buys?\b|agrees to buy|files for|files form d|purchas(e|es|ed|ing)|announc(e[sd]?|ing)\b|(profit|revenue|sales|net income|earnings)[^.\n]{0,40}\b(rises?|rising|rose|falls?|falling|fell|drops?|dropped|grows?|grew|growth|jumps?|jumped|surge[sd]?|soars?|soared|climbs?|climbed|declines?|declined|slips?|slipped|beats?|beaten|misses?|missed|tops?|topped)\b|(rises?|rose|falls?|fell|drops?|dropped|grows?|grew|growth|jumps?|jumped|surge[sd]?|soars?|soared|climbs?|climbed|declines?|declined|slips?|slipped)[^.\n]{0,30}(profits?|revenue|sales|net income)|reports? [^.\n]{0,60}\b(profit|loss|revenue|results|earnings|income)\b|\b(secur(e[sd]?|ing)|lands?|landed|snags?|snagged|bags?|bagged)\b[^.\n]{0,50}((\$|€|£|₹)\s?[\d.,]+|funding|financing)|(closes?|closed)[^.\n]{0,50}((\$|€|£|₹)\s?[\d.,]+|\bfunds?\b|\bround\b)|\bsign(s|ed|ing)?\b[^.\n]{0,60}\b(deals?|agreements?|pact|mou|memorandum|accords?|contracts?|partnership)\b|\binks?\b[^.\n]{0,60}\b(deals?|agreements?|pact|partnership)\b|(promotes?|promoted|taps?|elevates?|transitions?|transitioned)\b[^.\n]{0,50}\b(as )?(ceo|cfo|cto|coo|president|chair(man)?|general counsel)\b|breaks? ground|expands?\b|expanded\b|expanding\b|expansion\b[^.\n]{0,70}\b(facilit(y|ies)|plants?|factor(y|ies)|data cent(er|re)|headquarters|operations|capacity|production|fleet|manufacturing)|(wins?|won|books?|booked|booking|lands?|secures?|awarded)[^.\n]{0,45}\b(orders?|contracts?|tender)\b|tapped by|(declar(e[sd]?|ing)|initiat(e[sd]?|ing)|special|quarterly|interim)[^.\n]{0,25}dividends?\b|share (buyback|repurchase)|stock buyback|(cuts?|lowers?|lowered|withdraws?|withdrew|trims?|trimmed)[^.\n]{0,35}\b(guidance|forecast|outlook)\b)/i;

/**
 * Generic non-entity words that must never become companies.
 * NOTE: this guard intentionally over-rejects short/camel brand names; curated
 * (seed/reviewed) entities are exempt at the purge layer via provenance.
 */
const GENERIC_NAMES = new Set([
  "ai", "urls", "url", "data", "technology", "tech", "news", "business",
  "software", "platform", "digital", "media", "global", "group", "holdings",
  "ventures", "capital", "partners", "solutions", "systems", "services",
  "innovation", "insights", "labs", "cloud", "cyber", "robotics", "energy",
  "health", "finance", "fintech", "market", "markets", "research", "review",
  "reviews", "guide", "tips", "best", "top", "home", "about", "contact",
  "bank", "mark", "link", "owner", "alice", "natural", "slash", "pocket",
  "bot", "open", "open bot", "inc", "corp", "llc", "ltd", "company", "co",
  "app", "the", "forbes", "nikkei",
  // prompt-field labels / parser artifacts (counterparty_extract mock leak)
  "title", "text", "adding", "list",
  // funding-round / crypto / geo fragments NER mints from headlines
  "funding", "bitcoin", "ethereum", "india", "china", "brazil", "japan",
  "singapore", "pakistan", "chinese", "israel", "texas", "georgia",
  "canada", "uk", "u.k.", "u.s.", "usa",
  // syndicated publishers mistaken for subjects
  "fortune", "slashdot",
  // headline fragments / money-scale tokens the mock NER mints as companies
  "million", "billion", "trillion", "thousand", "includes", "phones",
  "primetime", "surprise", "pro", "related", "britain", "sunday",
  "california", "montana", "iowa", "texas", "florida", "georgia", "virginia",
  "revenue", "acquisitions", "mac studio",
  // prepositions / temporal / geo tokens mistaken for subjects
  // e.g. "OpenPayd … Ahead of Nasdaq", "AI or Overhiring", "available Sept. 29"
  // (do NOT include flash/series/ultra/watch — those can be real brand names)
  "ahead", "before", "after", "during", "against", "under", "over",
  "between", "through", "within", "without", "beyond", "across", "behind",
  "stock", "sept", "sept.", "september",
]);

/** Mock/markdown artifact suffixes on capitalized spans ("Great Retro RPG List"). */
const HEADLINE_ARTIFACT_RE =
  /\b(list|text|settlement list|settlement text|tunneler list|tunneler text)\s*$/i;

/** Money-scale or product-SKU fragments, not company names. */
const MONEY_OR_SKU_FRAGMENT_RE =
  /^(million|billion|trillion|thousand|includes?|phones?|primetime|surprise|pro|related|ai[\s-]?related)$/i;

/** "$25M Pre-Series C" style round labels from capitalized-token NER. */
const FUNDING_ROUND_FRAGMENT_RE = /^M\s+(Pre-)?Series\s+[A-F]\b$/i;

/** Headline glue: "IPO OpenAI", "Funding Nekkyo Co." */
const HEADLINE_GLUE_RE = /^(ipo|funding)\s+/i;

const STOPWORD_TAIL =
  /\b(As|And|Or|But|Of|The|A|An|In|On|At|For|To|From|With|By|Is|Are|Was|Were|It|Its|His|Her|Their|This|That|These|Those|You|Your|My|Our|Us)$/;


const ENTERTAINMENT_NAME_RE =
  /(season|episode|premiere|trailer|box office|emmy|oscar|grammy|red carpet|\bcast\b|netflix|hulu|hbo series)/i;

/** Bare domains masquerading as company names ("reuters.com", "threads.com"). */
export const DOMAIN_TOKEN_RE =
  /(^|\s|[a-z])[a-z0-9-]*\.(com|net|org|io|co|ai|uk|us|de|fr|app|dev|news|info|gov|edu|mil|int)\b/i
  ;

/** Media outlets / aggregators / standards bodies that appear constantly in article links. */
export const MEDIA_OR_AGGREGATOR_RE =
  /(reuters\b|bloomberg\b|businesswire|prnewswire|globenewswire|aboutads|flipboard|threads\b|mastodon|medium\b|substack|wordpress|wikipedia|wikimedia|google\s*news|associated press|ap news|variety|hollywood reporter|deadline|ign\b|gamespot|kotaku|polygon|slashdot\b|techcrunch\b|venturebeat\b|theverge\b|engadget\b|mashable\b|hacker\s*news\b)/i;

/** CDN/block-page artefacts from failed homepage fetches. */
export const BLOCK_PAGE_RE =
  /(access denied|just a moment|verify you are human|security verification|are you a robot|attention required|page not found|403|forbidden|enable javascript)/i;


/**
 * Ticker symbols that double as common English/tech words. Matching them
 * case-insensitively in headlines manufactures subject evidence out of noise
 * ("space tech startup" → BIO-TECHNE via ticker TECH; "like the Mac" →
 * MACERICH via ticker MAC).
 */
/** Registrable-domain brand: first meaningful label ("www" stripped). */
export const GENERIC_FUNDING_ALIAS_RE =
  /^(?:series(?:\s+(?:[a-f]|[1-4]))?|pre.?series(?:\s+[a-f])?|rounds?|funding|seed)$/;

/**
 * True for alias strings that are generic funding vocabulary ("series",
 * "series a", "seed", "round"…). Such tokens must never act as company-alias
 * evidence: a company literally named "Series" otherwise swallows every
 * "raises $12M Series A" headline in the corpus.
 */
export function isGenericFundingAlias(aliasNormalized: string): boolean {
  return GENERIC_FUNDING_ALIAS_RE.test(aliasNormalized.trim());
}

/**
 * True when an alias must never be used as company-match evidence.
 * Covers funding vocabulary plus common English/publisher words that
 * otherwise swallow every "Energy" / "Bank" / "Markets" headline.
 * Domain-kind matches are handled separately and are not filtered here.
 */
export function isGenericCompanyAlias(aliasNormalized: string): boolean {
  const n = aliasNormalized.trim().toLowerCase().replace(/\s+/g, " ");
  if (!n) return true;
  if (isGenericFundingAlias(n)) return true;
  return GENERIC_NAMES.has(n);
}

export const TICKER_STOPWORDS = new Set([
  "tech", "car", "cars", "data", "cloud", "ai", "app", "apps", "mac",
  "soda", "love", "key", "keys", "core", "real", "gold", "life", "care",
  "well", "true", "good", "now", "one", "two", "big", "top",
]);

/**
 * Decide whether a candidate canonical entity name is fit for the KB.
 * Returns null when acceptable, otherwise a short rejection reason.
 */
const PERSON_NAME_RE = /^[A-Z][a-z''\-]+(?: [A-Z][a-z''\-]+){1,2}$/;
const CORPORATE_MARKER_RE =
  /\b(inc|corp|corporation|ltd|limited|llc|llp|plc|gmbh|bv|pty|co|company|group|holdings|capital|ventures?|partners?|labs?|lab|technologies|tech|systems?|solutions?|ai|cloud|digital|media|studios?|bank|funds?|foundation|institute|university|industries|energy|health|bio|biotech|pharma|pharmaceuticals|therapeutics|sciences|robotics|software|networks?|analytics|security|financial|logistics|consulting|advisory|cosmetics|brands?|apparel|fashion|games?|gaming|records?|music|pictures|films?|motors|automotive|aerospace|space)\b/i;

/** People are not companies: "Dolly Parton" must never become a private-company card. */
export function looksLikePersonName(name: string): boolean {
  const n = name.trim();
  if (!PERSON_NAME_RE.test(n)) return false;
  if (CORPORATE_MARKER_RE.test(n)) return false;
  // All-caps acronym tokens ("GMI", "JW") are org-ish, not given names.
  return !n.split(/\s+/).some((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
}

export function entityNameRejectionReason(rawName: string): string | null {
  const name = rawName.trim();
  if (!name) return "empty";
  if (MONEY_OR_SKU_FRAGMENT_RE.test(name.replace(/\s+/g, " "))) return "headline_fragment";
  if (FUNDING_ROUND_FRAGMENT_RE.test(name.replace(/\s+/g, " "))) return "funding_round_fragment";
  if (HEADLINE_GLUE_RE.test(name)) return "headline_fragment";
  if (HEADLINE_ARTIFACT_RE.test(name)) return "headline_artifact";
  if (/^(title|text|adding|list)$/i.test(name.trim())) return "prompt_field_label";
  if (/^how\s+[a-z]/i.test(name)) return "looks_like_headline";
  // Wire lead-ins / exclusivity labels glued onto a brand ("Exclusive: Femtech Ipremom")
  if (/^(exclusive|breaking|update|alert)\b/i.test(name)) return "headline_lead_in";
  // Stale wrong-entity paste / multiword junk ("Publishers After EU Pressure", "European Union Skip")
  if (/\b(after|before|ahead of|sides with|facing|under new)\b/i.test(name) && name.split(/\s+/).length >= 3) {
    return "headline_fragment";
  }
  if (/\battempts to\b/i.test(name)) return "headline_fragment";
  if (/\badministration\b/i.test(name) && !/\b(Inc|LLC|Corp|Ltd|Co|PLC)\.?$/i.test(name.trim())) {
    return "headline_fragment";
  }
  if (/\b(billion|million|trillion)\s+(space|dollar|program|settlement|telescope)\b/i.test(name)) {
    return "money_phrase_not_company";
  }
  if (/^(disc-to-digital|officially revealed|great retro)/i.test(name)) return "headline_fragment";
  if (name.length <= 4 && !/^[A-Z]{2,5}$/.test(name) && !/[aeiou]/i.test(name.slice(1))) return "too_short";
  if (/^\W/.test(name)) return "punctuation_leading";
  if (/^(Inc|LLC|Ltd|Corp|Co|GmbH)\.?$/i.test(name)) return "legal_suffix_only";
  // Headline verbs glued onto a brand ("Neno Raises") — not a lone homonym
  // brand ("Raise" the insurtech company).
  const verbTail = /\b(raises?|raising|launches?|launching|acquires?|acquiring|open-?sources?|ipo raises?)\b/i;
  const nameWords = name.trim().split(/\s+/);
  if (/^(raises?|raising|launches?|launching|acquires?|acquiring|ipo)$/i.test(name.trim())) {
    return "headline_verb_glued";
  }
  if (nameWords.length > 1 && verbTail.test(name)) {
    return "headline_verb_glued";
  }
  if (looksLikePersonName(name)) return "person_name";

  // Camel-glitch concatenations like "West Bankbbc.co.uk", "PursuitsRetailers Want AI"
  if (/[a-z][A-Z]/.test(name.replace(/^Mc/, ""))) {
    const words = name.trim().split(/\s+/);
    const internalCaps = (name.match(/[a-z][A-Z]/g) ?? []).length;
    const skipCamelGlitch = words.length === 1 && internalCaps === 1 && name.length <= 24;
    // allow legit camel brands: OpenAI, YouTube, PayPal, LinkedIn, iPhone...
    const knownBrand =
      /(OpenAI|YouTube|PayPal|LinkedIn|iPhone|iPad|WhatsApp|TikTok|Snapchat|YouTubeTV|ByteDance|SpaceX|xAI\b|Figma|Canva|Ramp\b|Brex\b|Deel\b|Wise\b|Klarna|Monzo|Palantir|Anduril|Waymo|Stripe\b|Snowflake|Databricks|Mistral|HappyRobot|inKind|ApartmentIQ|QuantHealth|ProRata|Superhuman|OneDome|DeepSeek|GeoPura)/i.test(name);
    // Camel first token + corporate second token ("InRisk Labs") is a legit
    // two-word name, not a concatenation glitch.
    const corpTail = /\s+(Labs?|Capital|Ventures?|Technologies|Systems?|Group|Holdings|Partners|Works|AI)\.?$/i.test(
      name.trim(),
    );
    if (!skipCamelGlitch && !knownBrand && !corpTail) {
      return "camel_glitch";
    }
  }

  if (/^brand\s/i.test(name)) return "brand_fallback_prefix";
  if (/^(One Tech Tip|Mstdn)$/i.test(name.trim())) return "syndication_junk";
  if (BLOCK_PAGE_RE.test(name)) return "block_page_artifact";
  if (MEDIA_OR_AGGREGATOR_RE.test(name)) return "media_or_aggregator";

  const norm = normalizeName(name);
  if (!norm) return "normalizes_empty";
  const firstWord = norm.split(" ")[0] ?? "";
  if (GENERIC_NAMES.has(norm)) return "generic_word";
  // Generic leading word only forgivable when a corporate marker appears later
  // ("Digital Media Group" ok-ish; "Digital Advertising Alliance" not).
  if (GENERIC_NAMES.has(firstWord)) {
    const rest = norm.split(" ").slice(1).join(" ");
    if (!/(inc|llc|ltd|corp|group|holdings|technologies|technology|labs|systems|solutions|platform)/i.test(rest)) {
      return "generic_leading_word";
    }
  }
  if (DOMAIN_TOKEN_RE.test(name)) return "domain_in_name"; // "reuters.com", "West Bankbbc.co.uk"
  if (STOPWORD_TAIL.test(name.trim())) return "stopword_tail"; // "AI As", "Access Denied You"
  const words = name.split(/\s+/);
  if (words.length > 7) return "too_many_words";
  if (ENTERTAINMENT_NAME_RE.test(name)) return "entertainment_term";
  if (/https?:\/\/|\.(com|net|org|io|co|ai)\b/i.test(name) && words.length > 3) {
    return "looks_like_headline";
  }
  return null;
}

/** Names ending in LLC/LP/Fund/etc. — exempt from headline-fragment heuristics. */
export function looksLikeLegalEntityName(name: string): boolean {
  return /\b(LLC|L\.?P\.?|Inc\.?|Corp\.?|Ltd\.?|PLC|Fund|Trust|Holdings|Partners)\b\.?$/i.test(name.trim());
}

/** Headline verbs/phrases that must never be company names (title-context check). */
const HEADLINE_FRAGMENT_CONTEXT_RE =
  /\b(attempts?|punish|unlawful|judge|rules|were|ban(?:ned|s)?|shareholders|deadline|alert|encouraged|investigation launched|have opportunity|securities fraud)\b/i;

/**
 * True when a linked entity name is a headline fragment, not a company.
 * Used by kept-article scrub and editorial validation — scans primary AND secondary.
 */
export function isHeadlineFragmentEntity(name: string, title?: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (looksLikeLegalEntityName(n)) return false;
  if (/\battempts to\b/i.test(n)) return true;
  if (/\badministration\b/i.test(n) && !looksLikeLegalEntityName(n)) return true;
  if (HEADLINE_FRAGMENT_CONTEXT_RE.test(n) && n.split(/\s+/).length >= 3) return true;
  if (title) {
    const t = title.trim().toLowerCase();
    const nn = n.toLowerCase();
    if (nn.length >= 12 && t.startsWith(nn) && HEADLINE_FRAGMENT_CONTEXT_RE.test(n)) return true;
    // Headline lead-in pasted as company ("Grid instability fuels €11.6 million").
    // Do NOT flag legitimate title-subject brands ("Palo Alto Networks Acquires…",
    // "Comcast Technology Solutions Unveils…").
    if (nn.length >= 18 && t.startsWith(nn)) {
      if (HEADLINE_FRAGMENT_CONTEXT_RE.test(n)) return true;
      if (/\b(raises?|launches?|acquires?|unveils?|secures?|beats?|announces?|expands?)\b/i.test(n)) {
        return true;
      }
      const words = n.split(/\s+/);
      if (words.length >= 4 && !looksLikeLegalEntityName(n) && !CORPORATE_MARKER_RE.test(n)) {
        return true;
      }
    }
  }
  return false;
}

/** True when the headline is entertainment/celebrity slop without a hard business signal. */
export function isSlopTitle(title: string): { slop: boolean; reason?: string } {
  if (!ENTERTAINMENT_TITLE_RE.test(title)) return { slop: false };
  if (STRONG_BUSINESS_SIGNAL_RE.test(title)) return { slop: false, reason: "rescued_by_business_signal" };
  return { slop: true, reason: "entertainment_no_business_signal" };
}
