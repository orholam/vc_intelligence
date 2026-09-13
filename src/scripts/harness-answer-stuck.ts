/**
 * Answer any llm_requests stuck in claimed state (POST results via internal API).
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/harness-answer-stuck.ts
 */
import { sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { answerHarnessClaim } from "../harness/editorial-brain.js";

const BASE = process.env.HARNESS_BRAIN_BASE ?? "http://127.0.0.1:4600";

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  const rows = await db.execute(sql`
    SELECT id, stage, tier, system, user_prompt AS user
    FROM llm_requests WHERE status = 'claimed' ORDER BY claimed_at ASC
  `);
  const claimed = (rows as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  console.log(`claimed: ${claimed.length}`);
  for (const row of claimed) {
    const id = String(row.id);
    const stage = String(row.stage);
    const tier = row.tier as "mini" | "big" | "judge";
    const system = String(row.system);
    const user = String(row.user);
    const res = await answerHarnessClaim(stage, tier, system, user);
    const body = res.ok
      ? { ok: true, data: res.data, raw: "raw" in res ? res.raw : JSON.stringify(res.data), model: "editorial-brain" }
      : { ok: false, error: res.error.slice(0, 300), model: "editorial-brain" };
    const r = await fetch(`${BASE}/internal/llm/${id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`${r.ok ? "✓" : "✗"} ${id} ${stage} ${r.status}`);
  }
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
