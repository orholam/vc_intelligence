import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NewLaunch {
  tweetId: string;
  authorHandle: string;
  authorName?: string;
  text: string;
  url: string | null;
  linkedDomain: string | null;
  videoCount: number;
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  score: number;
  queryId: string;
  postedAtSec: number | null;
}

export interface LaunchRow extends NewLaunch {
  firstSeenAtSec: number;
}

export interface PollRecord {
  queryId: string;
  fetched: number;
  newLaunches: number;
  error?: string;
}

/** SQLite-backed dedupe store. One row per tweet ever seen. */
export class LaunchStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        tweet_id TEXT PRIMARY KEY,
        author_handle TEXT NOT NULL,
        author_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        url TEXT,
        linked_domain TEXT,
        video_count INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        retweets INTEGER NOT NULL DEFAULT 0,
        replies INTEGER NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0,
        query_id TEXT,
        posted_at INTEGER,
        first_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_launches_posted ON launches(posted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_launches_score ON launches(score DESC);
      CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ran_at INTEGER NOT NULL,
        query_id TEXT NOT NULL,
        fetched INTEGER NOT NULL,
        new_launches INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_polls_ran ON polls(ran_at DESC);
      CREATE TABLE IF NOT EXISTS requests (
        at INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'search'
      );
      CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at DESC);
    `);
  }

  /** @returns true when the tweet was new (not previously stored). */
  insertLaunch(l: NewLaunch): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO launches (
        tweet_id, author_handle, author_name, text, url, linked_domain,
        video_count, views, likes, retweets, replies, score, query_id,
        posted_at, first_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      l.tweetId,
      l.authorHandle,
      l.authorName ?? null,
      l.text,
      l.url ?? null,
      l.linkedDomain ?? null,
      l.videoCount,
      Math.max(0, Math.floor(l.views)),
      Math.max(0, Math.floor(l.likes)),
      Math.max(0, Math.floor(l.retweets)),
      Math.max(0, Math.floor(l.replies)),
      l.score,
      l.queryId,
      l.postedAtSec,
      Math.floor(Date.now() / 1000),
    );
    return Number(res.changes) === 1;
  }

  // ---------------------------------------------------------- observability

  /** Raw audit trail of individual query executions, newest first. */
  recentPolls(limit = 50): Array<{
    id: number;
    ranAtSec: number;
    queryId: string;
    fetched: number;
    newLaunches: number;
    error: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT id, ran_at AS ranAtSec, query_id AS queryId, fetched, new_launches AS newLaunches, error
         FROM polls ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      id: number;
      ranAtSec: number;
      queryId: string;
      fetched: number;
      newLaunches: number;
      error: string | null;
    }>;
  }

  /** Everything captured, no quality gates. */
  listLaunches(limit = 50): LaunchRow[] {
    return this.db
      .prepare(
        `SELECT
           tweet_id AS tweetId,
           author_handle AS authorHandle,
           author_name AS authorName,
           text,
           url,
           linked_domain AS linkedDomain,
           video_count AS videoCount,
           views,
           likes,
           retweets,
           replies,
           score,
           query_id AS queryId,
           posted_at AS postedAtSec,
           first_seen_at AS firstSeenAtSec
         FROM launches
         ORDER BY COALESCE(posted_at, first_seen_at) DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as LaunchRow[];
  }

  recentLaunches(opts: {
    sinceHours: number;
    limit: number;
    minScore?: number;
    minViews?: number;
    minLikes?: number;
    /** 0 = no upper bound. */
    maxLikes?: number;
  }): LaunchRow[] {
    const cutoff = Math.floor(Date.now() / 1000) - opts.sinceHours * 3600;
    const minScore = opts.minScore ?? 0;
    const minViews = opts.minViews ?? 0;
    const minLikes = opts.minLikes ?? 0;
    const maxLikes = opts.maxLikes ?? 0;
    return this.db
      .prepare(
        `SELECT
           tweet_id AS tweetId,
           author_handle AS authorHandle,
           author_name AS authorName,
           text,
           url,
           linked_domain AS linkedDomain,
           video_count AS videoCount,
           views,
           likes,
           retweets,
           replies,
           score,
           query_id AS queryId,
           posted_at AS postedAtSec,
           first_seen_at AS firstSeenAtSec
         FROM launches
         WHERE COALESCE(posted_at, first_seen_at) >= ?
           AND score >= ?
           AND views >= ?
           AND likes >= ?
           AND (? = 0 OR likes <= ?)
         ORDER BY score DESC, COALESCE(posted_at, first_seen_at) DESC
         LIMIT ?`,
      )
      .all(cutoff, minScore, minViews, minLikes, maxLikes, maxLikes, opts.limit) as unknown as LaunchRow[];
  }

  recordPoll(p: PollRecord): void {
    this.db
      .prepare(`INSERT INTO polls (ran_at, query_id, fetched, new_launches, error) VALUES (?, ?, ?, ?, ?)`)
      .run(Math.floor(Date.now() / 1000), p.queryId, p.fetched, p.newLaunches, p.error ?? null);
  }

  // ---------------------------------------------------------- request budget

  /** Record one outbound search request (called BEFORE the request is sent). */
  recordRequest(atSec = Math.floor(Date.now() / 1000)): void {
    this.db.prepare(`INSERT INTO requests (at, kind) VALUES (?, 'search')`).run(atSec);
  }

  searchCountSince(seconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - seconds;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE at >= ?`).get(cutoff) as { n: number };
    return Number(row.n);
  }

  lastRequestAt(): number | null {
    const row = this.db.prepare(`SELECT MAX(at) AS t FROM requests`).get() as { t: number | null };
    return row.t === null ? null : Number(row.t);
  }

  oldestRequestWithin(seconds: number): number | null {
    const cutoff = Math.floor(Date.now() / 1000) - seconds;
    const row = this.db.prepare(`SELECT MIN(at) AS t FROM requests WHERE at >= ?`).get(cutoff) as { t: number | null };
    return row.t === null ? null : Number(row.t);
  }

  budgetUsage(): { lastHour: number; last24h: number } {
    return {
      lastHour: this.searchCountSince(3600),
      last24h: this.searchCountSince(86_400),
    };
  }

  stats(): { totalLaunches: number; last24h: number; lastPollAt: number | null } {
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM launches`).get() as { n: number };
    const day = this.db
      .prepare(`SELECT COUNT(*) AS n FROM launches WHERE first_seen_at >= ?`)
      .get(Math.floor(Date.now() / 1000) - 86_400) as { n: number };
    const lastPoll = this.db.prepare(`SELECT MAX(ran_at) AS t FROM polls`).get() as { t: number | null };
    return { totalLaunches: Number(total.n), last24h: Number(day.n), lastPollAt: lastPoll.t };
  }

  close(): void {
    this.db.close();
  }
}
