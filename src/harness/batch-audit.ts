import { z } from "zod";
import { flattenEventTypes, getFilters, getIndustriesTaxonomy, getTemplate, renderPrompt } from "../config-files.js";
import type { LlmRouter } from "../llm/router.js";
import { excerpt } from "../lib/text.js";

/**
 * Harness part 1: one model pass over a waiting-room pile.
 *
 * The audit is supposed to look at the batch the way an editor would — keep,
 * drop, retag, catch misclassification — not open each article as its own
 * LLM job. Later harness parts (deep search, card updates) hone in on the
 * companies that survive.
 */

export const BatchAuditItem = z.object({
  index: z.number().int().min(0),
  keep: z.boolean(),
  reason: z.string().default(""),
  primary_tag: z.string().nullable().default(null),
  secondary_tags: z.array(z.string()).default([]),
  sentiment: z.enum(["positive", "negative", "neutral"]).default("neutral"),
  sentiment_score: z.number().min(-1).max(1).default(0),
  newsworthiness: z.enum(["high", "medium", "low"]).default("low"),
  industry_primary: z.string().nullable().default(null),
  industry_secondary: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]),
  subject_name: z.string().nullable().default(null),
});

export const BatchAuditResponse = z.object({
  items: z.array(BatchAuditItem),
});

export type BatchAuditVerdict = z.infer<typeof BatchAuditItem>;

export interface BatchAuditInput {
  id: string;
  title: string;
  publisherDomain: string;
  lead: string;
}

export interface BatchAuditResult {
  byIndex: Map<number, BatchAuditVerdict>;
  model: string;
  ok: boolean;
  error?: string;
}

function sanitizeItem(
  raw: z.infer<typeof BatchAuditItem>,
  validEvents: Set<string>,
  validSectors: Set<string>,
): BatchAuditVerdict {
  const primary = raw.primary_tag && validEvents.has(raw.primary_tag) ? raw.primary_tag : null;
  const secondary = raw.secondary_tags.filter((t) => validEvents.has(t) && t !== primary).slice(0, 3);
  const industry =
    raw.industry_primary && validSectors.has(raw.industry_primary) && raw.industry_primary !== "other_diversified"
      ? raw.industry_primary
      : null;
  return {
    ...raw,
    reason: raw.reason.slice(0, 200),
    primary_tag: primary,
    secondary_tags: secondary,
    industry_primary: industry,
    industry_secondary: raw.industry_secondary.filter((s) => validSectors.has(s)).slice(0, 2),
    countries: [...new Set(raw.countries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 4),
    subject_name: raw.subject_name?.trim() ? raw.subject_name.trim().slice(0, 160) : null,
  };
}

function formatChunk(chunk: BatchAuditInput[], offset: number): string {
  return chunk
    .map((item, i) => {
      const n = offset + i;
      const lead = excerpt(item.lead || item.title, 280).replace(/\n+/g, " ");
      return `### ITEM ${n}\nPUBLISHER: ${item.publisherDomain}\nTITLE: ${item.title}\nLEAD: ${lead}`;
    })
    .join("\n\n");
}

/** One editor-style pass over a slice of the waiting-room pile. */
export async function auditOneChunk(
  router: LlmRouter,
  inputs: BatchAuditInput[],
  offset: number,
  chunkSize: number,
): Promise<BatchAuditResult> {
  const byIndex = new Map<number, BatchAuditVerdict>();
  const chunk = inputs.slice(offset, offset + chunkSize);
  if (chunk.length === 0) return { byIndex, model: "none", ok: true };

  const events = flattenEventTypes();
  const sectors = getIndustriesTaxonomy().sectors;
  const validEvents = new Set(events.list.map((e) => e.id));
  const validSectors = new Set(sectors.map((s) => s.id));
  const tpl = getTemplate("batch_audit");
  const { system, user, templateVersion } = renderPrompt(tpl, {
    event_types: events.list.map((e) => e.id).join(", "),
    sectors: sectors.map((s) => s.id).join(", "),
    items: formatChunk(chunk, offset),
  });
  const call = await router.chatJson(BatchAuditResponse, system, user, {
    stage: "batch_audit",
    tier: "mini",
    promptTemplate: "batch_audit",
    promptTemplateVersion: templateVersion,
    articleId: null,
  });
  if (!call.ok) {
    return { byIndex, model: call.model, ok: false, error: call.error.slice(0, 200) };
  }
  for (const raw of call.data.items) {
    const sanitized = sanitizeItem(raw, validEvents, validSectors);
    byIndex.set(sanitized.index, sanitized);
  }
  return { byIndex, model: call.model, ok: true };
}

/**
 * Run the batch audit over `inputs` in chunks. Missing indexes default to
 * drop (keep=false) so a truncated model reply cannot silently publish.
 */
export async function auditWaitingBatch(
  router: LlmRouter,
  inputs: BatchAuditInput[],
): Promise<BatchAuditResult> {
  const byIndex = new Map<number, BatchAuditVerdict>();
  if (inputs.length === 0) return { byIndex, model: "none", ok: true };
  const chunkSize = getFilters().harness?.audit_chunk_size ?? 40;
  let model = "unknown";
  let ok = true;
  let error: string | undefined;
  for (let offset = 0; offset < inputs.length; offset += chunkSize) {
    const part = await auditOneChunk(router, inputs, offset, chunkSize);
    model = part.model;
    if (!part.ok) {
      ok = false;
      error = part.error;
      continue;
    }
    for (const [index, verdict] of part.byIndex) byIndex.set(index, verdict);
  }
  return { byIndex, model, ok, error };
}
