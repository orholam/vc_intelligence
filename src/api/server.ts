import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { getConfig } from "../config.js";
import { AppError, Errors } from "../lib/errors.js";
import { makeAuthHook, sendError } from "./auth.js";
import { checkRateLimit } from "./ratelimit.js";
import type { AppDeps } from "./deps.js";
import { buildOpenApiDoc } from "./openapi.js";
import { registerNewsRoutes } from "./routes/news.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerListGenRoutes } from "./routes/listgen.js";
import { registerFeedRoutes } from "./routes/feed.js";
import { registerWebhookAndTakedownRoutes } from "./routes/webhooks.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerInternalLlmRoutes } from "./routes/internal.js";
import { registerExoskeletonRoutes } from "./routes/exoskeleton.js";

const PUBLIC_PATHS = new Set([
  "/healthz",
  "/openapi.json",
  // Exoskeleton ops console — intentionally unauthenticated for now (admin gate later).
  "/v1/exoskeleton/snapshot",
  "/v1/exoskeleton/stream",
]);

export function buildApiApp(deps: AppDeps): FastifyInstance {
  const cfg = getConfig();
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 2_000_000,
    disableRequestLogging: process.env.NODE_ENV === "test",
  });

  const origins = cfg.API_PUBLIC_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  void app.register(cors, {
    origin: origins.length ? origins : false, // locked to configured origins (NFR-6)
    credentials: false,
  });

  // Structured request logs with ids (NFR-4).
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0]!;
    if (
      PUBLIC_PATHS.has(path) ||
      path.startsWith("/v1/exoskeleton/") ||
      path.startsWith("/internal/")
    )
      return; // internal routes guard themselves; exoskeleton is an unauthenticated ops surface
    try {
      const auth = await makeAuthHook(deps.db)(request);
      checkRateLimit(auth.keyId, auth.rateLimitPerMin);
    } catch (e) {
      throw e;
    }
  });

  app.setErrorHandler((err: Error, request: FastifyRequest, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.statusCode).send(err.toBody());
      return;
    }
    if (err instanceof ZodError) {
      void reply.status(422).send(
        Errors.validation("request validation failed", err.issues.slice(0, 5)).toBody(),
      );
      return;
    }
    if ("statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number") {
      // fastify internals (body too large, bad json, 404 route, etc.)
      const code = Number((err as { statusCode: number }).statusCode);
      void reply
        .status(code)
        .send({ error: { code: code === 404 ? "not_found" : "bad_request", message: err.message.slice(0, 300) } });
      return;
    }
    request.log.error({ err: err.message, stack: (err as Error).stack?.split("\n").slice(0, 4).join(" | ") }, "unhandled error");
    sendError(reply, err);
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "intelligence",
    time: new Date().toISOString(),
  }));

  app.get("/openapi.json", async (_request, reply) => {
    return reply.send(
      buildOpenApiDoc({
        title: "Copyr Intelligence API",
        version: "1.0.0",
        description:
          "Entity-resolved company news signals and natural-language company lists (ListGen). Auth: x-api-key header.",
      }),
    );
  });

  app.register(async (scoped) => {
    registerNewsRoutes(scoped, deps);
    registerCompanyRoutes(scoped, deps);
    registerEventRoutes(scoped, deps);
    registerListGenRoutes(scoped, deps);
    registerFeedRoutes(scoped, deps);
    registerWebhookAndTakedownRoutes(scoped, deps);
    registerAdminRoutes(scoped, deps);
    registerExoskeletonRoutes(scoped, deps);
    // Own encapsulated scope so the harness guard hook never wraps v1 routes.
    scoped.register(async (internalScope) => {
      registerInternalLlmRoutes(internalScope, deps);
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: { code: "not_found", message: "route not found" } });
  });

  return app;
}
