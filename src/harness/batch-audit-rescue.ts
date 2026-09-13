import { COMPANY_EVENT_SIGNAL_RE } from "../lib/quality.js";
import { extractTitleSubject } from "../lib/title-subject.js";
import type { BatchAuditVerdict } from "./batch-audit.js";

/** Dollar/euro amounts, named rounds, IPO, crowdfunding — not bare commentary verbs. */
const QUANTIFIED_EVENT_RE =
  /(\$\s?[\d.,]+\s*(million|billion|bn|m\b|k\b)|\bUSD\s?[\d.,]+|(€|£|₹)\s?[\d.,]+|series [a-f]\b|\bipo\b|crowdfund)/i;

/** Reasons the harness agent over-drops during fast drains (editorial false negatives). */
const SOFT_DROP_REASON_RE =
  /re-?pipeline|soft noise|stock tip|form d|crowdfunding soft|curb inco|commentary|earnings call|jim cramer|tagless_veto|already processed/i;

export interface BatchAuditRescueOpts {
  /** Prior discard_reason on the article row (e.g. requeue:editorial_fp). */
  priorDiscardReason?: string | null;
}

/**
 * True when a batch_audit drop should be overridden: the headline itself
 * reports a discrete, quantified company event anchored to a named subject.
 */
export function shouldRescueBatchAuditDrop(
  title: string,
  verdict: { keep: boolean; reason?: string },
  opts?: BatchAuditRescueOpts,
): boolean {
  if (verdict.keep) return false;
  const hay = title.trim();
  if (!COMPANY_EVENT_SIGNAL_RE.test(hay)) return false;

  const quantified =
    QUANTIFIED_EVENT_RE.test(hay) ||
    /\b(acquir(e[sd]?|ing)|merger|emerges? from stealth|launches? with)\b/i.test(hay);
  if (!quantified) return false;

  if (opts?.priorDiscardReason?.startsWith("requeue:")) return true;
  if (verdict.reason && SOFT_DROP_REASON_RE.test(verdict.reason)) return true;
  if (extractTitleSubject(hay)) return true;

  return false;
}

/** Flip keep=true and backfill subject_name when rescue triggers. */
export function rescueBatchAuditVerdict(
  verdict: BatchAuditVerdict,
  title: string,
  opts?: BatchAuditRescueOpts,
): BatchAuditVerdict {
  if (!shouldRescueBatchAuditDrop(title, verdict, opts)) return verdict;
  return {
    ...verdict,
    keep: true,
    reason: `rescue:company_event${verdict.reason ? ` · was: ${verdict.reason.slice(0, 80)}` : ""}`.slice(
      0,
      200,
    ),
    subject_name: verdict.subject_name ?? extractTitleSubject(title),
    newsworthiness: verdict.newsworthiness === "low" ? "medium" : verdict.newsworthiness,
  };
}
