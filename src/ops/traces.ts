import { sql } from "drizzle-orm";
import { EventEmitter } from "node:events";
import type { Db } from "../db/index.js";
import { pipelineJourneys, pipelineTraces } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";

/**
 * Live Pipeline item tracing.
 *
 * Pipeline handlers record each hop fire-and-forget into `pipeline_traces`
 * (the internal step buffer). When an item reaches a TERMINAL bucket, the
 * whole path is assembled into a single journey package (`pipeline_journeys`)
 * and pushed on `journeyBus` — one SSE event per item, replayed end-to-end by
 * the console. There is no history backpropagation: clients only ever animate
 * packages that complete after they connected (or arrive via the poll
 * fallback cursor). Never throws, never blocks the pipeline — a lost trace is
 * invisible cosmetics, not a correctness issue.
 */

export type TraceKind = "raw" | "article" | "fact";

/** Valid diagram node ids (must match web/src/pages/Exoskeleton.tsx). */
const TRACE_NODES = new Set([
  // sources
  "src_rss",
  "src_gdelt",
  "src_search",
  "src_launch",
  "src_formd",
  // programmatic chain
  "raw",
  "fetch",
  "prefilter",
  "dedupe",
  "waiting_room",
  // harness
  "harness",
  "cluster",
  "facts",
  "winners",
  "webhooks",
  // terminal buckets
  "fetch_failed",
  "prefilter_discards",
  "harness_discards",
]);

/** Buckets that end an item's journey and trigger package assembly.
 *  `dedupe` is terminal only for syndicated discards — unique pass-through
 *  hops are skipped in recordTrace so the waiting-room package is the one event. */
const TERMINAL_NODES = new Set([
  "fetch_failed",
  "prefilter_discards",
  "dedupe", // syndicated/stale dupes park here with an auditable reason
  "waiting_room",
  "harness_discards",
  "winners",
]);

export function isTerminalNode(node: string): boolean {
  return TERMINAL_NODES.has(node);
}

export interface TraceInput {
  node: string;
  refId: string;
  kind: TraceKind;
  label?: string | null;
  detail?: string | null;
}

export interface JourneyStep {
  node: string;
  ts: string;
  label: string | null;
  detail: string | null;
}

export interface JourneyPackage {
  id: string;
  ref_id: string;
  terminal_node: string;
  title: string | null;
  steps: JourneyStep[];
  created_at: string;
}

/** In-process fan-out of completed packages to SSE subscribers. */
export const journeyBus = new EventEmitter();
journeyBus.setMaxListeners(50);

export async function recordTrace(db: Db, input: TraceInput): Promise<void> {
  if (!TRACE_NODES.has(input.node)) {
    logger.debug({ node: input.node }, "trace dropped: unknown node");
    return;
  }
  try {
    await db.insert(pipelineTraces).values({
      id: opaqueId("trc"),
      node: input.node,
      refId: input.refId,
      kind: input.kind,
      label: input.label ? clip(input.label) : null,
      detail: input.detail ? clip(input.detail, 160) : null,
    });
  } catch (e) {
    logger.debug({ err: (e as Error).message }, "pipeline trace insert failed");
    return;
  }
  if (TERMINAL_NODES.has(input.node)) {
    // `dedupe` is both a pass-through hop (unique) and a discard sink.
    // Only the discard is a package; survivors wait for waiting_room.
    const passThroughDedupe =
      input.node === "dedupe" && (input.detail ?? "").toLowerCase().startsWith("unique");
    if (!passThroughDedupe) {
      try {
        await assembleJourney(db, input);
      } catch (e) {
        logger.warn(
          { err: (e as Error).message, node: input.node, refId: input.refId },
          "journey assemble failed",
        );
      }
    }
  }
}

