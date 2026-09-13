/**
 * Pure heuristics that separate serious product launches from engagement bait.
 * No network, no state — fully unit-testable.
 */

/** Hosts that never count as the product's own domain. */
const NON_PRODUCT_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "t.co",
]);

export function extractExternalDomain(urls: readonly string[]): string | null {
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (NON_PRODUCT_HOSTS.has(host)) continue;
      return host.replace(/^www\./, "");
    } catch {
      continue;
    }
  }
  return null;
}

const LAUNCH_RE =
  /\b(introduc(?:ing|e[ds]?)|launch(?:ing|ed)|unveil(?:ing|ed)?|announc(?:ing|e[sd]?)|now live|went live|just shipped)\b/i;

const LEADING_LAUNCH_RE =
  /^\s*(?:🚀|🎉|✨|\p{Extended_Pictographic}\s)?\s*(introduc|launch|unveil|announce|after \w+ (?:months?|weeks?|years?) of)/iu;

const NOISE_RE =
  /\b(conference|webinar|hiring|we'?re hiring|job open\w*|podcast episode|meetup|hackathon|giveaway|discount code|black friday|sale now on)\b/i;

export function looksLikeLaunchText(text: string): boolean {
  return LAUNCH_RE.test(text);
}

export function isNoiseText(text: string): boolean {
  return NOISE_RE.test(text);
}

export interface LaunchSignals {
  text: string;
  videoCount: number;
  views: number;
  likes: number;
  externalDomain: string | null;
}

export interface LaunchScore {
  score: number;
  domain: string | null;
  reasons: string[];
}

/**
 * Heuristic score in [0, 1]:
 * - base for matching a launch query
 * - strong bonus when the announcement phrase leads the post
 * - native video + own-domain link are the "serious launch" markers
 * - mild engagement lift; noise words demote hard
 */
export function scoreLaunch(signals: LaunchSignals): LaunchScore {
  const reasons: string[] = [];
  let score = 0.2; // matched a launch query at all
  reasons.push("matched-query");

  const text = signals.text ?? "";
  if (LEADING_LAUNCH_RE.test(text.slice(0, 48))) {
    score += 0.3;
    reasons.push("leading-phrase");
  } else if (LAUNCH_RE.test(text)) {
    score += 0.15;
    reasons.push("phrase-present");
  }

  if (signals.videoCount > 0) {
    score += signals.videoCount >= 2 ? 0.25 : 0.2;
    reasons.push("native-video");
  }

  if (signals.externalDomain) {
    score += 0.15;
    reasons.push(`domain:${signals.externalDomain}`);
  }

  const engagement = Math.max(signals.views / 10_000, signals.likes / 100);
  if (engagement >= 1) {
    score += Math.min(0.15, 0.05 * Math.floor(Math.log2(engagement + 1)));
    reasons.push("traction");
  }

  if (isNoiseText(text)) {
    score -= 0.4;
    reasons.push("noise-words");
  }

  return { score: Math.max(0, Math.min(1, round2(score))), domain: signals.externalDomain, reasons };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
