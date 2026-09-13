import { sql } from "drizzle-orm";
import { sha256Hex } from "../lib/hash.js";
import type { Db } from "../db/index.js";
import { articleEntities, articles, entities } from "../db/schema.js";
import { politeFetch } from "./fetcher.js";
import { opaqueId } from "../lib/ulid.js";
import { recordTrace } from "../ops/traces.js";

/**
 * SEC Form D ingestion (c-plan "left edge of the magic zone").
 *
 * Every priced private placement in the US must file a Form D within 15 days
 * of first sale. EDGAR's daily index files expose these as structured records:
 * issuer name, CIK, filing date — before any press exists.
 *
 * Source: https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{n}/form.{YYYYMMDD}.idx
 * (fixed-width; EFTS full-text search does NOT index Form D documents.)
 *
 * For each unique CIK we:
 *  1. upsert an entity keyed on registryIds.sec_cik (no LLM, no homepage fetch)
 *  2. insert a WAITING-ROOM article representing the filing event, with the
 *     primary entity linked deterministically (registry key = authoritative)
 *  3. the accepted funding_round fact is DEFERRED to harness part 3, carried
 *     in platform_meta.formd — card updates happen in the batched LLM job like
 *     every other signal
 *
 * Idempotency: articles.url_hash on the EDGAR accession URL + registry-keyed
 * entity lookup make re-runs no-ops.
 */

const LINE_RE =
  /^D\s{2,}(\S.*?)\s{2,}(\d{1,10})\s+(\d{8})\s+edgar\/data\/\d+\/([\d-]+)\.txt\s*$/;

interface DailyFiling {
  cik: string;
  name: string;
  fileDate: string; // YYYY-MM-DD
  accession: string; // e.g. 0002147036-26-000001
}

export interface FormDResult {
  filingsSeen: number;
  entitiesCreated: number;
  entitiesExisting: number;
  /** Waiting-room filing events queued for the harness batch. */
  waitingQueued: number;
  duplicates: number;
  /** Days whose index file could not be fetched (transient SEC 403/5xx). */
  dayErrors?: string[];
}

/** Title-case an ALL-CAPS EDGAR display name ("ACME ROBOTICS, INC." -> "Acme Robotics, Inc."). */
function titleCaseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bIi\b|\bIii\b|\bLlc\b|\bLllp\b|\bInc\b|\bCorp\b|\bLtd\b|\bPlc\b/g, (m) => m.toUpperCase());
}

function quarterOf(month1to12: number): 1 | 2 | 3 | 4 {
  return Math.floor((month1to12 - 1) / 3 + 1) as 1 | 2 | 3 | 4;
}

async function fetchDailyIndex(day: Date): Promise<DailyFiling[]> {
  const y = day.getUTCFullYear();
  const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(day.getUTCDate()).padStart(2, "0");
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${quarterOf(day.getUTCMonth() + 1)}/form.${y}${mm}${dd}.idx`;
  const res = await politeFetch(url, {
    accept: "text/plain,*/*",
    skipRobots: true, // documented bulk-feed path; fair-use via UA + rate limit
  });
  if (res.status === 404) return []; // weekend/holiday — no index for that day
  if (res.status !== 200) {
    throw new Error(`EDGAR daily index ${res.status}: ${url}`);
  }

  const out: DailyFiling[] = [];
  for (const line of res.body.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, rawName, cikRaw, yyyymmdd, accession] = m;
    if (!rawName || !cikRaw || !yyyymmdd || !accession) continue;
    out.push({
      name: rawName.trim(),
      cik: cikRaw.padStart(10, "0"), // index pads CIK with spaces, not zeros
      fileDate: `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`,
      accession,
    });
  }
  return out;
}

async function fetchFormDWindow(start: Date, end: Date): Promise<{ filings: DailyFiling[]; dayErrors: string[] }> {
  // SEC indexes are T+1; include today's attempt but tolerate 404.
  const out: DailyFiling[] = [];
  const dayErrors: string[] = [];
  const seen = new Set<string>();
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 3600_000) {
    const day = new Date(t);
    try {
      for (const f of await fetchDailyIndex(day)) {
        if (seen.has(f.accession)) continue;
        seen.add(f.accession);
        out.push(f);
      }
    } catch (e) {
      // Per-day isolation: SEC occasionally 403s individual index files;
      // one bad day must not sink the window (NFR-3).
      dayErrors.push(`${day.toISOString().slice(0, 10)}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return { filings: out, dayErrors };
}

