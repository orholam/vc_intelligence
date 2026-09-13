import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { backfillEntityBaselines } from "../entities/baseline.js";
import { getConfig } from "../config.js";

const client = postgres(getConfig().DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client, { schema, logger: false });
let total = 0;
for (let i = 0; i < 15; i++) {
  const r = await backfillEntityBaselines(db, 400);
  total += r.processed;
  if (!r.processed && !r.flagged) break;
}
console.log("baseline processed:", total);
await client.end();
process.exit(0);
