import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { hostToDomain } from "../lib/hash.js";
import { guessLanguage } from "../lib/text.js";
import { isUtilityDomain } from "../lib/domains.js";
import { getConfig } from "../config.js";

/**
 * Full-text extraction (FR-4). JS Readability implementation; the Python
 * trafilatura sidecar remains a pre-approved fallback if extraction success
 * drops below 85% on tier-1 sources (see README "Extractor policy").
 */
export interface Extracted {
  title: string;
  byline: string | null;
  publishedAt: Date | null;
  textContent: string;
  charCount: number;
  language: string;
  outlinkDomains: string[];
  ogMetadata: Record<string, string>;
}

function metaContent(dom: JSDOM, selectors: string[]): string | null {
  const doc = dom.window.document;
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const val = el?.getAttribute("content") ?? el?.getAttribute("datetime") ?? el?.textContent;
    if (val && val.trim()) return val.trim();
  }
  return null;
}

const DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="publish-date"]',
  'meta[name="pubdate"]',
  'meta[name="date"]',
  'meta[itemprop="datePublished"]',
  'time[datetime]',
  'time',
];

export function extractFromHtml(html: string, baseUrl: string): Extracted | null {
  const cfg = getConfig();
  void cfg;
  let dom: JSDOM;
  try {
    const virtualConsole = new VirtualConsole(); // suppress css/parser noise
    virtualConsole.on("jsdomError", () => {});
    dom = new JSDOM(html, { url: baseUrl, virtualConsole });
  } catch {
    return null;
  }
  const doc = dom.window.document;

  const selfHost = hostToDomain(new URL(baseUrl).hostname);

  // Run Readability on a CLONE so the original document keeps its <meta>/<og>
  // tags for metadata extraction below.
  interface ParsedArticle {
    title?: string | null;
    byline?: string | null;
    textContent?: string | null;
    content?: string | null;
  }
  let parsed: ParsedArticle | null = null;
  try {
    const reader = new Readability(doc.cloneNode(true) as never);
    parsed = (reader.parse() ?? null) as ParsedArticle | null;
  } catch {
    /* fall through to metadata-only extraction */
  }

  // Outbound link evidence comes from the ARTICLE BODY ONLY (FR-10 hygiene).
  // Whole-document scraping pulls nav/footer/public-file/related-widget links
  // (fcc.gov footers, share buttons) that poisoned primary resolution.
  const domains = new Set<string>();
  if (parsed?.content) {
    try {
      const fragDom = new JSDOM(parsed.content, { url: baseUrl, virtualConsole: new VirtualConsole() });
      for (const a of fragDom.window.document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") ?? "";
        try {
          const u = new URL(href, baseUrl);
          if (!/^https?:$/.test(u.protocol)) continue;
          const d = hostToDomain(u.hostname);
          if (d && d !== selfHost && !isUtilityDomain(d)) domains.add(d);
        } catch {
          /* skip malformed hrefs */
        }
      }
    } catch {
      /* fragment parse failure -> empty evidence; title matching still works */
    }
  }

  const ogMetadata: Record<string, string> = {};
  for (const m of doc.querySelectorAll('meta[property^="og:"], meta[name^="og:"]')) {
    const key = m.getAttribute("property") ?? m.getAttribute("name");
    const content = m.getAttribute("content");
    if (key && content) ogMetadata[key.replace(/^og:/, "")] = content.slice(0, 500);
  }

  const publishedRaw = metaContent(dom, DATE_SELECTORS);
  let publishedAt: Date | null = null;
  if (publishedRaw) {
    const t = Date.parse(publishedRaw);
    if (!Number.isNaN(t)) publishedAt = new Date(t);
  }

  let title = "";
  let byline: string | null = null;
  let textContent = "";
  if (parsed) {
    title = parsed.title ?? "";
    byline = parsed.byline ?? null;
    textContent = (parsed.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  if (!title) title = (ogMetadata["title"] ?? doc.title ?? "").trim();
  if (!textContent) {
    textContent = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 20_000);
  }
  if (!title && !textContent) return null;

  const langAttr = doc.documentElement?.getAttribute("lang");
  const language = (langAttr?.slice(0, 2) || guessLanguage(textContent)).toLowerCase();

  return {
    title,
    byline,
    publishedAt,
    textContent,
    charCount: textContent.length,
    language,
    outlinkDomains: [...domains].slice(0, 60),
    ogMetadata,
  };
}
