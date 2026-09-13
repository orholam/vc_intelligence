import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { type Db, createDb } from "../db/index.js";
import { migrateDatabase } from "../db/migrate-runner.js";
import { articleEntities, articles, sources } from "../db/schema.js";
import { canonicalizeUrl, hostToDomain, sha256Hex } from "../lib/hash.js";
import { opaqueId } from "../lib/ulid.js";
import { SourceRegistry, type SourceInput } from "../sources/registry.js";
import { EntityKb } from "../entities/kb.js";
import { entityNameRejectionReason } from "../lib/quality.js";

// Reuse xmonitor's pure de-noise classifier (sibling workspace package).
// Structural mirror of xmonitor/src/denoise.ts `evaluateLaunch` — declared
// locally so the type-only import stays out of the build program
// (tsconfig.build.json rootDir=src cannot span the workspace sibling).
type EvaluateLaunch = (input: {
  text: string;
  linkedDomain: string | null;
  views: number;
}) => { ok: boolean; score: number; reason: string };

/**
 * Bridge: copy xmonitor (X launch watcher, standalone SQLite) captures into
 * this service's `articles` table so they flow through the standard pipeline.
 *
 * Schema mapping — no new tables/columns:
 *   url / urlHash          <- tweet permalink (canonicalized)
 *   publisherDomain        <- x.com (the announcement's publisher)
 *   title                  <- first line of the post
 *   byline                 <- @author
 *   excerptText            <- full post text (≤400 chars)
 *   outlinkDomains         <- product domain linked in the post, if any
 *   platformMeta           <- surface:"x_monitor" + likes/views/retweets/
 *                             replies/video_count/query_id/external_url
 *   noiseStage             <- "pending" (standard filtering applies)
 */

const SOURCE_NAME = "X Launch Monitor";
const SOURCE_FEED_URL = "https://xmonitor.copyr.local/x-launches";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

function numArg(name: string, def: number): number {
  const raw = arg(name);
  if (raw === undefined) return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

interface XmLaunch {
  tweetId: string;
  authorHandle: string;
  authorName: string | null;
  text: string;
  url: string | null;
  linkedDomain: string | null;
  videoCount: number;
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  score: number;
  queryId: string | null;
  postedAtSec: number | null;
  firstSeenAtSec: number;
}

function loadFromSqlite(dbPath: string, opts: { hours: number; minScore: number; limit: number }): XmLaunch[] {
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cutoff = Math.floor(Date.now() / 1000) - opts.hours * 3600;
    return sqlite
      .prepare(
        `SELECT tweet_id AS tweetId, author_handle AS authorHandle, author_name AS authorName,
                text, url, linked_domain AS linkedDomain, video_count AS videoCount,
                views, likes, retweets, replies, score, query_id AS queryId,
                posted_at AS postedAtSec, first_seen_at AS firstSeenAtSec
         FROM launches
         WHERE COALESCE(posted_at, first_seen_at) >= ? AND score >= ?
         ORDER BY score DESC
         LIMIT ?`,
      )
      .all(cutoff, opts.minScore, opts.limit) as unknown as XmLaunch[];
  } finally {
    sqlite.close();
  }
}

async function ensureSource(db: Db): Promise<string> {
  const registry = new SourceRegistry(db);
  const input: SourceInput = {
    name: SOURCE_NAME,
    publisher: "X (Twitter) — build-in-public launch posts",
    feedUrl: SOURCE_FEED_URL,
    tier: 2,
    country: null,
    defaultLanguage: "en",
    topics: ["product-launch", "startups"],
    active: false, // not an RSS feed; polling lives in xmonitor itself
  };
  try {
    const row = await registry.create(input);
    return row.id;
  } catch {
    const existing = await db.select({ id: sources.id }).from(sources).where(eq(sources.feedUrl, SOURCE_FEED_URL)).limit(1);
    if (!existing.length) throw new Error("could not create or find X Launch Monitor source");
    return existing[0]!.id;
  }
}

/**
 * Attach the launched product as primary entity via the post's linked domain
 * (§6.2: website is the primary join key). The standard resolver only links
 * existing KB entities — these products are usually new, so we key on the
 * outlink domain like launchmonitor does. Idempotent per (article, entity).
 */
export async function attachEntityByDomain(
  db: Db,
  articleId: string,
  linkedDomain: string | null,
): Promise<boolean> {
  if (!linkedDomain) return false;
  const domain = hostToDomain(linkedDomain);
  if (!domain || !domain.includes(".")) return false;
  const kb = new EntityKb(db);
  let entityId: string;
  const existing = await kb.findByWebsite(domain);
  if (existing) {
    entityId = existing.id;
  } else {
    const brand =
      domain.replace(/^www\./, "").split(".")[0]?.replace(/[-_]/g, " ") ?? domain;
    const canonicalName = brand.charAt(0).toUpperCase() + brand.slice(1);
    // Skip junk brands rather than polluting the KB (same guard as FR-8).
    if (!canonicalName || entityNameRejectionReason(canonicalName)) return false;
    const entity = await kb.create(
      {
        canonicalName,
        website: domain,
        confidence: 0.55,
        reviewStatus: "auto_created",
        createdBy: "xmonitor",
        sourceRefs: ["x-monitor"],
      },
      "x-monitor",
    );
    entityId = entity.id;
  }
  const linked = await db
    .insert(articleEntities)
    .values({
      articleId,
      entityId,
      role: "primary",
      confidence: 0.8,
      evidence: { domain_overlap: true, llm: "not_needed", notes: ["x-monitor:outlink"] },
    })
    .onConflictDoNothing();
  return linked.count > 0;
}

