import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { resetConfigCache } from "../../src/config.js";

/**
 * Offline Postgres for tests: PGlite (WASM) with the bundled pgvector +
 * pg_trgm extensions where available. Applies the generated drizzle migration,
 * tolerating index types whose extension is missing in the WASM build.
 */
export interface TestDb {
  db: PgliteDatabase;
  client: PGlite;
  url: string;
  destroy(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intel-pglite-"));
  const client = new PGlite(dir, { extensions: { vector } });

  let trgm = false;
  try {
    await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    trgm = true;
  } catch {
    /* not bundled */
  }
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector;");

  const db = drizzle(client);

  // Apply migration SQL in order, skipping extension-dependent indexes when absent.
  const migrationsDir =
    process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of sqlFiles) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const statements = raw.split("--> statement-breakpoint");
    for (let stmt of statements) {
      stmt = stmt.trim();
      if (!stmt) continue;
      const needsTrgm = stmt.includes("gin_trgm_ops");
      // DROP INDEX statements for trgm indexes also fail when the extension
      // (and therefore the index) was never created.
      const touchesTrgm = needsTrgm || /_trgm_idx/.test(stmt);
      if (touchesTrgm && !trgm) continue;
      try {
        await client.exec(stmt);
      } catch (e) {
        // HNSW availability varies across pglite builds; degrade gracefully.
        if (/hnsw|vector_cosine/i.test(stmt)) continue;
        throw e;
      }
    }
  }

  await client.exec(`
    CREATE OR REPLACE VIEW v_discard_audit AS
    SELECT id, url, title, publisher_domain, published_at,
           noise_stage AS discard_stage, noise_score, discard_reason,
           source_id, created_at
    FROM articles WHERE noise_stage IN ('prefilter','llm_filter');
  `);

  return {
    db,
    client,
    url: dir,
    async destroy() {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Point the service config at a temp local-storage dir per test file. */
export function isolateConfig(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intel-store-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_DIR = dir;
  process.env.LLM_PROVIDER = "mock";
  resetConfigCache();
}

/**
 * Drizzle returns raw rows as an array under postgres-js but as
 * `{ rows: [...] }` under PGlite. Production code assumes the postgres-js
 * shape; this wrapper preserves the prototype while normalizing execute().
 */
export function normalizeExecuteShape<T extends object>(db: T): T {
  const wrapped = Object.create(db) as T & {
    execute: (...args: unknown[]) => Promise<unknown>;
  };
  const original = (db as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute.bind(db);
  wrapped.execute = async (...args: unknown[]) => {
    const result = await original(...args);
    if (Array.isArray(result)) return result;
    return (result as { rows?: unknown[] }).rows ?? [];
  };
  return wrapped;
}
