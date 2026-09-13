import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import type { LlmRouter } from "../llm/router.js";
import type { SourceRegistry } from "../sources/registry.js";
import type { EntityKb } from "../entities/kb.js";
import type { Storage } from "../storage.js";

/** Shared dependencies handed to every route module. */
export interface AppDeps {
  db: Db;
  router: LlmRouter;
  registry: SourceRegistry;
  kb: EntityKb;
  storage: Storage;
  /** Present when this process can send pg-boss jobs (all/worker modes). */
  enqueue?: (queue: string, data: object, options?: { singletonKey?: string }) => Promise<unknown>;
}

export type App = FastifyInstance & { deps?: AppDeps };
