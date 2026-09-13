import postgres from "postgres";

/**
 * Backlog deep-search pass D (documented educated-guess inference):
 * Final stage resolution for live entities still at funding_stage='unknown'.
 *
 *  A) Amount bands from evidence: latest accepted funding_round fact by
 *     event_date with amount_usd_est > 0 maps to a venture band:
 *       <500k -> pre_seed | 500k-3M -> seed | 3-15M -> series_a |
 *       15-50M -> series_b | 50-100M -> series_c | >=100M -> late_stage
 *     Marker: `inferred:stage-from-round-amount:<stage>`.
 *
 *  B) Pre-seed inference (user policy): legit operating companies with a
 *     real website AND kept news coverage but NO discoverable funding
 *     history -> pre_seed.
 *     Marker: `inferred:pre_seed:no-funding-history-found`.
 *
 *  C) Form D filers without any quantified round (--include-unquantified-formd,
 *     run only after enrich-edgar-submissions completes): they demonstrably
 *     raised exempt capital but no amount could be established anywhere;
 *     per policy these are guessed pre_seed.
 *     Marker: `inferred:pre_seed:unquantified-formd`.
 *
 * Idempotent: gates on funding_stage='unknown' and marker absence.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

async function passA(): Promise<string> {
  const res = await sql`
    WITH latest AS (
      SELECT DISTINCT ON (f.entity_id)
             f.entity_id AS id, (f.payload->>'amount_usd_est')::bigint AS amt
      FROM facts f JOIN entities e ON e.id = f.entity_id
      WHERE f.status='accepted' AND f.type='funding_round'
        AND COALESCE((f.payload->>'amount_usd_est')::bigint, 0) > 0
        AND e.merged_into IS NULL AND e.funding_stage='unknown'
        AND COALESCE(e.type,'private') NOT IN ('fund','person-org','public')
        AND e.created_by NOT IN ('import:seed')
        AND e.review_status <> 'reviewed'
      ORDER BY f.entity_id, COALESCE(NULLIF(f.payload->>'event_date',''), '0000') DESC
    )
    UPDATE entities e SET funding_stage =
        CASE WHEN l.amt < 500000 THEN 'pre_seed'
             WHEN l.amt < 3000000 THEN 'seed'
             WHEN l.amt < 15000000 THEN 'series_a'
             WHEN l.amt < 50000000 THEN 'series_b'
             WHEN l.amt < 100000000 THEN 'series_c'
             ELSE 'late_stage' END,
      source_refs = e.source_refs || ARRAY[('inferred:stage-from-round-amount:' ||
        CASE WHEN l.amt < 500000 THEN 'pre_seed'
             WHEN l.amt < 3000000 THEN 'seed'
             WHEN l.amt < 15000000 THEN 'series_a'
             WHEN l.amt < 50000000 THEN 'series_b'
             WHEN l.amt < 100000000 THEN 'series_c'
             ELSE 'late_stage' END)]::text[],
      updated_at = now()
    FROM latest l
    WHERE e.id = l.id RETURNING 1`;
  return `A amount-bands: ${res.count}`;
}

async function passB(): Promise<string> {
  const res = await sql`
    UPDATE entities e SET funding_stage='pre_seed',
      source_refs = e.source_refs || ARRAY['inferred:pre_seed:no-funding-history-found']::text[],
      updated_at = now()
    WHERE e.merged_into IS NULL AND e.funding_stage='unknown'
      AND e.created_by NOT IN ('formd','import:edgar','import:seed')
      AND COALESCE(e.type,'private') NOT IN ('fund','person-org','other','subsidiary','public')
      AND e.review_status NOT IN ('rejected','reviewed')
      AND e.website IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM article_entities ae JOIN articles a ON a.id = ae.article_id
        WHERE ae.entity_id = e.id AND a.noise_stage='kept')
    RETURNING 1`;
  return `B pre_seed-inference (site+coverage): ${res.count}`;
}

async function passC(): Promise<string> {
  const res = await sql`
    UPDATE entities e SET funding_stage='pre_seed',
      source_refs = e.source_refs || ARRAY['inferred:pre_seed:unquantified-formd']::text[],
      updated_at = now()
    WHERE e.merged_into IS NULL AND e.funding_stage='unknown'
      AND e.created_by = 'formd'
      AND COALESCE(e.type,'private') <> 'fund'
      AND e.review_status <> 'rejected'
    RETURNING 1`;
  return `C formd-unquantified->pre_seed: ${res.count}`;
}

async function main(): Promise<void> {
  const report: string[] = [];
  report.push(await passA());
  report.push(await passB());
  if (process.argv.includes("--include-unquantified-formd")) report.push(await passC());
  for (const line of report) console.log(`[infer-stage] ${line}`);
  const left = await sql`
    SELECT count(*)::int AS n FROM entities
    WHERE merged_into IS NULL AND funding_stage='unknown'
      AND COALESCE(type,'private') NOT IN ('fund','person-org')`;
  console.log(`[infer-stage] non-fund unknown remaining: ${left[0]?.n ?? "?"}`);
  await sql.end();
  process.exit(0);
}

void main();
