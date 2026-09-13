import { z } from "zod";

const Env = z.object({
  XM_DB_PATH: z.string().default("./data/xmonitor.sqlite"),
  /** Raw cookie header from a logged-in x.com session: "auth_token=...; ct0=...; ..." */
  XM_COOKIES: z.string().optional(),
  /** File containing either a raw cookie header or a Cookie-Editor JSON array. */
  XM_COOKIES_FILE: z.string().optional(),
  /** Refreshed cookies are persisted here and preferred on subsequent runs. */
  XM_SESSION_FILE: z.string().default("./data/x-session.json"),
  XM_POLL_MINUTES: z.coerce.number().int().min(3).max(240).default(10),
  XM_MAX_TWEETS_PER_POLL: z.coerce.number().int().min(10).max(200).default(60),
  /** Noise gate applied at digest time (not ingestion). */
  XM_MIN_VIEWS: z.coerce.number().int().min(0).default(200),
  /** Digest-time popularity window (likes); 0 disables a bound. */
  XM_MIN_LIKES: z.coerce.number().int().min(0).default(0),
  XM_MAX_LIKES: z.coerce.number().int().min(0).default(0),
  /** Server-side popularity floor baked into generated queries (X `min_faves:` op). */
  XM_QUERY_MIN_FAVES: z.coerce.number().int().min(0).default(0),
  XM_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.45),
  XM_DIGEST_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
  /** Extra full X search queries, comma-separated. */
  XM_QUERIES: z.string().optional(),
  // ---- strict rate limits (persisted across invocations) ----
  XM_MAX_SEARCHES_PER_HOUR: z.coerce.number().int().min(1).max(200).default(10),
  XM_MAX_SEARCHES_PER_DAY: z.coerce.number().int().min(1).max(1000).default(40),
  XM_QUERY_GAP_SECONDS: z.coerce.number().int().min(5).max(3600).default(25),
  /** Disable x-client-transaction-id/xpff header generation (some networks serve
   *  bot-wall HTML to Node's homepage fetch, breaking chunk resolution). */
  XM_DISABLE_TXHEADERS: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export interface XMonitorConfig {
  dbPath: string;
  cookies?: string;
  cookiesFile?: string;
  sessionFile: string;
  pollMinutes: number;
  maxTweetsPerPoll: number;
  minViews: number;
  minLikes: number;
  maxLikes: number;
  queryMinFaves: number;
  minScore: number;
  extraQueries?: string;
  digestHours: number;
  maxSearchesPerHour: number;
  maxSearchesPerDay: number;
  queryGapSeconds: number;
  disableTxHeaders: boolean;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): XMonitorConfig {
  const parsed = Env.parse(env);
  return {
    dbPath: parsed.XM_DB_PATH,
    cookies: parsed.XM_COOKIES,
    cookiesFile: parsed.XM_COOKIES_FILE,
    sessionFile: parsed.XM_SESSION_FILE,
    pollMinutes: parsed.XM_POLL_MINUTES,
    maxTweetsPerPoll: parsed.XM_MAX_TWEETS_PER_POLL,
    minViews: parsed.XM_MIN_VIEWS,
    minLikes: parsed.XM_MIN_LIKES,
    maxLikes: parsed.XM_MAX_LIKES,
    queryMinFaves: parsed.XM_QUERY_MIN_FAVES,
    minScore: parsed.XM_MIN_SCORE,
    extraQueries: parsed.XM_QUERIES,
    digestHours: parsed.XM_DIGEST_HOURS,
    maxSearchesPerHour: parsed.XM_MAX_SEARCHES_PER_HOUR,
    maxSearchesPerDay: parsed.XM_MAX_SEARCHES_PER_DAY,
    queryGapSeconds: parsed.XM_QUERY_GAP_SECONDS,
    disableTxHeaders: parsed.XM_DISABLE_TXHEADERS === "1" || parsed.XM_DISABLE_TXHEADERS === "true",
    logLevel: parsed.LOG_LEVEL,
  };
}
