import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { ListCompany} from "../contracts.js";
import { ListGenRequest, ListGenResponse } from "../contracts.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";
import { interpretQuery } from "../../listgen/interpret.js";
import { queryRankedCompanies } from "../../listgen/pipeline.js";
import { getFilters } from "../../config-files.js";

/** FR-20: POST /v1/list/generate/companies — natural-language company lists. */
export function registerListGenRoutes(app: FastifyInstance, deps: AppDeps) {
  registerRoute({
    method: "post",
    path: "/v1/list/generate/companies/",
    operationId: "generateCompanyList",
    summary:
      "Natural-language query -> ranked, enriched company list with per-company recent signals.",
    tags: ["listgen"],
    body: ListGenRequest,
    response: ListGenResponse,
  });

  app.post("/v1/list/generate/companies/", async (request, reply) => {
    const body = ListGenRequest.parse(request.body ?? {});
    const max = Math.min(body.limit, getFilters().listgen.max_companies_default * 4);

    const interpreted = await interpretQuery(deps.router, body.query);
    const ranked = await queryRankedCompanies(deps.db, interpreted, max);

    const companies = ranked.map((r) => {
      const e = r.entity as Record<string, unknown>;
      return {
        id: String(e.id),
        canonical_name: String(e.canonical_name),
        legal_name: (e.legal_name as string | null) ?? null,
        website: (e.website as string | null) ?? null,
        aliases: (e.aliases as string[]) ?? [],
        type: String(e.type ?? "private"),
        status: String(e.status ?? "operating"),
        country: (e.country as string | null) ?? null,
        hq_city: (e.hq_city as string | null) ?? null,
        founded_year: (e.founded_year as number | null) ?? null,
        industry_tags: (e.industry_tags as string[]) ?? [],
        tickers: (e.tickers as string[]) ?? [],
        funding_stage: (e.funding_stage as string | null) ?? null,
        total_raised_usd: e.total_raised_usd != null ? Number(e.total_raised_usd) : null,
        last_funding_date: e.last_funding_date
          ? new Date(String(e.last_funding_date)).toISOString().slice(0, 10)
          : null,
        source_refs: (e.source_refs as string[]) ?? [],
        confidence: Number(e.confidence ?? 0.5),
        merged_into: (e.merged_into as string | null) ?? null,
        derived: {
          article_count_30d: r.derived.article_count_30d,
          last_news_date:
            r.derived.last_news_date ?? r.recent_signals[0]?.published_date ?? null,
          top_event_types: r.derived.top_event_types.map((t) => ({
            tag: t.tag,
            count: Number(t.count),
          })),
        },
        relevance_score: r.relevance_score,
        recent_signals: r.recent_signals.map((s) => ({
          headline: s.headline,
          url: s.url,
          published_date: s.published_date,
          tag: s.tag,
        })),
      } satisfies z.infer<typeof ListCompany>;
    });

    return reply.send({
      count: companies.length,
      companies,
      interpreted_filters: interpreted,
    });
  });
}
