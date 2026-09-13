/**
 * Park scrub leftovers and mock-junk from the waiting room so harness batches
 * hit real unresolved news instead of re-scanning 3k+ already-decided rows.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/park-scrub-waiting.ts
 */
import { sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);

  const before = await db.execute(sql`SELECT count(*)::int AS c FROM articles WHERE noise_stage = 'waiting'`);
  const beforeN = Number((before as { rows?: { c: number }[] }).rows?.[0]?.c ?? 0);

  await db.execute(sql`
    UPDATE articles
    SET noise_stage = 'llm_filter', updated_at = now()
    WHERE noise_stage = 'waiting' AND discard_reason LIKE 'scrub:%'
  `);

  await db.execute(sql`
    UPDATE articles
    SET noise_stage = 'llm_filter', updated_at = now()
    WHERE noise_stage = 'waiting'
      AND discard_reason = 'harness:unresolved_subject'
      AND primary_tag = 'status.no_event'
  `);

  const after = await db.execute(sql`SELECT count(*)::int AS c FROM articles WHERE noise_stage = 'waiting'`);
  const afterN = Number((after as { rows?: { c: number }[] }).rows?.[0]?.c ?? 0);

  console.log(`waiting before: ${beforeN}`);
  console.log(`waiting after:  ${afterN}`);
  console.log(`parked:         ${beforeN - afterN}`);

  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
