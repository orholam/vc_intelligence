import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { makeProvider, LlmRouter } from "../llm/router.js";
import { runBenchmarkHarness } from "../benchmark/harness.js";

/**
 * FR-23: one-command end-to-end benchmark run.
 *   --window-days=7 --max-companies=133
 * Writes benchmarks/YYYY-MM.md + raw archive + DB row.
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 3 });
  const router = new LlmRouter(db, makeProvider(cfg));
  const windowDays = Number(process.argv.find((a) => a.startsWith("--window-days="))?.split("=")[1] ?? 7);
  const maxCompanies = Number(process.argv.find((a) => a.startsWith("--max-companies="))?.split("=")[1] ?? 133);
  const res = await runBenchmarkHarness(db, router, { windowDays, maxCompanies });
  console.log(JSON.stringify({ period: res.period, metrics: res.metrics, report: res.reportPath }, null, 2));
  process.exit(0);
}
main().catch((e: Error) => {
  console.error("benchmark failed:", e.message);
  process.exit(1);
});
