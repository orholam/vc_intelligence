import { getConfig } from "../config.js";
import { hostToDomain } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { isAllowed } from "./robots.js";

/**
 * Polite fetcher (FR-4): robots.txt-aware, identifiable UA, per-domain
 * min-interval rate limiting (default 1 req / 2 s), hard timeout (default 10 s).
 */
export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  headers: Headers;
  body: string;
}

const lastHitByDomain = new Map<string, number>();

async function respectDomainInterval(domain: string): Promise<void> {
  const cfg = getConfig();
  const minInterval = cfg.FETCH_DOMAIN_MIN_INTERVAL_MS;
  for (;;) {
    const now = Date.now();
    const last = lastHitByDomain.get(domain) ?? 0;
    const waitUntil = last + minInterval;
    if (now >= waitUntil) {
      lastHitByDomain.set(domain, now);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(waitUntil - now, 1000)));
  }
}

export class BlockedByRobotsError extends Error {
  constructor(url: string) {
    super(`blocked by robots.txt: ${url}`);
  }
}

export async function politeFetch(
  url: string,
  opts: { accept?: string; timeoutMs?: number; skipRobots?: boolean; skipRateLimit?: boolean; headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<FetchedPage> {
  const cfg = getConfig();
  if (!opts.skipRobots && !(await isAllowed(url))) {
    throw new BlockedByRobotsError(url);
  }
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (!opts.skipRateLimit) await respectDomainInterval(hostToDomain(u.hostname));

  const res = await fetch(url, {
    method: opts.method,
    body: opts.body,
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? cfg.FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": cfg.FETCH_USER_AGENT,
      accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en",
      ...opts.headers,
    },
  });
  // Cap body size to 3 MB to protect the small VPS.
  const buf = await res.arrayBuffer();
  const capped = buf.byteLength > 3_000_000 ? buf.slice(0, 3_000_000) : buf;
  return {
    url,
    finalUrl: res.url || url,
    status: res.status,
    headers: res.headers,
    body: new TextDecoder("utf-8", { fatal: false }).decode(capped),
  };
}

export interface ConditionalGetResult {
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
  page?: FetchedPage;
}

/** Conditional GET with ETag/If-Modified-Since support (FR-2). */
export async function conditionalGet(
  url: string,
  cond: { etag?: string | null; lastModified?: string | null },
  opts: { accept?: string } = {},
): Promise<ConditionalGetResult> {
  const cfg = getConfig();
  const headers: Record<string, string> = {};
  if (cond.etag) headers["if-none-match"] = cond.etag;
  if (cond.lastModified) headers["if-modified-since"] = cond.lastModified;

  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid feed url: ${url}`);
  }
  await respectDomainInterval(hostToDomain(u.hostname));
  const res = await fetch(url, {
    signal: AbortSignal.timeout(cfg.FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": cfg.FETCH_USER_AGENT,
      accept: opts.accept ?? "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.8, */*;q=0.5",
      ...headers,
    },
  });
  if (res.status === 304) {
    return { notModified: true, etag: cond.etag ?? null, lastModified: cond.lastModified ?? null };
  }
  const buf = await res.arrayBuffer();
  const capped = buf.byteLength > 2_000_000 ? buf.slice(0, 2_000_000) : buf;
  return {
    notModified: false,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    page: {
      url,
      finalUrl: res.url || url,
      status: res.status,
      headers: res.headers,
      body: new TextDecoder("utf-8", { fatal: false }).decode(capped),
    },
  };
}

/** Fetch with a single retry on transient failures + robots/ratelimit policy. */
export async function fetchWithRetry(url: string, opts?: Parameters<typeof politeFetch>[1]) {
  try {
    return await politeFetch(url, opts);
  } catch (e) {
    if (e instanceof BlockedByRobotsError) throw e;
    logger.warn({ url, err: (e as Error).message }, "fetch failed; retrying once");
    await new Promise((r) => setTimeout(r, 1500));
    return politeFetch(url, opts);
  }
}
