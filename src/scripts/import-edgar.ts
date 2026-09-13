import { createDb, ensureExtensionsAndViews } from "../db/index.js";
import { getConfig } from "../config.js";
import { EntityKb } from "../entities/kb.js";
import { importEdgar } from "../entities/imports/edgar.js";

/** FR-7: SEC EDGAR US public filers. Usage: --enrich=200 */
async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL, { max: 1 });
  await ensureExtensionsAndViews(db);
  const enrich = Number(process.argv.find((a) => a.startsWith("--enrich="))?.split("=")[1] ?? 0);
  const res = await importEdgar({ db, kb: new EntityKb(db) }, { enrichLimit: enrich });
  console.log(JSON.stringify(res));
  process.exit(0);
}
main().catch((e: Error) => {
  console.error("edgar import failed:", e.message);
  process.exit(1);
});
