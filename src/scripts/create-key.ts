import { sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { generateApiKey } from "../api/auth.js";
import { apiKeys, domainLists } from "../db/schema.js";

/**
 * CLI utilities:
 *   create-key <name>            mint an API key (raw shown once)
 *   block-domain <domain>        GDELT quality blocklist (FR-3)
 *   allow-domain <domain>        GDELT quality allowlist
 */
async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: create-key <name> | block-domain <domain> | allow-domain <domain>");
    process.exit(1);
  }
  const db = createDb(getConfig().DATABASE_URL, { max: 1 });

  switch (cmd) {
    case "create-key": {
      const name = z.string().min(2).parse(arg ?? "default");
      const key = generateApiKey();
      await db.insert(apiKeys).values({
        id: key.id,
        name,
        keyHash: key.hash,
        keyPrefix: key.prefix,
      });
      console.log(`\nAPI key for "${name}" (store now — shown once):\n${key.raw}\n`);
      break;
    }
    case "block-domain":
    case "allow-domain": {
      const domain = z.string().min(3).parse(arg);
      const list = cmd === "block-domain" ? "block" : "allow";
      await db
        .insert(domainLists)
        .values({ domain: domain.toLowerCase(), list })
        .onConflictDoUpdate({ target: domainLists.domain, set: { list } });
      console.log(`${list}listed ${domain}`);
      break;
    }
    default:
      console.error(`unknown command ${cmd}`);
      process.exit(1);
  }
  await db.execute(sql`SELECT 1`); // keep client alive until flush
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("failed:", err.message);
  process.exit(1);
});
