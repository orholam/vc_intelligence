import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getConfig } from "../config.js";

/** Applies SQL migrations + extensions + audit views. Idempotent. */
async function main(): Promise<void> {
  const cfg = getConfig();
  const client = postgres(cfg.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve(here, "../../migrations");
  if (!fs.existsSync(migrationsDir)) throw new Error(`migrations dir missing: ${migrationsDir}`);

  await db.execute(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(`CREATE EXTENSION IF NOT EXISTS vector`);

  await migrate(db, { migrationsFolder: migrationsDir });

  // FR-5 sampled discard-audit view.
  await db.execute(`
    CREATE OR REPLACE VIEW v_discard_audit AS
    SELECT id, url, title, publisher_domain, published_at,
           noise_stage AS discard_stage, noise_score, discard_reason,
           source_id, created_at
    FROM articles
    WHERE noise_stage IN ('prefilter', 'llm_filter')
  `);

  console.error(JSON.stringify({ ok: true, migrations: migrationsDir }));
  await client.end();
}

main().catch((err: Error) => {
  console.error("migrate failed:", err.message);
  process.exit(1);
});
