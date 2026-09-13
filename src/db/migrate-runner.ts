import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Shared migration runner used by the CLI and the backfill scaffolding. */
export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  await db.execute(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(`CREATE EXTENSION IF NOT EXISTS vector`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir =
    process.env.MIGRATIONS_DIR ?? path.resolve(here, "../../migrations");
  if (!fs.existsSync(migrationsDir)) throw new Error(`migrations dir missing: ${migrationsDir}`);
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

  await client.end();
}
