import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  CompanyCard,
  CompanySearchQuery,
  CompanySearchResponse,
  CompanyEnrichmentResponse,
  EnrichmentQuery,
  CompanyGrowthQuery,
  CompanyGrowthResponse,
  CompanyIndustriesQuery,
  CompanyIndustriesResponse,
  CompanyMixQuery,
  CompanyMixResponse,
} from "../contracts.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";
import { Errors } from "../../lib/errors.js";
import { getCompanyProfileConfig, type ProfileSectionId } from "../../config-files.js";
import { readEntityProfile } from "../../entities/profile.js";
import { TRACKED_COMPANY_SQL } from "../../entities/tracked.js";

/** FR-19: company entity card + filtered search. */

type Derived = {
  article_count_30d: number;
  last_news_date: string | null;
  top_event_types: Array<{ tag: string; count: number }>;
};

function toDto(e: Record<string, unknown>, derived: Derived) {
  const lastFunding = e.last_funding_date ?? e.lastFundingDate ?? null;
  return {
    id: String(e.id),
    canonical_name: String(e.canonical_name ?? e.canonicalName ?? ""),
    legal_name: (e.legal_name ?? e.legalName ?? null) as string | null,
    website: (e.website ?? null) as string | null,
    aliases: ((e.aliases ?? []) as string[]),
    type: String(e.type ?? "private"),
    status: String(e.status ?? "operating"),
    country: (e.country ?? null) as string | null,
    hq_city: (e.hq_city ?? e.hqCity ?? null) as string | null,
    founded_year: (e.founded_year ?? e.foundedYear ?? null) as number | null,
    industry_tags: ((e.industry_tags ?? e.industryTags ?? []) as string[]),
    tickers: ((e.tickers ?? []) as string[]),
    funding_stage: (e.funding_stage ?? e.fundingStage ?? null) as string | null,
    total_raised_usd:
      e.total_raised_usd != null
        ? Number(e.total_raised_usd)
        : ((e.totalRaisedUsd ?? null) as number | null),
    last_funding_date: lastFunding ? new Date(String(lastFunding)).toISOString().slice(0, 10) : null,
    source_refs: ((e.source_refs ?? e.sourceRefs ?? []) as string[]),
    confidence: Number(e.confidence ?? 0.5),
    merged_into: (e.merged_into ?? e.mergedInto ?? null) as string | null,
    derived,
  };
}

