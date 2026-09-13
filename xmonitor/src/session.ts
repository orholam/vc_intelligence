import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ErrorRateLimitStrategy, Scraper } from "@the-convocation/twitter-scraper";
import type { XMonitorConfig } from "./config.js";
import type { Logger } from "./log.js";

export class SessionError extends Error {}

/**
 * Cookie candidates, in precedence order:
 * 1. persisted session file (refreshed cookies from previous runs)
 * 2. XM_COOKIES_FILE (raw header string or Cookie-Editor JSON export)
 * 3. XM_COOKIES env var (raw header string)
 *
 * Cookies are carried around as strings ("k=v; Path=/; Domain=.x.com") —
 * the scraper parses them itself.
 */
export function loadCookieCandidates(cfg: XMonitorConfig): string[][] {
  const out: string[][] = [];

  if (existsSync(cfg.sessionFile)) {
    try {
      const cookies = cookiesFromJsonFile(JSON.parse(readFileSync(cfg.sessionFile, "utf8")) as unknown);
      if (cookies.length) out.push(cookies);
    } catch {
      // corrupt file — fall through
    }
  }

  if (cfg.cookiesFile && existsSync(cfg.cookiesFile)) {
    try {
      const content = readFileSync(cfg.cookiesFile, "utf8").trim();
      const cookies = content.startsWith("[") || content.startsWith("{")
        ? cookiesFromJsonFile(JSON.parse(content))
        : parseCookieHeader(content);
      if (cookies.length) out.push(cookies);
    } catch {
      // fall through
    }
  }

  if (cfg.cookies) {
    const cookies = parseCookieHeader(cfg.cookies);
    if (cookies.length) out.push(cookies);
  }

  return out;
}

/** Parse a raw browser cookie header into per-cookie strings:
 * "auth_token=...; ct0=...; lang=en" -> ["auth_token=...", "ct0=...", "lang=en"]
 */
export function parseCookieHeader(header: string): string[] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("=") && !part.endsWith("="));
}

/** Accepts Cookie-Editor style JSON objects/arrays or plain cookie strings. */
export function cookiesFromJsonFile(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      out.push(item);
    } else if (typeof item === "object" && item !== null && "name" in item && "value" in item) {
      const rec = item as Record<string, unknown>;
      const attrs = [`Path=${typeof rec.path === "string" && rec.path ? rec.path : "/"}`];
      if (typeof rec.domain === "string" && rec.domain) attrs.push(`Domain=${rec.domain}`);
      attrs.push("Secure");
      out.push(`${String(rec.name)}=${String(rec.value)}; ${attrs.join("; ")}`);
    }
  }
  return out;
}

export async function persistSession(sessionFile: string, scraper: Scraper): Promise<void> {
  const cookies = await scraper.getCookies();
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify(cookies.map((c) => c.toString()), null, 2), "utf8");
}

/**
 * Build an authenticated scraper. Search requires a logged-in session; the
 * experimental headers mirror what X's web client sends.
 */
export async function createScraper(cfg: XMonitorConfig, log: Logger): Promise<Scraper> {
  const candidates = loadCookieCandidates(cfg);
  if (!candidates.length) {
    throw new SessionError(noSessionMessage());
  }

  for (const [i, cookies] of candidates.entries()) {
    const source = i === 0 ? `session file ${cfg.sessionFile}` : i === 1 ? "cookies file" : "XM_COOKIES env";
    const scraper = new Scraper({
      rateLimitStrategy: new ErrorRateLimitStrategy(),
      experimental: {
        xClientTransactionId: !cfg.disableTxHeaders,
        xpff: !cfg.disableTxHeaders,
      },
    });
    try {
      await scraper.setCookies(cookies);
      if (await scraper.isLoggedIn()) {
        log.info({ via: source }, "session valid");
        await persistSession(cfg.sessionFile, scraper); // refresh persisted copy
        return scraper;
      }
      log.warn({ via: source }, "cookies rejected by x.com");
    } catch (err) {
      log.warn({ via: source, err: (err as Error).message }, "session check failed");
    }
  }

  throw new SessionError(
    `All cookie sources failed. Export fresh cookies from a logged-in x.com browser session.\n${noSessionMessage()}`,
  );
}

function noSessionMessage(): string {
  return [
    "",
    "Setup:",
    "  1. Log in to x.com in your browser",
    '  2. DevTools -> Application -> Cookies -> copy all cookies as "name=value; name2=value2"',
    "  3. Put them in XM_COOKIES (env/.env) or XM_COOKIES_FILE",
    "  Use a dedicated aged account, never your personal one.",
  ].join("\n");
}
