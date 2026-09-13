/**
 * Rebuild profiles that were marked complete with thin/repetitive payloads.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/profile-rebuild-thin.ts [--days=3]
 */
import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { generateEntityProfile } from "../entities/profile.js";
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

async function main(): Promise<void> {
  const days = argNum("days", 3);
  const db = createDb(getConfig().DATABASE_URL);
  const router = new LlmRouter(db, makeProvider());

  const thin = rowsOf<{ entity_id: string; name: string }>(
    await db.execute(sql`
      SELECT DISTINCT e.id AS entity_id, e.canonical_name AS name
      FROM entities e
      JOIN entity_profiles ep ON ep.entity_id = e.id
      WHERE e.merged_into IS NULL
        AND e.created_at >= now() - (${days}::int * interval '1 day')
        AND ep.status = 'complete'
        AND (
          (ep.section = 'product_offering' AND ep.payload->>'core_offering' ~* 'raises?.*million')
          OR (ep.section = 'industry' AND ep.payload->'industry'->0->>'label' = 'healthcare'
              AND e.industry_tags IS NOT NULL AND NOT (e.industry_tags && ARRAY['healthtech','biotech_pharma','medtech_devices']))
          OR ep.last_error LIKE 'thin:%'
          OR ep.payload::text LIKE '%| Beyond Background%'
        )
    `),
  );

  console.log(JSON.stringify({ days, thin_targets: thin.length }));

  for (const t of thin) {
    await db.execute(sql`
      DELETE FROM entity_profiles WHERE entity_id = ${t.entity_id}
    `);
    let rounds = 0;
    while (rounds < 5) {
      rounds++;
      const res = await generateEntityProfile(db, router, String(t.entity_id), { crawl: true });
      console.log(
        JSON.stringify({
          entity_id: t.entity_id,
          name: t.name,
          completed: res.completed.length,
          pending: res.pending.length,
          round: rounds,
        }),
      );
      if (res.pending.length === 0 || res.completed.length === 0) break;
    }
  }

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
