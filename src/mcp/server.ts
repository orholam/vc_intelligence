#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { makeProvider, LlmRouter } from "../llm/router.js";
import { SourceRegistry } from "../sources/registry.js";
import { EntityKb } from "../entities/kb.js";
import { readEntityProfile } from "../entities/profile.js";
import { getCompanyProfileConfig, type ProfileSectionId } from "../config-files.js";
import { interpretQuery } from "../listgen/interpret.js";
import { queryRankedCompanies } from "../listgen/pipeline.js";

/**
 * Public MCP wrapping the product API: news, search, ListGen, company card, facts.
 * Run: pnpm mcp:start   (stdio transport)
 */

async function main(): Promise<void> {
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 3 });
  const router = new LlmRouter(db, makeProvider(cfg));
  const kb = new EntityKb(db);
  void new SourceRegistry(db);

  const server = new McpServer({
    name: "copyr-intelligence",
    version: "0.1.0",
  });

  server.tool(
    "get_company_news",
    "Fetch recent news for one company by entity id, slug, domain or website URL.",
    {
      company: z.string().describe("entity id (ent_…), slug, domain, or URL"),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
      category: z.string().optional().describe("comma-separated event tags/families"),
      unique_article: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(200).optional().default(10),
    },
    async ({ company, start_date, end_date, category, unique_article, limit }) => {
      const ent =
        (await kb.findByWebsite(company)) ??
        (await kb.findByExactName(company)) ??
        (/^ent_/.test(company) ? await kb.get(company).catch(() => null) : null);
      if (!ent) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `company '${company}' not found` }) }] };
      }
      const conds = [
        "a.noise_stage = 'kept'",
        "ae.role = 'primary'",
        sql`ae.entity_id = ${ent.id}`,
      ];
      if (start_date) conds.push(sql`a.published_at >= ${new Date(`${start_date}T00:00:00Z`)}`);
      if (end_date) conds.push(sql`a.published_at <= ${new Date(`${end_date}T23:59:59Z`)}`);
      if (unique_article) {
        conds.push(sql`(a.story_cluster_id IS NULL OR a.is_cluster_representative = true)`);
      }
      const where = sql.join(conds, sql` AND `);
      let rows;
      if (category) {
        const tags = category.split(",").map((t) => t.trim()).filter(Boolean);
        rows = await db.execute(sql`
          SELECT a.title, a.url, a.publisher_domain, a.published_at, a.primary_tag,
                 a.sentiment, a.newsworthiness, a.ai_summary, a.fact_id
          FROM articles a JOIN article_entities ae ON ae.article_id = a.id
          WHERE ${where} AND (${sql.join(tags.map((t) => sql`${t}::text = ANY(a.all_tags)`), sql` OR `)})
          ORDER BY a.published_at DESC LIMIT ${limit}
        `);
      } else {
        rows = await db.execute(sql`
          SELECT a.title, a.url, a.publisher_domain, a.published_at, a.primary_tag,
                 a.sentiment, a.newsworthiness, a.ai_summary, a.fact_id
          FROM articles a JOIN article_entities ae ON ae.article_id = a.id
          WHERE ${where}
          ORDER BY a.published_at DESC LIMIT ${limit}
        `);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ entity_id: ent.id, count: rows.length, news: rows }, null, 2) }],
      };
    },
  );

  server.tool(
    "search_companies",
    "Search the company knowledge base by name, industry tag and/or country.",
    {
      q: z.string().optional(),
      industry: z.string().optional(),
      country: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ q, industry, country, limit }) => {
      const res = await kb.search({ q, industry, country, limit: limit ?? 20, offset: 0 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: res.total,
            companies: res.data.map((e) => ({
              id: e.id, canonical_name: e.canonicalName, website: e.website,
              country: e.country, industry_tags: e.industryTags, funding_stage: e.fundingStage,
            })),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "generate_company_list",
    "Natural-language query -> ranked company list with interpreted filters and recent signals.",
    {
      query: z.string().min(3).describe('e.g. "Series A AI startups in the US that raised recently"'),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ query, limit }) => {
      const filters = await interpretQuery(router, query);
      const ranked = await queryRankedCompanies(db, filters, Math.min(limit ?? 25, 100));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: ranked.length,
            interpreted_filters: filters,
            companies: ranked.map((r) => ({
              id: String((r.entity as Record<string, unknown>).id),
              canonical_name: String((r.entity as Record<string, unknown>).canonical_name),
              relevance_score: r.relevance_score,
              recent_signals: r.recent_signals.map((s) => s.headline),
            })),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "get_company_enrichment",
    "Deep company profile (akta Company Data parity): firmographics, location, funding, M&A, business model, technology, customers and more. Complete sections only; request a subset or all.",
    {
      company: z.string().describe("entity id (ent_…), slug, domain, or URL"),
      sections: z
        .string()
        .optional()
        .describe(
          "comma-separated subset: firmographic,location,company_hierarchy,product_offering,industry,financial_estimate,funding_detail,mna_and_investment,business_model,company_assessment,digital_presence,trust_signal,management_profile,strategic_signal,customer_profile,technology (default: all)",
        ),
    },
    async ({ company, sections }) => {
      const ent =
        (await kb.findByWebsite(company)) ??
        (await kb.findByExactName(company)) ??
        (/^ent_/.test(company) ? await kb.get(company).catch(() => null) : null);
      if (!ent) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `company '${company}' not found` }) }] };
      }
      const cfg = getCompanyProfileConfig();
      let requested = cfg.sections as ProfileSectionId[];
      if (sections) {
        const parts = sections.split(",").map((s) => s.trim()).filter(Boolean);
        requested = parts.filter((p): p is ProfileSectionId =>
          (cfg.sections as string[]).includes(p),
        );
      }
      const profile = await readEntityProfile(db, ent.id, requested);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              company_id: ent.id,
              complete_sections: profile.completeSections,
              missing_sections: profile.missingSections,
              generated_at: profile.generatedAt,
              sections: profile.sections,
            },
            null,
            2,
          ),
        }],
      };
    },
  );

  server.tool(
    "list_facts",
    "Structured facts (funding rounds, acquisitions, leadership, closures) with amount, stage, and related fields. News of those types points at a row here.",
    {
      type: z.string().optional().describe("comma-separated: funding_round,acquisition,…"),
      stage: z.string().optional().describe("funding stage, e.g. series_a"),
      country: z.string().optional().describe("ISO country code"),
      limit: z.number().int().min(1).max(200).optional().default(10),
    },
    async ({ type, stage, country, limit }) => {
      const conds = [sql`e.merged_into IS NULL`, sql`f.status IN ('accepted', 'proposed')`];
      if (type) {
        const types = type.split(",").map((t) => t.trim()).filter(Boolean);
        if (types.length) {
          conds.push(sql`(${sql.join(types.map((t) => sql`f.type = ${t}`), sql` OR `)})`);
        }
      }
      if (stage) {
        const stages = stage.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (stages.length) {
          conds.push(
            sql`(lower(COALESCE(f.payload->>'funding_stage', '')) IN (${sql.join(
              stages.map((s) => sql`${s}`),
              sql`, `,
            )}))`,
          );
        }
      }
      if (country) conds.push(sql`upper(e.country) = ${country.toUpperCase()}`);
      const whereSql = sql.join(conds, sql` AND `);
      const rows = await db.execute(sql`
        SELECT f.id, f.entity_id, f.type, f.status, f.payload,
               e.canonical_name AS entity_name, e.country
        FROM facts f
        JOIN entities e ON e.id = f.entity_id
        WHERE ${whereSql}
        ORDER BY COALESCE(f.promoted_at, f.created_at) DESC
        LIMIT ${limit ?? 10}
      `);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.tool(
    "list_waiting_room",
    "Admin: how much is piled in the waiting room (articles that passed rules and await the editorial harness). Does not replace the HTTP claim loop.",
    {
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ limit }) => {
      const depth = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM articles WHERE noise_stage = 'waiting'
      `);
      const rows = await db.execute(sql`
        SELECT id, title, publisher_domain, published_at, primary_tag
        FROM articles
        WHERE noise_stage = 'waiting'
        ORDER BY published_at DESC
        LIMIT ${limit ?? 25}
      `);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ waiting: Number((depth[0] as { n?: number })?.n ?? 0), items: rows }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "run_waiting_room_harness",
    "Admin: enqueue one harness batch over the waiting room (corrections → new companies → cards → publish). The LLM claim loop (GET /internal/llm/claim) still answers the batch. Keep that HTTP loop running.",
    {
      confirm: z.boolean().optional().describe("set true to enqueue; ignored, the call itself fires the run"),
    },
    async () => {
      const cfg = getConfig();
      const res = await fetch(`http://127.0.0.1:${cfg.APP_PORT}/v1/exoskeleton/harness/run`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: Error) => {
  // stdio servers must not pollute stdout with errors
  console.error("mcp server failed:", err.message);
  process.exit(1);
});
