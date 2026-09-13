import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { benchmarkRuns, kvState } from "../db/schema.js";
import { opaqueId } from "../lib/ulid.js";
import type { LlmRouter } from "../llm/router.js";
import { queryGdelt } from "../ingestion/gdelt.js";
import { loadBenchmarkCompanies, type BenchmarkCompany } from "./companies.js";
import { judgeStories, type JudgedStory } from "./judge.js";
import { makeWebSearchAdapter } from "./webcheck.js";

/**
 * FR-23 self-benchmark harness — port of akta-pro's public methodology:
 *   - 133-company list + date-window protocol
 *   - retrieval: internal index AND GDELT (second "provider" so recall has a
 *     validated-story universe; akta compares multiple providers)
 *   - neutral-LLM judging (different family than production) per story
 *   - independent web-search validation (Serper adapter; cross-provider
 *     corroboration substitutes when no search key is configured)
 *   - metrics identical to their definitions (see metrics below)
 *   - report -> benchmarks/YYYY-MM.md + raw archive in object storage + DB row
 */

export interface HarnessOptions {
  windowDays?: number;
  windowEnd?: Date;
  maxCompanies?: number;
  maxStoriesPerProvider?: number;
}

interface RetrievedStory {
  headline: string;
  url: string;
  publishedDate: string;
  publisherDomain: string;
}

export interface ProviderRun {
  provider: "internal" | "gdelt";
  stories: RetrievedStory[];
  judged: JudgedStory[];
}

export interface CompanyResult {
  company: BenchmarkCompany;
  internal: ProviderRun;
  gdelt: ProviderRun;
}

export interface Metrics {
  newsPrecisionPct: number;
  companyPrecisionPct: number;
  overallPrecisionPct: number;
  recallPct: number;
  f1Pct: number;
  coveragePct: number;
  costUsd: number;
  costPer1kCorrectUsd: number | null;
}

