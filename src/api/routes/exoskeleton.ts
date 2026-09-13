import type { FastifyInstance } from "fastify";
import { getConfig } from "../../config.js";
import { getExoskeletonSnapshot, listStageItems } from "../../ops/exoskeleton.js";
import { createMisflag, deleteMisflag, listMisflags } from "../../ops/misflags.js";
import { injectGhostNews } from "../../ops/ghost.js";
import { journeyBus, recentJourneys } from "../../ops/traces.js";
import type { JourneyPackage } from "../../ops/traces.js";
import { QUEUE } from "../../queue/jobs.js";
import { opaqueId } from "../../lib/ulid.js";
import { logger } from "../../lib/logger.js";
import type { AppDeps } from "../deps.js";

/**
 * Live Pipeline (exoskeleton) — observability surface (internal ops, no auth
 * for now; will move behind an admin gate later). NOT part of the public
 * OpenAPI doc. Endpoints:
 *
 *   GET  /v1/exoskeleton/snapshot     full current-state JSON (polling fallback)
 *   GET  /v1/exoskeleton/stream       SSE: `snapshot` (~2s) + `journey` events
 *                                    (one package per item reaching a terminal
 *                                    bucket; no history replay on connect)
 *   GET  /v1/exoskeleton/journeys     completed packages since a cursor
 *                                    (poll fallback for the animation)
 *   GET  /v1/exoskeleton/stage/:node  items currently in (or last through) a node
 *   GET  /v1/exoskeleton/flags        operator miscategorization flags (durable)
 *   POST /v1/exoskeleton/flags        flag an item as miscategorized { ref_id, … }
 *   DELETE /v1/exoskeleton/flags/:id  remove a flag
 *   POST /v1/exoskeleton/harness/run  fire the waiting-room harness batch now
 *   POST /v1/exoskeleton/ghost        inject a synthetic news item into the pipeline
 */

const STREAM_INTERVAL_MS = 2000;
const HEARTBEAT_MS = 15_000;

export function registerExoskeletonRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/v1/exoskeleton/snapshot", async (_request, reply) => {
    const snap = await getExoskeletonSnapshot(deps.db, deps.router);
    return reply.send(snap);
  });

  app.get("/v1/exoskeleton/stage/:node", async (request, reply) => {
    const node = String((request.params as { node?: string }).node ?? "");
    const q = request.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 40;
    const body = await listStageItems(deps.db, node, Number.isFinite(limit) ? limit : 40);
    return reply.send(body);
  });

  app.get("/v1/exoskeleton/journeys", async (request, reply) => {
    const q = request.query as { since?: string; limit?: string };
    const limit = q.limit ? Number(q.limit) : 40;
    const journeys = await recentJourneys(
      deps.db,
      q.since && !Number.isNaN(Date.parse(q.since)) ? q.since : null,
      Number.isFinite(limit) ? limit : 40,
    );
    return reply.send({ journeys });
  });

  app.get("/v1/exoskeleton/flags", async (request, reply) => {
    const q = request.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 250;
    const flags = await listMisflags(deps.db, Number.isFinite(limit) ? limit : 250);
    return reply.send({ flags });
  });

  app.post("/v1/exoskeleton/flags", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const refId = typeof body.ref_id === "string" ? body.ref_id.trim() : "";
    if (!refId) {
      return reply.status(400).send({ error: { code: "ref_id_required", message: "ref_id is required" } });
    }
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const flag = await createMisflag(deps.db, {
      refId,
      kind: body.kind === "raw" || body.kind === "fact" ? body.kind : "article",
      title: typeof body.title === "string" ? body.title : null,
      terminalNode: typeof body.terminal_node === "string" ? body.terminal_node : null,
      detail: typeof body.detail === "string" ? body.detail : null,
      steps: steps as JourneyPackage["steps"],
      note: typeof body.note === "string" ? body.note : null,
    });
    return reply.status(201).send({ ok: true, flag });
  });

  app.delete("/v1/exoskeleton/flags/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    const removed = await deleteMisflag(deps.db, id);
    if (!removed) {
      return reply.status(404).send({ error: { code: "not_found", message: "flag not found" } });
    }
    return reply.send({ ok: true });
  });

  app.post("/v1/exoskeleton/harness/run", async (_request, reply) => {
    const runId = opaqueId("run");
    if (!deps.enqueue) {
      return reply.status(503).send({
        error: { code: "pipeline_unavailable", message: "pipeline enqueue is not running in this process" },
      });
    }
    try {
      await deps.enqueue(QUEUE.harnessRun, { runId });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "harness run enqueue failed");
      return reply.status(500).send({
        error: { code: "enqueue_failed", message: "could not queue the harness run" },
      });
    }
    const cfg = getConfig();
    const key = cfg.LLM_API_KEY.trim();
    const usableKey = key.length > 8 && !/^sk-(xxx|test|placeholder)$/i.test(key);
    return reply.status(202).send({
      ok: true,
      run_id: runId,
      llm_provider: cfg.LLM_PROVIDER,
      claim_while_running: true,
      part1_stage: "batch_audit",
      answer_timeout_ms: cfg.LLM_HARNESS_TIMEOUT_MS,
      mock_fallback: cfg.LLM_PROVIDER === "auto" && usableKey,
    });
  });

  app.post("/v1/exoskeleton/ghost", async (_request, reply) => {
    if (!deps.enqueue) {
      return reply.status(503).send({
        error: { code: "pipeline_unavailable", message: "pipeline enqueue is not running in this process" },
      });
    }
    const ghost = await injectGhostNews(deps.db, deps.enqueue);
    return reply.status(202).send({ ok: true, ...ghost });
  });

  app.get("/v1/exoskeleton/stream", async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write("retry: 3000\n\n");

    let closed = false;
    let pushing = false;
    const push = async () => {
      if (closed || pushing) return;
      pushing = true;
      try {
        const snap = await getExoskeletonSnapshot(deps.db, deps.router);
        if (!closed) raw.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      } catch {
        if (!closed) raw.write(`event: error\ndata: {"message":"snapshot build failed"}\n\n`);
      } finally {
        pushing = false;
      }
    };
    void push();
    const iv = setInterval(() => void push(), STREAM_INTERVAL_MS);

    // One package per item at its terminal bucket — the console animates the
    // packaged path exactly once, on receipt.
    const onJourney = (pkg: JourneyPackage) => {
      if (closed) return;
      try {
        raw.write(`event: journey\ndata: ${JSON.stringify(pkg)}\n\n`);
      } catch {
        /* client vanished mid-write; close handler cleans up */
      }
    };
    journeyBus.on("journey", onJourney);

    const hb = setInterval(() => {
      if (!closed) raw.write(":hb\n\n");
    }, HEARTBEAT_MS);
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(iv);
      clearInterval(hb);
      journeyBus.off("journey", onJourney);
      try {
        raw.end();
      } catch {
        /* already gone */
      }
    };
    request.raw.on("close", stop);
    request.raw.on("error", stop);
  });
}
