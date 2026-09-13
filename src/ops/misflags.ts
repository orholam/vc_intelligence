import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { pipelineMisflags } from "../db/schema.js";
import { opaqueId } from "../lib/ulid.js";
import type { JourneyStep } from "./traces.js";

/**
 * Operator miscategorization flags (exoskeleton Live Pipeline).
 *
 * The durable review trail a human leaves when they disagree with an item's
 * terminal verdict: discard that should have been kept, winner that should
 * have been dropped, waiting-room item that was never relevant, etc. Unlike
 * pipeline_traces/journeys these rows DO NOT self-clean — the console shows
 * them (with a steps snapshot) long after the original journey expired.
 */

export type MisflagKind = "raw" | "article" | "fact";

export interface MisflagInput {
  refId: string;
  kind?: MisflagKind;
  title?: string | null;
  terminalNode?: string | null;
  detail?: string | null;
  steps?: JourneyStep[] | null;
  note?: string | null;
}

export interface MisflagRow {
  id: string;
  ref_id: string;
  kind: MisflagKind;
  title: string | null;
  terminal_node: string | null;
  detail: string | null;
  steps: JourneyStep[] | null;
  note: string | null;
  created_at: string;
}

function map(row: Record<string, unknown>): MisflagRow {
  return {
    id: String(row.id),
    ref_id: String(row.refId),
    kind: String(row.kind ?? "article") as MisflagKind,
    title: row.title === null || row.title === undefined ? null : String(row.title),
    terminal_node: row.terminalNode === null || row.terminalNode === undefined ? null : String(row.terminalNode),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    steps: Array.isArray(row.steps) ? (row.steps as JourneyStep[]) : null,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    created_at: toIso(row.createdAt),
  };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v ?? Date.now()));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** Newest first; bounded so the ops surface stays snappy. */
export async function listMisflags(db: Db, limit = 250): Promise<MisflagRow[]> {
  const lim = Math.min(500, Math.max(1, Math.floor(limit)));
  const rows = await db
    .select()
    .from(pipelineMisflags)
    .orderBy(desc(pipelineMisflags.createdAt))
    .limit(lim);
  return rows.map((r) => map(r as unknown as Record<string, unknown>));
}

export async function createMisflag(db: Db, input: MisflagInput): Promise<MisflagRow> {
  const [row] = await db
    .insert(pipelineMisflags)
    .values({
      id: opaqueId("mfl"),
      refId: input.refId,
      kind: input.kind ?? "article",
      title: input.title ? input.title.slice(0, 300) : null,
      terminalNode: input.terminalNode ? input.terminalNode.slice(0, 60) : null,
      detail: input.detail ? input.detail.slice(0, 400) : null,
      steps: Array.isArray(input.steps) ? input.steps.slice(0, 60) : null,
      note: input.note ? input.note.slice(0, 500) : null,
    })
    .returning();
  return map((row ?? {}) as Record<string, unknown>);
}

/** Returns false when no flag had that id. */
export async function deleteMisflag(db: Db, id: string): Promise<boolean> {
  if (!id) return false;
  const rows = await db
    .delete(pipelineMisflags)
    .where(eq(pipelineMisflags.id, id))
    .returning({ id: pipelineMisflags.id });
  return rows.length > 0;
}