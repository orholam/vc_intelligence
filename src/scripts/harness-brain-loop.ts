/**
 * OFFLINE/TEST ONLY — mock editorial brain loop (MockProvider).
 *
 * Production: invoke @drain-waiting-room in Cursor (model harness:agent).
 *
 * Usage: pnpm harness:brain  (or via pnpm harness:drain-mock)
 */
import { answerHarnessClaim } from "../harness/editorial-brain.js";

const BASE = process.env.HARNESS_BRAIN_BASE ?? "http://127.0.0.1:4600";
const MAX = Number(process.env.HARNESS_BRAIN_MAX ?? 500);
const CHECK_EVERY = Number(process.env.HARNESS_BRAIN_CHECK_EVERY ?? 10);

interface Claimed {
  id: string;
  stage: string;
  tier: "mini" | "big" | "judge";
  system: string;
  user: string;
}

async function stats(): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/internal/llm/stats`);
  return (await r.json()) as Record<string, unknown>;
}

async function claim(): Promise<Claimed | null> {
  const r = await fetch(`${BASE}/internal/llm/claim?wait=25`);
  const j = (await r.json()) as { request: Claimed | null };
  return j.request;
}

async function postResult(id: string, body: unknown): Promise<boolean> {
  const r = await fetch(`${BASE}/internal/llm/${id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return true;
  console.error(`POST ${id} failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return false;
}

async function answer(req: Claimed): Promise<boolean> {
  const res = await answerHarnessClaim(req.stage, req.tier, req.system, req.user);
  if (!res.ok) {
    return postResult(req.id, { ok: false, error: res.error.slice(0, 300), model: "editorial-brain" });
  }
  return postResult(req.id, {
    ok: true,
    data: res.data,
    raw: "raw" in res ? res.raw : JSON.stringify(res.data),
    model: "editorial-brain",
  });
}

function logCheckpoint(n: number, waitingBefore: number | null): void {
  void (async () => {
    const s = await stats();
    console.log(`[check ${n}] queue=${JSON.stringify(s.queue)} waiting_start=${waitingBefore ?? "?"}`);
  })();
}

async function main(): Promise<void> {
  console.log(`editorial harness brain → ${BASE} (max ${MAX})`);
  let waitingBefore: number | null = null;
  try {
    const { createDb } = await import("../db/index.js");
    const { getConfig } = await import("../config.js");
    const { sql } = await import("drizzle-orm");
    const db = createDb(getConfig().DATABASE_URL);
    const r = await db.execute(sql`SELECT count(*)::int AS c FROM articles WHERE noise_stage = 'waiting'`);
    const row = (r as { rows?: { c: number }[] }).rows?.[0];
    waitingBefore = Number(row?.c ?? 0);
    console.log(`waiting room start: ${waitingBefore}`);
    await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
  } catch {
    /* optional */
  }

  for (let i = 1; i <= MAX; i++) {
    const req = await claim();
    if (!req) {
      const q = (await stats()).queue as { pending?: number; claimed?: number } | undefined;
      if ((q?.pending ?? 0) === 0 && (q?.claimed ?? 0) === 0) {
        console.log(`idle at ${i}`);
        logCheckpoint(i, waitingBefore);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      continue;
    }
    const t0 = Date.now();
    const ok = await answer(req);
    console.log(`${ok ? "✓" : "✗"} ${i} ${req.stage} ${req.id.slice(-8)} ${Date.now() - t0}ms`);
    if (i % CHECK_EVERY === 0) logCheckpoint(i, waitingBefore);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
