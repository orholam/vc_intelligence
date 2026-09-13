/**
 * Deterministic lexical organization-candidate extraction ("NER-lite").
 * Used by FR-10 candidate generation and by the offline mock provider.
 */
import { entityNameRejectionReason } from "./quality.js";
import { normalizeName } from "./text.js";
import { extractTitleSubject, isFundingRoundFragment, stripPublisherSuffix } from "./title-subject.js";

const NON_ORG_TOKENS = new Set(
  [
    // calendar / general
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "mr", "mrs", "ms", "dr", "prof", "st",
    // common sentence starters / newswords
    "new", "new york times", "update", "exclusive", "analysis", "opinion",
    "photo", "credit", "getty", "reuters", "bloomberg", "ap", "afp",
    "north", "south", "east", "west", "united states", "united kingdom", "european union",
  ].map((w) => w.toLowerCase()),
);

const ORG_SUFFIX_HINTS =
  /\b(inc|llc|ltd|limited|plc|corp|corporation|co|company|gmbh|holdings?|group|technologies|technology|tech|labs|laboratories|systems?|solutions?|software|ventures|capital|partners|ai|robotics|bio|therapeutics|health|bank|studios|media|networks?|platform|industries|works|digital|cloud|data|security|energy|motors|aerospace|pharma|biosciences)\b/i;

export interface OrgSpan {
  name: string;
  start: number;
  end: number;
  score: number;
}

const TOKEN_RE = /[A-Z][A-Za-z0-9&.'\-]*(?:\s+[A-Z][A-Za-z0-9&.'\-]*)*/g;

/**
 * Extract candidate organization mentions from text using capitalization
 * sequences + suffix hints + quotes. Recall-oriented; precision comes later
 * from the alias index and the resolver.
 */
export function heuristicOrganizations(text: string): OrgSpan[] {
  const cleaned = stripPublisherSuffix(text.split("\n")[0] ?? text);
  const titleSubject = extractTitleSubject(cleaned);
  const out = new Map<string, OrgSpan>();
  const push = (name: string, start: number, score: number) => {
    name = name.replace(/\s+/g, " ").trim();
    if (!name) return;
    if (isFundingRoundFragment(name)) return;
    if (entityNameRejectionReason(name)) return;
    const lower = name.toLowerCase();
    if (NON_ORG_TOKENS.has(lower)) return;
    if (name.length < 3 || name.length > 60) return;
    if (/^\d/.test(name)) return;
    const existing = out.get(lower);
    if (!existing || existing.score < score) {
      out.set(lower, { name, start, end: start + name.length, score });
    }
  };

  // Quoted names first: Acme "Acme Robotics" ...
  for (const m of cleaned.matchAll(/["\u201c]([A-Z][^"\u201d]{2,48})["\u201d]/g)) {
    if (m[1]) push(m[1], m.index ?? 0, 0.5);
  }

  // Capitalized token runs
  for (const m of cleaned.matchAll(TOKEN_RE)) {
    const run = m[0];
    const idx = m.index ?? 0;
    // split runs at sentence boundaries artifacts: keep <=4 tokens
    const tokens = run.split(/\s+/);
    if (tokens.length > 4) continue;
    let score = 0.3;
    if (ORG_SUFFIX_HINTS.test(run)) score += 0.35;
    if (tokens.length >= 2) score += 0.1;
    // all-caps acronym like NVDA, OpenAI handled above; treat short all-caps as lower confidence
    if (run === run.toUpperCase() && run.length <= 6) score -= 0.15;
    // preceded by lowercase word => mid-sentence proper noun, good signal
    const prev = cleaned.slice(Math.max(0, idx - 2), idx);
    if (prev.endsWith(" ") && /\p{Ll}/u.test(cleaned.slice(Math.max(0, idx - 8), idx - 1))) {
      score += 0.05;
    }
    if (titleSubject && normalizeName(run) === normalizeName(titleSubject)) score += 0.45;
    if (score >= 0.3) push(run, idx, Math.min(score, 0.95));
  }

  if (titleSubject) {
    push(titleSubject, 0, 0.92);
  }

  return [...out.values()].sort((a, b) => b.score - a.score);
}

/** Simple polarity lexicon for the offline mock provider. */
const POSITIVE_WORDS = new Set(
  ("gain gains grew growth grow surge surged soar soared rise rises rose rally record strong higher boost boosted wins won award awarded breakthrough profitable profit raises raised upgrade upgraded expansion expands launch launches launched success successful partnership secures secured milestone beats tops exceeds approval approved breakthrough resilient robust demand adoption".split(
    " ",
  )),
);
const NEGATIVE_WORDS = new Set(
  ("loss losses fell fall falls drop dropped decline declined slump slumped plunge plunged crash weak lower cut cuts layoffs lawsuit sued sues fined penalty breach hack hacked outage recall bankruptcy bankruptcy distress warning misses missed downgrade downgraded fraud probe investigation halt halted shutdown shuts closes crisis concern concerns risk risks layoff firing".split(
    " ",
  )),
);

export function lexiconSentiment(text: string): {
  sentiment: "positive" | "negative" | "neutral";
  score: number;
} {
  const words = text.toLowerCase().match(/\b[a-z']+\b/g) ?? [];
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    else if (NEGATIVE_WORDS.has(w)) neg++;
  }
  // Saturation guard (Class 8): trivial items with 1-2 lexicon hits must not
  // pin at ±1.00; widen the neutral band and cap the magnitude.
  const total = pos + neg;
  if (total < 3) return { sentiment: "neutral", score: 0 };
  let score = (pos - neg) / total;
  score = Math.max(-0.9, Math.min(0.9, score));
  score = Number(score.toFixed(2));
  return {
    sentiment: score > 0.35 ? "positive" : score < -0.35 ? "negative" : "neutral",
    score,
  };
}
