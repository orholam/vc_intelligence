import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { makeProvider, LlmRouter } from "../llm/router.js";
import {
  dueProfileEntities,
  generateEntityProfile,
  profileProgress,
} from "../entities/profile.js";

/**
 * FR-25 ops runner: drive company-profile generation on demand
 * (`profile:run [--entity=ent_x] [--limit=50] [--no-crawl]`).
 * The hourly `company-profile-tick` calls the same engine; this script exists
 * for backfills, retries after parking (reset rows first via SQL logged in
 * AGENT-COORDINATION.md) and local verification.
 *
 * Usage:
 *   pnpm profile:run                       # sweep due entities (tick parity)
 *   pnpm profile:run -- --entity=ent_01J.. # single entity, crawl enabled
 *   pnpm profile:run -- --no-crawl         # corpus+registry evidence only
 */

function argStr(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  const router = new LlmRouter(db, makeProvider());
  const crawl = !process.argv.includes("--no-crawl");
  const entityId = argStr("entity");
  const limit = Number(argStr("limit") ?? 50);

  resetConfigCache();
  const targets = entityId ? [entityId] : await dueProfileEntities(db, limit);
  console.error(JSON.stringify({ targets: targets.length, crawl }));

  for (const id of targets) {
    const res = await generateEntityProfile(db, router, id, { crawl });
    console.log(
      JSON.stringify({
        entity_id: res.entityId,
        finalized: res.finalized.length,
        completed: res.completed.length,
        failed: res.failedNow.length,
        pending: res.pending.length,
        skipped: res.skipped ?? null,
      }),
    );
    if (res.skipped === "budget_hard") break;
  }

  console.error(JSON.stringify(await profileProgress(db)));
}

main().catch((err: Error) => {
  console.error("profile:run failed:", err.message);
  process.exit(1);
});
