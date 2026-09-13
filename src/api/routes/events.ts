import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EventsQuery, EventsResponse } from "../contracts.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";

/**
 * FR-9 serving surface: structured, entity-resolved market events over the
 * signal-derived facts store. Events are the event-axis counterpart of
 * /v1/news (article axis): funding_round / acquisition / leadership_change /
 * closure objects with payload fields flattened and evidence articles attached.
 */

const EVENT_TS = sql`COALESCE(f.promoted_at, f.created_at)`;

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps) {
  registerRoute({
    method: "get",
    path: "/v1/events/",
    operationId: "listEvents",
    summary:
      "Structured market events (signal-derived facts): funding rounds, acquisitions, leadership changes, closures. Filter by type/entity_type/stage/country/window.",
    tags: ["events"],
    query: EventsQuery,
    response: EventsResponse,
  });

  app.get("/v1/events/", async (_request, reply) => {
    const q = EventsQuery.parse(_request.query ?? {});

    const conds = [sql`e.merged_into IS NULL`, sql`f.status IN ('accepted', 'proposed')`];
    if (q.type) {
      const types = q.type.split(",").map((t) => t.trim()).filter(Boolean);
      if (types.length) {
        conds.push(sql`(${sql.join(types.map((t) => sql`f.type = ${t}`), sql` OR `)})`);
      }
    }
    if (q.entity_type) conds.push(sql`e.type = ${q.entity_type}`);
    if (q.stage) {
      const stages = q.stage.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (stages.length) {
        conds.push(
          sql`(lower(COALESCE(f.payload->>'funding_stage', '')) IN (${sql.join(
            stages.map((s) => sql`${s}`),
            sql`, `,
          )}))`,
        );
      }
    }
    if (q.country) conds.push(sql`upper(e.country) = ${q.country.toUpperCase()}`);
    // NOTE: ISO strings + cast — Date params break db.execute under postgres-js.
    if (q.start_date) conds.push(sql`(${EVENT_TS}) >= ${`${q.start_date}T00:00:00Z`}::timestamptz`);
    if (q.end_date) conds.push(sql`(${EVENT_TS}) <= ${`${q.end_date}T23:59:59Z`}::timestamptz`);

    const whereSql = sql.join(conds, sql` AND `);

    const rows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT f.id, f.entity_id, f.type, f.payload, f.status, f.distinct_publishers,
             f.best_source_tier, f.promoted_at, f.created_at,
             e.canonical_name AS entity_name, e.website AS entity_website,
             e.type AS entity_type, e.status AS entity_status,
             e.country, e.funding_stage,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'id', a.id, 'title', a.title, 'url', a.url,
                 'publisher', a.publisher_domain,
                 'published_date', to_char(a.published_at AT TIME ZONE 'UTC',
                                            'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
               FROM (
                 SELECT a2.id, a2.title, a2.url, a2.publisher_domain, a2.published_at
                 FROM unnest(f.evidence_article_ids) AS x(aid)
                 JOIN articles a2 ON a2.id = x.aid
                 ORDER BY a2.published_at DESC
                 LIMIT 3
               ) a
             ), '[]'::json) AS evidence_articles
      FROM facts f
      JOIN entities e ON e.id = f.entity_id
      WHERE ${whereSql}
      ORDER BY ${EVENT_TS} DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `);

    const totals = await deps.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM facts f
      JOIN entities e ON e.id = f.entity_id
      WHERE ${whereSql}
    `);

    const data = rows.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const promotedAt = r.promoted_at ? new Date(String(r.promoted_at)).toISOString() : null;
      const createdAt = new Date(String(r.created_at)).toISOString();
      const eventDate =
        typeof payload.event_date === "string" && payload.event_date.length > 0
          ? payload.event_date
          : (promotedAt ?? createdAt).slice(0, 10);
      return {
        id: String(r.id),
        type: String(r.type),
        entity_id: String(r.entity_id),
        entity_name: String(r.entity_name),
        entity_website: (r.entity_website as string | null) ?? null,
        entity_type: String(r.entity_type),
        status: String(r.entity_status),
        fact_status: r.status === "accepted" ? "accepted" : "proposed",
        country: (r.country as string | null) ?? null,
        funding_stage:
          (r.funding_stage as string | null) ??
          ((payload.funding_stage as string | undefined) ?? null),
        amount_usd_est:
          payload.amount_usd_est != null ? Number(payload.amount_usd_est) : null,
        lead_investors: (payload.lead_investors as string[] | undefined) ?? [],
        event_date: eventDate,
        distinct_publishers: Number(r.distinct_publishers ?? 1),
        best_source_tier:
          r.best_source_tier != null ? Number(r.best_source_tier) : null,
        evidence_articles: Array.isArray(r.evidence_articles)
          ? (r.evidence_articles as Array<Record<string, unknown>>).map((a) => ({
              id: String(a.id),
              title: String(a.title ?? ""),
              url: String(a.url ?? ""),
              publisher: String(a.publisher ?? ""),
              published_date: String(a.published_date ?? ""),
            }))
          : [],
        promoted_at: promotedAt,
        created_at: createdAt,
      };
    });

    return reply.send({
      total: Number(totals[0]?.n ?? 0),
      count: data.length,
      offset: q.offset,
      data,
    });
  });
}
