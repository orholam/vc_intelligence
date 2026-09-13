import { createDb, ensureExtensionsAndViews } from "../db/index.js";
import { getConfig } from "../config.js";
import { EntityKb } from "../entities/kb.js";
import { importWikidata } from "../entities/imports/wikidata.js";

/** FR-7: Wikidata bootstrap import (paged, resumable). Usage: --limit=5000 */
async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL, { max: 1 });
  await ensureExtensionsAndViews(db);
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  const res = await importWikidata({ db, kb: new EntityKb(db) }, { limit: Number.isFinite(limit) ? limit : undefined });
  console.log(JSON.stringify(res));
  process.exit(0);
}
main().catch((e: Error) => {
  console.error("wikidata import failed:", e.message);
  process.exit(1);
});
