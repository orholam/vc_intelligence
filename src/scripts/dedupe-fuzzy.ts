import postgres from "postgres";
import { normalizeName } from "../lib/text.js";

/**
 * Fuzzy syndication dedup (FR-17 hardening): syndicates reword headlines, so
 * exact-title collapse misses them. Groups kept articles by primary entity +
 * token-Jaccard title similarity inside a recency window; keeps the earliest
 * copy of each cluster, demotes the rest with an audit reason.
 *
 *   pnpm quality:fuzzydedup [--window-hours=48] [--threshold=0.7]
 */

const arg = (name: string, def: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence",
  { max: 1, onnotice: () => {} },
);

function tokens(title: string): Set<string> {
  return new Set(
    normalizeName(title)
      .split(" ")
      .filter((t) => t.length > 2),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const windowHours = arg("window-hours", 48);
const threshold = Math.min(0.95, Math.max(0.5, arg("threshold", 0.7)));

const rows = await sql`
  SELECT a.id, a.title, a.published_at,
         ae.entity_id AS primary_entity
  FROM articles a
  LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
  WHERE a.noise_stage = 'kept'
    AND a.published_at >= now() - interval '14 days'
  ORDER BY a.published_at ASC`;

interface Row {
  id: string;
  title: string;
  published_at: Date;
  primary_entity: string | null;
}

const byKey = new Map<string, Row[]>();
for (const r of rows as unknown as Row[]) {
  // Group key: primary entity when known, else publisher-less global pool is
  // too risky — fall back to first significant title token bucket instead.
  const key =
    r.primary_entity ??
    "unresolved:" + (tokens(r.title).values().next().value ?? "none");
  const list = byKey.get(key) ?? [];
  list.push(r);
  byKey.set(key, list);
}

let demoted = 0;
const samples: string[] = [];
for (const [, list] of byKey) {
  if (list.length < 2) continue;
  const keptUntil: Array<{ t: Set<string>; at: number }> = [];
  for (const r of list) {
    const t = tokens(r.title);
    const at = new Date(r.published_at).getTime();
    const isDupe = keptUntil.some(
      (k) =>
        Math.abs(k.at - at) <= windowHours * 3600_000 && jaccard(k.t, t) >= threshold,
    );
    if (isDupe) {
      await sql`
        UPDATE articles SET noise_stage='llm_filter', noise_score=0.93,
          discard_reason=${"recheck:near_duplicate_syndication"}, updated_at=now()
        WHERE id=${r.id}`;
      demoted++;
      if (samples.length < 8) samples.push(r.title.slice(0, 70));
    } else {
      keptUntil.push({ t, at });
    }
  }
}
console.log(
  JSON.stringify({ scanned: rows.length, near_duplicates_demoted: demoted }, null, 1),
);
for (const s of samples) console.log("  •", s);

await sql.end();
