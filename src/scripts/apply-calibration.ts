import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { writeFileSync } from "node:fs";

/**
 * D4 confidence calibration (post-hoc, monotone):
 *   1. measure empirical accuracy per confidence decile against the
 *      anchored-evidence proxy (alias/domain corroboration),
 *   2. store the piecewise mapping in config/calibration.json (R08),
 *   3. remap stored primary-link confidences once, preserving originals in
 *      evidence.original_confidence so re-runs never double-apply.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});
void schema;
void drizzle;

async function main(): Promise<void> {
  const already = await sql`SELECT value FROM kv_state WHERE key='calibration_applied' LIMIT 1`;
  if (already.length) {
    console.log("[calibration] already applied:", JSON.stringify(already[0]?.value));
    process.exit(0);
  }

  const rows = await sql`
    SELECT WIDTH_BUCKET(confidence,0.0001,1,10) decile, AVG(ok)::float acc FROM (
      SELECT ae.confidence,
        CASE WHEN COALESCE(ae.evidence->>'domain_overlap','false')='true'
               OR (ae.evidence->>'alias' IS NOT NULL AND ae.evidence->>'alias' NOT IN ('none',''))
             THEN 1 ELSE 0 END ok
      FROM article_entities ae JOIN articles a ON a.id=ae.article_id
      WHERE a.noise_stage='kept' AND ae.role='primary'
        AND a.created_at >= now() - interval '31 days'
    ) s GROUP BY 1 ORDER BY 1`;

  // Build monotone mapping: bin center -> empirical accuracy (floored at the
  // previous target to keep it non-decreasing, capped at 0.97).
  const bins: Array<{ lo: number; hi: number; target: number }> = [];
  let prev = 0.05;
  for (const r of rows) {
    const d = Number(r.decile);
    const lo = Math.max(0, (d - 1) / 10);
    const hi = Math.min(1, d / 10);
    let acc = Number(r.acc);
    if (!Number.isFinite(acc)) acc = prev;
    acc = Math.min(0.97, Math.max(prev, Math.round(acc * 1000) / 1000));
    prev = acc;
    bins.push({ lo, hi, target: acc });
  }
  const cfg = {
    $comment:
      "D4 post-hoc confidence calibration for primary resolution links. Mapping: find first bin containing confidence; new confidence = target. Derived from anchored-evidence empirical accuracy over the trailing 31d corpus.",
    version: "2026.08.1",
    method: "decile empirical accuracy vs anchored-evidence proxy",
    bins,
  };
  writeFileSync("config/calibration.json", JSON.stringify(cfg, null, 2));

  // One-shot remap preserving originals.
  let applied = 0;
  for (const b of bins) {
    const res = await sql`
      UPDATE article_entities ae SET
        confidence = ${b.target}::real,
        evidence = COALESCE(ae.evidence,'{}'::jsonb) || jsonb_build_object('original_confidence', ae.confidence)
      WHERE ae.role='primary'
        AND ae.evidence->>'original_confidence' IS NULL
        AND ae.confidence > ${b.lo}::real AND ae.confidence <= ${b.hi}::real
        AND EXISTS (SELECT 1 FROM articles a WHERE a.id=ae.article_id AND a.noise_stage='kept')
      RETURNING 1`;
    applied += res.count;
  }
  await sql`
    INSERT INTO kv_state (key, value) VALUES ('calibration_applied', jsonb_build_object('at', now(), 'bins', ${JSON.stringify(bins)}::jsonb))
    ON CONFLICT (key) DO NOTHING`;
  console.log(`[calibration] applied to ${applied} links; bins=${bins.length}`);
  await sql.end();
  process.exit(0);
}

void main();
