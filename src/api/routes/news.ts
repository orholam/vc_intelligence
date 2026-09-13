import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { getConfig } from "../../config.js";
import { Errors } from "../../lib/errors.js";
import { autocreateEntity } from "../../entities/autocreate.js";
import { excerpt } from "../../lib/text.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";
import {
  LatestNewsQuery,
  LatestNewsResponse,
  NewsQuery,
  NewsResponse,
  NewsStatsResponse,
  NewsOverviewQuery,
  NewsOverviewResponse,
  SourceBreakdownResponse,
} from "../contracts.js";

/**
 * Acquisition-module dimension (c-plan): which pipeline brought the article
 * in. Launch surfaces are named modules; everything else maps by the
 * raw_items discovery path. Shared by the module filter and by_module
 * aggregation so they can never drift.
 *
 *   launchmonitor   — Okara Launch Library pushes (surface okara-launch-library)
 *   xmonitor        — X launch watcher imports (surface x_monitor)
 *   hacker-news     — HN front-page ingests (surface hn)
 *   rss-feeds       — tiered RSS polling (discovered_via rss)
 *   gdelt           — GDELT watchlist polls (discovered_via gdelt)
 *   web-search      — search-index discovery (discovered_via search)
 *   direct-ingest   — everything else (manual scripts, no raw item)
 */
const MODULE_CASE = sql`CASE
  WHEN a.platform_meta->>'surface' = 'okara-launch-library' THEN 'launchmonitor'
  WHEN a.platform_meta->>'surface' = 'x_monitor' THEN 'xmonitor'
  WHEN a.platform_meta->>'surface' = 'hn' THEN 'hacker-news'
  WHEN ri.discovered_via = 'rss' THEN 'rss-feeds'
  WHEN ri.discovered_via = 'gdelt' THEN 'gdelt'
  WHEN ri.discovered_via = 'search' THEN 'web-search'
  ELSE 'direct-ingest'
END`;

/**
 * FR-18: GET /v1/news/ — news by company with resolution order
 * opaque ID -> slug -> domain -> URL fetch-and-create (FR-8).
 * GET /v1/news/latest — most recent kept articles with a company attached;
 * unattributed kept rows are resolution backlog, not published state.
 */

const ULID_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

type ArticleOut = z.infer<typeof NewsResponse>["data"][number];

type EntityLink = { id: string; name: string; role: "primary" | "secondary" };