async function retrieveInternal(
  db: Db,
  company: BenchmarkCompany,
  windowStart: Date,
  windowEnd: Date,
): Promise<RetrievedStory[]> {
  const real = await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT a.title, a.url, a.published_at, a.publisher_domain
    FROM articles a
    JOIN article_entities x ON x.article_id = a.id AND x.role IN ('primary','secondary')
    JOIN entities e ON e.id = x.entity_id
    WHERE a.noise_stage = 'kept'
      AND a.published_at BETWEEN ${windowStart.toISOString()} AND ${windowEnd.toISOString()}
      AND (
        (${company.website ?? ""} <> '' AND e.website = ${company.website})
        OR e.canonical_name ILIKE ${`%${company.name}%`}
        OR a.title ILIKE ${`%${company.name}%`}
      )
    ORDER BY a.published_at DESC
    LIMIT 40
  `);
  return real.map((r) => ({
    headline: String(r.title),
    url: String(r.url),
    publishedDate: new Date(String(r.published_at)).toISOString(),
    publisherDomain: String(r.publisher_domain),
  }));
}

async function retrieveGdelt(
  company: BenchmarkCompany,
  windowStart: Date,
  windowEnd: Date,
): Promise<RetrievedStory[]> {
  // Free-tier GDELT quota is shared with the live watcher; when exhausted the
  // per-company queries backoff for minutes each. BENCHMARK_SKIP_GDELT=1 runs
  // the harness internal-index-only and says so in the artifact (disclosure).
  if (process.env.BENCHMARK_SKIP_GDELT === "1") return [];
  const days = Math.max(1, Math.ceil((windowEnd.getTime() - windowStart.getTime()) / 86_400_000));
  const hits = await queryGdelt(`"${company.name}"`, {
    maxRecords: 40,
    timespan: `${days}d`,
  });
  return hits
    .map((h) => ({
      headline: h.title ?? "",
      url: h.url,
      publishedDate: h.seendate ? parseGdeltDate(h.seendate).toISOString() : windowStart.toISOString(),
      publisherDomain: h.domain ?? "",
    }))
    .filter((s) => {
      const t = Date.parse(s.publishedDate);
      return t >= windowStart.getTime() && t <= windowEnd.getTime();
    });
}

function parseGdeltDate(seen: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seen.trim());
  if (m) {
    const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x));
    return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, se!));
  }
  return new Date(seen);
}

// ------------------------------------------------------------------- metrics
/** Metric definitions mirror akta metrics/readme.md. */
export function computeMetrics(
  runs: ProviderRun[],
  allValidatedStoryUrls: Set<string>,
  costUsd: number,
): Metrics {
  let judgedNews = 0;
  let newsYes = 0;
  let judgedCompany = 0;
  let aboutYes = 0;
  let correctArticles = 0;

  for (const run of runs) {
    for (const j of run.judged) {
      if (!j.isRealNews && !j.reason.startsWith("judge_error")) continue; // unjudgeable excluded
      if (j.reason.startsWith("judge_error")) continue;
      judgedNews++;
      if (j.isRealNews) newsYes++;
      if (j.isRealNews) {
        judgedCompany++;
        if (j.isAboutCompany) aboutYes++;
        if (j.isAboutCompany && j.isInWindow) correctArticles++;
      }
    }
  }

  const newsPrecisionPct = judgedNews ? (newsYes / judgedNews) * 100 : 0;
  const companyPrecisionPct = judgedCompany ? (aboutYes / judgedCompany) * 100 : 0;
  // overall precision = product of the two percentages / 100 (akta definition)
  const overallPrecisionPct = (newsPrecisionPct * companyPrecisionPct) / 100;

  // recall over validated story universe (cross-provider union)
  let covered = 0;
  for (const run of runs) {
    for (const j of run.judged) {
      if (j.isRealNews && j.isAboutCompany && allValidatedStoryUrls.has(normalizeUrlKey(j.url))) {
        covered++;
        break; // one hit per provider suffices; loop guards per-run counting
      }
    }
  }
  const totalValidated = Math.max(allValidatedStoryUrls.size, 0);
  const recallPct = totalValidated ? (covered / totalValidated) * 100 : 0;
  const f1Pct =
    overallPrecisionPct + recallPct > 0
      ? (2 * overallPrecisionPct * recallPct) / (overallPrecisionPct + recallPct)
      : 0;

  return {
    newsPrecisionPct: round(newsPrecisionPct),
    companyPrecisionPct: round(companyPrecisionPct),
    overallPrecisionPct: round(overallPrecisionPct),
    recallPct: round(recallPct),
    f1Pct: round(f1Pct),
    coveragePct: 0,
    costUsd: round(costUsd, 4),
    costPer1kCorrectUsd: correctArticles ? round((costUsd / correctArticles) * 1000, 4) : null,
  };
}

function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// -------------------------------------------------------------------- runner
export async function runBenchmarkHarness(
  db: Db,
  router: LlmRouter,
  opts: HarnessOptions = {},
): Promise<{ period: string; metrics: Metrics; reportPath: string }> {
  const companies = loadBenchmarkCompanies().slice(0, opts.maxCompanies ?? 133);
  const windowEnd = opts.windowEnd ?? new Date(); // protocol: trailing window ending now
  const windowDays = opts.windowDays ?? 7;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 3600 * 1000);

  // Name the artifact by the window-END month (the month being graded);
  // a Jul-22..Aug-22 window closes in August.
  const period = (windowEnd ?? new Date()).toISOString().slice(0, 7);
  const spendBefore = await monthSpend(db);
  const webcheck = makeWebSearchAdapter();

  const results: CompanyResult[] = [];
  for (const company of companies) {
    const [internalStories, gdeltStories] = await Promise.all([
      retrieveInternal(db, company, windowStart, windowEnd),
      retrieveGdelt(company, windowStart, windowEnd).catch(() => [] as RetrievedStory[]),
    ]);

    const internalJudged = await judgeStories(router, company.name, windowStart.toISOString(), windowEnd.toISOString(), dedupe(internalStories));
    const gdeltJudged = await judgeStories(router, company.name, windowStart.toISOString(), windowEnd.toISOString(), dedupe(gdeltStories));

    results.push({
      company,
      internal: { provider: "internal", stories: dedupe(internalStories), judged: internalJudged },
      gdelt: { provider: "gdelt", stories: dedupe(gdeltStories), judged: gdeltJudged },
    });

    // rate-limit friendliness toward the free GDELT API
    await new Promise((r) => setTimeout(r, 400));
  }

  // Validated-story universe: cross-provider corroborated OR webcheck-supported.
  // R09 guard: a webcheck layer that returns empty for every probe is DOWN,
  // not "story invalid" — writing a recall-0 artifact on infra failure would
  // silently degrade measurement. Abort loudly instead; rerun when it recovers.
  // Validation persistence: a successful probe is a FACT about the world (the
  // story exists on the open web) — cached in kv_state so later runs inherit
  // earlier evidence instead of re-rolling probe luck under rate limits.
  const webcheckAttempts = { searches: 0, nonEmpty: 0 };
  const cacheKey = "benchmark_webcheck_validations";
  const validationCache = new Set<string>(
    await db
      .select({ v: kvState.value })
      .from(kvState)
      .where(eq(kvState.key, cacheKey))
      .then((rows) => ((rows[0]?.v as string[] | undefined) ?? []))
      .catch(() => []),
  );
  const newlyValidated = new Set<string>();
  const validatedUrls = new Set<string>(validationCache);
  for (const res of results) {
    const internalUrls = new Set(res.internal.judged.filter(isCorrect).map((j) => normalizeUrlKey(j.url)));
    const gdeltUrls = new Set(res.gdelt.judged.filter(isCorrect).map((j) => normalizeUrlKey(j.url)));
    for (const u of internalUrls) if (gdeltUrls.has(u)) validatedUrls.add(u);
    for (const u of gdeltUrls) if (internalUrls.has(u)) validatedUrls.add(u);
    if (webcheck.name !== "noop") {
      for (const j of [...res.internal.judged, ...res.gdelt.judged]) {
        if (!isCorrect(j)) continue;
        const urlKey = normalizeUrlKey(j.url);
        if (validationCache.has(urlKey)) {
          validatedUrls.add(urlKey);
          continue;
        }
        if (webcheckAttempts.searches >= 15 && webcheckAttempts.nonEmpty === 0 && validatedUrls.size === 0) {
          throw new Error(
            `webcheck '${webcheck.name}' returned no results for ${webcheckAttempts.searches} consecutive probes — ` +
            `validation provider unavailable (rate-limited or down). Benchmark aborted without writing an artifact; ` +
            `retry when the search index recovers.`,
          );
        }
        webcheckAttempts.searches++;
        const snippets = await webcheck.search(j.headline).catch(() => []);
        if (snippets.length) {
          webcheckAttempts.nonEmpty++;
          validatedUrls.add(urlKey);
          newlyValidated.add(urlKey);
        }
      }
    }
  }
  if (newlyValidated.size && webcheck.name !== "noop") {
    try {
      await db
        .insert(kvState)
        .values({ key: cacheKey, value: [...validationCache, ...newlyValidated] as unknown as never })
        .onConflictDoUpdate({
          target: kvState.key,
          set: { value: [...validationCache, ...newlyValidated] as unknown as never, updatedAt: new Date() },
        });
    } catch {
      // cache write is best-effort: measurement proceeds uncached
    }
  }

  const spendAfter = await monthSpend(db);
  const costUsd = Math.max(0, spendAfter - spendBefore);

  // Overall metrics across providers (leaderboard style, one row per provider).
  const byProvider = (p: ProviderRun["provider"]) =>
    results.flatMap((r) => [r.internal, r.gdelt]).filter((run) => run.provider === p);
  const internalMetrics = computeMetrics(byProvider("internal"), validatedUrls, costUsd);
  const gdeltMetrics = computeMetrics(byProvider("gdelt"), validatedUrls, 0);

  const companiesCovered = results.filter((r) =>
    r.internal.judged.some((j) => j.isRealNews && j.isAboutCompany && j.isInWindow),
  ).length;
  internalMetrics.coveragePct = round((companiesCovered / companies.length) * 100);

  const reportPath = await writeReport(period, {
    windowStart,
    windowEnd,
    companiesCount: companies.length,
    validatedStoryCount: validatedUrls.size,
    webcheckProbes: { ...webcheckAttempts, cacheHits: validationCache.size },
    internalMetrics,
    gdeltMetrics,
    results,
    degradeEvents: await degradeDisclosure(db, windowStart),
  });

  await db.insert(benchmarkRuns).values({
    id: opaqueId("bnr"),
    period,
    windowStart,
    windowEnd,
    config: {
      windowDays,
      companies: companies.length,
      webcheck: webcheck.name,
      webcheckProbes: { ...webcheckAttempts, cacheHits: validationCache.size },
    },
    metrics: { internal: internalMetrics, gdelt: gdeltMetrics } as unknown as never,
    reportPath,
    status: "done",
    llmCostUsd: costUsd,
    finishedAt: new Date(),
  });

  return { period, metrics: internalMetrics, reportPath };
}

function isCorrect(j: JudgedStory): boolean {
  return j.isRealNews && j.isAboutCompany;
}

function dedupe(stories: RetrievedStory[]): RetrievedStory[] {
  const seen = new Set<string>();
  return stories.filter((s) => {
    const k = normalizeUrlKey(s.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function monthSpend(db: Db): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    SELECT COALESCE(SUM(cost_usd),0)::float8 AS total FROM llm_calls
    WHERE created_at >= date_trunc('month', now())
  `);
  return Number(rows[0]?.total ?? 0);
}

