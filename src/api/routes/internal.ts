import type { FastifyInstance } from "fastify";
import { getConfig, type AppConfig } from "../../config.js";
import { Errors } from "../../lib/errors.js";
import type { AppDeps } from "../deps.js";
import {
  claimNextHarnessRequest,
  expireStaleHarnessRequests,
  harnessQueueStats,
  submitHarnessResult,
  HarnessResultSchema,
} from "../../llm/harness.js";

const POLL_MS = 400;

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Shared-secret gate; falls back to socket-loopback-only when HARNESS_KEY is unset. */
function harnessAuthorized(cfg: AppConfig, request: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): boolean {
  const provided = request.headers["x-harness-key"];
  if (cfg.HARNESS_KEY) {
    if (typeof provided !== "string" || provided.length !== cfg.HARNESS_KEY.length) return false;
    let diff = 0;
    for (let i = 0; i < cfg.HARNESS_KEY.length; i++) {
      diff |= provided.charCodeAt(i)! ^ cfg.HARNESS_KEY.charCodeAt(i)!;
    }
    return diff === 0;
  }
  // Socket address, not request.ip — X-Forwarded-For must never grant loopback.
  return isLoopback(request.socket?.remoteAddress);
}

/**
 * Internal work API for LLM_PROVIDER=harness (path 2). NOT part of the public
 * v1 surface: excluded from OpenAPI and from x-api-key auth; guarded by
 * HARNESS_KEY or loopback-only socket access.
 */
export function registerInternalLlmRoutes(app: FastifyInstance, deps: AppDeps): void {
  const cfg = getConfig();

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    if (!harnessAuthorized(cfg, request as unknown as { headers: Record<string, unknown>; socket?: { remoteAddress?: string } })) {
      void reply.status(403).send({ error: { code: "forbidden", message: "harness access denied" } });
    }
  });

  /**
   * Claim one pending completion. `wait` long-polls up to 30s so a polling
   * harness can keep a single steady request in flight.
   */
  app.get("/internal/llm/claim", async (request, reply) => {
    const waitSec = Math.min(Number((request.query as { wait?: string }).wait ?? 0) || 0, 30);
    await expireStaleHarnessRequests(deps.db, cfg.LLM_HARNESS_TIMEOUT_MS);
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const req = await claimNextHarnessRequest(deps.db);
      if (req) return reply.send({ request: req });
      if (Date.now() >= deadline) return reply.send({ request: null });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });

  /** Answer a claimed completion. Idempotent; 409 once already resolved. */
  app.post("/internal/llm/:id/result", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = HarnessResultSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validation("invalid harness result", parsed.error.issues.slice(0, 5));
    }
    const accepted = await submitHarnessResult(deps.db, id, parsed.data);
    if (!accepted) throw Errors.conflict(`request ${id} already resolved or unknown`);
    return reply.send({ ok: true });
  });

  /** Tiny observability window for operators/harness loops. */
  app.get("/internal/llm/stats", async () => {
    const c = getConfig();
    const key = c.LLM_API_KEY.trim();
    const usableKey = key.length > 8 && !/^sk-(xxx|test|placeholder)$/i.test(key);
    return {
      ok: true,
      queue: await harnessQueueStats(deps.db),
      llm_provider: c.LLM_PROVIDER,
      answer_timeout_ms: c.LLM_HARNESS_TIMEOUT_MS,
      mock_fallback: c.LLM_PROVIDER === "auto" && usableKey,
    };
  });
}
