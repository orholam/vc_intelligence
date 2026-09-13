/**
 * Baseline + deep company-profile enrichment for recently spawned entities.
 *
 * Newest empty cards first — the company a user just clicked on /latest must
 * be in this batch, not buried behind older high-confidence names.
 *
 * Usage:
 *   tsx --env-file-if-exists=.env.local src/scripts/enrich-new-companies.ts
 *   tsx --env-file-if-exists=.env.local src/scripts/enrich-new-companies.ts --days=2 --limit=200
 *   tsx --env-file-if-exists=.env.local src/scripts/enrich-new-companies.ts --no-crawl
 */
import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { backfillEntityBaselines } from "../entities/baseline.js";
import { generateEntityProfile, profileProgress } from "../entities/profile.js";
import { makeProvider, LlmRouter } from "../llm/router.js";

function argNum(name: string, def: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

function argStr(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const days = argNum("days", 2);
  const limit = argNum("limit", 200);
  const crawl = !process.argv.includes("--no-crawl");
  const createdBy = argStr("created-by");

  const db = createDb(getConfig().DATABASE_URL);
  const router = new LlmRouter(db, makeProvider());

  const targets = rowsOf<{ id: string; name: string; needs_backfill: boolean }>(
    createdBy
      ? await db.execute(sql`
          SELECT e.id, e.canonical_name AS name, e.needs_backfill
          FROM entities e
          WHERE e.merged_into IS NULL
            AND e.created_by = ${createdBy}
            AND e.type NOT IN ('fund', 'person-org')
          ORDER BY e.created_at DESC
          LIMIT ${limit}
        `)
      : await db.execute(sql`
          SELECT e.id, e.canonical_name AS name, e.needs_backfill
          FROM entities e
          WHERE e.merged_into IS NULL
            AND e.created_at >= now() - (${days}::int * interval '1 day')
            AND e.type NOT IN ('fund', 'person-org')
            AND EXISTS (
              SELECT 1 FROM article_entities ae
              JOIN articles a ON a.id = ae.article_id
              WHERE ae.entity_id = e.id AND ae.role = 'primary' AND a.noise_stage = 'kept'
            )
          ORDER BY
            COALESCE((
              SELECT COUNT(*)::int FROM entity_profiles ep
              WHERE ep.entity_id = e.id AND ep.status = 'complete'
            ), 0) ASC,
            e.created_at DESC
          LIMIT ${limit}
        `),
  );

  console.log(JSON.stringify({ days, limit, crawl, createdBy: createdBy ?? null, targets: targets.length }));

  if (targets.length === 0) {
    console.log(JSON.stringify(await profileProgress(db)));
    await db.$client.end();
    return;
  }

  const ids = targets.map((t) => String(t.id));
  const baseline = await backfillEntityBaselines(db, ids.length, ids);
  console.log(JSON.stringify({ phase: "baseline", ...baseline }));

  // Scrub-minted / thin cards often stay needs_backfill (no industry tag), which
  // skips profiling. Unlock kept-coverage targets so the user-visible card can fill.
  if (ids.length) {
    await db.execute(sql`
      UPDATE entities SET
        funding_stage = COALESCE(NULLIF(btrim(funding_stage), ''), 'unknown'),
        industry_tags = CASE
          WHEN cardinality(industry_tags) = 0 THEN ARRAY['other_diversified']::text[]
          ELSE industry_tags
        END,
        needs_backfill = false,
        updated_at = now()
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND needs_backfill = true
        AND merged_into IS NULL
    `);
  }

  let profiled = 0;
  let sectionsDone = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of targets) {
    let rounds = 0;
    let lastPending = 99;
    while (rounds < 6) {
      rounds++;
      const res = await generateEntityProfile(db, router, String(t.id), { crawl });
      if (res.skipped) {
        skipped += 1;
        console.log(
          JSON.stringify({
            entity_id: t.id,
            name: t.name,
            skipped: res.skipped,
            pending: res.pending.length,
            round: rounds,
          }),
        );
        if (res.skipped === "budget_hard") break;
        break;
      }
      sectionsDone += res.finalized.length + res.completed.length;
      console.log(
        JSON.stringify({
          entity_id: t.id,
          name: t.name,
          finalized: res.finalized.length,
          completed: res.completed.length,
          failed: res.failedNow.length,
          pending: res.pending.length,
          round: rounds,
        }),
      );
      if (res.failedNow.length) failed += 1;
      if (res.skipped === "budget_hard") break;
      if (res.pending.length === 0) {
        profiled += 1;
        break;
      }
      if (res.pending.length >= lastPending && res.completed.length === 0) break;
      lastPending = res.pending.length;
    }
  }

  const progress = await profileProgress(db);
  console.log(
    JSON.stringify({
      phase: "done",
      profiled,
      sectionsDone,
      skipped,
      failed,
      progress,
    }),
  );

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
