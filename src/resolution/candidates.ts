import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { entities } from "../db/schema.js";
import { isGenericCompanyAlias } from "../lib/quality.js";
import { normalizeName } from "../lib/text.js";
import { heuristicOrganizations } from "../lib/ner-heuristics.js";

/**
 * FR-10 candidate generation: union of (a) NER mentions resolved through the
 * alias index (exact + trigram fuzzy), (b) domain matches between article
 * outbound links and entity websites, (c) ticker tokens. Recall-first;
 * precision comes from the resolver (FR-11).
 */

export interface Candidate {
  entity: typeof entities.$inferSelect;
  sources: Array<"alias_exact" | "alias_fuzzy" | "domain" | "ticker">;
  matchedAlias?: string;
}

export async function generateCandidates(
  db: Db,
  input: { title: string; lead: string; outlinkDomains: string[] },
  opts: { maxMentions?: number } = {},
): Promise<{ candidates: Candidate[]; mentions: string[] }> {
  const maxMentions = opts.maxMentions ?? 12;
  const text = `${input.title}\n${input.lead}`;
  const spans = heuristicOrganizations(text).slice(0, maxMentions);
  const mentions = spans.map((s) => s.name);
  const byId = new Map<string, Candidate>();

  const push = (
    entity: typeof entities.$inferSelect,
    src: Candidate["sources"][number],
    matchedAlias?: string,
  ) => {
    const cur = byId.get(entity.id);
    if (cur) {
      if (!cur.sources.includes(src)) cur.sources.push(src);
      if (!cur.matchedAlias && matchedAlias) cur.matchedAlias = matchedAlias;
    } else {
      byId.set(entity.id, { entity, sources: [src], matchedAlias });
    }
  };

  // (a) exact alias matches for each detected mention
  const norms = [...new Set(mentions.map(normalizeName).filter((n) => n.length >= 3))];
  if (norms.length) {
    const rows = await db.execute<{
      id: string;
      canonical_name: string;
      legal_name: string | null;
      website: string | null;
      aliases: string[];
      type: string;
      status: string;
      country: string | null;
      hq_city: string | null;
      founded_year: number | null;
      industry_tags: string[];
      tickers: string[];
      confidence: number;
      merged_into: string | null;
      alias_norm: string;
    }>(sql`
      SELECT DISTINCT ON (e.id, al.alias_normalized)
             e.id, e.canonical_name, e.legal_name, e.website, e.aliases, e.type,
             e.status::text AS status, e.country, e.hq_city, e.founded_year,
             e.industry_tags, e.tickers, e.confidence, e.merged_into,
             al.alias_normalized AS alias_norm
      FROM aliases al
      JOIN entities e ON e.id = al.entity_id
      WHERE al.alias_normalized IN (${sql.join(norms.map((n) => sql`${n}`), sql`, `)})
        AND e.merged_into IS NULL
        AND al.kind != 'ticker'
      LIMIT 40
    `);
    for (const r of rows) {
      // Generic funding vocabulary must never introduce a candidate: a
      // company named "Series" would otherwise match every "Series A" round.
      if (isGenericCompanyAlias(r.alias_norm)) continue;
      push(rowToEntity(r), "alias_exact", r.alias_norm);
    }

    // (b) fuzzy trigram fallback for mentions without an exact hit
    const missed = norms.filter(
      (n) =>
        !isGenericCompanyAlias(n) &&
        ![...byId.values()].some((c) => c.matchedAlias === n),
    );
    for (const m of missed.slice(0, 6)) {
      let fuzzy: Array<{ id: string }>;
      try {
        fuzzy = await db.execute<{ id: string }>(sql`
          SELECT e.id
          FROM aliases al
          JOIN entities e ON e.id = al.entity_id
          WHERE e.merged_into IS NULL
            AND al.alias_normalized % ${m}
            AND length(al.alias_normalized) BETWEEN 4 AND 60
          ORDER BY similarity(al.alias_normalized, ${m}) DESC
          LIMIT 3
        `);
      } catch {
        // pg_trgm similarity unavailable in some embedded/WASM builds.
        continue;
      }
      if (!fuzzy.length) continue;
      const ids = fuzzy.map((r) => r.id);
      const ents = await db.select().from(entities).where(inArray(entities.id, ids));
      for (const e of ents) push(e, "alias_fuzzy");
    }
  }

  // (c) domain overlap between article links and entity websites
  const domains = input.outlinkDomains.filter(Boolean).slice(0, 30);
  if (domains.length) {
    const domRows = await db.execute<Record<string, unknown>>(sql`
      SELECT * FROM entities
      WHERE merged_into IS NULL AND website IN (${sql.join(domains.map((d) => sql`${d}`), sql`, `)})
      LIMIT 10
    `);
    for (const r of domRows) {
      push(rowToEntity(r), "domain");
    }
  }

  return { candidates: [...byId.values()], mentions };
}

// Raw-row -> entity shape helper for exact-alias query results.
function rowToEntity(r: Record<string, unknown>): typeof entities.$inferSelect {
  return {
    id: r.id as string,
    canonicalName: r.canonical_name as string,
    legalName: (r.legal_name ?? null) as string | null,
    website: (r.website ?? null) as string | null,
    aliases: (r.aliases ?? []) as string[],
    type: (r.type ?? "private") as typeof entities.$inferSelect["type"],
    status: (r.status ?? "operating") as typeof entities.$inferSelect["status"],
    country: (r.country ?? null) as string | null,
    hqCity: (r.hq_city ?? null) as string | null,
    foundedYear: (r.founded_year ?? null) as number | null,
    industryTags: (r.industry_tags ?? []) as string[],
    tickers: (r.tickers ?? []) as string[],
    fundingStage: (r.funding_stage ?? null) as string | null,
    totalRaisedUsd: (r.total_raised_usd ?? null) as number | null,
    lastFundingDate: (r.last_funding_date ?? null) as Date | null,
    sourceRefs: (r.source_refs ?? []) as string[],
    registryIds: (r.registry_ids ?? null) as Record<string, string> | null,
    confidence: (r.confidence ?? 0.5) as number,
    mergedInto: (r.merged_into ?? null) as string | null,
    isMonitored: Boolean(r.is_monitored),
    needsBackfill: (r.needs_backfill ?? true) as boolean,
    ventureBand: (r.venture_band ?? null) as typeof entities.$inferSelect["ventureBand"],
    bandedAt: (r.banded_at ?? null) as Date | null,
    reviewStatus: (r.review_status ?? "reviewed") as typeof entities.$inferSelect["reviewStatus"],
    createdBy: (r.created_by ?? "manual") as string,
    createdAt: (r.created_at ?? new Date()) as Date,
    updatedAt: (r.updated_at ?? new Date()) as Date,
  };
}
