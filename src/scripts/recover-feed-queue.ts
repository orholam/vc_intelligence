/**
 * Clear stale fetch-feed pg-boss backlog and re-queue stuck pending articles.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/recover-feed-queue.ts [--dry-run]
 */
import { sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { createBoss, ensureQueues } from "../queue/boss.js";
import { ALL_QUEUES, QUEUE } from "../queue/jobs.js";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  console.log(dryRun ? "DRY RUN" : "LIVE");

  const before = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'fetch-feed' AND state = 'created'
  `);
  const stale = Number(before[0]?.n ?? 0);
  console.log(`fetch-feed created backlog: ${stale}`);

  if (!dryRun && stale > 0) {
    const purged = await db.execute(sql`
      DELETE FROM pgboss.job
      WHERE name = 'fetch-feed' AND state = 'created'
      RETURNING id
    `);
    const rows = (purged as { rows?: unknown[] }).rows ?? purged;
    console.log(`purged fetch-feed jobs: ${Array.isArray(rows) ? rows.length : 0}`);
  }

  const pending = await db.execute<{ id: string }>(sql`
    SELECT id FROM articles WHERE noise_stage = 'pending'
  `);
  console.log(`pending articles needing filter-article: ${pending.length}`);

  if (!dryRun && pending.length > 0) {
    const boss = await createBoss();
    await boss.start();
    await ensureQueues(boss, ALL_QUEUES);
    for (const row of pending) {
      await boss.send(QUEUE.filterArticle, { articleId: row.id }, { singletonKey: row.id });
    }
    await boss.stop();
    console.log(`re-enqueued filter-article for ${pending.length} pending rows`);
  }

  const waiting = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM articles WHERE noise_stage = 'waiting'
  `);
  console.log(`waiting room now: ${waiting[0]?.n ?? 0}`);

  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
