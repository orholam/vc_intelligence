import postgres from "postgres";
import { randomUUID } from "node:crypto";

/**
 * Backlog deep-search pass C (manual research findings):
 * Applies agent-researched funding evidence to entity cards from a TSV file:
 *   entityId <TAB> stage [<TAB> amountUsd [<TAB> YYYY-MM-DD [<TAB> sourceUrl]]]
 * stage may be "unknown" to leave untouched (only record nothing).
 *
 * Real rounds additionally become accepted `funding_round` facts
 * (dedup_key `research:<sha1(sourceUrl||entity)>`, R07-consistent payloads)
 * so banding/facts-probes stay coherent. Inference-only outcomes use the
 * caller-supplied marker (e.g. `inferred:pre_seed`) in source_refs.
 * Idempotent: facts conflict on dedup_key; fields never regress.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

const VALID_STAGES = new Set([
  "pre_seed", "seed", "series_a", "series_b", "series_c", "late_stage",
  "public", "bootstrapped", "unknown",
]);

interface Row {
  id: string;
  stage: string;
  amount: number | null;
  date: string | null;
  url: string;
}

function parseLine(line: string): Row | null {
  const [id, stage, amount, date, url] = line.split("\t");
  if (!id || !id.startsWith("ent_")) return null;
  const st = (stage ?? "").trim().toLowerCase();
  if (!VALID_STAGES.has(st)) return null;
  return {
    id,
    stage: st,
    amount: amount && Number(amount.replace(/[^0-9]/g, "")) > 0 ? Number(amount.replace(/[^0-9]/g, "")) : null,
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    url: (url ?? "").trim(),
  };
}

async function main(): Promise<void> {
  const file = process.argv.find((a) => !a.startsWith("--") && a.endsWith(".tsv"));
  const dryRun = process.argv.includes("--dry");
  if (!file) {
    console.error("usage: tsx enrich-apply-findings.ts findings.tsv [--dry]");
    process.exit(1);
  }
  const text = await import("node:fs").then((fs) => fs.readFileSync(file, "utf8"));
  const rows = text.split("\n").map(parseLine).filter((r): r is Row => r !== null);
  console.log(`[apply-findings] rows: ${rows.length}${dryRun ? " (dry)" : ""}`);

  let staged = 0;
  let skipped = 0;
  let facts = 0;

  for (const r of rows) {
    const live = await sql`
      SELECT id, funding_stage FROM entities WHERE id = ${r.id} AND merged_into IS NULL LIMIT 1`;
    if (!live.length) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`  ${r.id} -> ${r.stage}${r.amount ? ` $${r.amount}` : ""}${r.date ? ` @${r.date}` : ""}`);
      continue;
    }

    if (r.stage !== "unknown") {
      const refs = r.url ? [`research:${r.url.slice(0, 200)}`] : [];
      await sql`
        UPDATE entities SET
          funding_stage = ${r.stage},
          total_raised_usd = CASE WHEN ${r.amount}::bigint IS NOT NULL
            THEN GREATEST(COALESCE(total_raised_usd,0), ${r.amount}::bigint) ELSE total_raised_usd END,
          last_funding_date = COALESCE(${r.date}::timestamptz, last_funding_date),
          source_refs = ${refs.length ? sql`source_refs || ${refs}::text[]` : sql`source_refs`},
          updated_at = now()
        WHERE id = ${r.id}`;
      staged++;

      // Real round -> accepted fact keeps the KB self-consistent (R06/R07).
      if (r.amount || r.date) {
        const payload: Record<string, unknown> = { funding_stage: r.stage };
        if (r.amount) payload.amount_usd_est = r.amount;
        if (r.date) payload.event_date = r.date;
        if (r.url) payload.source = r.url;
        const dedup = `research:${r.id}:${r.url || `${r.stage}:${r.amount ?? ""}:${r.date ?? ""}`}`;
        const ins = await sql`
          INSERT INTO facts (id, entity_id, type, payload, status, evidence_article_ids,
                             distinct_publishers, best_source_tier, dedup_key, promoted_at)
          VALUES (${`fct_r_${randomUUID().replaceAll("-", "").slice(0, 20)}`}, ${r.id}, 'funding_round',
                  ${sql.json(payload as never)}, 'accepted', '{}', 1, 2, ${dedup}, now())
          ON CONFLICT (dedup_key) DO NOTHING RETURNING 1`;
        facts += ins.count;
      }
    }
  }
  console.log(`[apply-findings] done: staged=${staged}, facts=${facts}, skipped=${skipped}`);
  await sql.end();
  process.exit(0);
}

void main();
