import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { entityImports, entities } from "../../db/schema.js";
import { sha256Hex } from "../../lib/hash.js";
import type { CreateEntityInput, EntityKb } from "../kb.js";

export interface ImportContext {
  db: Db;
  kb: EntityKb;
}

export type ImportOutcome = "created" | "updated" | "unchanged" | "skipped";

/**
 * Idempotent record upsert (FR-7 AC: re-running an import creates zero
 * duplicates). Payload hash short-circuits unchanged records; changed payloads
 * update the existing entity in place; new external ids create entities.
 */
export async function importOne(
  ctx: ImportContext,
  source: "wikidata" | "edgar" | "companies_house" | "seed",
  externalId: string,
  buildInput: () => CreateEntityInput | null,
): Promise<ImportOutcome> {
  const payload = buildInput();
  if (!payload) return "skipped";
  const payloadHash = sha256Hex(JSON.stringify(payload));

  const [existing] = await ctx.db
    .select()
    .from(entityImports)
    .where(and(eq(entityImports.source, source), eq(entityImports.externalId, externalId)))
    .limit(1);

  if (existing && !existing.entityId) {
    // previous run skipped creation; retry
  }

  if (!existing) {
    // Name-quality guard fires as a throw from kb.create; for authoritative
    // registry imports a single odd name must skip, not abort the whole run.
    let entityId: string | null = null;
    if (!entityId && payload.website) {
      const byDomain = await ctx.kb.findByWebsite(payload.website);
      if (byDomain) {
        entityId = byDomain.id;
        await enrichExisting(ctx, byDomain.id, payload);
      }
    }
    if (!entityId) {
      const cik =
        payload.registryIds?.sec_cik ??
        (payload.sourceRefs ?? [])
          .find((r) => r.startsWith("edgar:cik:"))
          ?.slice("edgar:cik:".length);
      if (cik) {
        const byCik = await ctx.kb.findBySecCik(cik);
        if (byCik) {
          entityId = byCik.id;
          await enrichExisting(ctx, byCik.id, payload);
        }
      }
    }
    if (!entityId) {
      try {
        const created = await ctx.kb.create({ ...payload, createdBy: `import:${source}` }, `import:${source}`);
        entityId = created.id;
      } catch (e) {
        if (!(e as Error).message.includes("entity name rejected")) throw e;
        console.error(`[import:${source}] skipped ${externalId}: ${(e as Error).message.slice(0, 140)}`);
        return "skipped";
      }
    }
    await ctx.db
      .insert(entityImports)
      .values({ source, externalId, entityId, payloadHash })
      .onConflictDoNothing();
    return "created";
  }

  if (existing.payloadHash === payloadHash) return "unchanged";
  if (existing.entityId) {
    await enrichExisting(ctx, existing.entityId, payload);
    await ctx.db
      .update(entityImports)
      .set({ payloadHash, importedAt: new Date() })
      .where(and(eq(entityImports.source, source), eq(entityImports.externalId, externalId)));
    return "updated";
  }
  return "skipped";
}

/** Merge non-conflicting fields into an existing entity without clobbering curated data. */
async function enrichExisting(ctx: ImportContext, entityId: string, incoming: CreateEntityInput) {
  const [cur] = await ctx.db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
  if (!cur) return;
  const set: Record<string, unknown> = {};
  if (!cur.website && incoming.website) set.website = incoming.website;
  for (const tag of incoming.industryTags ?? []) {
    if (!(cur.industryTags as string[]).includes(tag)) {
      set.industryTags = [...(cur.industryTags as string[]), tag];
    }
  }
  for (const t of incoming.tickers ?? []) {
    if (!(cur.tickers as string[]).includes(t)) set.tickers = [...(cur.tickers as string[]), t];
  }
  const refs = new Set([...(cur.sourceRefs as string[]), ...(incoming.sourceRefs ?? [])]);
  set.sourceRefs = [...refs];
  if (incoming.foundedYear && !cur.foundedYear) set.foundedYear = incoming.foundedYear;
  if (incoming.country && !cur.country) set.country = incoming.country.toUpperCase();
  if (incoming.hqCity && !cur.hqCity) set.hqCity = incoming.hqCity;
  if (incoming.registryIds) {
    set.registryIds = { ...(cur.registryIds ?? {}), ...incoming.registryIds };
  }
  if (!Object.keys(set).length) return;
  set.updatedAt = new Date();
  await ctx.db.update(entities).set(set).where(eq(entities.id, entityId));
  if (incoming.aliases?.length) {
    for (const alias of incoming.aliases) await ctx.kb.addAlias(entityId, alias);
  }
}

/** Simple progress reporter used by all import scripts. */
export class ProgressLogger {
  private counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  private lastReport = Date.now();

  add(outcome: ImportOutcome) {
    this.counts[outcome]++;
    if (Date.now() - this.lastReport > 5000) {
      console.error(JSON.stringify({ progress: this.snapshot() }));
      this.lastReport = Date.now();
    }
  }

  snapshot() {
    return { ...this.counts };
  }

  async checkpointDb(db: Db): Promise<void> {
    // keep transactions small on long imports
    await db.execute(sql`SELECT 1`);
  }
}
