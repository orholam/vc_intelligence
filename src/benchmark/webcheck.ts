import { z } from "zod";

/**
 * FR-23 independent validation: stories are checked against the open web via a
 * pluggable search adapter. Configure SERPER_API_KEY (or implement
 * WebSearchAdapter) for full validation; without it, cross-provider
 * corroboration (internal index ∩ GDELT) substitutes and is flagged in the
 * report — matching akta's rule that only validated stories count toward
 * recall.
 */
export interface WebSearchAdapter {
  readonly name: string;
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

const SerperResponse = z.object({
  organic: z
    .array(z.object({ title: z.string(), link: z.string(), snippet: z.string().optional() }))
    .default([]),
});

export class SerperAdapter implements WebSearchAdapter {
  readonly name = "serper";
  constructor(private apiKey: string) {}

  async search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`serper ${res.status}`);
    const parsed = SerperResponse.parse(await res.json());
    return parsed.organic.map((o) => ({ title: o.title, url: o.link, snippet: o.snippet ?? "" }));
  }
}

export class NoopAdapter implements WebSearchAdapter {
  readonly name = "noop";
  async search(): Promise<Array<{ title: string; url: string; snippet: string }>> {
    return [];
  }
}

/**
 * Keenable (free, keyless MCP web index) as the independent validation
 * provider. The OUTPUT-RUBRIC allows cross-provider corroboration to
 * substitute for a paid search key; Keenable is that second provider — it is
 * independent of both our internal index and GDELT.
 */
export class KeenableAdapter implements WebSearchAdapter {
  readonly name = "keenable";
  async search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const { keenableSearch } = await import("../ingestion/keenable.js");
    try {
      const hits = await keenableSearch(query, { maxResults: 5 });
      return hits.map((h) => ({ title: h.title ?? "", url: h.url, snippet: h.snippet ?? "" }));
    } catch {
      // rate-limited or transient: no validation evidence this round
      return [];
    }
  }
}

export function makeWebSearchAdapter(): WebSearchAdapter {
  const key = process.env.SERPER_API_KEY;
  if (key) return new SerperAdapter(key);
  if (process.env.BENCHMARK_WEBCHECK === "keenable") return new KeenableAdapter();
  return new NoopAdapter();
}