export function registerCompanyRoutes(app: FastifyInstance, deps: AppDeps) {
  registerRoute({
    method: "get",
    path: "/v1/companies/{id}",
    operationId: "getCompany",
    summary: "Entity card (basic KB fields) with derived 30-day news stats.",
    tags: ["companies"],
    response: CompanyCard,
  });

  app.get("/v1/companies/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    if (!id.startsWith("ent_")) throw Errors.badRequest("company ids look like ent_<ulid>");
    const card = await deps.kb.entityCard(id);
    return reply.send(
      toDto(card as unknown as Record<string, unknown>, {
        article_count_30d: card.derived.article_count_30d,
        last_news_date: card.derived.last_news_date
          ? new Date(card.derived.last_news_date).toISOString()
          : null,
        top_event_types: card.derived.top_event_types.map((t) => ({
          tag: t.tag,
          count: Number(t.count),
        })),
      }),
    );
  });

  // FR-25: akta-parity company enrichment (16 sections, evidence-cited).
  registerRoute({
    method: "get",
    path: "/v1/companies/{id}/enrichment",
    operationId: "getCompanyEnrichment",
    summary:
      "Deep company profile (akta Company Data parity): firmographic, location, funding, M&A, business model, technology and more. Request sections via ?sections=csv; complete sections only are returned.",
    tags: ["companies"],
    query: EnrichmentQuery,
    response: CompanyEnrichmentResponse,
  });

  app.get("/v1/companies/:id/enrichment", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    if (!id.startsWith("ent_")) throw Errors.badRequest("company ids look like ent_<ulid>");
    const q = EnrichmentQuery.parse(request.query ?? {});
    const cfg = getCompanyProfileConfig();
    let requested = cfg.sections as ProfileSectionId[];
    if (q.sections !== undefined) {
      const parts = q.sections.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) throw Errors.badRequest("sections must be a non-empty csv");
      const unknown = parts.filter((p) => !cfg.sections.includes(p as ProfileSectionId));
      if (unknown.length) {
        throw Errors.badRequest(
          `unknown sections: ${unknown.join(", ")} — allowed: ${cfg.sections.join(", ")}`,
        );
      }
      requested = [...new Set(parts)] as ProfileSectionId[];
    }
    await deps.kb.get(id); // 404 when missing
    const profile = await readEntityProfile(deps.db, id, requested);
    return reply.send({
      company_id: id,
      sections: profile.sections,
      complete_sections: profile.completeSections,
      missing_sections: profile.missingSections,
      generated_at: profile.generatedAt,
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/companies/search",
    operationId: "searchCompanies",
    summary: "Basic filtered company search (name/industry/country).",
    tags: ["companies"],
    query: CompanySearchQuery,
    response: CompanySearchResponse,
  });

  app.get("/v1/companies/search", async (request, reply) => {
    const q = CompanySearchQuery.parse(request.query ?? {});
    // R06: baseline-incomplete entities stay out of default search surfaces.
    // Canonical company view: funds/person-orgs are excluded unless asked for
    // explicitly via entity_type, so counts agree with /v1/news/stats.
    const conds = [sql`merged_into IS NULL`, sql`needs_backfill = false`];
    if (q.entity_type) conds.push(sql`type = ${q.entity_type}`);
    else conds.push(sql`type NOT IN ('fund', 'person-org', 'public')`);
    if (q.q?.trim()) conds.push(sql`lower(canonical_name) LIKE ${"%" + q.q.trim().toLowerCase() + "%"}`);
    if (q.industry)
      conds.push(
        sql`EXISTS (SELECT 1 FROM unnest(e.industry_tags) t WHERE regexp_replace(lower(t), '[^a-z0-9]+', '_', 'g') = ${q.industry})`,
      );
    if (q.country) conds.push(sql`country = ${q.country.toUpperCase()}`);
    if (q.funding_stage) {
      const stages = q.funding_stage.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (stages.length) {
        conds.push(
          sql`(lower(COALESCE(funding_stage, '')) IN (${sql.join(
            stages.map((s) => sql`${s}`),
            sql`, `,
          )}))`,
        );
      }
    }
    if (q.venture_band) conds.push(sql`venture_band = ${q.venture_band}`);
    const whereSql = sql.join(conds, sql` AND `);

    let rows;
    try {
      rows = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT e.*,
             COALESCE(s.article_count_30d, 0) AS article_count_30d,
             s.last_news_date,
             s.top_event_types
      FROM entities e
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS article_count_30d,
               MAX(a.published_at) AS last_news_date,
               COALESCE(
                 (SELECT json_agg(y) FROM (
                    SELECT a2.primary_tag AS tag, COUNT(*)::int AS count
                    FROM articles a2
                    JOIN article_entities ae2 ON ae2.article_id = a2.id AND ae2.role = 'primary'
                    WHERE ae2.entity_id = e.id AND a2.noise_stage = 'kept'
                      AND a2.primary_tag IS NOT NULL
                      AND a2.published_at >= now() - interval '90 days'
                    GROUP BY a2.primary_tag ORDER BY count DESC LIMIT 5
                  ) y),
                 '[]'::json
               ) AS top_event_types
        FROM articles a
        JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
        WHERE ae.entity_id = e.id AND a.noise_stage = 'kept'
          AND a.published_at >= now() - interval '30 days'
      ) s ON true
      WHERE ${whereSql}
      ORDER BY s.last_news_date DESC NULLS LAST, confidence DESC
      LIMIT ${Math.min(q.limit, 100)} OFFSET ${q.offset}
    `);
    } catch (e) {
      throw e;
    }
    const totals = await deps.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM entities e WHERE ${whereSql}
    `);

    return reply.send({
      total: Number(totals[0]?.n ?? 0),
      count: rows.length,
      offset: q.offset,
      data: rows.map((r) =>
        toDto(r, {
          article_count_30d: Number(r.article_count_30d ?? 0),
          last_news_date: r.last_news_date ? new Date(String(r.last_news_date)).toISOString() : null,
          top_event_types: Array.isArray(r.top_event_types)
            ? (r.top_event_types as Array<{ tag: string; count: number }>)
            : [],
        }),
      ),
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/companies/growth",
    operationId: "getCompanyGrowth",
    summary:
      "KB-compilation growth: cumulative canonical-company count over time from entities.created_at, bucketed by day/week/month. Canonical set matches /v1/companies/search default.",
    tags: ["companies"],
    query: CompanyGrowthQuery,
    response: CompanyGrowthResponse,
  });

  app.get("/v1/companies/growth", async (request, reply) => {
    const q = CompanyGrowthQuery.parse(request.query ?? {});
    // Canonical company set — identical predicate to /v1/companies/search's
    // default view, so the series ends exactly at "companies tracked".
    const COMPANY = TRACKED_COMPANY_SQL;

    // Build the bucket grid ending at the current bucket so zero-add buckets
    // still appear (and cumulative lines up with COUNT(*)).
    const end = truncBucket(q.granularity, new Date());
    const start = new Date(end);
    stepBucket(q.granularity, start, -(q.buckets - 1));

    const sinceIso = start.toISOString();
    const totals = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE created_at < ${sinceIso}::timestamptz)::int AS base
      FROM entities
      WHERE ${COMPANY}
    `);
    const adds = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT date_trunc(${q.granularity}, created_at)::date AS bucket, COUNT(*)::int AS added
      FROM entities
      WHERE ${COMPANY} AND created_at >= ${sinceIso}::timestamptz
      GROUP BY 1 ORDER BY 1
    `);

    const addedByBucket = new Map<string, number>(
      adds.map((r) => [new Date(String(r.bucket)).toISOString().slice(0, 10), Number(r.added ?? 0)]),
    );

    let running = Number(totals[0]?.base ?? 0);
    const points: Array<{ date: string; added: number; cumulative: number }> = [];
    for (let d = new Date(start); d <= end; stepBucket(q.granularity, d, 1)) {
      const key = d.toISOString().slice(0, 10);
      const added = addedByBucket.get(key) ?? 0;
      running += added;
      points.push({ date: key, added, cumulative: running });
    }

    return reply.send({
      granularity: q.granularity,
      total: Number(totals[0]?.n ?? 0),
      points,
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/companies/industries",
    operationId: "getCompanyIndustries",
    summary:
      "Industry mix of the canonical company set: company count per normalized industry tag (case/punctuation-insensitive), largest first. Canonical set matches /v1/companies/search default.",
    tags: ["companies"],
    query: CompanyIndustriesQuery,
    response: CompanyIndustriesResponse,
  });

  app.get("/v1/companies/industries", async (request, reply) => {
    const q = CompanyIndustriesQuery.parse(request.query ?? {});
    // Canonical company set — identical predicate to /v1/companies/search's
    // default view, so bubble counts sum against "companies tracked".
    const COMPANY = TRACKED_COMPANY_SQL;

    const totals = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE array_length(industry_tags, 1) > 0)::int AS classified
      FROM entities
      WHERE ${COMPANY}
    `);
    const byIndustry = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT regexp_replace(lower(t), '[^a-z0-9]+', '_', 'g') AS industry,
             COUNT(DISTINCT e.id)::int AS companies
      FROM entities e, unnest(e.industry_tags) t
      WHERE ${COMPANY}
      GROUP BY 1
      ORDER BY companies DESC, industry ASC
      LIMIT ${q.limit}
    `);

    return reply.send({
      total_companies: Number(totals[0]?.n ?? 0),
      total_classified: Number(totals[0]?.classified ?? 0),
      industries: byIndustry.map((r) => ({
        industry: String(r.industry ?? ""),
        count: Number(r.companies ?? 0),
      })),
    });
  });

  registerRoute({
    method: "get",
    path: "/v1/companies/mix",
    operationId: "getCompanyMix",
    summary:
      "Company-side snapshot of the canonical set: C0 venture-band mix, HQ-country mix, and entity-type mix. Complements /v1/news/overview for the /latest state-of-the-database view.",
    tags: ["companies"],
    query: CompanyMixQuery,
    response: CompanyMixResponse,
  });

  app.get("/v1/companies/mix", async (request, reply) => {
    const q = CompanyMixQuery.parse(request.query ?? {});
    // Canonical company set — identical predicate to /v1/companies/search's
    // default view, so every bucket sums against "companies tracked".
    const COMPANY = TRACKED_COMPANY_SQL;

    const totals = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COUNT(*)::int AS n
      FROM entities
      WHERE ${COMPANY}
    `);

    const byBand = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COALESCE(venture_band, 'unbanded') AS band, COUNT(*)::int AS count
      FROM entities
      WHERE ${COMPANY}
      GROUP BY 1
      ORDER BY count DESC
    `);

    const byCountry = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT COALESCE(country, 'unknown') AS country, COUNT(*)::int AS count
      FROM entities
      WHERE ${COMPANY}
      GROUP BY 1
      ORDER BY count DESC, country ASC
      LIMIT ${q.country_limit}
    `);

    const byType = await deps.db.execute<Record<string, unknown>>(sql`
      SELECT type, COUNT(*)::int AS count
      FROM entities
      WHERE ${COMPANY}
      GROUP BY 1
      ORDER BY count DESC
    `);

    return reply.send({
      total: Number(totals[0]?.n ?? 0),
      by_venture_band: byBand.map((r) => ({
        band: String(r.band ?? "unbanded"),
        count: Number(r.count ?? 0),
      })),
      by_country: byCountry.map((r) => ({
        country: String(r.country ?? "unknown"),
        count: Number(r.count ?? 0),
      })),
      by_type: byType.map((r) => ({
        type: String(r.type ?? ""),
        count: Number(r.count ?? 0),
      })),
    });
  });
}

/** Truncate to the UTC start of a day/ISO-week/month bucket. */
function truncBucket(g: "day" | "week" | "month", d: Date): Date {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  if (g === "week") t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  else if (g === "month") t.setUTCDate(1);
  return t;
}

/** Shift a bucket-start date by n buckets (n may be negative). */
function stepBucket(g: "day" | "week" | "month", d: Date, n: number): void {
  if (g === "month") d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCDate(d.getUTCDate() + n * (g === "week" ? 7 : 1));
}
