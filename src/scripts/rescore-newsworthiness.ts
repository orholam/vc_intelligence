import { sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb, type Db } from "../db/index.js";
import { blendNewsworthiness } from "../enrichment/pipeline.js";

/**
 * Gap-fix rescore (c-plan follow-up): kept articles enriched before the
 * scoring overhaul carry `newsworthiness` computed under the old formula and
 * old source tiers. This recomputes the tier deterministically for every kept,
 * LLM-enriched article (launch-surface articles excluded — their tier comes
 * from the crowd gate, not this formula). Zero LLM spend.
 *
 * Dry-run by default; pass --apply to write.
 *
 * Usage: pnpm rescore:newsworthiness [--apply]
 */

export interface NewsworthinessRescoreOutcome {
  scanned: number;
  changed: number;
  distributionBefore: Record<string, number>;
  distributionAfter: Record<string, number>;
}

export async function rescoreNewsworthiness(
  db: Db,
  apply: boolean,
): Promise<NewsworthinessRescoreOutcome> {
  const rows = await db.execute<{
    id: string;
    primary_tag: string | null;
    newsworthiness: string | null;
    source_tier: number | null;
  }>(sql`
    SELECT a.id, a.primary_tag, a.newsworthiness, s.tier AS source_tier
    FROM articles a
    LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.noise_stage = 'kept'
      AND a.platform_meta IS NULL
      AND a.primary_tag IS NOT NULL
    ORDER BY a.published_at ASC
  `);

  const distributionBefore: Record<string, number> = {};
  const distributionAfter: Record<string, number> = {};
  let changed = 0;

  for (const row of rows) {
    const before = (row.newsworthiness ?? "unknown") as string;
    distributionBefore[before] = (distributionBefore[before] ?? 0) + 1;

    const after = await blendNewsworthiness(
      db,
      { articleId: String(row.id), sourceTier: row.source_tier == null ? null : Number(row.source_tier) },
      row.primary_tag,
    );
    distributionAfter[after] = (distributionAfter[after] ?? 0) + 1;

    if (after !== row.newsworthiness) {
      changed++;
      if (apply) {
        await db.execute(sql`
          UPDATE articles SET newsworthiness = ${after}, updated_at = now()
          WHERE id = ${String(row.id)}
        `);
      }
    }
  }

  return { scanned: rows.length, changed, distributionBefore, distributionAfter };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  resetConfigCache();
  const db = createDb(getConfig().DATABASE_URL, { max: 4 });
  const outcome = await rescoreNewsworthiness(db, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...outcome }, null, 2));
  process.exit(0);
}

if (process.argv[1]?.includes("rescore-newsworthiness")) {
  main().catch((err: Error) => {
    console.error("rescore-newsworthiness failed:", err.message);
    process.exit(1);
  });
}
