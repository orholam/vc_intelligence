import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import type { Db } from "../db/index.js";

/**
 * OUTPUT-RUBRIC §8 judgment protocol tooling: generates the fixed monthly
 * stratified samples (60 articles / 40 entities / 30 facts / 40 summaries /
 * 20 clusters / 10 canned ListGen queries) and writes them alongside the
 * FIXED-COLUMN judgments.csv contract so scores stay auditable and
 * drift-comparable month over month.
 *
 * Read-only against the corpus; ~90 minutes of judging follows offline.
 *
 * Usage: pnpm rubric:sample [--window-days=31]
 */

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/** Fixed column contract — changing this invalidates month-over-month drift. */
const JUDGMENTS_COLUMNS = [
  "item_kind",
  "item_id",
  "stratum",
  "judge",
  "judged_at",
  // article judgments (B1/B2/B5)
  "is_real_news_about_real_company",
  "is_right_company",
  "is_category_correct",
  "precision_ok_for_source_floor",
  // entity judgments (C0/C2/D3/D4/D5)
  "venture_band",
  "baseline_fields_ok",
  "resolution_verified",
  "confidence_decile",
  "registry_linkage_ok",
  // fact judgments
  "fact_type_correct",
  "amount_within_20pct_or_estimated",
  "investors_real_and_attributed",
  "date_within_14d",
  "reject_reason_coherent",
  // summary/cluster judgments (E4/E5)
  "summary_fully_faithful",
  "cluster_pure",
  "cluster_split_missed",
  "representative_best_tier",
  // listgen judgments (G2)
  "listgen_precision_at_limit",
  "interpreted_filters_match_intent",
  "notes",
] as const;

interface SampleRow {
  kind: string;
  id: string;
  stratum: string;
}

/**
 * Deterministic stratified draw: rows ordered by id, every stride-th taken so
 * re-running in the same window yields the identical panel (auditability).
 */
async function draw(
  db: Db,
  querySql: ReturnType<typeof sql>,
  n: number,
  kind: string,
  stratumOf: (r: Record<string, unknown>) => string,
): Promise<SampleRow[]> {
  const rows = await db.execute<Record<string, unknown>>(querySql);
  const ids = rows.map((r) => String(r.id));
  if (!ids.length) return [];
  const stride = Math.max(1, Math.floor(ids.length / n));
  const out: SampleRow[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (out.length < n && i < rows.length * Math.max(1, Math.ceil(n / Math.max(1, ids.length)))) {
    const r = rows[(i * stride) % rows.length]!;
    const id = String(r.id);
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ kind, id, stratum: stratumOf(r) });
    }
    i++;
    if (stride === 1 && seen.size >= rows.length) break;
  }
  return out.slice(0, n);
}