async function main(): Promise<void> {
  const hours = numArg("hours", 48);
  const minScore = numArg("min-score", 0.5);
  const limit = numArg("limit", 200);
  const dryRun = process.argv.includes("--dry-run");
  const noDenoise = process.argv.includes("--no-denoise");
  const xmDb = arg("xm-db") ?? path.resolve(import.meta.dirname ?? ".", "../../xmonitor/data/xmonitor.sqlite");

  const xmonitorRoot = path.resolve(import.meta.dirname ?? ".", "../../xmonitor");
  const { evaluateLaunch } = (await import(
    pathToFileURL(path.join(xmonitorRoot, "src/denoise.ts")).href
  )) as { evaluateLaunch: EvaluateLaunch };

  resetConfigCache();
  const cfg = getConfig();
  await migrateDatabase(cfg.DATABASE_URL);
  const db = createDb(cfg.DATABASE_URL, { max: 8 });

  const all = loadFromSqlite(xmDb, { hours, minScore, limit });
  const rejected: Array<{ handle: string; reason: string }> = [];
  const launches: XmLaunch[] = [];
  for (const l of all) {
    const verdict = noDenoise
      ? { ok: true as const, score: l.score, reason: "denoise-disabled" }
      : evaluateLaunch({ text: l.text, linkedDomain: l.linkedDomain, views: l.views });
    if (verdict.ok) launches.push(l);
    else rejected.push({ handle: `@${l.authorHandle}`, reason: verdict.reason });
  }
  console.log(
    `[import-xmonitor] ${all.length} captured -> ${launches.length} pass de-noise, ${rejected.length} rejected` +
      `${dryRun ? " [DRY RUN]" : ""}`,
  );
  const byReason: Record<string, number> = {};
  for (const r of rejected) {
    const key = r.reason.split("(")[0] ?? "other";
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  for (const [reason, n] of Object.entries(byReason)) console.log(`   ✗ ${n}\t${reason}`);
  if (!launches.length) return;

  const sourceId = await ensureSource(db);
  console.log(`[import-xmonitor] source=${SOURCE_NAME} (${sourceId})`);

  let inserted = 0;
  let skipped = 0;
  let linked = 0;
  for (const l of launches) {
    const permalink = l.url ?? `https://x.com/${l.authorHandle}/status/${l.tweetId}`;
    const canon = canonicalizeUrl(permalink);
    const firstSentence = l.text.split("\n")[0]?.trim() || `Launch post by @${l.authorHandle}`;
    const title = firstSentence.slice(0, 160);
    const values = {
      id: opaqueId("art"),
      sourceId,
      url: permalink,
      urlHash: sha256Hex(canon),
      publisherDomain: "x.com",
      title,
      byline: `@${l.authorHandle}`,
      publishedAt: new Date((l.postedAtSec ?? l.firstSeenAtSec) * 1000),
      language: "en",
      excerptText: l.text.replace(/\s+/g, " ").trim().slice(0, 400),
      outlinkDomains: l.linkedDomain ? [l.linkedDomain] : [],
      platformMeta: {
        surface: "x_monitor",
        likes: l.likes,
        views: l.views,
        retweets: l.retweets,
        replies: l.replies,
        video_count: l.videoCount,
        external_url: l.linkedDomain,
        query_id: l.queryId,
        monitor_score: l.score,
      },
      noiseStage: "kept" as const, // de-noised upstream by xmonitor's evaluateLaunch gate
      noiseScore: l.score,
    };

    if (dryRun) {
      console.log(`  would add: ${values.byline} ❤${l.likes} 👁${l.views} — ${title.slice(0, 70)}`);
      inserted++;
      continue;
    }

    const res = await db.insert(articles).values(values)
      .onConflictDoNothing({ target: articles.urlHash })
      .returning({ id: articles.id });
    if (res.length) {
      inserted++;
      try {
        if (await attachEntityByDomain(db, res[0]!.id, l.linkedDomain)) linked++;
      } catch (e) {
        console.error(`   entity attach failed for ${permalink}: ${(e as Error).message}`);
      }
    } else {
      skipped++;
    }
  }

  console.log(`[import-xmonitor] done: ${inserted} imported (${linked} entity-linked), ${skipped} already present`);
}

// Only auto-run as a CLI — importing this module (e.g. for
// attachEntityByDomain) must not trigger an import run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[import-xmonitor] ${(err as Error).message}`);
      process.exit(1);
    });
}
