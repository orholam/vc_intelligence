import { rawItems } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { canonicalizeUrl, sha256Hex } from "../lib/hash.js";
import { opaqueId } from "../lib/ulid.js";
import { recordTrace } from "./traces.js";

/** RFC 2606 reserved TLD — never fetched from the public internet. */
export const GHOST_HOST = "ghost.invalid";

export function isGhostUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === GHOST_HOST;
  } catch {
    return false;
  }
}

export function ghostArticleHtml(opts: { title: string; publishedAt: Date }): string {
  const iso = opts.publishedAt.toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(opts.title)}</title>
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="article:published_time" content="${iso}" />
</head>
<body>
  <article>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>Ghost Probe Labs announced today that it has raised $12 million in Series A funding
    to expand its pipeline-observability platform for venture-backed software companies.
    The round was led by a synthetic debug investor and is not a real financing event.</p>
    <p>The company said it will use the capital to ship live tracing across fetch,
    rules filtering, wire dedupe, the waiting room, the harness batch, and
    webhook fan-out so operators can watch a single news item's packaged
    journey land bucket by bucket.</p>
    <p>Ghost Probe Labs is a reserved debug subject for the Copyr intelligence service.
    Articles hosted on ${GHOST_HOST} are injected by the ops console and never crawled
    from the public web. This paragraph exists so extraction and the 500-character
    prefilter body floor both succeed on a deterministic fixture.</p>
  </article>
</body>
</html>`;
}

export interface GhostInjectResult {
  rawItemId: string;
  url: string;
  title: string;
}

/**
 * Insert a unique synthetic raw item and enqueue fetch-article so it traverses
 * the real pipeline (fetch is short-circuited for ghost.invalid URLs).
 */
export async function injectGhostNews(
  db: Db,
  enqueue: (queue: string, data: object) => Promise<unknown>,
): Promise<GhostInjectResult> {
  const rawItemId = opaqueId("rit");
  const token = rawItemId.slice(-8);
  const title = `Ghost Probe Labs raises $12 million Series A (${token})`;
  const url = canonicalizeUrl(`https://${GHOST_HOST}/probe/${rawItemId}`);
  const publishedAt = new Date();

  await db.insert(rawItems).values({
    id: rawItemId,
    sourceId: null,
    discoveredVia: "manual",
    url,
    urlHash: sha256Hex(url),
    guidHash: sha256Hex(url),
    title,
    publishedAt,
    rawPayload: { ghost: true, probe: token },
  });

  void recordTrace(db, {
    node: "raw",
    refId: rawItemId,
    kind: "raw",
    label: title,
    detail: "ghost · debug inject",
  });

  await enqueue("fetch-article", { rawItemId });
  return { rawItemId, url, title };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
