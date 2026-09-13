import { entityNameRejectionReason } from "./quality.js";

/** Syndicated headline suffixes that are never the article subject. */
const PUBLISHER_SUFFIX_RE =
  /\s[-|–—]\s*(Slashdot|TechCrunch|VentureBeat|Ars Technica|Hacker News|ReadWrite|Gizmodo|Engadget|Mashable|Business Insider|CNBC|Reuters|Bloomberg|The Verge|Wired|Forbes)\s*$/i;

const SUBJECT_PREFIX_NOISE =
  /^(livestock tech platform|ai cloud provider|ai agent startup|the)\s+/i;

/** "$25M Pre-Series C" / "$22M Series B" fragments the capitalized-token NER mints. */
export const FUNDING_ROUND_FRAGMENT_RE = /^M\s+(Pre-)?Series\s+[A-F]\b$/i;

export function stripPublisherSuffix(title: string): string {
  return title.replace(PUBLISHER_SUFFIX_RE, "").trim();
}

export function isFundingRoundFragment(name: string): boolean {
  return FUNDING_ROUND_FRAGMENT_RE.test(name.trim());
}

function cleanSubject(raw: string): string | null {
  const name = raw.replace(/^["'“”]+|["'“”]+$/g, "").replace(SUBJECT_PREFIX_NOISE, "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const reason = entityNameRejectionReason(name);
  // Title grammar already anchored the span — allow soft rejects NER would block.
  const softOk = new Set(["generic_leading_word", "generic_word", "person_name", "headline_verb_glued"]);
  if (reason && !softOk.has(reason)) return null;
  return name;
}

/**
 * Grammatical subject from a VC headline: the company raising, being acquired,
 * or named in an executive appointment — not publisher suffixes or round labels.
 */
export function extractTitleSubject(title: string): string | null {
  const t = stripPublisherSuffix(title).trim();

  const raises = /^(.*?)\s+raises?\b/i.exec(t);
  if (raises?.[1]) {
    const commaSubject = raises[1].includes(",")
      ? /,\s*([A-Z][\w&.'-]+(?:\s+[A-Z][\w&.'-]+){0,3})\s+raises?\b/i.exec(t)?.[1]
      : undefined;
    const sub = cleanSubject(commaSubject ?? raises[1]);
    if (sub) return sub;
  }

  const raised = /^(.*?)\s+raised\b/i.exec(t);
  if (raised?.[1]) {
    const sub = cleanSubject(raised[1]);
    if (sub) return sub;
  }

  const secures = /^(.*?)\s+secures?\b/i.exec(t);
  if (secures?.[1]) {
    const sub = cleanSubject(secures[1]);
    if (sub) return sub;
  }

  const closesAcquisition = /^(.*?)\s+closes?\s+acquisition\s+of\s+(.+?)(?:,|\s+becoming|\s+for\b|$)/i.exec(t);
  if (closesAcquisition?.[1]) {
    const sub = cleanSubject(closesAcquisition[1]);
    if (sub) return sub;
  }

  const agreesAcquire = /^(.*?)\s+agrees?\s+to\s+acquire\s+(.+?)(?:\s+for\b|\s+in\b|$)/i.exec(t);
  if (agreesAcquire?.[1]) {
    const sub = cleanSubject(agreesAcquire[1]);
    if (sub) return sub;
  }

  const acquires = /^(.*?)\s+acquires?\s+(.+?)(?:\s+for\b|\s+in\b|$)/i.exec(t);
  if (acquires?.[1] && !/\bto\s*$/i.test(acquires[1])) {
    const sub = cleanSubject(acquires[1]);
    if (sub) return sub;
  }

  const namesExec = /^(.*?)\s+names?\s+new\s+/i.exec(t);
  if (namesExec?.[1]) {
    const sub = cleanSubject(namesExec[1]);
    if (sub) return sub;
  }

  const launches = /^(.*?)\s+launches?\s+/i.exec(t);
  if (launches?.[1]) {
    const sub = cleanSubject(launches[1]);
    if (sub) return sub;
  }

  const hires = /^(.*?)\s+hires?\s+/i.exec(t);
  if (hires?.[1]) {
    const sub = cleanSubject(hires[1]);
    if (sub) return sub;
  }

  const plansIpo = /^(.*?)\s+plans?\s+ipo\b/i.exec(t);
  if (plansIpo?.[1]) {
    const sub = cleanSubject(plansIpo[1]);
    if (sub) return sub;
  }

  const ipoLead = /^(.+?)\s+ipo\s*:/i.exec(t);
  if (ipoLead?.[1]) {
    const sub = cleanSubject(ipoLead[1]);
    if (sub) return sub;
  }

  const closesFunding = /^(.*?)\s+closes?\s+([€$£₹]|\d)/i.exec(t);
  if (closesFunding?.[1]) {
    const sub = cleanSubject(closesFunding[1]);
    if (sub) return sub;
  }

  const closesCrowdfund = /^(.*?)\s+closes?\s+(their\s+)?crowdfunding/i.exec(t);
  if (closesCrowdfund?.[1]) {
    const sub = cleanSubject(closesCrowdfund[1]);
    if (sub) return sub;
  }

  const emerges = /^(.+?)\s+emerges?\s+from\s+stealth/i.exec(t);
  if (emerges?.[1]) {
    const sub = cleanSubject(emerges[1].replace(/^.*\bstartup\s+/i, ""));
    if (sub) return sub;
  }

  return null;
}

/** Acquiree / target company when the headline is M&A-shaped. */
export function extractAcquisitionTarget(title: string): string | null {
  const t = stripPublisherSuffix(title).trim();

  const closesOf = /closes?\s+acquisition\s+of\s+(.+?)(?:,|\s+becoming|\s+for\b|$)/i.exec(t);
  if (closesOf?.[1]) return cleanSubject(closesOf[1]);

  const agrees = /agrees?\s+to\s+acquire\s+(.+?)(?:\s+for\b|\s+in\b|$)/i.exec(t);
  if (agrees?.[1]) return cleanSubject(agrees[1]);

  const acquires = /acquires?\s+(.+?)(?:\s+for\b|\s+in\b|$)/i.exec(t);
  if (acquires?.[1]) return cleanSubject(acquires[1]);

  const toAcquire = /to\s+acquire\s+(.+?)(?:\s+for\b|\s+in\b|,|$)/i.exec(t);
  if (toAcquire?.[1]) return cleanSubject(toAcquire[1]);

  return null;
}