/** Fold the buffered hops for this item into one journey package and broadcast it. */
async function assembleJourney(db: Db, input: TraceInput): Promise<void> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT node, label, detail, created_at FROM pipeline_traces
    WHERE ref_id = ${input.refId}
    ORDER BY created_at ASC, id ASC
    LIMIT 60
  `);
  if (!rows.length) return;
  const steps: JourneyStep[] = rows.map((r) => ({
    node: String(r.node),
    ts: toIso(r.created_at),
    label: r.label === null || r.label === undefined ? null : clip(String(r.label), 140),
    detail: r.detail === null || r.detail === undefined ? null : clip(String(r.detail), 160),
  }));
  const title =
    [...steps].reverse().find((s) => s.label)?.label ??
    steps[0]?.label ??
    input.refId;
  const pkg = {
    id: opaqueId("jrn"),
    refId: input.refId,
    terminalNode: input.node,
    title,
    steps,
  };
  let createdAt = new Date().toISOString();
  try {
    const inserted = await db
      .insert(pipelineJourneys)
      .values({
        id: pkg.id,
        refId: pkg.refId,
        terminalNode: pkg.terminalNode,
        title: pkg.title,
        steps: pkg.steps,
      })
      .onConflictDoNothing({ target: [pipelineJourneys.refId, pipelineJourneys.terminalNode] })
      .returning({ id: pipelineJourneys.id, createdAt: pipelineJourneys.createdAt });
    if (!inserted.length) return; // already packaged (retry race)
    createdAt = toIso(inserted[0]?.createdAt ?? new Date());
  } catch (e) {
    // Persist is best-effort. Still fan the package out so the console
    // replays the path — a missing table must not mute the animation.
    logger.warn(
      { err: (e as Error).message, refId: input.refId, node: input.node },
      "journey persist failed; emitting in-memory package",
    );
  }
  const out: JourneyPackage = {
    id: pkg.id,
    ref_id: pkg.refId,
    terminal_node: pkg.terminalNode,
    title: pkg.title,
    steps,
    created_at: createdAt,
  };
  journeyBus.emit("journey", out);
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v ?? Date.now()));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function clip(s: string, max = 140): string {
  const str = s.replace(/\s+/g, " ").trim();
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** Poll-fallback cursor read: journeys completed after `since`. */
export async function recentJourneys(
  db: Db,
  since: string | null,
  limit = 40,
): Promise<JourneyPackage[]> {
  const lim = Math.min(100, Math.max(1, Math.floor(limit)));
  try {
    const rows = since
      ? await db.execute<Record<string, unknown>>(sql`
          SELECT id, ref_id, terminal_node, title, steps, created_at
          FROM pipeline_journeys WHERE created_at > ${since}
          ORDER BY created_at ASC LIMIT ${lim}
        `)
      : await db.execute<Record<string, unknown>>(sql`
          SELECT id, ref_id, terminal_node, title, steps, created_at
          FROM pipeline_journeys ORDER BY created_at DESC LIMIT ${lim}
        `);
    return (since ? rows : [...rows].reverse()).map((r) => ({
      id: String(r.id),
      ref_id: String(r.ref_id),
      terminal_node: String(r.terminal_node),
      title: r.title === null || r.title === undefined ? null : String(r.title),
      steps: (r.steps ?? []) as JourneyStep[],
      created_at: toIso(r.created_at),
    }));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "recent journeys read failed");
    return [];
  }
}

let lastCleanupAt = 0;

/** Bounded self-cleaning so both tables stay tiny; called from snapshot builds. */
export async function cleanupOldTraces(db: Db): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < 5 * 60_000) return;
  lastCleanupAt = now;
  try {
    await db.execute(sql`DELETE FROM pipeline_traces WHERE created_at < now() - interval '2 hours'`);
    await db.execute(sql`DELETE FROM pipeline_journeys WHERE created_at < now() - interval '2 hours'`);
  } catch (e) {
    logger.debug({ err: (e as Error).message }, "trace cleanup failed");
  }
}
