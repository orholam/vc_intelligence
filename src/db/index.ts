import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };

/**
 * Create a Drizzle client over postgres-js.
 * `max: 1` for scripts/tests; the app uses a small pool sized for one VPS.
 */
export function createDb(databaseUrl: string, opts: { max?: number } = {}): Db {
  const client = postgres(databaseUrl, {
    max: opts.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return drizzle(client, { schema });
}

/** Extensions + views that must exist before/alongside migrations. */
export async function ensureExtensionsAndViews(db: Db): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  // FR-5 AC: sampled audit view over discards.
  await db.execute(sql`
    CREATE OR REPLACE VIEW v_discard_audit AS
    SELECT id, url, title, publisher_domain, published_at,
           noise_stage AS discard_stage,
           noise_score,
           discard_reason,
           source_id,
           created_at
    FROM articles
    WHERE noise_stage IN ('prefilter', 'llm_filter')
  `);
}
