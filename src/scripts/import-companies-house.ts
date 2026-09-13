import { createDb, ensureExtensionsAndViews } from "../db/index.js";
import { getConfig } from "../config.js";
import { EntityKb } from "../entities/kb.js";
import { importCompaniesHouse } from "../entities/imports/companies-house.js";

/** FR-7: UK Companies House. Usage: --queries="fintech london" [--per-query=50] */
async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL, { max: 1 });
  await ensureExtensionsAndViews(db);
  const q = process.argv.find((a) => a.startsWith("--queries="))?.split("=").slice(1).join("=") ?? "";
  if (!q) throw new Error("pass --queries=\"term1 term2\" (space-separated search terms)");
  const perQuery = Number(process.argv.find((a) => a.startsWith("--per-query="))?.split("=")[1] ?? 50);
  const res = await importCompaniesHouse(
    { db, kb: new EntityKb(db) },
    { queries: q.split(/\s+/).filter(Boolean), maxResultsPerQuery: perQuery },
  );
  console.log(JSON.stringify(res));
  process.exit(0);
}
main().catch((e: Error) => {
  console.error("companies house import failed:", e.message);
  process.exit(1);
});
