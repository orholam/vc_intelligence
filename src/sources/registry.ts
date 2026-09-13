import { and, asc, eq, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { type Db } from "../db/index.js";
import { sources } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import { opaqueId } from "../lib/ulid.js";

// Realignment 08-25 (RSS inflow round): cadence raised from {15,60,1440} so
// tier-3 niche verticals no longer sit on a daily poll — every VC specialization
// needs same-day coverage, and conditional GETs keep the extra polls cheap.
export const POLL_CADENCE_MINUTES: Record<1 | 2 | 3, number> = { 1: 15, 2: 30, 3: 120 };

export const SourceInput = z.object({
  name: z.string().min(2).max(120),
  publisher: z.string().min(2).max(160),
  feedUrl: z.string().url(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  country: z.string().length(2).nullish(),
  defaultLanguage: z.string().length(2).default("en"),
  topics: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});
export type SourceInput = z.infer<typeof SourceInput>;

export function nextPollAt(tier: 1 | 2 | 3, from = new Date()): Date {
  return new Date(from.getTime() + POLL_CADENCE_MINUTES[tier] * 60_000);
}

function backoffMinutes(failureStreak: number): number {
  // exponential: 5m,10m,20m... capped at 24h (FR-2)
  const m = Math.min(5 * 2 ** Math.max(0, failureStreak - 1), 24 * 60);
  return m;
}

export class SourceRegistry {
  constructor(private db: Db) {}

  async create(input: SourceInput) {
    const id = opaqueId("src");
    const [row] = await this.db
      .insert(sources)
      .values({
        id,
        ...input,
        country: input.country ?? null,
        defaultLanguage: input.defaultLanguage ?? "en",
        topics: input.topics ?? [],
        nextPollAt: new Date(), // eligible immediately
      })
      .onConflictDoNothing({ target: sources.feedUrl })
      .returning();
    if (!row) throw Errors.conflict(`source with feed_url already exists`);
    return row;
  }

  async update(id: string, patch: Partial<SourceInput>) {
    const [row] = await this.db
      .update(sources)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(sources.id, id))
      .returning();
    if (!row) throw Errors.notFound(`source ${id} not found`);
    return row;
  }

  async remove(id: string) {
    const rows = await this.db.delete(sources).where(eq(sources.id, id)).returning();
    if (!rows.length) throw Errors.notFound(`source ${id} not found`);
  }

  async get(id: string) {
    const [row] = await this.db.select().from(sources).where(eq(sources.id, id)).limit(1);
    if (!row) throw Errors.notFound(`source ${id} not found`);
    return row;
  }

  async list(opts: { active?: boolean; tier?: 1 | 2 | 3; limit?: number; offset?: number } = {}) {
    const conds = [];
    if (opts.active !== undefined) conds.push(eq(sources.active, opts.active));
    if (opts.tier !== undefined) conds.push(eq(sources.tier, opts.tier));
    return this.db
      .select()
      .from(sources)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(sources.name))
      .limit(Math.min(opts.limit ?? 100, 1000))
      .offset(opts.offset ?? 0);
  }

  async count(): Promise<number> {
    const r = await this.db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM sources`);
    return Number(r[0]?.n ?? 0);
  }

  /** FR-1 AC: adding a feed never requires a code change; activation toggles instantly. */
  async setActive(id: string, active: boolean) {
    return this.update(id, { active });
  }

  async recordFetchSuccess(id: string, etag: string | null, lastModified: string | null) {
    const [row] = await this.db.select().from(sources).where(eq(sources.id, id)).limit(1);
    if (!row) return;
    await this.db
      .update(sources)
      .set({
        lastFetchedAt: new Date(),
        etag: etag ?? row.etag,
        lastModified: lastModified ?? row.lastModified,
        failureStreak: 0,
        lastError: null,
        nextPollAt: nextPollAt(row.tier),
        updatedAt: new Date(),
      })
      .where(eq(sources.id, id));
  }

  async recordFetchFailure(id: string, error: string) {
    const [row] = await this.db.select().from(sources).where(eq(sources.id, id)).limit(1);
    if (!row) return;
    const streak = row.failureStreak + 1;
    await this.db
      .update(sources)
      .set({
        failureStreak: streak,
        lastError: error.slice(0, 300),
        nextPollAt: new Date(Date.now() + backoffMinutes(streak) * 60_000),
        updatedAt: new Date(),
      })
      .where(eq(sources.id, id));
  }

  /** Sources due for polling right now (per-tier scheduler picks these up). */
  async dueSources(limit = 100): Promise<Array<typeof sources.$inferSelect>> {
    return this.db
      .select()
      .from(sources)
      .where(and(eq(sources.active, true), sql`COALESCE(next_poll_at, to_timestamp(0)) <= now()`))
      .orderBy(sql`COALESCE(next_poll_at, to_timestamp(0)) ASC`)
      .limit(limit);
  }

  // ---------------------------------------------------------- bulk import (FR-1)
  async importFromRecords(records: SourceInput[]): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;
    for (const rec of records) {
      const parsed = SourceInput.safeParse(rec);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const inserted = await this.db
        .insert(sources)
        .values({
          id: opaqueId("src"),
          ...parsed.data,
          country: parsed.data.country ?? null,
          nextPollAt: new Date(),
        })
        .onConflictDoNothing({ target: sources.feedUrl })
        .returning();
      if (inserted.length) created++;
      else skipped++;
    }
    return { created, skipped };
  }

  /** OPML bulk import: outline elements with xmlUrl + text/title attributes. */
  async importOpml(xml: string, defaults: Partial<SourceInput> = {}): Promise<{ created: number; skipped: number }> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const doc = parser.parse(xml) as OpmlDoc;
    const records: SourceInput[] = [];
    const walk = (node: OpmlNode | OpmlNode[] | undefined) => {
      if (!node) return;
      const arr = Array.isArray(node) ? node : [node];
      for (const n of arr) {
        const url = n["@_xmlUrl"] ?? n["@_htmlUrl"];
        if (url && /^https?:\/\//.test(url)) {
          const title = n["@_title"] || n["@_text"] || url;
          records.push({
            name: title.slice(0, 120),
            publisher: title.slice(0, 160),
            feedUrl: url,
            tier: defaults.tier ?? 3,
            country: defaults.country ?? null,
            defaultLanguage: defaults.defaultLanguage ?? "en",
            topics: defaults.topics ?? [],
            active: true,
          });
        }
        if (n.outline) walk(n.outline);
      }
    };
    walk(doc?.opml?.body?.outline);
    return this.importFromRecords(records);
  }

  /** CSV bulk import: header row `name,publisher,feed_url,tier,country,default_language,topics`. */
  async importCsv(csv: string): Promise<{ created: number; skipped: number }> {
    const { parse } = await import("csv-parse/sync");
    const rows: Record<string, string>[] = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
    const records: SourceInput[] = rows.map((r) => ({
      name: (r.name || r.feed_url || "").slice(0, 120),
      publisher: (r.publisher || r.name || r.feed_url || "").slice(0, 160),
      feedUrl: r.feed_url ?? r.url ?? "",
      tier: (Number(r.tier ?? 3) === 1 ? 1 : Number(r.tier ?? 3) === 2 ? 2 : 3),
      country: r.country ? r.country.slice(0, 2).toLowerCase() : null,
      defaultLanguage: (r.default_language || "en").slice(0, 2),
      topics: r.topics ? r.topics.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
      active: true,
    }));
    return this.importFromRecords(records);
  }
}

interface OpmlNode {
  "@_text"?: string;
  "@_title"?: string;
  "@_xmlUrl"?: string;
  "@_htmlUrl"?: string;
  outline?: OpmlNode | OpmlNode[];
}
interface OpmlDoc {
  opml?: { body?: { outline?: OpmlNode | OpmlNode[] } };
}
