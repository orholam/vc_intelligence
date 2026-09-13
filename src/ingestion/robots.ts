import { hostToDomain } from "../lib/hash.js";
import { getConfig } from "../config.js";
import robotsParserImport from "robots-parser";

interface RobotsRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
const robotsParser = robotsParserImport as unknown as (
  url: string,
  contents: string,
) => RobotsRules;

/**
 * robots.txt handling for FR-4/NFR-7: fetched once per domain, cached with a
 * TTL; unknown/fetch-failure defaults to ALLOW except explicit disallow-all.
 */
interface RobotsEntry {
  parser: ReturnType<typeof robotsParser>;
  expiresAt: number;
}

const cache = new Map<string, RobotsEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

export async function isAllowed(url: string): Promise<boolean> {
  const cfg = getConfig();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const origin = u.origin;
  const key = hostToDomain(u.hostname) || u.hostname;

  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || entry.expiresAt < now) {
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": cfg.FETCH_USER_AGENT },
        signal: AbortSignal.timeout(Math.min(cfg.FETCH_TIMEOUT_MS, 8000)),
      });
      if (!res.ok && res.status !== 404) throw new Error(`robots http ${res.status}`);
      const body = res.ok ? await res.text() : "";
      entry = {
        parser: robotsParser(`${origin}/robots.txt`, body),
        // If we failed to read robots.txt, retry sooner rather than hammering.
        expiresAt: now + (body ? TTL_MS : NEGATIVE_TTL_MS),
      };
    } catch {
      // Cannot determine policy: be conservative but not sticky.
      cache.set(key, { parser: robotsParser("", ""), expiresAt: now + NEGATIVE_TTL_MS });
      return true;
    }
    cache.set(key, entry);
  }
  return entry.parser.isAllowed(url, cfg.FETCH_USER_AGENT.split(" ")[0]) !== false;
}
