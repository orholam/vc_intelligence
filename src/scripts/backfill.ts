import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { migrateDatabase } from "../db/migrate-runner.js";
import { articles, kvState, sources } from "../db/schema.js";
import { SourceRegistry } from "../sources/registry.js";
import { EntityKb } from "../entities/kb.js";
import { importSeeds } from "../entities/imports/seeds.js";
import { makeProvider, LlmRouter } from "../llm/router.js";
import { LocalStorage } from "../storage.js";
import {
  handleFetchArticle,
  handleFilterArticle,
} from "../queue/jobs.js";
import { runHarness } from "../harness/run.js";
import { autocreateEntity } from "../entities/autocreate.js";
import { pollFeed } from "../ingestion/rss.js";
import { ingestFormDFilings } from "../ingestion/formd.js";
import { ingestLaunchSurfaces } from "../ingestion/launches.js";
import { isUtilityDomain } from "../lib/domains.js";
import { syncSourceTiers } from "./sync-source-tiers.js";

/**
 * Archive backfill scaffolding.
 *
 * Replays the production pipeline over the recent past window using exactly
 * the runtime systems (same tables, handlers, robots politeness, budget
 * ledger), with the mock provider standing in provisionally for LLM calls.
 *
 * RSS archives naturally reach 1-2 weeks deep on tier-1 feeds, so polling the
 * registry once yields a realistic published_at distribution across
 * `--days` (default 7; deeper windows depend on feed depth).
 *
 * Usage:
 *   pnpm backfill -- --days=7 --max-feeds=200 --max-fetch=150 --max-homepages=30
 */

