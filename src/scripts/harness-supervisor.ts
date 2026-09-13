/**
 * Cycle supervisor: fire harness runs until waiting room empty.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/harness-supervisor.ts
 */
const BASE = process.env.HARNESS_BRAIN_BASE ?? "http://127.0.0.1:4600";
const POLL_MS = Number(process.env.HARNESS_SUPERVISOR_POLL_MS ?? 15_000);
const MAX_CYCLES = Number(process.env.HARNESS_SUPERVISOR_MAX ?? 50);

async function snapshot(): Promise<{ waiting: number; running: boolean }> {
  const r = await fetch(`${BASE}/v1/exoskeleton/snapshot`);
  const j = (await r.json()) as {
    stages?: { waiting_now?: number };
    harness?: { running_now?: boolean };
  };
  return {
    waiting: j.stages?.waiting_now ?? 0,
    running: Boolean(j.harness?.running_now),
  };
}

async function fireHarness(): Promise<boolean> {
  const r = await fetch(`${BASE}/v1/exoskeleton/harness/run`, { method: "POST" });
  const j = (await r.json()) as { ok?: boolean; error?: { message?: string } };
  if (!r.ok) {
    console.log(`harness/run ${r.status}: ${j.error?.message ?? "failed"}`);
    return false;
  }
  console.log(`harness/run queued ok=${j.ok}`);
  return true;
}

async function main(): Promise<void> {
  console.log(`harness supervisor → ${BASE} (max ${MAX_CYCLES} cycles)`);
  for (let i = 1; i <= MAX_CYCLES; i++) {
    const { waiting, running } = await snapshot();
    console.log(`[cycle ${i}] waiting=${waiting} harness_running=${running}`);
    if (waiting === 0) {
      console.log("waiting room empty — done");
      return;
    }
    if (!running) {
      await fireHarness();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log("max cycles reached");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
