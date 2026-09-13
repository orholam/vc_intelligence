import { politeFetch } from "./fetcher.js";
import { logger } from "../lib/logger.js";

/**
 * Google News RSS wrapper resolution. Google News search feeds hand out
 * `news.google.com/rss/articles/<id>` redirect wrappers, not publisher URLs:
 *
 *  - Legacy `<id>` values are base64url protobufs embedding the target URL
 *    (decodable offline).
 *  - Post-2024 `AU_yqL…` ids are opaque; resolution needs the per-article
 *    signature/timestamp embedded in the wrapper page plus one POST to
 *    Google's internal batchexecute endpoint (Fbv4je/garturlreq rpc).
 *
 * The wrapper itself is a redirect hop, not content: robots.txt is skipped for
 * it, and the normal robots/rate-limit policy applies to the resolved
 * publisher URL downstream.
 */

const BATCH_EXECUTE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

export function isGoogleNewsWrapper(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "news.google.com" && /^\/(rss\/)?articles\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** Extract the article id from a wrapper URL (`?oc=5` and friends stripped). */
export function googleNewsArticleId(url: string): string | null {
  const m = url.match(/\/(?:rss\/)?articles\/([^/?#]+)/);
  return m?.[1] ?? null;
}

/**
 * Legacy offline decode: base64url-decode the id, walk the protobuf for the
 * first length-delimited string field, return it when it is an http(s) URL.
 */
export function decodeLegacyArticleId(id: string): string | null {
  let b64 = id.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  let i = 0;
  while (i < bytes.length) {
    const wireType = bytes[i]! & 7;
    if (wireType === 2) {
      // length-delimited field: varint length, then payload
      let len = 0;
      let shift = 0;
      let j = i + 1;
      for (;;) {
        if (j >= bytes.length) return null;
        const b = bytes[j]!;
        len |= (b & 0x7f) << shift;
        shift += 7;
        j += 1;
        if (!(b & 0x80)) break;
      }
      if (j + len > bytes.length) return null;
      const s = bytes.subarray(j, j + len).toString("utf8");
      if (/^https?:\/\//i.test(s)) return s;
      i = j + len; // non-URL string field — keep scanning
      continue;
    }
    if (wireType === 0) {
      let j = i + 1;
      while (j < bytes.length && bytes[j]! & 0x80) j += 1;
      i = j + 1;
      continue;
    }
    return null;
  }
  return null;
}

export interface WrapperSignature {
  signature: string;
  timestamp: number;
}

/** Parse data-n-a-sg / data-n-a-ts out of the wrapper landing page HTML. */
export function parseWrapperSignature(html: string): WrapperSignature | null {
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts || !/^\d+$/.test(ts)) return null;
  return { signature: sg, timestamp: Number(ts) };
}

const REQUEST_SHELL = [
  ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
  "X",
  "X",
  1,
  [1, 1, 1],
  1,
  1,
  null,
  0,
  0,
  null,
  0,
];

/** Build the urlencoded f.req body batchexecute expects (Fbv4je garturlreq). */
export function buildBatchExecuteBody(articleId: string, sig: WrapperSignature): string {
  const rpcInner = JSON.stringify([
    "garturlreq",
    REQUEST_SHELL,
    articleId,
    sig.timestamp,
    sig.signature,
  ]);
  const fReq = JSON.stringify([[["Fbv4je", rpcInner, null, "generic"]]]);
  return `f.req=${encodeURIComponent(fReq)}`;
}

/** Extract the garturlres target URL from a batchexecute response body. */
export function parseBatchExecuteResponse(body: string): string | null {
  let text = body;
  if (text.startsWith(")]}'")) text = text.slice(text.indexOf("\n") + 1);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("[")) continue;
    let envelopes: unknown;
    try {
      envelopes = JSON.parse(t);
    } catch {
      continue;
    }
    if (!Array.isArray(envelopes)) continue;
    for (const env of envelopes) {
      if (
        Array.isArray(env) &&
        env[0] === "wrb.fr" &&
        env[1] === "Fbv4je" &&
        typeof env[2] === "string"
      ) {
        try {
          const payload = JSON.parse(env[2]);
          if (Array.isArray(payload) && payload[0] === "garturlres") {
            const url = payload[1];
            if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
          }
        } catch {
          /* malformed inner payload */
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a Google News wrapper to the publisher URL. Two network hops
 * (wrapper page + batchexecute), both rate-limited via politeFetch's domain
 * interval. Returns null when Google refuses (consent wall, layout change).
 */
export async function resolveGoogleNewsUrl(wrapperUrl: string): Promise<string | null> {
  const articleId = googleNewsArticleId(wrapperUrl);
  if (!articleId) return null;

  const legacy = decodeLegacyArticleId(articleId);
  if (legacy) return legacy;

  const page = await politeFetch(wrapperUrl, { skipRobots: true });
  if (page.status >= 400) return null;
  const sig = parseWrapperSignature(page.body);
  if (!sig) {
    logger.debug({ url: wrapperUrl }, "google news wrapper has no signature");
    return null;
  }

  const res = await politeFetch(BATCH_EXECUTE_URL, {
    skipRobots: true,
    method: "POST",
    body: buildBatchExecuteBody(articleId, sig),
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      referer: "https://news.google.com/",
    },
    accept: "*/*",
  });
  if (res.status >= 400) return null;
  return parseBatchExecuteResponse(res.body);
}
