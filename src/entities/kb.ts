import { and, desc, eq, gte, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { aliases, articleEntities, articles, entities, facts, stories } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import { hostToDomain } from "../lib/hash.js";
import { normalizeName } from "../lib/text.js";
import { entityNameRejectionReason } from "../lib/quality.js";

import { opaqueId } from "../lib/ulid.js";

export const EntityType = z.enum(["private", "public", "subsidiary", "person-org", "fund", "other"]);
export const EntityStatus = z.enum(["operating", "active", "acquired", "closed", "unknown"]);

/** §6.2 basic entity card fields — deliberately shallow per NG1. */
export const EntityInput = z.object({
  canonicalName: z.string().min(2).max(200),
  legalName: z.string().max(200).nullish(),
  website: z.string().nullish(), // domain or URL; normalized to registrable domain
  aliases: z.array(z.string()).default([]),
  type: EntityType.default("private"),
  status: EntityStatus.default("operating"),
  country: z.string().length(2).nullish(),
  hqCity: z.string().max(120).nullish(),
  foundedYear: z.number().int().min(1600).max(2100).nullish(),
  industryTags: z.array(z.string()).default([]),
  tickers: z.array(z.string()).default([]),
  /** D3 stage policy: null is a defect — evidenced value, else unknown/bootstrapped. */
  fundingStage: z.string().nullish(), // populated ONLY by FR-9 accepted facts
  totalRaisedUsd: z.number().nonnegative().nullish(),
  lastFundingDate: z.date().nullish(),
  sourceRefs: z.array(z.string()).default([]),
  registryIds: z.record(z.string()).nullish(),
  confidence: z.number().min(0).max(1).default(0.5),
  isMonitored: z.boolean().default(false),
  reviewStatus: z.enum(["auto_created", "reviewed"]).default("reviewed"),
  createdBy: z.string().default("manual"),
});
export type EntityInput = z.infer<typeof EntityInput>;
export type CreateEntityInput = z.input<typeof EntityInput>;

/** R06 baseline-at-birth check: complete cards skip the backfill queue. */
function baselineCompleteAtBirth(input: CreateEntityInput): boolean {
  return Boolean(
    input.website &&
      input.country &&
      (input.industryTags?.length ?? 0) > 0 &&
      input.fundingStage && input.fundingStage.trim() !== "",
  );
}

export function normalizeWebsite(raw: string): string {
  return hostToDomain(raw.includes("://") || raw.includes(".") ? raw : `${raw}`);
}

async function insertAliasRows(
  db: Db,
  entityId: string,
  entries: Array<{ alias: string; kind: "name" | "former_name" | "ticker" | "domain" | "abbrev"; weight?: number; source?: string }>,
): Promise<void> {
  if (!entries.length) return;
  const seen = new Set<string>();
  const rows = [];
  for (const e of entries) {
    const norm = normalizeName(e.alias);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    rows.push({
      id: opaqueId("als"),
      entityId,
      alias: e.alias,
      aliasNormalized: norm,
      kind: e.kind,
      weight: e.weight ?? 1,
      source: e.source ?? "manual",
    });
  }
  if (!rows.length) return;
  await db.insert(aliases).values(rows).onConflictDoNothing();
}

/**
 * FR-6 entity store: opaque stable ids, domain as primary join key, alias
 * table driving candidate generation. Idempotent-friendly via unique indexes.
 */
export class EntityKb {
  constructor(private db: Db) {}

  async create(input: CreateEntityInput, source?: string): Promise<typeof entities.$inferSelect> {
    // The name guard protects against garbage minted from article text
    // (autocreate). Curated imports (seed/edgar/wikidata/companies-house)
    // carry verified provenance, so their names are trusted.
    const curated = /^import:(seed|edgar|wikidata|companies-house)/.test(source ?? "") ||
      source === "manual";
    if (!curated) {
      const rejection = entityNameRejectionReason(input.canonicalName);
      if (rejection) throw Errors.badRequest(`entity name rejected (${rejection}): "${input.canonicalName}"`);
    }
    const id = opaqueId("ent");
    const website = input.website ? normalizeWebsite(input.website) : null;
    const [row] = await this.db
      .insert(entities)
      .values({
        id,
        canonicalName: input.canonicalName,
        legalName: input.legalName ?? null,
        website,
        aliases: [input.canonicalName, ...(input.aliases ?? [])],
        type: input.type,
        status: input.status === "active" ? "operating" : input.status,
        country: input.country ? input.country.toUpperCase() : null,
        hqCity: input.hqCity ?? null,
        foundedYear: input.foundedYear ?? null,
        industryTags: input.industryTags,
        tickers: input.tickers,
        // D3 stage policy: funding_stage is NEVER null on a stored card — an
        // evidenced stage where facts allow, literal "unknown" otherwise.
        fundingStage: input.fundingStage?.trim() ? input.fundingStage.trim().toLowerCase() : "unknown",
        totalRaisedUsd: input.totalRaisedUsd ?? null,
        lastFundingDate: input.lastFundingDate ?? null,
        sourceRefs: input.sourceRefs ?? [],
        registryIds: input.registryIds ?? null,
        confidence: input.confidence,
        isMonitored: input.isMonitored,
        reviewStatus: input.reviewStatus,
        createdBy: input.createdBy,
        // R06: incomplete cards stay flagged out of default surfaces until
        // the baseline worker drains them.
        needsBackfill: !baselineCompleteAtBirth(input),
      })
      .returning();

    await insertAliasRows(this.db, id, [
      { alias: input.canonicalName, kind: "name", weight: 1, source },
      ...((input.aliases ?? []).filter((a) => !entityNameRejectionReason(a)).map((a) => ({ alias: a, kind: "name" as const, source }))),
      ...((input.tickers ?? []).map((t) => ({ alias: t, kind: "ticker" as const, weight: 0.8, source }))),
      ...(website ? [{ alias: website, kind: "domain" as const, weight: 0.9, source }] : []),
    ]);
    return row!;
  }

  async get(id: string): Promise<typeof entities.$inferSelect> {
    const [row] = await this.db.select().from(entities).where(eq(entities.id, id)).limit(1);
    if (!row) throw Errors.notFound(`entity ${id} not found`);
    return row;
  }

  async update(id: string, patch: Partial<EntityInput>): Promise<typeof entities.$inferSelect> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.canonicalName !== undefined) set.canonicalName = patch.canonicalName;
    if (patch.legalName !== undefined) set.legalName = patch.legalName ?? null;
    if (patch.website !== undefined)
      set.website = patch.website ? normalizeWebsite(patch.website) : null;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.status !== undefined)
      set.status = patch.status === "active" ? "operating" : patch.status;
    if (patch.country !== undefined)
      set.country = patch.country ? patch.country.toUpperCase() : null;
    if (patch.hqCity !== undefined) set.hqCity = patch.hqCity ?? null;
    if (patch.foundedYear !== undefined) set.foundedYear = patch.foundedYear ?? null;
    if (patch.industryTags !== undefined) set.industryTags = patch.industryTags;
    if (patch.tickers !== undefined) set.tickers = patch.tickers;
    if (patch.confidence !== undefined) set.confidence = patch.confidence;
    if (patch.isMonitored !== undefined) set.isMonitored = patch.isMonitored;
    if (patch.reviewStatus !== undefined) set.reviewStatus = patch.reviewStatus;

    const rows = await this.db.update(entities).set(set).where(eq(entities.id, id)).returning();
    if (!rows.length) throw Errors.notFound(`entity ${id} not found`);

    if (patch.aliases?.length) {
      await insertAliasRows(
        this.db,
        id,
        patch.aliases.map((a) => ({ alias: a, kind: "name" as const })),
      );
    }
    return rows[0]!;
  }

  // ------------------------------------------------------------- aliases
  async addAlias(entityId: string, alias: string, kind: "name" | "former_name" | "ticker" | "domain" | "abbrev" = "name") {
    const norm = normalizeName(alias);
    if (!norm) throw Errors.badRequest("alias normalizes to empty");
    await this.db.insert(aliases).values({ id: opaqueId("als"), entityId, alias, aliasNormalized: norm, kind }).onConflictDoNothing();
    await this.db.execute(sql`
      UPDATE entities SET aliases = (
        SELECT array_agg(DISTINCT a) FROM (
          SELECT unnest(aliases || ARRAY[${alias}]::text[]) AS a
        ) s
      ), updated_at = now() WHERE id = ${entityId}
    `);
  }

  async removeAlias(aliasRowId: string) {
    await this.db.delete(aliases).where(eq(aliases.id, aliasRowId));
  }

  async listAliases(entityId: string) {
    return this.db.select().from(aliases).where(eq(aliases.entityId, entityId));
  }

  // ------------------------------------------------------------- lookups
  async findByWebsite(domainOrUrl: string) {
    const domain = hostToDomain(domainOrUrl);
    if (!domain) return null;
    const [row] = await this.db
      .select()
      .from(entities)
      .where(and(eq(entities.website, domain), sql`${entities.mergedInto} IS NULL`))
      .limit(1);
    return row ?? null;
  }

  async findBySecCik(cik: string) {
    const padded = cik.replace(/\D/g, "").padStart(10, "0");
    if (!padded || padded === "0000000000") return null;
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND (
          registry_ids->>'sec_cik' = ${padded}
          OR source_refs @> ARRAY[${`edgar:cik:${padded}`}]::text[]
        )
      LIMIT 1
    `);
    const id = rows[0]?.id;
    return id ? this.get(String(id)) : null;
  }

  async findByExactName(name: string) {
    const norm = normalizeName(name);
    if (!norm) return null;
    const rows = await this.db
      .select({ e: entities })
      .from(aliases)
      .innerJoin(entities, eq(entities.id, aliases.entityId))
      .where(and(eq(aliases.aliasNormalized, norm), sql`${entities.mergedInto} IS NULL`))
      .limit(1);
    return rows[0]?.e ?? null;
  }

  /**
   * FR-6 AC: merge tooling. Merged entity keeps its opaque id in place with
   * `merged_into` pointer (ids stay stable across renames/merges); aliases and
   * references migrate to the surviving entity.
   */
  async merge(sourceId: string, targetId: string): Promise<void> {
    if (sourceId === targetId) throw Errors.badRequest("cannot merge entity into itself");
    const target = await this.get(targetId);
    if (target.mergedInto) throw Errors.conflict(`target entity already merged into ${target.mergedInto}`);

    // Move aliases that do not collide.
    const srcAliases = await this.db.select().from(aliases).where(eq(aliases.entityId, sourceId));
    for (const a of srcAliases) {
      const moved = await this.db
        .update(aliases)
        .set({ entityId: targetId })
        .where(and(eq(aliases.id, a.id), sql`NOT EXISTS (SELECT 1 FROM aliases x WHERE x.entity_id = ${targetId} AND x.alias_normalized = ${a.aliasNormalized})`))
        .returning();
      if (!moved.length) await this.db.delete(aliases).where(eq(aliases.id, a.id));
    }

    // Re-point article resolutions, story clusters, facts.
    await this.db
      .update(articleEntities)
      .set({ entityId: targetId })
      .where(eq(articleEntities.entityId, sourceId));
    await this.db.update(stories).set({ primaryEntityId: targetId }).where(eq(stories.primaryEntityId, sourceId));
    await this.db.update(facts).set({ entityId: targetId }).where(eq(facts.entityId, sourceId));

    await this.db
      .update(entities)
      .set({ mergedInto: targetId, isMonitored: false, updatedAt: new Date() })
      .where(eq(entities.id, sourceId));

    // Collapse duplicate (article, entity) pairs after re-pointing.
    await this.db.execute(sql`
      DELETE FROM article_entities a
      USING article_entities b
      WHERE a.article_id = b.article_id AND a.entity_id = b.entity_id AND a.ctid > b.ctid
        AND a.role = 'secondary' AND b.role = 'secondary'
    `);
  }

  /**
   * FR-19 company search: filtered by free text (canonical name trigram-ish),
   * industry tag, country. p95 <500ms supported by indexes on live subset.
   */
  async search(opts: { q?: string; industry?: string; country?: string; limit?: number; offset?: number }) {
    // R06: flagged (baseline-incomplete) entities stay out of default search.
    const conds = [
      sql`${entities.mergedInto} IS NULL`,
      sql`${entities.needsBackfill} = false`,
      sql`${entities.type} NOT IN ('fund', 'person-org', 'public')`,
    ];
    if (opts.q && opts.q.trim()) {
      conds.push(ilike(entities.canonicalName, `%${opts.q.trim()}%`));
    }
    if (opts.industry) conds.push(sql`industry_tags @> ARRAY[${opts.industry}::text]`);
    if (opts.country)
      conds.push(eq(entities.country, opts.country.toUpperCase()));
    const where = and(...conds);
    const data = await this.db
      .select()
      .from(entities)
      .where(where)
      .orderBy(desc(entities.confidence))
      .limit(Math.min(opts.limit ?? 10, 100))
      .offset(opts.offset ?? 0);
    const totalRows = await this.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM entities WHERE ${where}
    `);
    return { data, total: Number(totalRows[0]?.n ?? 0) };
  }

  /** FR-19 entity card + derived stats. */
  async entityCard(id: string) {
    const ent = await this.get(id);
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const statsRows = await this.db
      .select({
        articleCount30d: sql<number>`COUNT(*)::int`,
        lastNewsDate: sql<Date | null>`MAX(${articles.publishedAt})`,
      })
      .from(articleEntities)
      .innerJoin(articles, eq(articles.id, articleEntities.articleId))
      .where(
        and(
          eq(articleEntities.entityId, id),
          gte(articles.publishedAt, since30d),
          eq(articles.noiseStage, "kept"),
        ),
      );
    const topEventsRows = await this.db.execute<{ primary_tag: string; n: number }>(sql`
      SELECT a.primary_tag, COUNT(*)::int AS n
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE ae.entity_id = ${id} AND a.noise_stage = 'kept'
        AND a.published_at >= now() - interval '90 days'
        AND a.primary_tag IS NOT NULL
      GROUP BY a.primary_tag ORDER BY n DESC LIMIT 5
    `);
    return {
      ...ent,
      derived: {
        article_count_30d: Number(statsRows[0]?.articleCount30d ?? 0),
        last_news_date: statsRows[0]?.lastNewsDate ?? null,
        top_event_types: topEventsRows.map((r) => ({
          tag: r.primary_tag,
          count: Number(r.n),
        })),
      },
    };
  }

  /** Entities referenced by any of the given ids, excluding merged ones. */
  async resolveMany(ids: string[]) {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(entities)
      .where(and(inArray(entities.id, ids), sql`${entities.mergedInto} IS NULL`));
  }
}
