/**
 * Pre-ingest de-noise: separate real product launches from everything else
 * that matches "introducing/launching + video" on X — personal introductions,
 * breaking-news posts, sports milestones, celebrity updates.
 *
 * Pure function; fully unit-tested against real captured examples.
 */

export interface DenoiseInput {
  text: string;
  linkedDomain: string | null;
  views: number;
}

export interface DenoiseVerdict {
  ok: boolean;
  score: number;
  reason: string;
}

const SOCIAL_DOMAINS = new Set(["x.com", "twitter.com", "t.co", "youtu.be", "youtube.com", "instagram.com", "tiktok.com"]);

// Personal/group introductions are never launches.
const PERSONAL_INTRO_RE =
  /\bintroduc(?:e|ing|es)?\b[^.!?\n]{0,40}\b(my ?sel[fh]|himself|herself|themselves|each other|my (?:girlfriend|boyfriend|cat|dog|friend|new)|you all|y'all|u all)\b/i;
const NEWS_STYLE_RE =
  /^\s*(?:🚨\s*)?(?:break(?:ing)?|just in|it'?s official|official statement|confirmed[::]|reports?:|update[::])\b/i;
const SPORTS_RE =
  /\b(?:\d+(?:st|nd|rd|th)\s+(?:HR|home run)|hits? (?:his|her|a) (?:\d+|home run)|grand slam|walk-?off|goal (?:against|of the season)|match point|knock(?:ed)? ?out (?:in|at) round)\b/i;

// Product signals.
const LEADING_LAUNCH_RE =
  /^\s*(?:🚀|🎉|✨|\p{Extended_Pictographic}\s)?\s*(?:we'?re|we are|just|introducing|proudly?|finally|today (?:we))?[\s\S]{0,20}?(introduc\w*|launch\w*|unveil\w*|announc\w*|shipp?ed|going live|now live)/iu;
const PRODUCT_VOCAB_RE =
  /\b(app|api|beta|saas|tool|platform|extension|dashboard|marketplace|open[- ]source|waitlist|sign ?up|download|pricing|free tier|v\d(?:\.\d)?|mcp|cli|sdk|ios|android|compare|analytics|automat\w+|agent\w*|editor|library|framework|template|boilerplate)\b/i;
// "Introducing the RetroTINK-6X CE:" / "Launching GemEx - ..." — mixed-case
// naming (ALLCAPS shouting doesn't count) followed by a : / — / - separator.
const NAMED_TARGET_RE =
  /\b(?:introduc\w*|launch\w*|unveil\w*)\s+(?:the\s+|our\s+|my\s+|an?\s+)?[A-Z][a-z][\w .-]{0,48}[:—-]\s/;

export function evaluateLaunch(input: DenoiseInput): DenoiseVerdict {
  const text = input.text ?? "";

  if (PERSONAL_INTRO_RE.test(text)) {
    return { ok: false, score: 0, reason: "personal-introduction" };
  }
  if (NEWS_STYLE_RE.test(text)) {
    return { ok: false, score: 0, reason: "news-style" };
  }
  if (SPORTS_RE.test(text)) {
    return { ok: false, score: 0, reason: "sports-milestone" };
  }

  let score = 0;
  const reasons: string[] = [];

  if (LEADING_LAUNCH_RE.test(text.slice(0, 64))) {
    score += 0.35;
    reasons.push("leading-phrase");
  } else {
    score += 0.1; // matched the search query somewhere, weaker
    reasons.push("phrase-present");
  }

  const domain = input.linkedDomain && !SOCIAL_DOMAINS.has(input.linkedDomain) ? input.linkedDomain : null;
  if (domain) {
    score += 0.2;
    reasons.push("own-domain");
  }

  if (PRODUCT_VOCAB_RE.test(text)) {
    score += 0.15;
    reasons.push("product-vocab");
  }

  // Announcement-with-named-target pattern: "Introducing the RetroTINK-6X CE:"
  // or "Launching GemEx - ..." Requires mixed-case naming (ALLCAPS shouting
  // doesn't count) followed by a : / — / - separator.
  const namedTarget = NAMED_TARGET_RE.test(text);
  if (namedTarget) {
    score += 0.1;
    reasons.push("named-target");
  }

  if (input.views >= 10_000) {
    score += 0.15;
    reasons.push("high-traction");
  } else if (input.views >= 500) {
    score += 0.05;
    reasons.push("traction");
  }

  // Hashtag storms are marketing spam more often than launches.
  const hashtags = text.match(/#\w+/g)?.length ?? 0;
  if (hashtags > 3) {
    score -= 0.25;
    reasons.push("hashtag-storm");
  }

  // MANDATORY product evidence — traction alone can never substitute:
  // an own-domain link, product vocabulary, or a properly-named target.
  const evidence = domain !== null || PRODUCT_VOCAB_RE.test(text) || namedTarget;
  if (!evidence) reasons.push("no-product-evidence");

  const ok = score >= 0.45 && evidence;
  return { ok, score: Math.round(score * 100) / 100, reason: ok ? reasons.join("+") : `low-signal(${reasons.join("+")})` };
}
