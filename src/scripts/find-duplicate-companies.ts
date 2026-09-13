#!/usr/bin/env node
/**
 * List obvious duplicate company cards (same website, still live).
 * Does not merge. Operator: POST /v1/admin/entities/merge
 *   { source_entity_id, target_entity_id }
 */
import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL, { max: 2 });
  const rows = await db.execute<{
    website: string;
    n: number;
    ids: string;
    names: string;
  }>(sql`
    SELECT website, COUNT(*)::int AS n,
           string_agg(id, ',' ORDER BY created_at) AS ids,
           string_agg(canonical_name, ' | ' ORDER BY created_at) AS names
    FROM entities
    WHERE merged_into IS NULL
      AND website IS NOT NULL
      AND website <> ''
    GROUP BY website
    HAVING COUNT(*) > 1
    ORDER BY n DESC, website
    LIMIT 200
  `);
  for (const r of rows) {
    console.log(`${r.n}\t${r.website}\t${r.names}\t${r.ids}`);
  }
  console.log(`# ${rows.length} website-duplicate groups. Merge via POST /v1/admin/entities/merge`);
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