export async function ingestFormDFilings(
  db: Db,
  opts: { days?: number } = {},
): Promise<FormDResult> {
  const days = opts.days ?? 7;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600_000);

  const { filings: hits, dayErrors } = await fetchFormDWindow(start, end);

  // Deduplicate by CIK within the window (multiple filings per issuer possible).
  const byCik = new Map<string, { accession: string; name: string; fileDate: string | null }>();
  for (const f of hits) {
    if (!byCik.has(f.cik)) {
      byCik.set(f.cik, {
        accession: f.accession,
        name: f.name,
        fileDate: f.fileDate,
      });
    }
  }

  const result: FormDResult = {
    filingsSeen: hits.length,
    entitiesCreated: 0,
    entitiesExisting: 0,
    waitingQueued: 0,
    duplicates: 0,
    ...(dayErrors.length ? { dayErrors } : {}),
  };

  for (const [cik, info] of byCik) {
    if (!info.name) continue;

    // 1. Registry-keyed entity upsert (strongest join key where domains are thin).
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL AND registry_ids->>'sec_cik' = ${cik}
      LIMIT 1
    `);
    let entityId: string;
    if (existing[0]) {
      entityId = String(existing[0].id);
      result.entitiesExisting++;
    } else {
      entityId = opaqueId("ent");
      await db.insert(entities).values({
        id: entityId,
        canonicalName: titleCaseName(info.name),
        legalName: titleCaseName(info.name),
        website: null,
        aliases: [],
        type: "private",
        status: "operating",
        country: "US",
        industryTags: [],
        tickers: [],
        registryIds: { sec_cik: cik },
        confidence: 0.6,
        isMonitored: true, // GDELT watchlist picks up future coverage automatically
        reviewStatus: "auto_created",
        createdBy: "formd",
        sourceRefs: [`edgar:cik:${cik}`],
      });
      result.entitiesCreated++;
    }

    if (!info.accession) continue;

    // 2. Waiting-room filing event (deterministic; no LLM, no fact yet).
    const displayName = titleCaseName(info.name);
    const accessionUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${info.accession}-index.htm`;
    const urlHash = sha256Hex(accessionUrl);
    const dup = await db.execute<{ id: string }>(sql`
      SELECT id FROM articles WHERE url_hash = ${urlHash} LIMIT 1
    `);
    if (dup[0]) {
      result.duplicates++;
      continue;
    }
    const articleId = opaqueId("art");
    const publishedAt = info.fileDate ? new Date(`${info.fileDate}T00:00:00Z`) : new Date();
    const inserted = await db
      .insert(articles)
      .values({
        id: articleId,
        url: accessionUrl,
        urlHash,
        publisherDomain: "sec.gov",
        title: `${displayName} files Form D notice of exempt offering`,
        byline: "SEC EDGAR",
        publishedAt,
        language: "en",
        excerptText: `Form D filed by ${displayName} (CIK ${cik}), accession ${info.accession}.`,
        outlinkDomains: [],
        noiseStage: "waiting",
        primaryTag: "funding.registry",
        secondaryTags: [],
        allTags: ["funding.registry", "funding"],
        platformMeta: {
          formd: { accession: info.accession, fileDate: info.fileDate ?? null, cik },
        },
      })
      .onConflictDoNothing({ target: articles.urlHash })
      .returning({ id: articles.id });
    if (!inserted.length) {
      result.duplicates++;
      continue;
    }
    result.waitingQueued++;

    void recordTrace(db, {
      node: "raw",
      refId: articleId,
      kind: "article",
      label: `${displayName} Form D`,
      detail: `Form D · EDGAR accession ${info.accession}`,
    });

    await db.insert(articleEntities).values({
      articleId,
      entityId,
      role: "primary",
      confidence: 1,
      evidence: { llm: "not_needed", notes: [`registry:sec_cik:${cik}`] },
    });
  }

  return result;
}
