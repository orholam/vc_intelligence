import { sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { TICKER_STOPWORDS } from "../lib/quality.js";

/**
 * KB alias backfill: companies whose headline short-name exists only as a
 * ticker-kind alias ("UBER" -> Uber Technologies) lose candidate generation
 * now that the alias lookup excludes kind='ticker' (FR-11 rev). Promote each
 * entity's non-stopword, non-trivial tickers to explicit kind='name' aliases.
 *
 * Idempotent: skips entities that already hold a name-kind row with the same
 * normalized form. Stopworded tickers (TECH, MAC, ...) are deliberately NOT
 * promoted — they stay ticker-only and never drive candidacy.
 *
 * Usage: pnpm exec tsx src/scripts/backfill-ticker-names.ts [--apply]
 */

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  resetConfigCache();
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 2 });

  const stopwords = [...TICKER_STOPWORDS];
  const rows = await db.execute<{ id: string; canonical_name: string; ticker: string }>(sql`
    SELECT e.id, e.canonical_name, t.ticker
    FROM entities e
    CROSS JOIN LATERAL unnest(e.tickers) AS t(ticker)
    WHERE e.merged_into IS NULL
      AND length(btrim(t.ticker)) >= 3
      AND lower(btrim(t.ticker)) NOT IN (${sql.join(stopwords.map((w) => sql`${w}`), sql`, `)})
      AND NOT EXISTS (
        SELECT 1 FROM aliases al
        WHERE al.entity_id = e.id
          AND al.kind = 'name'
          AND al.alias_normalized = lower(regexp_replace(btrim(t.ticker), '[^a-zA-Z0-9]+', ' ', 'g'))
      )
  `);

  console.log(`[ticker-names] mode=${apply ? "APPLY" : "DRY-RUN"} candidates=${rows.length}`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.canonical_name}  <-  name alias "${r.ticker}"`);
  }
  if (apply) {
    // Promote IN PLACE: the unique index (alias_normalized, entity_id) spans
    // kinds, so an insert of a name-kind twin of an existing ticker row would
    // conflict. Flipping kind keeps history intact and unblocks candidacy.
    let promoted = 0;
    for (const r of rows) {
      const norm = r.ticker.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const res = await db.execute(sql`
        UPDATE aliases SET kind = 'name'
        WHERE entity_id = ${r.id}
          AND alias_normalized = ${norm}
          AND kind = 'ticker'
      `);
      promoted += Number((res as unknown as { count?: number }).count ?? res.length ?? 0);
    }
    console.log(`[ticker-names] promoted ${promoted} ticker aliases to kind='name'`);
  } else {
    console.log("[ticker-names] dry-run only — re-run with --apply to write.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
