import Parser from "rss-parser";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { domainLists, rawItems, type sources } from "../db/schema.js";
import { sha256Hex, canonicalizeUrl, hostToDomain } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { parseLooseDate } from "../lib/text.js";
import { conditionalGet } from "./fetcher.js";
import type { SourceRegistry } from "../sources/registry.js";

const parser = new Parser({
  customFields: {
    item: [
      ["dc:creator", "creator"],
      ["content:encoded", "contentEncoded"],
    ],
  },
  headers: {},
});

export interface PollResult {
  sourceId: string;
  ok: boolean;
  notModified?: boolean;
  seen: number;
  inserted: number;
  insertedIds: string[];
  error?: string;
}

/**
 * Some real-world feeds (e.g. WordPress blogs) ship bare `&` in titles, which
 * strict XML parsers reject for the WHOLE feed. Retry once with unescaped
 * ampersands sanitized so one sloppy entity doesn't blackhole a source.
 */
export function sanitizeBareAmpersands(xml: string): string {
  return xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

export async function parseFeedTolerant(xml: string) {
  try {
    return await parser.parseString(xml);
  } catch (first) {
    try {
      return await parser.parseString(sanitizeBareAmpersands(xml));
    } catch {
      throw first; // surface the original parse error
    }
  }
}

/**
 * Poll one feed (FR-2): conditional GET -> parse -> content-hash dedup ->
 * insert raw items. Idempotent under at-least-once execution: duplicate
 * GUID/link hashes hit unique indexes and are skipped.
 */
export async function pollFeed(
  db: Db,
  registry: SourceRegistry,
  source: typeof sources.$inferSelect,
): Promise<PollResult> {
  try {
    const cond = await conditionalGet(source.feedUrl, {
      etag: source.etag,
      lastModified: source.lastModified,
    });
    if (cond.notModified || !cond.page) {
      await registry.recordFetchSuccess(source.id, cond.etag, cond.lastModified);
      return { sourceId: source.id, ok: true, notModified: true, seen: 0, inserted: 0, insertedIds: [] };
    }
    const page = cond.page;
    if (page.status >= 400) throw new Error(`feed http ${page.status}`);

    const feed = await parseFeedTolerant(page.body);
    const items = feed.items ?? [];
    let inserted = 0;
    const insertedIds: string[] = [];
    for (const item of items.slice(0, 100)) {
      const link = item.link?.trim();
      if (!link || !/^https?:\/\//i.test(link)) continue;
      const guid = item.guid?.trim() || link;
      const title = item.title?.slice(0, 500) ?? null;
      const published =
        parseLooseDate(item.isoDate) ??
        parseLooseDate(item.pubDate) ??
        new Date();
      const res = await db
        .insert(rawItems)
        .values({
          id: opaqueId("rit"),
          sourceId: source.id,
          discoveredVia: "rss",
          url: canonicalizeUrl(link),
          urlHash: sha256Hex(canonicalizeUrl(link)),
          guidHash: sha256Hex(canonicalizeUrl(guid)),
          title,
          publishedAt: published,
          rawPayload: {
            creator: (item as unknown as Record<string, unknown>)["creator"] ?? null,
            categories: item.categories ?? [],
          },
        })
        .onConflictDoNothing()
        .returning({ id: rawItems.id });
      if (res.length) {
        inserted++;
        insertedIds.push(res[0]!.id);
      }
    }
    await registry.recordFetchSuccess(source.id, cond.etag, cond.lastModified);
    return { sourceId: source.id, ok: true, seen: items.length, inserted, insertedIds };
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ sourceId: source.id, err: msg }, "rss poll failed");
    await registry.recordFetchFailure(source.id, msg);
    return { sourceId: source.id, ok: false, seen: 0, inserted: 0, insertedIds: [], error: msg };
  }
}

/**
 * Publisher domains we already trust (used by the GDELT quality gate).
 * Deliberately EXCLUDES publisher domains seen on historical articles:
 * that union let junk discovery domains (syndication networks, classifieds,
 * content farms) self-perpetuate as "trusted" forever. Trust now comes only
 * from curated feed hosts and explicit allowlist entries.
 */
export async function knownPublisherDomains(db: Db): Promise<Set<string>> {
  const allowRows = await db
    .select({ domain: domainLists.domain })
    .from(domainLists)
    .where(eq(domainLists.list, "allow"));
  const feedRows = await db.execute<{ d: string }>(sql`
    SELECT DISTINCT regexp_replace(feed_url, '^https?://([^/]+).*', '\\1') AS d FROM sources WHERE active = true
  `);
  const domains = [
    ...allowRows.map((r) => hostToDomain(r.domain)),
    ...feedRows.map((r) => hostToDomain(r.d)),
  ].filter(Boolean);
  return new Set(domains);
}
