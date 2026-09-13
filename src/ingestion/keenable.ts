
/**
 * Keenable search client over its keyless public MCP endpoint
 * (https://api.keenable.ai/mcp). Independent web index built for agents;
 * optional paid key lifts rate limits via KEENABLE_API_KEY (sent as
 * X-API-Key on the HTTP API — unused on the MCP surface).
 */

const MCP_URL = process.env.KEENABLE_MCP_URL ?? "https://api.keenable.ai/mcp";

export interface SearchHit {
  title: string;
  url: string;
  publishedAt?: string;
  snippet?: string;
}

interface McpResponse {
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code?: number; message?: string };
}

async function mcpCall(id: number, method: string, params?: unknown): Promise<McpResponse["result"]> {
  let res: Response;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(process.env.KEENABLE_API_KEY ? { "x-api-key": process.env.KEENABLE_API_KEY } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`keenable mcp unreachable: ${(e as Error).message}`);
  }
  if (res.status === 429) throw new KeenableRateLimited();
  if (!res.ok) throw new Error(`keenable mcp http ${res.status}`);

  // Streamable-HTTP transport may answer JSON or an SSE stream with data: lines.
  const raw = await res.text();
  const jsonLine = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .pop() ?? raw;
  const parsed = JSON.parse(jsonLine.trim()) as McpResponse;
  if (parsed.error) throw new Error(`keenable mcp error: ${parsed.error.message ?? "unknown"}`);
  return parsed.result;
}

export class KeenableRateLimited extends Error {}

/** Parse the text-block result format: repeated "Title:/URL:/Published:/Snippets:" groups. */
export function parseSearchBlocks(text: string): SearchHit[] {
  const hits: SearchHit[] = [];
  let cur: Partial<SearchHit> & { snippetLines?: string[] } = {};
  let inSnippets = false;
  const flush = () => {
    if (cur.url && cur.title) {
      hits.push({
        title: cur.title,
        url: cur.url,
        ...(cur.publishedAt ? { publishedAt: cur.publishedAt } : {}),
        ...(cur.snippetLines?.length ? { snippet: cur.snippetLines.join(" ").slice(0, 600) } : {}),
      });
    }
    cur = {};
    cur.snippetLines = [];
    inSnippets = false;
  };
  cur.snippetLines = [];
  for (const line of text.split("\n")) {
    if (/^Title:\s*/.test(line)) {
      flush();
      cur.title = line.replace(/^Title:\s*/, "").trim();
    } else if (/^URL:\s*/.test(line)) {
      cur.url = line.replace(/^URL:\s*/, "").trim();
      inSnippets = false;
    } else if (/^Published:\s*/.test(line)) {
      cur.publishedAt = line.replace(/^Published:\s*/, "").trim();
    } else if (/^Acquired:\s*/.test(line)) {
      // ignore
    } else if (/^Snippets?:\s*$/.test(line)) {
      inSnippets = true;
    } else if (inSnippets && line.trim()) {
      cur.snippetLines!.push(line.trim());
    }
  }
  flush();
  return hits.filter((h) => /^https?:\/\//i.test(h.url));
}

export async function keenableSearch(
  query: string,
  opts: { publishedAfter?: string; maxResults?: number } = {},
): Promise<SearchHit[]> {
  const args: Record<string, unknown> = { query, max_results: Math.min(opts.maxResults ?? 6, 20) };
  if (opts.publishedAfter) args.published_after = opts.publishedAfter;

  let attempt = 0;
  for (;;) {
    try {
      const result = await mcpCall(100 + attempt, "tools/call", {
        name: "search_web_pages",
        arguments: args,
      });
      const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
      return parseSearchBlocks(text);
    } catch (e) {
      attempt++;
      if (e instanceof KeenableRateLimited || /http 429|rate/i.test((e as Error).message)) {
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 25_000)); // clear the per-minute window
        continue;
      }
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export interface FetchedMarkdown {
  title: string | null;
  text: string;
}

export async function keenableFetchMarkdown(url: string): Promise<FetchedMarkdown | null> {
  const result = await mcpCall(500, "tools/call", {
    name: "fetch_page_content",
    arguments: { url, max_chars: 40_000 },
  });
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text.trim()) return null;
  const titleMatch = /^(?:Title:\s*(.+)|#\s+(.+))$/m.exec(text);
  return {
    title: titleMatch?.[1]?.trim() ?? titleMatch?.[2]?.trim() ?? null,
    text,
  };
}