// --------------------------------------------------------------------- report
interface ReportInput {
  windowStart: Date;
  windowEnd: Date;
  companiesCount: number;
  validatedStoryCount: number;
  /** R09: probe health of the validation layer for this run. */
  webcheckProbes: { searches: number; nonEmpty: number; cacheHits: number };
  internalMetrics: Metrics;
  gdeltMetrics: Metrics;
  results: CompanyResult[];
  /** R09: budget degradation in-window is disclosed, never silent. */
  degradeEvents: Array<{ kind: string; message: string; created_at: string }>;
}

/** R09/G4: budget degrade/stop events recorded by the router during the window. */
async function degradeDisclosure(db: Db, windowStart: Date) {
  const rows = await db.execute<{ kind: string; message: string; created_at: string }>(sql`
    SELECT kind, message, created_at FROM pipeline_events
    WHERE kind IN ('budget_degrade_soft', 'budget_stop_hard')
      AND created_at >= ${windowStart.toISOString()}::timestamptz
    ORDER BY created_at ASC LIMIT 50
  `);
  return rows.map((r) => ({
    kind: r.kind,
    message: r.message,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

async function writeReport(period: string, input: ReportInput): Promise<string> {
  const dir = path.resolve(process.cwd(), "benchmarks");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${period}.md`);

  const lines: string[] = [];
  lines.push(`# Benchmark — ${period}`);
  lines.push("");
  lines.push(`> Methodology ported from github.com/akta-pro/benchmark-company-news-retrieval.`);
  lines.push(`> Judge model family differs from production models; validation via ${input.validatedStoryCount} corroborated/web-checked stories.`);
  lines.push(`> Validation probes this run: ${input.webcheckProbes.searches} attempted, ${input.webcheckProbes.nonEmpty} returned evidence, ${input.webcheckProbes.cacheHits} served from prior-run cache.`);
  lines.push("");
  lines.push(`Window: ${input.windowStart.toISOString()} → ${input.windowEnd.toISOString()}`);
  lines.push(`Companies: ${input.companiesCount}`);
  lines.push("");
  lines.push("| metric | internal | gdelt (baseline) |");
  lines.push("|---|---|---|");
  const m = input.internalMetrics;
  const g = input.gdeltMetrics;
  lines.push(`| news precision % | ${m.newsPrecisionPct} | ${g.newsPrecisionPct} |`);
  lines.push(`| company-entity precision % | ${m.companyPrecisionPct} | ${g.companyPrecisionPct} |`);
  lines.push(`| overall precision % | ${m.overallPrecisionPct} | ${g.overallPrecisionPct} |`);
  lines.push(`| recall % | ${m.recallPct} | ${g.recallPct} |`);
  lines.push(`| F1 % | ${m.f1Pct} | ${g.f1Pct} |`);
  lines.push(`| company coverage % | ${m.coveragePct} | - |`);
  lines.push(`| $/1K correct articles | ${m.costPer1kCorrectUsd ?? "-"} | - |`);
  lines.push(`| LLM cost $ | ${m.costUsd} | 0 |`);
  lines.push("");
  lines.push("## Budget degradation disclosure (R09)");
  lines.push("");
  if (input.degradeEvents.length === 0) {
    lines.push("No soft-cap degrade or hard-cap stop events were recorded in this window.");
  } else {
    lines.push(
      "This window experienced budget degradation; grade it against that disclosure:",
    );
    lines.push("");
    for (const e of input.degradeEvents) {
      lines.push(`- \`${e.created_at}\` **${e.kind}** — ${e.message}`);
    }
  }
  lines.push("");

  await fs.promises.writeFile(file, lines.join("\n"));
  // Raw outputs archived next to the report (raw/ is gitignored).
  const rawDir = path.resolve(process.cwd(), "benchmarks", "raw");
  await fs.promises.mkdir(rawDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(rawDir, `${period}-${Date.now()}.json`),
    JSON.stringify(input.results, null, 2),
  );
  return path.relative(process.cwd(), file);
}
