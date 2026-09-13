/**
 * OFFLINE/TEST ONLY — programmatic MockProvider brain (NOT real editorial work).
 *
 * Production drain: invoke the `drain-waiting-room` Cursor skill — the agent
 * long-polls claim and answers with real reasoning, model `harness:agent`.
 *
 * Usage: pnpm harness:mock-agent
 */
import { answerHarnessClaim } from "../harness/editorial-brain.js";

const BASE = process.env.HARNESS_BRAIN_BASE ?? "http://127.0.0.1:4600";
const MAX = Number(process.env.HARNESS_MOCK_AGENT_MAX ?? 500);
const INFINITE = MAX <= 0;
const IDLE_ROUNDS_TO_STOP = Number(process.env.HARNESS_MOCK_AGENT_IDLE_ROUNDS ?? 6);
/** Blocked from publishing when LLM_PROVIDER=harness (see isMockModelName). */
const MODEL = "harness:mock-agent";

async function llmStats() {
  const r = await fetch(`${BASE}/internal/llm/stats`);
  return (await r.json()) as { queue?: { pending?: number; claimed?: number } };
}

async function waitingCount(): Promise<number> {
  const r = await fetch(`${BASE}/v1/exoskeleton/snapshot`);
  const j = (await r.json()) as { stages?: { waiting_now?: number } };
  return j.stages?.waiting_now ?? 0;
}

async function claim() {
  const r = await fetch(`${BASE}/internal/llm/claim?wait=25`);
  const j = (await r.json()) as {
    request: { id: string; stage: string; tier: "mini" | "big" | "judge"; system: string; user: string } | null;
  };
  return j.request;
}

async function post(id: string, body: unknown): Promise<boolean> {
  const r = await fetch(`${BASE}/internal/llm/${id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

async function answer(req: {
  id: string;
  stage: string;
  tier: "mini" | "big" | "judge";
  system: string;
  user: string;
}): Promise<boolean> {
  const res = await answerHarnessClaim(req.stage, req.tier, req.system, req.user);
  if (!res.ok) {
    return post(req.id, { ok: false, error: res.error.slice(0, 300), model: MODEL });
  }
  return post(req.id, {
    ok: true,
    data: res.data,
    raw: "raw" in res ? res.raw : JSON.stringify(res.data),
    model: MODEL,
  });
}

async function main(): Promise<void> {
  console.warn("");
  console.warn("⚠  MOCK AGENT — MockProvider only. Will NOT publish in harness mode.");
  console.warn("   Production: invoke @drain-waiting-room in Cursor instead.");
  console.warn("");

  const mode = INFINITE ? "until waiting room empty" : `max ${MAX}`;
  console.log(`mock harness agent → ${BASE} (${mode})`);
  let idleRounds = 0;
  let i = 0;

  for (;;) {
    if (!INFINITE && i >= MAX) {
      console.log(`reached HARNESS_MOCK_AGENT_MAX=${MAX}`);
      return;
    }

    const req = await claim();
    if (!req) {
      const q = await llmStats();
      const pending = q.queue?.pending ?? 0;
      const claimed = q.queue?.claimed ?? 0;
      const waiting = await waitingCount();

      if (pending === 0 && claimed === 0) {
        idleRounds++;
        console.log(`[idle ${idleRounds}] waiting=${waiting} llm_queue empty`);
        if (INFINITE && waiting === 0 && idleRounds >= IDLE_ROUNDS_TO_STOP) {
          console.log("waiting room empty and queue idle — done");
          return;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      continue;
    }

    idleRounds = 0;
    i++;
    const t0 = Date.now();
    const ok = await answer(req);
    console.log(`${ok ? "✓" : "✗"} ${i} ${req.stage} ${req.id.slice(-8)} ${Date.now() - t0}ms`);

    if (!INFINITE && i % 25 === 0) {
      const waiting = await waitingCount();
      console.log(`[check ${i}] waiting=${waiting}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
