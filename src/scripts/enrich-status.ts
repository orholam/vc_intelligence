/**
 * Profile enrichment status for the enrich-new-companies skill (no LLM).
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/enrich-status.ts [--days=2]
 *
 * User-visible success = newest kept-coverage companies have baseline +
 * at least one complete profile section. Corpus-wide sections_pending is
 * background debt — not the done signal.
 */
import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { profileProgress } from "../entities/profile.js";

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

async function main(): Promise<void> {
  const days = argNum("days", 2);
  const db = createDb(getConfig().DATABASE_URL);

  const progress = await profileProgress(db);

  const recent = rowsOf<{
    id: string;
    name: string;
    created_at: Date | string;
    needs_backfill: boolean;
    website: string | null;
    complete_sections: number;
  }>(
    await db.execute(sql`
      SELECT e.id,
             e.canonical_name AS name,
             e.created_at,
             e.needs_backfill,
             e.website,
             COALESCE((
               SELECT COUNT(*)::int FROM entity_profiles ep
               WHERE ep.entity_id = e.id AND ep.status = 'complete'
             ), 0) AS complete_sections
      FROM entities e
      WHERE e.merged_into IS NULL
        AND e.created_at >= now() - (${days}::int * interval '1 day')
        AND e.type NOT IN ('fund', 'person-org')
        AND EXISTS (
          SELECT 1 FROM article_entities ae
          JOIN articles a ON a.id = ae.article_id
          WHERE ae.entity_id = e.id AND ae.role = 'primary' AND a.noise_stage = 'kept'
        )
      ORDER BY e.created_at DESC
    `),
  );

  const empty = recent.filter((r) => Number(r.complete_sections) === 0);
  const stillBackfill = recent.filter((r) => r.needs_backfill);
  const withProfile = recent.filter((r) => Number(r.complete_sections) > 0);

  const statsRes = await fetch(`${process.env.HARNESS_BRAIN_BASE ?? "http://127.0.0.1:4600"}/internal/llm/stats`).catch(
    () => null,
  );
  const llmQueue = statsRes?.ok ? ((await statsRes.json()) as { queue?: unknown }).queue : null;

  console.log(
    JSON.stringify(
      {
        days,
        recent_with_coverage: recent.length,
        recent_with_profile: withProfile.length,
        recent_empty: empty.length,
        recent_needs_backfill: stillBackfill.length,
        newest_empty: empty.slice(0, 15).map((r) => ({
          name: r.name,
          id: r.id,
          complete_sections: Number(r.complete_sections),
          needs_backfill: Boolean(r.needs_backfill),
          website: r.website,
          created_at: r.created_at,
        })),
        progress,
        llm_queue: llmQueue,
      },
      null,
      2,
    ),
  );

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
