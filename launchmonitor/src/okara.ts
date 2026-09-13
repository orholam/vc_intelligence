import type { OkaraLaunch } from "./store.js";

export interface FetchOptions {
  baseUrl: string;
  maxPages: number;
  gapMs: number;
  onPage: (batch: OkaraLaunch[], offset: number) => void;
}

export interface FetchResult {
  fetched: number;
  pages: number;
  blocked: boolean;
  rateLimited: boolean;
  error?: string;
}

const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.5);

/**
 * Page through the Okara Launch Library API.
 *
 * NOTE: okara.ai bot-protects this endpoint (TLS fingerprinting + headless
 * detection). Plain fetches from servers/CI typically receive
 * `403 {"error":"Automated access denied."}` — in that case capture the JSON
 * with a real browser (see README) and use `import <file>` instead. Repeated
 * automated attempts risk IP blacklisting, so this client stops on the first
 * block or rate-limit instead of retrying aggressively.
 */
export async function fetchLaunches(opts: FetchOptions): Promise<FetchResult> {
  const out: FetchResult = { fetched: 0, pages: 0, blocked: false, rateLimited: false };
  const pageSize = 12;
  let offset = 0;

  for (; out.pages < opts.maxPages; offset += pageSize) {
    let res: Response;
    try {
      res = await fetch(
        `${opts.baseUrl}/api/launch-library?q=&categories=&sort=newest&offset=${offset}`,
        { headers: { Accept: "application/json" } },
      );
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      return out;
    }

    if (res.status === 403) {
      out.blocked = true;
      return out;
    }
    if (res.status === 429) {
      out.rateLimited = true;
      return out;
    }
    if (!res.ok) {
      out.error = `HTTP ${res.status}`;
      return out;
    }

    const data = (await res.json()) as { launches?: OkaraLaunch[] };
    const batch = data.launches ?? [];
    if (batch.length === 0) return out;

    opts.onPage(batch, offset);
    out.fetched += batch.length;
    out.pages++;

    if (batch.length < pageSize) return out;
    await new Promise((r) => setTimeout(r, jitter(opts.gapMs)));
  }
  return out;
}
