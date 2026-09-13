/**
 * Faithful extractive summarization (emulates the summary LLM stage).
 *
 * E4 contract: every factual claim must be supported by the excerpt/full
 * text; no invented numbers or names; names the company and the event;
 * ≤400 chars. We therefore ONLY reuse substrings of the article text plus
 * the classification label, never generate new claims.
 */

import { excerpt } from "../../lib/text.js";
import { findTerm, sentencesOf, stripDateline } from "./lex.js";

export interface SummaryInput {
  title: string;
  body: string;
  /** resolved primary entity canonical name (may be null) */
  entityName?: string | null;
  /** classification label e.g. "Seed round" (may be null) */
  eventLabel?: string | null;
}

const NOISE_TAIL =
  /(sign up|subscribe|read more|click here|all rights reserved|follow us|advertisement|share this (article|post))/i;

function cleanSentence(s: string): string {
  let out = stripDateline(s).trim();
  if (NOISE_TAIL.test(out)) out = out.replace(NOISE_TAIL, "").trim();
  return out.replaceAll(/\s+/g, " ");
}

export function summarizeArticle(input: SummaryInput): string {
  const { title } = input;
  const body = (input.body ?? "").split(/\nEVENT_TYPES =/)[0] ?? "";
  const entity = input.entityName?.trim() ?? null;

  const sentences = sentencesOf(body.slice(0, 3000)).map(cleanSentence).filter((s) => s.length > 30 && s.length < 400);
  const entityTokens = entity
    ? entity.toLowerCase().split(/\s+/).filter((t) => t.length > 2 && !/^(inc|corp|ltd|llc|the)$/.test(t))
    : [];
  const eventTokens = (input.eventLabel ?? "").toLowerCase().split(/[\s-]+/).filter((t) => t.length > 3);

  const scored = sentences.map((s, idx) => {
    let score = Math.max(0, 3 - idx) * 0.5; // early-position bonus
    for (const tok of entityTokens) {
      score += findTerm(s.toLowerCase(), "", "", tok).count > 0 ? 2.5 : 0;
    }
    for (const tok of eventTokens) {
      score += findTerm(s.toLowerCase(), "", "", tok).count > 0 ? 1.2 : 0;
    }
    if (/[$€£₹]\s?\d|\b\d+(\.\d+)?\s?(%|percent)\b/.test(s)) score += 1.5;
    if (/\b(announced|said|according to|reported)\b/i.test(s)) score += 0.4;
    if (/^["“]/.test(s)) score -= 1; // raw quotes make poor stand-alone summaries
    return { s, score };
  });

  scored.sort((a, b) => b.score - b.s.length / 1000 - (a.score - a.s.length / 1000));
  const picked: string[] = [];
  let total = 0;
  for (const cand of scored.slice(0, 3)) {
    if (!cand.s) continue;
    if (total + cand.s.length + 1 > 380) continue;
    picked.push(cand.s);
    total += cand.s.length + 1;
    if (picked.length >= 2 || total > 240) break;
  }

  let summary = picked.join(" ").trim();

  // Guarantee the company is named (E4-c): prepend when the pick missed it.
  if (entity && summary && !entityTokens.some((t) => summary.toLowerCase().includes(t))) {
    summary = `${entity}: ${summary}`;
  }
  // Guarantee an event mention (E4-c): append the classified event label.
  if (input.eventLabel && summary && !eventTokens.some((t) => summary.toLowerCase().includes(t))) {
    summary = `${summary.replace(/[.\s]+$/, "")} — ${input.eventLabel.toLowerCase()}.`;
  }
  if (!summary) {
    // Title fallback: the headline itself is a faithful compression.
    summary = entity ? `${entity}: ${stripDateline(title)}` : stripDateline(title);
  }

  return excerpt(summary, 400);
}
