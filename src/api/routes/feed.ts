import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { FeedQuery, FeedResponse } from "../contracts.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";
import { excerpt } from "../../lib/text.js";
import { FIRST_COVERAGE_COL } from "./news.js";
import { getConfig } from "../../config.js";

/**
 * FR-21: GET /v1/feed — incremental polling endpoint with cursor.
 * Cursor format: base64("<ISO timestamp>|<last article id>") for stable paging
 * when multiple articles share a timestamp.
 */
export function registerFeedRoutes(app: FastifyInstance, deps: AppDeps) {
  registerRoute({
    method: "get",
    path: "/v1/feed",
    operationId: "pollFeed",
    summary: "Incremental article feed for subscribed entities (cursor-based sync).",
    tags: ["feed"],
    query: FeedQuery,
    response: FeedResponse,
  });

  app.get("/v1/feed", async (request, reply) => {
    const q = FeedQuery.parse(request.query ?? {});
    const entityIds = q.entities.split(",").map((s) => s.trim()).filter(Boolean);
    if (!entityIds.length) {
      return reply.send({ events: [], next_cursor: null });
    }

    let sinceIso: string | null = null;
    let lastId: string | null = null;
    const rawCursor = q.cursor ?? (q.since ? Buffer.from(`${q.since}|`).toString("base64") : null);
    if (rawCursor) {
      try {
        const decoded = Buffer.from(rawCursor, "base64").toString("utf8");
        const [ts, id] = decoded.split("|");
        sinceIso = ts ?? null;
        lastId = id || null;
      } catch {
        sinceIso = null;
        lastId = null;
      }
    }

    const rows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT DISTINCT a.*, ${FIRST_COVERAGE_COL}
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE ae.entity_id IN (${sql.join(entityIds.map((e2) => sql`${e2}`), sql`, `)})
        AND a.noise_stage = 'kept'
        ${sinceIso ? sql`AND (a.created_at, a.id) > (${sinceIso}::timestamptz, ${lastId})` : sql``}
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ${Math.min(q.limit, 1000)}
    `);

    // every company related to each article (any role), primary first
    const linksByArticle = new Map<string, Array<{ id: string; name: string; role: "primary" | "secondary" }>>();
    if (rows.length) {
      const linkRows = await deps.db.execute<Record<string, unknown>>(sql`
        SELECT ae.article_id, ae.entity_id, ae.role, e.canonical_name
        FROM article_entities ae
        JOIN entities e ON e.id = ae.entity_id
        WHERE ae.article_id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})
        ORDER BY ae.article_id, CASE WHEN ae.role = 'primary' THEN 0 ELSE 1 END
      `);
      for (const lr of linkRows) {
        const key = String(lr.article_id);
        const list = linksByArticle.get(key) ?? [];
        list.push({
          id: String(lr.entity_id),
          name: String(lr.canonical_name ?? ""),
          role: lr.role === "primary" ? "primary" : "secondary",
        });
        linksByArticle.set(key, list);
      }
    }

    const passthrough = getConfig().TEXT_PASSTHROUGH;
    const events = rows.map((r) => {
      const row = r as Record<string, unknown>;
      const links = linksByArticle.get(String(row.id)) ?? [];
      return {
        type: "article" as const,
        article: {
          id: String(row.id),
          entity_id: links.find((l) => l.role === "primary")?.id ?? links[0]?.id ?? "",
          entities: links,
          title: String(row.title ?? ""),
          url: String(row.url ?? ""),
          publisher: String(row.publisher_domain ?? ""),
          published_date: new Date(String(row.published_at)).toISOString(),
          language: String(row.language ?? "en"),
          ai_summary: (row.ai_summary as string | null) ?? null,
          sentiment: (row.sentiment as "positive" | "negative" | "neutral" | null) ?? null,
          sentiment_score: (row.sentiment_score as number | null) ?? null,
          newsworthiness: (row.newsworthiness as "high" | "medium" | "low" | null) ?? null,
          tags: (((row.all_tags as string[] | null)) ?? []).map((t) => ({
            name: t,
            is_primary: t === row.primary_tag,
          })),
          industry_primary: (row.industry_primary as string | null) ?? null,
          industry_secondary: (row.industry_secondary as string[] | null) ?? [],
          countries: (row.countries as string[] | null) ?? [],
          excerpt: excerpt(String(row.excerpt_text ?? row.title ?? ""), 400),
          text_available: passthrough,
          first_coverage: Boolean(row.first_coverage),
        },
      };
    });

    const lastRow = rows[rows.length - 1];
    const nextCursor = lastRow
      ? Buffer.from(
          `${new Date(String(lastRow.created_at)).toISOString()}|${String(lastRow.id)}`,
        ).toString("base64")
      : null;

    // Contract shape check keeps the schema honest in tests.
    void FeedResponse.safeParse({ events, next_cursor: nextCursor });
    return reply.send({ events, next_cursor: nextCursor });
  });
}