function arg(name: string, def: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (raw === undefined) return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function argList(name: string): string[] {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const days = arg("days", 7);
  const maxFeeds = arg("max-feeds", 200);
  const feedConcurrency = arg("feed-concurrency", 6);
  const maxFetch = arg("max-fetch", 150);
  const fetchConcurrency = arg("fetch-concurrency", 4);
  const maxHomepages = arg("max-homepages", 30);
  const perDomain = arg("per-domain", 2);
  const excludeDomains = new Set(argList("exclude-domains"));
  const windowStart = new Date(Date.now() - days * 24 * 3600_000);

  // Local storage for extracted text during backfill.
  process.env.STORAGE_DRIVER ||= "local";
  process.env.LOCAL_STORAGE_DIR ||= path.resolve(process.cwd(), "data", "backfill-storage");
  resetConfigCache();
  const cfg = getConfig();

  console.log(`[backfill] window=${windowStart.toISOString()}..now days=${days}`);
  console.log("[backfill] migrations…");
  await migrateDatabase(cfg.DATABASE_URL);

  const db = createDb(cfg.DATABASE_URL, { max: 8 });
  const registry = new SourceRegistry(db);
  const kb = new EntityKb(db);
  const router = new LlmRouter(db, makeProvider());
  const storage = new LocalStorage(cfg.LOCAL_STORAGE_DIR);

  // ---- phase 1: seed sources + KB -------------------------------------------------
  const seedPath = process.env.FEEDS_SEED_FILE
    ? path.resolve(process.env.FEEDS_SEED_FILE)
    : path.resolve(new URL(import.meta.url, "file://").pathname, "../../../config/feeds.seed.json");
  if ((await registry.count()) === 0) {
    console.log("[1/9] seeding source registry…");
    const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as {
      feeds: Parameters<SourceRegistry["importFromRecords"]>[0];
    };
    const res = await registry.importFromRecords(parsed.feeds);
    console.log(`[1/9] sources created=${res.created} skipped=${res.skipped}`);
  } else {
    console.log(`[1/9] sources already seeded (${await registry.count()})`);
  }

  // c-plan: re-tiering is config-driven; sync tier/active into the live registry.
  const tierSync = await syncSourceTiers(db, seedPath);
  console.log(`[1/9] tier-sync ${JSON.stringify(tierSync)}`);

  const entCount = await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM entities`);
  if (!Number(entCount[0]?.n ?? 0)) {
    console.log("[2/9] importing entity seed list…");
    const seeds = await importSeeds({ db, kb });
    console.log(`[2/9] ${JSON.stringify(seeds)}`);
  } else {
    console.log(`[2/9] entities present (${Number(entCount[0]?.n ?? 0)})`);
  }

  // ---- phase 1.5: left-edge ingestion families (c-plan) ---------------------------
  let formd;
  if (process.env.BACKFILL_SKIP_FORMD !== "1") {
    console.log("[3/9] SEC Form D filings → entities + funding facts…");
    try {
      formd = await ingestFormDFilings(db, { days });
      console.log(`[3/9] formd ${JSON.stringify(formd)}`);
    } catch (e) {
      console.warn(`[3/9] Form D ingestion failed: ${(e as Error).message.slice(0, 160)}`);
    }
  } else {
    console.log("[3/9] Form D skipped (BACKFILL_SKIP_FORMD=1)");
  }

  console.log("[4/9] launch surfaces (HN Show HN / Product Hunt / …)…");
  const launchResults = await ingestLaunchSurfaces(db);
  for (const r of launchResults) {
    console.log(`[4/9] ${r.surface}: enabled=${r.enabled} seen=${r.seen} ingested=${r.ingested} newEnts=${r.entitiesCreated} dups=${r.duplicates}${r.note ? ` note=${r.note}` : ""}`);
  }

  // ---- phase 2: poll feeds ---------------------------------------------------------
  console.log("[5/9] polling feeds…");
  const allSources = await db.select().from(sources).where(eq(sources.active, true)).limit(maxFeeds);
  let pollInserted = 0;
  let pollFailed = 0;
  const insertedIds: string[] = [];
  await pool(allSources.slice(0, maxFeeds), feedConcurrency, async (src) => {
    const res = await pollFeed(db, registry, src);
    if (res.ok) pollInserted += res.inserted;
    else pollFailed++;
    insertedIds.push(...res.insertedIds);
  });
  console.log(`[5/9] polled=${allSources.length} ok=${allSources.length - pollFailed} failed=${pollFailed} newRaw=${pollInserted}`);

  // Window-filter raw items directly (works across reruns; not tied to this
  // run's insertions).
  const windowItems = await db.execute<{ id: string }>(sql`
    SELECT id FROM raw_items WHERE published_at >= ${windowStart.toISOString()}
  `);
  const targets = windowItems.map((r) => String(r.id));

  // ---- phase 3: pick fetch targets (tier, recency, per-domain cap) ------------------
  console.log(`[6/9] fetching full text for up to ${maxFetch} of ${targets.length} in-window items…`);
  const ranked = targets.length
    ? await db.execute<{ id: string; domain: string }>(sql`
        SELECT id, domain FROM (
          SELECT r.id,
                 regexp_replace(regexp_replace(r.url, '^https?://(www\\.)?', ''), '/.*$', '') AS domain,
                 ROW_NUMBER() OVER (
                   PARTITION BY regexp_replace(regexp_replace(r.url, '^https?://(www\\.)?', ''), '/.*$', '')
                   ORDER BY COALESCE(s.tier, 4) ASC, r.published_at DESC
                 ) AS rn
          FROM raw_items r LEFT JOIN sources s ON s.id = r.source_id
          WHERE r.published_at >= ${windowStart.toISOString()}
            AND r.fetch_state = 'pending'
            ${excludeDomains.size
              ? sql`AND regexp_replace(regexp_replace(r.url, '^https?://(www\\.)?', ''), '/.*$', '') NOT IN (${sql.join([...excludeDomains].map((d) => sql`${d}`), sql`, `)})`
              : sql``}
        ) ranked
        WHERE rn <= ${perDomain}
        ORDER BY rn ASC, id ASC
        LIMIT ${maxFetch}
      `)
    : [];
  const fetchList: Array<{ id: string }> = ranked.map((r) => ({ id: String(r.id) }));

  let fetched = 0;
  const keptArticles: string[] = [];
  await pool(fetchList, fetchConcurrency, async ({ id }) => {
    try {
      const { articleId } = await handleFetchArticle({ db, registry, router, storage }, id);
      if (!articleId) return;
      fetched++;
      const filterRes = await handleFilterArticle({ db, registry, router, storage }, articleId);
      if (filterRes.waiting) keptArticles.push(articleId);
    } catch (e) {
      console.warn(`[6/9] item ${id} failed: ${(e as Error).message.slice(0, 120)}`);
    }
  });
  console.log(`[6/9] fetched=${fetched}/${fetchList.length} waiting_room=${keptArticles.length}`);

  // ---- phase 4: bootstrap entities from prominent outlink domains (FR-8 agent) -----
  if (keptArticles.length) {
    const domRows = await db.execute<{ d: string; n: number }>(sql`
      SELECT d, COUNT(*)::int AS n
      FROM (
        SELECT unnest(outlink_domains) AS d
        FROM articles WHERE id IN (
          ${sql.join(keptArticles.map((a) => sql`${a}`), sql`, `)}
        )
      ) x
      WHERE d NOT IN (SELECT website FROM entities WHERE website IS NOT NULL AND merged_into IS NULL)
      GROUP BY d ORDER BY n DESC LIMIT ${maxHomepages}
    `);
    // Publishers/media outlets live in the SOURCE registry and in
    // publisher_domain columns — they are not subject companies (FR-8 guard).
    const pubHosts = new Set<string>();
    for (const h of await db.execute<{ h: string }>(sql`
      SELECT DISTINCT regexp_replace(regexp_replace(feed_url, '^https?://(www\\.)?', ''), '/.*$', '') AS h
      FROM sources
    `)) pubHosts.add(String(h.h));
    for (const h of await db.execute<{ h: string }>(sql`
      SELECT DISTINCT publisher_domain AS h FROM articles WHERE noise_stage='kept'
    `)) pubHosts.add(String(h.h));

    const domains = domRows
      .map((r) => String(r.d))
      .filter((d) => !isUtilityDomain(d))
      .filter((d) => !pubHosts.has(d.replace(/^www\./, "")))
      .slice(0, maxHomepages);
    console.log(`[7/9] autocreating entities for ${domains.length} outlink domains…`);
    let created = 0;
    for (const domain of domains) {
      try {
        const res = await autocreateEntity(db, router, { url: `https://${domain}` });
        if (res.created) created++;
      } catch (e) {
        console.warn(`[7/9] autocreate ${domain}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
    console.log(`[7/9] autocreated=${created} entities`);
  }

  // Reprocess published winners that lost their resolution (e.g. after a
  // junk-entity purge): flip them back into the waiting room so the harness
  // re-runs corrections and republishes.
  if (process.env.BACKFILL_REPROCESS === "1") {
    const reRows = await db.execute<{ id: string }>(sql`
      SELECT a.id FROM articles a
      WHERE a.noise_stage = 'kept'
        AND NOT EXISTS (
          SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id AND ae.role = 'primary'
        )
      LIMIT 400
    `);
    for (const r of reRows) {
      await db
        .update(articles)
        .set({ noiseStage: "waiting", resolvedAt: null })
        .where(eq(articles.id, String(r.id)));
    }
    console.log(`[reprocess] re-waiting ${reRows.length} unresolved winners`);
  }

  // ---- phase 5: the harness (corrections -> story match -> deep search -> cards) -----
  if (keptArticles.length || process.env.BACKFILL_REPROCESS === "1") {
    console.log(`[8/9] firing the harness over the waiting room…`);
    try {
      const summary = await runHarness({ db, registry, router, storage });
      console.log(`[8/9] harness: ${JSON.stringify(summary)}`);
    } catch (e) {
      console.warn(`[8/9] harness run failed: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  // ---- summary -----------------------------------------------------------------------
  const counts = await db.execute<{
    raw: number; arts: number; kept: number; disc: number; ents: number;
    linked: number; stories: number; facts_p: number; facts_a: number; llm_cost: number;
    formd_ents: number; launch_arts: number; first_cov: number;
  }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM raw_items) AS raw,
      (SELECT COUNT(*)::int FROM articles) AS arts,
      (SELECT COUNT(*)::int FROM articles WHERE noise_stage='kept') AS kept,
      (SELECT COUNT(*)::int FROM articles WHERE noise_stage IN ('prefilter','llm_filter')) AS disc,
      (SELECT COUNT(*)::int FROM entities) AS ents,
      (SELECT COUNT(*)::int FROM article_entities WHERE role='primary') AS linked,
      (SELECT COUNT(*)::int FROM stories) AS stories,
      (SELECT COUNT(*)::int FROM facts WHERE status='proposed') AS facts_p,
      (SELECT COUNT(*)::int FROM facts WHERE status='accepted') AS facts_a,
      (SELECT COALESCE(SUM(cost_usd),0)::float8 FROM llm_calls) AS llm_cost,
      (SELECT COUNT(*)::int FROM entities WHERE created_by='formd') AS formd_ents,
      (SELECT COUNT(*)::int FROM articles WHERE platform_meta IS NOT NULL AND noise_stage='kept') AS launch_arts,
      (SELECT COUNT(*)::int FROM articles a
        WHERE a.noise_stage='kept' AND NOT EXISTS (
          SELECT 1 FROM articles b
          JOIN article_entities be ON be.article_id = b.id AND be.role = 'primary'
          WHERE be.entity_id = (SELECT ae.entity_id FROM article_entities ae
                                WHERE ae.article_id = a.id AND ae.role = 'primary' LIMIT 1)
            AND b.noise_stage='kept' AND b.published_at < a.published_at
        )) AS first_cov
  `);
  const c = counts[0]!;
  console.log("[9/9 summary]", JSON.stringify({
    ...c,
    windowDays: days,
    ...(formd ? { formd } : {}),
    launch_ingested: launchResults.reduce((n, r) => n + r.ingested, 0),
  }, null, 2));

  await db
    .insert(kvState)
    .values({
      key: "backfill:last_run",
      value: {
        at: new Date().toISOString(),
        days,
        ...c,
        ...(formd ? { formd } : {}),
        launch_ingested: launchResults.reduce((n, r) => n + r.ingested, 0),
      },
    })
    .onConflictDoUpdate({
      target: kvState.key,
      set: { value: { at: new Date().toISOString(), days, ...c } },
    });

  process.exit(0);
}

main().catch((err: Error) => {
  console.error("backfill failed:", err.stack?.split("\n").slice(0, 4).join("\n") ?? err.message);
  process.exit(1);
});