/** All companies related to each of the given articles (any role), primary first. */
async function hydrateEntities(
  db: AppDeps["db"],
  articleIds: string[],
): Promise<Map<string, EntityLink[]>> {
  const map = new Map<string, EntityLink[]>();
  if (!articleIds.length) return map;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT ae.article_id, ae.entity_id, ae.role, e.canonical_name
    FROM article_entities ae
    JOIN entities e ON e.id = ae.entity_id
    WHERE ae.article_id IN (${sql.join(articleIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY ae.article_id, CASE WHEN ae.role = 'primary' THEN 0 ELSE 1 END
  `);
  for (const r of rows) {
    const key = String(r.article_id);
    const list = map.get(key) ?? [];
    list.push({
      id: String(r.entity_id),
      name: String(r.canonical_name ?? ""),
      role: r.role === "primary" ? "primary" : "secondary",
    });
    map.set(key, list);
  }
  return map;
}

function toArticle(
  r: Record<string, unknown>,
  passthrough: boolean,
  links: EntityLink[],
): ArticleOut {
  const primary = links.find((l) => l.role === "primary");
  return {
    id: String(r.id),
    entity_id: primary?.id ?? links[0]?.id ?? "",
    entities: links,
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    publisher: String(r.publisher_domain ?? ""),
    published_date: new Date(String(r.published_at)).toISOString(),
    language: String(r.language ?? "en"),
    ai_summary: (r.ai_summary as string | null) ?? null,
    sentiment: (r.sentiment as ArticleOut["sentiment"]) ?? null,
    sentiment_score: (r.sentiment_score as number | null) ?? null,
    newsworthiness: (r.newsworthiness as ArticleOut["newsworthiness"]) ?? null,
    tags: ((r.all_tags as string[] | null) ?? []).map((t) => ({
      name: t,
      is_primary: t === r.primary_tag,
    })),
    industry_primary: (r.industry_primary as string | null) ?? null,
    industry_secondary: (r.industry_secondary as string[] | null) ?? [],
    countries: (r.countries as string[] | null) ?? [],
    excerpt: excerpt(String(r.excerpt_text ?? r.title ?? ""), 400),
    text_available: passthrough,
    first_coverage: Boolean(r.first_coverage),
  };
}

/** Earliest-kept-coverage marker (c-plan exclusivity signal). */
export const FIRST_COVERAGE_COL = sql`
  NOT EXISTS (
    SELECT 1 FROM articles b
    JOIN article_entities be ON be.article_id = b.id AND be.role = 'primary'
    WHERE be.entity_id = (
      SELECT ae.entity_id FROM article_entities ae
      WHERE ae.article_id = a.id AND ae.role = 'primary'
      LIMIT 1
    )
      AND b.noise_stage = 'kept'
      AND b.published_at < a.published_at
  ) AS first_coverage`;

type RangeFilters = {
  start_date?: string;
  end_date?: string;
  category?: string;
  unique_article: boolean;
  publisher?: string;
  surface?: string;
  module?: string;
};

function rangeFilterConds(q: RangeFilters) {
  const conds: ReturnType<typeof sql>[] = [];
  // NOTE: pass ISO strings + explicit cast — Date params break db.execute
  // under the postgres-js driver (works in PGlite tests, fails live).
  if (q.start_date) conds.push(sql`a.published_at >= ${`${q.start_date}T00:00:00Z`}::timestamptz`);
  if (q.end_date) conds.push(sql`a.published_at <= ${`${q.end_date}T23:59:59Z`}::timestamptz`);
  if (q.category) {
    const tags = q.category.split(",").map((t) => t.trim()).filter(Boolean);
    conds.push(sql`(${sql.join(tags.map((t) => sql`${t}::text = ANY(a.all_tags)`), sql` OR `)})`);
  }
  if (q.unique_article) {
    // one article per story cluster per entity (FR-17)
    conds.push(sql`(a.story_cluster_id IS NULL OR a.id = (
      SELECT a2.id FROM articles a2
      WHERE a2.story_cluster_id = a.story_cluster_id
      ORDER BY a2.is_cluster_representative DESC, a2.published_at DESC
      LIMIT 1
    ))`);
  }
  if (q.publisher) {
    conds.push(sql`a.publisher_domain = ${q.publisher.toLowerCase()}`);
  }
  if (q.surface) {
    conds.push(sql`COALESCE(a.platform_meta->>'surface', 'press') = ${q.surface}`);
  }
  if (q.module) {
    // requires `LEFT JOIN raw_items ri` in the enclosing query (MODULE_CASE)
    conds.push(sql`${MODULE_CASE} = ${q.module}`);
  }
  return conds;
}

async function resolveCompanyParam(deps: AppDeps, company: string) {
  const { kb } = deps;

  // 1) opaque entity id
  if (/^ent_/.test(company)) {
    if (!ULID_RE.test(company.slice(4))) throw Errors.notFound(`company ${company} not found`);
    return kb.get(company);
  }

  // 2) slug (kebab-case of canonical name)
  if (!company.includes(".")) {
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const rows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND lower(regexp_replace(canonical_name, '[^a-zA-Z0-9]+', '-', 'g')) = ${slug}
      ORDER BY confidence DESC LIMIT 1
    `);
    const hit = rows[0];
    if (hit) return kb.get(String(hit.id));
    const byName = await kb.findByExactName(company);
    if (byName) return byName;
  }

  // 3) domain
  let hostname: string | null = null;
  try {
    hostname = new URL(/^[a-z]+:\/\//i.test(company) ? company : `https://${company}`).hostname;
  } catch {
    hostname = null;
  }
  if (hostname?.includes(".")) {
    const ent = await kb.findByWebsite(hostname);
    if (ent) return ent;
  }

  // 4) URL fetch-and-create via the extraction agent (FR-8)
  if (/^https?:\/\//i.test(company)) {
    const res = await autocreateEntity(deps.db, deps.router, { url: company });
    return kb.get(res.entityId);
  }

  throw Errors.notFound(
    `company '${company}' not found; pass an entity id, slug, domain or article URL`,
  );
}

export function registerNewsRoutes(app: FastifyInstance, deps: AppDeps) {
  registerRoute({
    method: "get",
    path: "/v1/news/",
    operationId: "getCompanyNews",
    summary:
      "News mentioning one company (any relation, primary or secondary). `company` accepts opaque id | slug | domain | URL (fetch-and-create).",
    tags: ["news"],
    query: NewsQuery,
    response: NewsResponse,
  });

  app.get("/v1/news/", async (_request, reply) => {
    const q = NewsQuery.parse(_request.query ?? {});
    const entity = await resolveCompanyParam(deps, q.company);

    // match articles where the company is related in ANY role (primary or secondary)
    const conds: ReturnType<typeof sql>[] = [
      sql`a.noise_stage = 'kept'`,
      ...rangeFilterConds(q),
    ];
    if (q.blacklisted) {
      const domains = q.blacklisted.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
      conds.push(sql`(${sql.join(domains.map((d) => sql`a.publisher_domain <> ${d}`), sql` AND `)})`);
    }
    const whereSql = sql.join(conds, sql` AND `);

    const rows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT a.*, ${FIRST_COVERAGE_COL}
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE ae.entity_id = ${entity.id} AND ${whereSql}
      ORDER BY a.published_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `);
    const totals = await deps.db.execute<{ n: number }>(sql`
      SELECT COUNT(DISTINCT a.id)::int AS n
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE ae.entity_id = ${entity.id} AND ${whereSql}
    `);

    const passthrough = getConfig().TEXT_PASSTHROUGH;
    const linksByArticle = await hydrateEntities(deps.db, rows.map((r) => String(r.id)));
    const data: ArticleOut[] = rows.map((r) =>
      toArticle(r, passthrough, linksByArticle.get(String(r.id)) ?? []),
    );

    return reply.send({
      total: Number(totals[0]?.n ?? 0),
      count: data.length,
      offset: q.offset,
      data,
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/news/latest",
    operationId: "getLatestNews",
    summary:
      "Most recent resolved articles across all entities, newest first. Every article carries 1+ related companies (FR-11: company-less articles are never counted as resolved nor served). Filterless window over the index for volume/monitoring views.",
    tags: ["news"],
    query: LatestNewsQuery,
    response: LatestNewsResponse,
  });

  app.get("/v1/news/latest", async (_request, reply) => {
    const q = LatestNewsQuery.parse(_request.query ?? {});

    const conds: ReturnType<typeof sql>[] = [
      // Kept AND attributed: /latest serves winners with a company attached
      // (one resolved state — resolution is part of publishing, not an
      // optional filter). Unattributed kept rows are a resolution backlog,
      // never a published state.
      sql`a.noise_stage = 'kept'`,
      sql`EXISTS (SELECT 1 FROM article_entities ael WHERE ael.article_id = a.id)`,
      ...rangeFilterConds(q),
    ];
    if (q.entity_type) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM article_entities ae2
        JOIN entities e2 ON e2.id = ae2.entity_id
        WHERE ae2.article_id = a.id AND ae2.role = 'primary' AND e2.type = ${q.entity_type}
      )`);
    }
    if (q.unique_article) {
      // one article per story cluster per entity (FR-17)
      conds.push(sql`(a.story_cluster_id IS NULL OR a.id = (
        SELECT a2.id FROM articles a2
        WHERE a2.story_cluster_id = a.story_cluster_id
        ORDER BY a2.is_cluster_representative DESC, a2.published_at DESC
        LIMIT 1
      ))`);
    }
    const whereSql = sql.join(conds, sql` AND `);

    const rows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT a.*, ${FIRST_COVERAGE_COL}
      FROM articles a
      LEFT JOIN raw_items ri ON ri.id = a.raw_item_id
      WHERE ${whereSql}
      ORDER BY a.published_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `);
    const totals = await deps.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM articles a
      LEFT JOIN raw_items ri ON ri.id = a.raw_item_id
      WHERE ${whereSql}
    `);

    const passthrough = getConfig().TEXT_PASSTHROUGH;
    const linksByArticle = await hydrateEntities(deps.db, rows.map((r) => String(r.id)));
    const data = rows.map((r) => {
      const links = linksByArticle.get(String(r.id)) ?? [];
      return {
        ...toArticle(r, passthrough, links),
        entity_name: links.find((l) => l.role === "primary")?.name ?? links[0]?.name ?? "",
      };
    });

    return reply.send({
      total: Number(totals[0]?.n ?? 0),
      count: data.length,
      offset: q.offset,
      data,
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/news/stats",
    operationId: "getNewsStats",
    summary:
      "Corpus-wide business stats. Entity metrics use the canonical company set (live, baseline-complete, excluding funds/person-orgs) so numbers agree with /v1/companies/search; news volume and publisher counts cover the whole kept index.",
    tags: ["news"],
    response: NewsStatsResponse,
  });

  app.get("/v1/news/stats", async (_request, reply) => {
    // Canonical company set — identical predicate to /v1/companies/search's
    // default view, so "companies tracked" never disagrees across surfaces.
    const COMPANY = sql`merged_into IS NULL AND needs_backfill = false AND type NOT IN ('fund', 'person-org')`;
    const counts = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM entities WHERE ${COMPANY}) AS total_entities,
        (SELECT COUNT(*)::int FROM articles WHERE noise_stage = 'kept') AS total_news,
        (SELECT COUNT(*)::int FROM articles WHERE noise_stage = 'kept' AND published_at >= now() - interval '24 hours') AS news_24h,
        (
          SELECT COUNT(DISTINCT ae.entity_id)::int
          FROM article_entities ae
          JOIN articles a ON a.id = ae.article_id AND a.noise_stage = 'kept'
          JOIN entities e ON e.id = ae.entity_id AND ${COMPANY}
        ) AS covered_entities,
        (SELECT COUNT(*)::int FROM entities WHERE ${COMPANY} AND is_monitored) AS monitored_entities,
        (SELECT COUNT(DISTINCT publisher_domain)::int FROM articles WHERE noise_stage = 'kept') AS total_publishers
    `);
    const c = counts[0] ?? {};
    const byStage = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COALESCE(NULLIF(funding_stage, ''), 'unknown') AS stage, COUNT(*)::int AS count
      FROM entities
      WHERE ${COMPANY}
      GROUP BY 1
      ORDER BY count DESC, stage ASC
    `);

    return reply.send({
      total_entities: Number(c.total_entities ?? 0),
      total_news: Number(c.total_news ?? 0),
      news_24h: Number(c.news_24h ?? 0),
      covered_entities: Number(c.covered_entities ?? 0),
      monitored_entities: Number(c.monitored_entities ?? 0),
      total_publishers: Number(c.total_publishers ?? 0),
      by_funding_stage: byStage.map((r) => ({
        stage: String(r.stage ?? "unknown"),
        count: Number(r.count ?? 0),
      })),
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/news/overview",
    operationId: "getNewsOverview",
    summary:
      "State-of-the-index aggregates for monitoring views: daily kept-article volume (deduped like the /latest feed, stacked by newsworthiness), the current noise-stage lifecycle snapshot of the whole article index, and the top primary event tags over the window.",
    tags: ["news"],
    query: NewsOverviewQuery,
    response: NewsOverviewResponse,
  });

  app.get("/v1/news/overview", async (_request, reply) => {
    const q = NewsOverviewQuery.parse(_request.query ?? {});

    // Dedupe identical to /latest's default view (one article per story
    // cluster) so the volume chart lines up with "articles in view".
    const UNIQUE = sql`(a.story_cluster_id IS NULL OR a.id = (
      SELECT a2.id FROM articles a2
      WHERE a2.story_cluster_id = a.story_cluster_id
      ORDER BY a2.is_cluster_representative DESC, a2.published_at DESC
      LIMIT 1
    ))`;

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (q.days - 1));
    const sinceIso = start.toISOString();

    const volumeRows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT to_char(date_trunc('day', a.published_at), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE a.newsworthiness = 'high')::int AS high,
             COUNT(*) FILTER (WHERE a.newsworthiness = 'medium')::int AS medium,
             COUNT(*) FILTER (WHERE a.newsworthiness = 'low')::int AS low
      FROM articles a
      WHERE a.noise_stage = 'kept'
        AND a.published_at >= ${sinceIso}::timestamptz
        AND ${UNIQUE}
      GROUP BY 1
    `);
    const byDay = new Map<string, Record<string, unknown>>(
      volumeRows.map((r) => [String(r.day), r]),
    );
    // Fill the full window so zero-volume days still render (matches growth).
    const volume = [];
    for (let i = 0; i < q.days; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      const r = byDay.get(key);
      volume.push({
        date: key,
        total: Number(r?.total ?? 0),
        high: Number(r?.high ?? 0),
        medium: Number(r?.medium ?? 0),
        low: Number(r?.low ?? 0),
      });
    }

    const lifecycleRows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT noise_stage AS stage, COUNT(*)::int AS count
      FROM articles
      GROUP BY 1
      ORDER BY count DESC
    `);

    const topicRows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT a.primary_tag AS tag, COUNT(*)::int AS count
      FROM articles a
      WHERE a.noise_stage = 'kept'
        AND a.primary_tag IS NOT NULL
        AND a.published_at >= ${sinceIso}::timestamptz
        AND ${UNIQUE}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT ${q.topic_limit}
    `);

    return reply.send({
      days: q.days,
      volume,
      lifecycle: lifecycleRows.map((r) => ({
        stage: String(r.stage ?? ""),
        count: Number(r.count ?? 0),
      })),
      topics: topicRows.map((r) => ({
        tag: String(r.tag ?? ""),
        count: Number(r.count ?? 0),
      })),
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/news/sources",
    operationId: "getNewsSourceBreakdown",
    summary:
      "Source-effectiveness breakdown over the kept-article index. Same filters as /v1/news/latest (publisher/surface/module included). Aggregates by acquisition module (rss-feeds, gdelt, web-search, launchmonitor, hacker-news…), by publisher domain, and by launch surface, each with distinct-primary-company coverage.",
    tags: ["news"],
    query: LatestNewsQuery,
    response: SourceBreakdownResponse,
  });

  app.get("/v1/news/sources", async (_request, reply) => {
    const q = LatestNewsQuery.parse(_request.query ?? {});

    const conds: ReturnType<typeof sql>[] = [
      sql`a.noise_stage = 'kept'`,
      ...rangeFilterConds(q),
    ];
    if (q.entity_type) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM article_entities ae2
        JOIN entities e2 ON e2.id = ae2.entity_id
        WHERE ae2.article_id = a.id AND ae2.role = 'primary' AND e2.type = ${q.entity_type}
      )`);
    }
    const whereSql = sql.join(conds, sql` AND `);

    const byPublisher = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT a.publisher_domain AS source,
             COUNT(*)::int AS articles,
             COUNT(DISTINCT ae.entity_id)::int AS companies,
             MAX(a.published_at) AS last_published
      FROM articles a
      LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      LEFT JOIN raw_items ri ON ri.id = a.raw_item_id
      WHERE ${whereSql}
      GROUP BY a.publisher_domain
      ORDER BY articles DESC, source ASC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `);

    const totals = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COUNT(*)::int AS total_articles,
             COUNT(DISTINCT a.publisher_domain)::int AS total_sources
      FROM articles a
      LEFT JOIN raw_items ri ON ri.id = a.raw_item_id
      WHERE ${whereSql}
    `);

    const bySurface = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COALESCE(a.platform_meta->>'surface', 'press') AS surface,
             COUNT(*)::int AS articles,
             COUNT(DISTINCT ae.entity_id)::int AS companies,
             MAX(a.published_at) AS last_published
      FROM articles a
      LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      LEFT JOIN raw_items ri ON ri.id = a.raw_item_id
      WHERE ${whereSql}
      GROUP BY 1
      ORDER BY articles DESC
    `);

    const byModule = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT ${MODULE_CASE} AS module,
             COUNT(*)::int AS articles,
             COUNT(DISTINCT ae.entity_id)::int AS companies,
             MAX(a.published_at) AS last_published
      FROM articles a
      LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      LEFT JOIN raw_items ri ON ri.id = a.raw_item_id
      WHERE ${whereSql}
      GROUP BY 1
      ORDER BY articles DESC
    `);

    const toStat = (r: Record<string, unknown>) => ({
      source: String(r.source ?? ""),
      articles: Number(r.articles ?? 0),
      companies: Number(r.companies ?? 0),
      last_published: r.last_published
        ? new Date(String(r.last_published)).toISOString()
        : "",
    });

    return reply.send({
      total_articles: Number(totals[0]?.total_articles ?? 0),
      total_sources: Number(totals[0]?.total_sources ?? 0),
      by_publisher: byPublisher.map(toStat),
      by_surface: bySurface.map((r) => ({
        surface: String(r.surface ?? ""),
        articles: Number(r.articles ?? 0),
        companies: Number(r.companies ?? 0),
        last_published: r.last_published
          ? new Date(String(r.last_published)).toISOString()
          : "",
      })),
      by_module: byModule.map((r) => ({
        module: String(r.module ?? ""),
        articles: Number(r.articles ?? 0),
        companies: Number(r.companies ?? 0),
        last_published: r.last_published
          ? new Date(String(r.last_published)).toISOString()
          : "",
      })),
    });
  });
}
