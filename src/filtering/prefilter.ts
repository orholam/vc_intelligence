import { getFilters } from "../config-files.js";
import { isSlopTitle } from "../lib/quality.js";
import { hostToDomain } from "../lib/hash.js";
import { normalizeWhitespace } from "../lib/text.js";

export interface PrefilterInput {
  url: string;
  title: string;
  body?: string | null;
}

export interface PrefilterResult {
  kept: boolean;
  /** 0..1 confidence the item is junk (higher = more likely discarded). */
  score: number;
  reason?: string;
}

/**
 * Stage (a) of FR-5: cheap lexical/heuristic pre-filter. Targets press-release
 * directories, tag/category pages, non-news formats and tiny bodies before any
 * LLM spend. Deterministic and config-driven (NFR-9).
 */
export function prefilter(input: PrefilterInput): PrefilterResult {
  const cfg = getFilters().prefilter;

  // Job-board publishers are never deal-flow news regardless of wording.
  const JOB_BOARDS = new Set([
    "builtinsf.com", "builtin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com",
    "jobs.lever.co", "boards.greenhouse.io", "ashbyhq.com",
  ]);
  try {
    const host = hostToDomain(new URL(input.url).hostname);
    if (JOB_BOARDS.has(host)) {
      return { kept: false, score: 0.95, reason: "job_board_domain" };
    }
  } catch { /* invalid url falls through to other gates */ }

  const urlLower = input.url.toLowerCase();
  for (const pattern of cfg.blocked_url_patterns) {
    if (urlLower.includes(pattern.toLowerCase())) {
      return { kept: false, score: 0.95, reason: `url_matches:${pattern}` };
    }
  }

  const title = normalizeWhitespace(input.title);
  if (title.length < cfg.min_title_chars) {
    return { kept: false, score: 0.9, reason: "title_too_short" };
  }

  const slop = isSlopTitle(title);
  if (slop.slop) {
    return { kept: false, score: 0.88, reason: `slop_title:${slop.reason}` };
  }

  // Genuine funding/M&A headlines survive even when the body is thin (wire copy).
  const fundingSignal =
    cfg.keep_if_funding_signals &&
    /\b(rais|fund|series|acquir|merger|ipo)\b/i.test(title);

  // c-plan: other strong event titles survive thin wire bodies too — the LLM
  // filter makes the final call; prefilter stays a cheap recall-preserving gate.
  const eventSignal =
    !fundingSignal &&
    (cfg.keep_if_event_title_patterns ?? []).some((rawRx) => {
      const m = /^\(\?([a-z]+)\)/.exec(rawRx);
      const rx = new RegExp(rawRx.slice(m?.[0]?.length ?? 0), m?.[1] ?? undefined);
      return rx.test(title);
    });
  const rescueSignal = fundingSignal || eventSignal;

  for (const rawRx of cfg.non_news_title_patterns) {
    const m = /^\(\?([a-z]+)\)/.exec(rawRx);
    const rx = new RegExp(rawRx.slice(m?.[0]?.length ?? 0), m?.[1] ?? undefined);
    if (rx.test(title) && !rescueSignal) {
      return { kept: false, score: 0.85, reason: `title_pattern:${rawRx}` };
    }
  }

  const body = input.body ?? "";
  if (!rescueSignal && body && body.length < cfg.min_body_chars) {
    return { kept: false, score: 0.8, reason: "body_below_min_chars" };
  }

  // Kept items carry a low junk score.
  return { kept: true, score: rescueSignal ? 0.2 : 0.05 };
}
