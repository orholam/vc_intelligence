/**
 * Clear orphan harness lock + fail stuck active harness-run pg-boss jobs.
 * Run after killing the dev server mid-harness.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/harness-recover-stale.ts
 */
import { sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  const jobs = await db.execute(sql`
    UPDATE pgboss.job
    SET state = 'failed', completed_on = now()
    WHERE name = 'harness-run' AND state = 'active'
    RETURNING id
  `);
  const jobRows = (jobs as { rows?: { id: string }[] }).rows ?? [];
  await db.execute(sql`
    UPDATE kv_state
    SET value = jsonb_build_object(
      'status', 'done',
      'lastRun', (SELECT value->'lastRun' FROM kv_state WHERE key = 'harness_run')
    ), updated_at = now()
    WHERE key = 'harness_run'
  `);
  console.log(`failed ${jobRows.length} active harness-run job(s); released harness_run lock`);
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
