import fs from "node:fs";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { SourceRegistry } from "../sources/registry.js";

/**
 * Bulk-import feeds from OPML/CSV file:
 *   tsx src/scripts/import-sources.ts <file.opml|file.csv> [tier]
 */
async function main(): Promise<void> {
  const [file, tierArg] = process.argv.slice(2);
  if (!file) {
    console.error("usage: import-sources.ts <file.opml|file.csv> [tier=3]");
    process.exit(1);
  }
  const db = createDb(getConfig().DATABASE_URL, { max: 1 });
  const registry = new SourceRegistry(db);
  const content = fs.readFileSync(file, "utf8");
  const tier = (Number(tierArg ?? 3) === 1 ? 1 : Number(tierArg ?? 3) === 2 ? 2 : 3) as 1 | 2 | 3;

  const res = /\.csv$/i.test(file)
    ? await registry.importCsv(content)
    : await registry.importOpml(content, { tier });
  console.log(JSON.stringify({ file, ...res }));
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("import failed:", err.message);
  process.exit(1);
});
