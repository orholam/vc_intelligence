/**
 * Answer company_profile harness claims from packed evidence (profile-brain).
 * Posts as harness:agent so sections can complete. Other stages are refused
 * so the drain queue cannot be silently mock-answered.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/enrich-answer-profiles.ts [--max=400]
 */
import { answerProfileClaim } from "../harness/profile-brain.js";

const BASE = process.env.HARNESS_BRAIN_BASE ?? "http://127.0.0.1:4600";
const MAX = Number(process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 800);

type Claimed = {
  id: string;
  stage: string;
  user: string;
};

async function claim(): Promise<Claimed | null> {
  const r = await fetch(`${BASE}/internal/llm/claim?wait=20`);
  const j = (await r.json()) as { request: Claimed | null };
  return j.request;
}

async function post(id: string, body: unknown): Promise<void> {
  const r = await fetch(`${BASE}/internal/llm/${id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`POST ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  let n = 0;
  let idle = 0;
  while (n < MAX && idle < 8) {
    const req = await claim();
    if (!req) {
      idle += 1;
      continue;
    }
    idle = 0;
    const company = /^COMPANY:\s*(.+)$/m.exec(req.user)?.[1] ?? "?";
    const sections = /Build ONLY these sections:\s*(.+)/.exec(req.user)?.[1] ?? "";
    if (req.stage !== "company_profile") {
      console.log(`skip ${req.stage} ${req.id}`);
      await post(req.id, {
        ok: false,
        error: "enrich-answer-profiles only handles company_profile",
        model: "harness:agent",
      });
      continue;
    }
    const data = answerProfileClaim(req.user);
    await post(req.id, {
      ok: true,
      data,
      raw: JSON.stringify(data),
      model: "harness:agent",
    });
    n += 1;
    console.log(`${n} ${company} :: ${sections}`);
  }
  console.log(JSON.stringify({ answered: n, max: MAX, idle_streak: idle }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
