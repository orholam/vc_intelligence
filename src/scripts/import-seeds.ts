import { createDb, ensureExtensionsAndViews } from "../db/index.js";
import { getConfig } from "../config.js";
import { EntityKb } from "../entities/kb.js";
import { importSeeds } from "../entities/imports/seeds.js";

/** FR-7 seed lists: drop curated JSON/CSV exports into config/seeds/ then run. */
async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL, { max: 1 });
  await ensureExtensionsAndViews(db);
  const res = await importSeeds({ db, kb: new EntityKb(db) });
  console.log(JSON.stringify(res));
  process.exit(0);
}
main().catch((e: Error) => {
  console.error("seed import failed:", e.message);
  process.exit(1);
});