export async function buildSamples(db: Db, days: number) {
  const articles = await draw(
    db,
    sql`
      SELECT a.id, s.tier::text AS tier, COALESCE(a.newsworthiness, 'none') AS nw
      FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.created_at >= now() - (${days} * interval '1 day') AND a.noise_stage = 'kept'
      ORDER BY a.id
    `,
    60,
    "article",
    (r) => `tier:${r.tier ?? "?"}|nw:${r.nw}`,
  );

  const entityRows = await db.execute<Record<string, unknown>>(sql`
    SELECT e.id, e.created_by,
           width_bucket(e.confidence, 0, 1, 10)::text AS decile
    FROM entities e
    WHERE e.created_at >= now() - (${days} * interval '1 day') AND e.merged_into IS NULL
    ORDER BY e.id
  `);
  // Stratify created_by x confidence-decile deterministically.
  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const r of entityRows) {
    const k = `${r.created_by}|d${r.decile}`;
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }
  const entities: SampleRow[] = [];
  let round = 0;
  while (entities.length < 40 && buckets.size > 0 && round < 100) {
    for (const [k, list] of [...buckets.entries()].sort()) {
      const pick = list[round];
      if (pick) entities.push({ kind: "entity", id: String(pick.id), stratum: k });
      if (entities.length >= 40) break;
    }
    round++;
  }

  const facts = await draw(
    db,
    sql`
      SELECT id, type FROM facts WHERE created_at >= now() - (${days} * interval '1 day')
      ORDER BY id
    `,
    30,
    "fact",
    (r) => `type:${r.type}`,
  );

  const summaries = await draw(
    db,
    sql`
      SELECT id, COALESCE(newsworthiness, 'none') AS nw FROM articles
      WHERE created_at >= now() - (${days} * interval '1 day')
        AND noise_stage = 'kept' AND ai_summary IS NOT NULL
      ORDER BY id
    `,
    40,
    "summary",
    (r) => `nw:${r.nw}`,
  );

  const clusters = await draw(
    db,
    sql`
      SELECT s.id, s.article_count::text AS size FROM stories s
      WHERE s.first_seen_at >= now() - (${days} * interval '1 day') AND s.article_count > 1
      ORDER BY s.id
    `,
    20,
    "cluster",
    (r) => `size:${r.size}`,
  );

  let listgen: SampleRow[] = [];
  try {
    const cfgPath = path.resolve(process.cwd(), "config", "rubric.listgen.queries.json");
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      queries?: Array<{ id?: string }>;
    };
    listgen = (parsed.queries ?? [])
      .slice(0, 10)
      .map((q, idx) => ({
        kind: "listgen",
        id: String(q.id ?? `query-${idx + 1}`),
        stratum: "canned",
      }));
  } catch {
    // truth-set file missing -> empty section, CSV still emitted
  }

  return { articles, entities, facts, summaries, clusters, listgen };
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export async function writeJudgmentPack(db: Db, days: number): Promise<string> {
  const samples = await buildSamples(db, days);
  const period = new Date().toISOString().slice(0, 7);
  const dir = path.resolve(process.cwd(), "rubric", period);
  fs.mkdirSync(dir, { recursive: true });

  const all: SampleRow[] = [
    ...samples.articles,
    ...samples.entities,
    ...samples.facts,
    ...samples.summaries,
    ...samples.clusters,
    ...samples.listgen,
  ];

  const csvPath = path.join(dir, "judgments.csv");
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, JUDGMENTS_COLUMNS.join(",") + "\n");
  }
  // Append any item ids not already logged (idempotent re-runs).
  const existing = new Set(
    fs
      .readFileSync(csvPath, "utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(",")[1]),
  );
  const app = all
    .filter((s) => !existing.has(s.id))
    .map((s) =>
      [
        s.kind,
        s.id,
        csvEscape(s.stratum),
        ...Array.from({ length: JUDGMENTS_COLUMNS.length - 3 }, () => ""),
      ].join(","),
    );
  if (app.length) fs.appendFileSync(csvPath, app.join("\n") + "\n");

  fs.writeFileSync(path.join(dir, "samples.json"), JSON.stringify({ period, days, samples }, null, 2));

  console.log(`# rubric pack ${period}`);
  console.log(`articles: ${samples.articles.length}  entities: ${samples.entities.length}  facts: ${samples.facts.length}`);
  console.log(`summaries: ${samples.summaries.length}  clusters: ${samples.clusters.length}  listgen: ${samples.listgen.length}`);
  console.log(`judgments: ${csvPath} (+${app.length} new rows)`);
  console.log(`samples:   ${path.join(dir, "samples.json")}`);
  return dir;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 2 });
  const days = Number(arg("window-days") ?? 31);
  await writeJudgmentPack(db, Number.isFinite(days) ? days : 31);
}

// CLI guard so tests can import without side effects.
if (process.argv[1] && process.argv[1].includes("rubric-sample")) {
  main()
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error("sample failed:", err.message);
      process.exit(1);
    });
}
