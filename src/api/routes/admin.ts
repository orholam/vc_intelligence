import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  AliasAdd,
  CostDashboardResponse,
  EntityCreate,
  EntityUpdate,
  MergeRequest,
  SourceCreate,
  SourceUpdate,
  SourcesResponse,
} from "../contracts.js";
import { blendedArticleCost, stageCostBreakdown, recentPipelineEvents, ledgerDaysThisMonth } from "../../llm/router.js";
import { computeFunnelAlerts, loadFunnelDays } from "../../ops/funnel.js";
import type { Db } from "../../db/index.js";

/**
 * c-plan alignment KPIs (§8 success metrics): is the corpus aimed at the
 * magic zone? private-share of kept articles, mention concentration,
 * launch-surface entity pool size.
 */
async function alignmentKpis(db: Db) {
  const share = await db.execute<{ total: number; priv: number }>(sql`
    SELECT
      COUNT(DISTINCT a.id)::int AS total,
      COUNT(DISTINCT CASE WHEN e.type = 'private' THEN a.id END)::int AS priv
    FROM articles a
    JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    JOIN entities e ON e.id = ae.entity_id
    WHERE a.noise_stage = 'kept'
      AND a.published_at >= now() - interval '7 days'
  `);
  const conc = await db.execute<{ mentions: number }>(sql`
    SELECT SUM(c)::int AS mentions FROM (
      SELECT COUNT(*)::int AS c
      FROM article_entities ae
      JOIN articles a ON a.id = ae.article_id AND a.noise_stage = 'kept'
      JOIN entities e ON e.id = ae.entity_id AND e.merged_into IS NULL
      WHERE a.published_at >= now() - interval '7 days'
      GROUP BY ae.entity_id
      ORDER BY c DESC
      LIMIT 10
    ) t
  `);
  const totalMentions = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM article_entities ae
    JOIN articles a ON a.id = ae.article_id AND a.noise_stage = 'kept'
    JOIN entities e ON e.id = ae.entity_id AND e.merged_into IS NULL
    WHERE a.published_at >= now() - interval '7 days'
  `);
  const launchEnts = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM entities WHERE created_by LIKE 'launch:%' AND merged_into IS NULL
  `);

  const total = Number(share[0]?.total ?? 0);
  const top10 = Number(conc[0]?.mentions ?? 0);
  const allMentions = Number(totalMentions[0]?.n ?? 0);
  return {
    private_share_pct_7d: total ? Number(((Number(share[0]?.priv ?? 0) / total) * 100).toFixed(1)) : 0,
    top10_mention_share_pct_7d: allMentions ? Number(((top10 / allMentions) * 100).toFixed(1)) : 0,
    launch_entities_total: Number(launchEnts[0]?.n ?? 0),
  };
}
import { generateApiKey, requireAuth } from "../auth.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";
import { z } from "zod";

/**
 * Admin surface: FR-1 source registry CRUD + OPML/CSV bulk import, FR-6
 * entity CRUD + alias merge tooling, API key minting, NFR-4 cost/volume
 * dashboard. All routes require a valid API key (`admin` tag in the spec).
 */

function toSourceDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    publisher: String(row.publisher),
    feed_url: String(row.feed_url),
    tier: Number(row.tier),
    country: (row.country as string | null) ?? null,
    default_language: String(row.default_language ?? "en"),
    topics: (row.topics as string[] | null) ?? [],
    active: Boolean(row.active),
    last_fetched_at: row.last_fetched_at ? new Date(String(row.last_fetched_at)).toISOString() : null,
    failure_streak: Number(row.failure_streak ?? 0),
    next_poll_at: row.next_poll_at ? new Date(String(row.next_poll_at)).toISOString() : null,
  };
}

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps) {
  // ------------------------------------------------------------- sources FR-1
  registerRoute({
    method: "get",
    path: "/v1/admin/sources",
    operationId: "listSources",
    summary: "List feed sources.",
    tags: ["admin"],
    admin: true,
    query: z.object({
      active: z.enum(["true", "false"]).optional(),
      tier: z.coerce.number().pipe(z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    response: SourcesResponse,
  });
  app.get("/v1/admin/sources", async (request, reply) => {
    const q = z
      .object({
        active: z.enum(["true", "false"]).optional(),
        tier: z.coerce.number().pipe(z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query ?? {});
    const rows = await deps.registry.list({
      active: q.active === undefined ? undefined : q.active === "true",
      tier: q.tier,
      limit: q.limit,
      offset: q.offset,
    });
    const total = await deps.registry.count();
    return reply.send({ total, count: rows.length, offset: q.offset, data: rows.map((r) => toSourceDto(r)) });
  });

  registerRoute({
    method: "post",
    path: "/v1/admin/sources",
    operationId: "createSource",
    summary: "Add a feed source (no code change needed — FR-1 AC).",
    tags: ["admin"],
    admin: true,
    body: SourceCreate,
  });
  app.post("/v1/admin/sources", async (request, reply) => {
    const body = SourceCreate.parse(request.body);
    const created = await deps.registry.create({
      name: body.name,
      publisher: body.publisher,
      feedUrl: body.feed_url,
      tier: body.tier,
      country: body.country ?? null,
      defaultLanguage: body.default_language,
      topics: body.topics,
      active: body.active,
    });
    return reply.status(201).send(toSourceDto(created));
  });

  app.patch("/v1/admin/sources/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id);
    const body = SourceUpdate.parse(request.body ?? {});
    const updated = await deps.registry.update(id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.publisher !== undefined && { publisher: body.publisher }),
      ...(body.feed_url !== undefined && { feedUrl: body.feed_url }),
      ...(body.tier !== undefined && { tier: body.tier }),
      ...(body.country !== undefined && { country: body.country ?? null }),
      ...(body.default_language !== undefined && { defaultLanguage: body.default_language }),
      ...(body.topics !== undefined && { topics: body.topics }),
      ...(body.active !== undefined && { active: body.active }),
    });
    return reply.send(toSourceDto(updated));
  });

  app.delete("/v1/admin/sources/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id);
    await deps.registry.remove(id);
    return reply.send({ deleted: true });
  });

  registerRoute({
    method: "post",
    path: "/v1/admin/sources/import/opml",
    operationId: "importSourcesOpml",
    summary: "Bulk import feeds from OPML XML.",
    tags: ["admin"],
    admin: true,
  });
  app.post("/v1/admin/sources/import/opml", async (request, reply) => {
    const body = z.object({ opml: z.string().min(10), tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3) }).parse(request.body);
    const res = await deps.registry.importOpml(body.opml, { tier: body.tier });
    return reply.send(res);
  });

  registerRoute({
    method: "post",
    path: "/v1/admin/sources/import/csv",
    operationId: "importSourcesCsv",
    summary: 'Bulk import feeds from CSV with header: name,publisher,feed_url,tier,country,default_language,topics.',
    tags: ["admin"],
    admin: true,
  });
  app.post("/v1/admin/sources/import/csv", async (request, reply) => {
    const body = z.object({ csv: z.string().min(5) }).parse(request.body);
    const res = await deps.registry.importCsv(body.csv);
    return reply.send(res);
  });

  // ------------------------------------------------------------ entities FR-6
  registerRoute({
    method: "post",
    path: "/v1/admin/entities",
    operationId: "createEntity",
    summary: "Create an entity in the knowledge base.",
    tags: ["admin"],
    admin: true,
  });
  app.post("/v1/admin/entities", async (request, reply) => {
    const body = EntityCreate.parse(request.body);
    const created = await deps.kb.create(
      {
        canonicalName: body.canonical_name,
        legalName: body.legal_name ?? null,
        website: body.website ?? null,
        aliases: body.aliases,
        type: body.type,
        status: body.status,
        country: body.country ?? null,
        hqCity: body.hq_city ?? null,
        foundedYear: body.founded_year ?? null,
        industryTags: body.industry_tags,
        tickers: body.tickers,
        confidence: body.confidence,
        isMonitored: body.is_monitored,
        reviewStatus: "reviewed",
        createdBy: `api-key:${requireAuth(request).keyId}`,
      },
      "api",
    );
    return reply.status(201).send({ id: created.id });
  });

  app.patch("/v1/admin/entities/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id);
    const body = EntityUpdate.parse(request.body ?? {});
    const updated = await deps.kb.update(id, {
      canonicalName: body.canonical_name,
      legalName: body.legal_name ?? undefined,
      website: body.website ?? undefined,
      aliases: body.aliases,
      type: body.type,
      status: body.status,
      country: body.country ?? undefined,
      hqCity: body.hq_city ?? undefined,
      foundedYear: body.founded_year ?? undefined,
      industryTags: body.industry_tags,
      tickers: body.tickers,
      confidence: body.confidence,
      isMonitored: body.is_monitored,
    });
    return reply.send({ id: updated.id, canonical_name: updated.canonicalName });
  });

  app.post("/v1/admin/entities/:id/aliases", async (request, reply) => {
    const id = String((request.params as { id?: string }).id);
    const body = AliasAdd.parse(request.body);
    await deps.kb.addAlias(id, body.alias);
    return reply.status(201).send({ added: true });
  });

  app.get("/v1/admin/entities/:id/aliases", async (request, reply) => {
    const id = String((request.params as { id?: string }).id);
    const rows = await deps.kb.listAliases(id);
    return reply.send({
      data: rows.map((r) => ({ id: r.id, alias: r.alias, kind: r.kind, weight: r.weight })),
    });
  });

  app.delete("/v1/admin/entities/:id/aliases/:aliasId", async (request, reply) => {
    void request;
    const aliasId = String((request.params as { aliasId?: string }).aliasId);
    await deps.kb.removeAlias(aliasId);
    return reply.send({ removed: true });
  });

  registerRoute({
    method: "post",
    path: "/v1/admin/entities/merge",
    operationId: "mergeEntities",
    summary: "Merge two entities (duplicate collapse); opaque target id is preserved.",
    tags: ["admin"],
    admin: true,
  });
  app.post("/v1/admin/entities/merge", async (request, reply) => {
    const body = MergeRequest.parse(request.body);
    await deps.kb.merge(body.source_entity_id, body.target_entity_id);
    return reply.send({ merged_into: body.target_entity_id });
  });

  // ------------------------------------------------------------------ api keys
  app.post("/v1/admin/api-keys", async (request, reply) => {
    const body = z.object({ name: z.string().min(2).max(80) }).parse(request.body);
    const key = generateApiKey();
    const { apiKeys } = await import("../../db/schema.js");
    await deps.db.insert(apiKeys).values({
      id: key.id,
      name: body.name,
      keyHash: key.hash,
      keyPrefix: key.prefix,
    });
    return reply.status(201).send({ id: key.id, key: key.raw, note: "store this value now; it cannot be retrieved again" });
  });

  // ------------------------------------------------------- observability NFR-4
  registerRoute({
    method: "get",
    path: "/v1/admin/dashboard",
    operationId: "costAndVolumeDashboard",
    summary: "Cost + volume dashboard: budget state, per-stage LLM costs, pipeline volumes.",
    tags: ["admin"],
    admin: true,
    response: CostDashboardResponse,
  });
  app.get("/v1/admin/dashboard", async (_request, reply) => {
    const status = await deps.router.budgetStatus();
    const stages = await stageCostBreakdown(deps.db);
    const blended = await blendedArticleCost(deps.db);

    const vols = await deps.db.execute<{
      raw_24h: number;
      kept_24h: number;
      discarded_24h: number;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM raw_items WHERE created_at >= now() - interval '24 hours') AS raw_24h,
        (SELECT COUNT(*)::int FROM articles WHERE noise_stage = 'kept' AND created_at >= now() - interval '24 hours') AS kept_24h,
        (SELECT COUNT(*)::int FROM articles WHERE noise_stage IN ('prefilter','llm_filter') AND created_at >= now() - interval '24 hours') AS discarded_24h
    `);
    const v = vols[0];
    const total24 = Number(v?.kept_24h ?? 0) + Number(v?.discarded_24h ?? 0);

    // R09/G4: disclosed degradation + ledger continuity.
    const [degradeEvents, ledgerDays] = await Promise.all([
      recentPipelineEvents(deps.db),
      ledgerDaysThisMonth(deps.db),
    ]);
    // R13: funnel counters + week-over-week deviation alerts.
    const funnelDays = await loadFunnelDays(deps.db, 14);
    const funnelAlerts = computeFunnelAlerts(funnelDays);
    const backfillRows = await deps.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM entities WHERE merged_into IS NULL AND needs_backfill = true
    `);

    return reply.send({
      budget: {
        month: status.month,
        spent_usd: status.spentUsd,
        cap_usd: status.capUsd,
        soft_limit_usd: status.softLimitUsd,
        classify_only_mode: status.classifyOnlyMode,
      },
      stages,
      blended_article_cost_usd: blended == null ? null : Number(blended.toFixed(6)),
      pipeline_volumes: {
        raw_items_24h: Number(v?.raw_24h ?? 0),
        kept_articles_24h: Number(v?.kept_24h ?? 0),
        discarded_24h: Number(v?.discarded_24h ?? 0),
        discard_rate_pct: total24 ? Number((((Number(v?.discarded_24h ?? 0)) / total24) * 100).toFixed(1)) : 0,
      },
      alignment: await alignmentKpis(deps.db),
      degrade_events: degradeEvents,
      ledger_days_month: ledgerDays,
      funnel_days: funnelDays.map((d) => ({
        day: d.day,
        raw_items: d.rawItems,
        fetched: d.fetched,
        extracted: d.extracted,
        kept: d.kept,
        prefilter_discards: d.prefilterDiscards,
        llm_discards: d.llmDiscards,
        quarantined: d.quarantined,
        parked_failures: d.parkedFailures,
        resolved: d.resolved,
        enriched: d.enriched,
        clustered: d.clustered,
        facts_proposed: d.factsProposed,
        facts_accepted: d.factsAccepted,
        needs_backfill_outstanding: d.needsBackfillOutstanding,
        profiles_complete: d.profilesComplete,
      })),
      funnel_alerts: funnelAlerts,
      needs_backfill_outstanding: Number(backfillRows[0]?.n ?? 0),
    });
  });
}
