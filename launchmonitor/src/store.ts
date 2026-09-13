import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "./lib.js";

/** One launch as captured from the Okara Launch Library. */
export interface OkaraLaunch {
  slug: string;
  company_name: string | null;
  tagline: string | null;
  launched_at: string | null; // ISO date
  launch_url: string | null;
  company_website: string | null;
  category?: string | { name?: string } | null;
  subcategory?: string | null;
  handle?: string | null;
  views?: number | null;
  likes?: number | null;
  reposts?: number | null;
  comments?: number | null;
  saves?: number | null;
  author_followers?: number | null;
  is_yc_launch?: boolean | null;
  [k: string]: JsonValue | undefined;
}

export interface ImportStats {
  inserted: number;
  updated: number;
  total: number;
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS launches (
  slug TEXT PRIMARY KEY,
  company_name TEXT,
  tagline TEXT,
  launched_at TEXT,
  launch_url TEXT,
  company_website TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launches_launched ON launches(launched_at DESC);

CREATE TABLE IF NOT EXISTS syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  entities_created INTEGER NOT NULL,
  entities_matched INTEGER NOT NULL,
  articles_inserted INTEGER NOT NULL,
  articles_existing INTEGER NOT NULL,
  links_created INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_syncs_ran ON syncs(ran_at DESC);
`;

/** SQLite cache of Okara launches + sync audit log (mirrors xmonitor's store). */
export class LaunchStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(MIGRATION);
  }

  /** Insert or refresh one launch. Returns "inserted" or "updated". */
  upsertLaunch(l: OkaraLaunch): "inserted" | "updated" {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .prepare("SELECT last_seen_at FROM launches WHERE slug = ?")
      .get(l.slug);
    if (existing) {
      this.db
        .prepare(
          `UPDATE launches SET company_name = ?, tagline = ?, launched_at = ?,
           launch_url = ?, company_website = ?, payload = ?, last_seen_at = ?
           WHERE slug = ?`,
        )
        .run(
          l.company_name ?? null,
          l.tagline ?? null,
          l.launched_at ?? null,
          l.launch_url ?? null,
          l.company_website ?? null,
          JSON.stringify(l),
          now,
          l.slug,
        );
      return "updated";
    }
    this.db
      .prepare(
        `INSERT INTO launches
         (slug, company_name, tagline, launched_at, launch_url, company_website, payload, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.slug,
        l.company_name ?? null,
        l.tagline ?? null,
        l.launched_at ?? null,
        l.launch_url ?? null,
        l.company_website ?? null,
        JSON.stringify(l),
        now,
        now,
      );
    return "inserted";
  }

  allLaunches(): OkaraLaunch[] {
    const rows = this.db.prepare("SELECT payload FROM launches").all() as Array<{
      payload: string;
    }>;
    return rows.map((r) => JSON.parse(r.payload) as OkaraLaunch);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM launches").get() as { n: number };
    return row.n;
  }

  recordSync(s: Omit<ImportStats, "inserted" | "updated"> & {
    entitiesCreated: number;
    entitiesMatched: number;
    articlesInserted: number;
    articlesExisting: number;
    linksCreated: number;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO syncs
         (ran_at, source_count, entities_created, entities_matched,
          articles_inserted, articles_existing, links_created, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.floor(Date.now() / 1000),
        s.total,
        s.entitiesCreated,
        s.entitiesMatched,
        s.articlesInserted,
        s.articlesExisting,
        s.linksCreated,
        s.error ?? null,
      );
  }

  recentSyncs(limit = 5): unknown[] {
    return this.db
      .prepare(
        `SELECT * FROM syncs ORDER BY ran_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      )
      .all();
  }

  close(): void {
    this.db.close();
  }
}
