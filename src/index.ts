import { getConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { logger } from "./lib/logger.js";
import { makeProvider, LlmRouter } from "./llm/router.js";
import { SourceRegistry } from "./sources/registry.js";
import { EntityKb } from "./entities/kb.js";
import { makeStorage } from "./storage.js";
import { buildApiApp } from "./api/server.js";
import type { AppDeps } from "./api/deps.js";
import { ALL_QUEUES, registerWorkers, startSchedules, type PipelineDeps } from "./queue/jobs.js";
import { createBoss, ensureQueues } from "./queue/boss.js";

/**
 * Entrypoint. Modes:
 *   all    (default) — API + pipeline workers in one process (single VPS target)
 *   api                 — HTTP API only
 *   worker              — pipeline workers only
 *
 * Optional --llm=<mock|openai-compatible|harness|auto> overrides LLM_PROVIDER
 * for this run (e.g. `pnpm dev -- --llm=harness`) without touching env files.
 */
async function main(): Promise<void> {
  const llmArg = process.argv.find((a) => a.startsWith("--llm="))?.split("=")[1];
  if (llmArg && ["mock", "openai-compatible", "harness", "auto"].includes(llmArg)) {
    process.env.LLM_PROVIDER = llmArg;
  }
  const cfg = getConfig();
  const onVercel = Boolean(process.env.VERCEL);
  const mode = (
    onVercel
      ? "api"
      : (process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "all")
  ) as "all" | "api" | "worker";

  const db = createDb(cfg.DATABASE_URL, { max: onVercel ? 1 : 10 });
  const router = new LlmRouter(db, makeProvider(cfg, db));
  const registry = new SourceRegistry(db);
  const kb = new EntityKb(db);
  const storage = makeStorage(cfg);

  const deps: AppDeps & PipelineDeps = { db, router, registry, kb, storage };

  if (mode === "all" || mode === "worker") {
    const boss = await createBoss();
    await boss.start();
    await ensureQueues(boss, ALL_QUEUES);
    deps.enqueue = async (queue, data, options) => boss.send(queue, data as object, options);
    await registerWorkers(boss, deps);
    await startSchedules(boss, deps, async (queue, data, options) => boss.send(queue, data as object, options));
    logger.info("pipeline workers started");

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, async () => {
        logger.info({ signal }, "shutting down");
        try {
          await boss.stop();
        } finally {
          process.exit(0);
        }
      });
    }
  }

  if (mode === "all" || mode === "api") {
    const app = buildApiApp(deps);
    const port = Number(process.env.PORT ?? cfg.APP_PORT);
    await app.listen({ port, host: "0.0.0.0" });
    logger.info({ port, mode }, "API listening");
  }

  // DB connectivity sanity for the API-only mode too.
  if (mode === "api") {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => process.exit(0));
    }
  }
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, "fatal startup error");
  process.exit(1);
});
