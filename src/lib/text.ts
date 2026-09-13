const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m);
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** First ~maxChars chars on a word boundary (excerpt policy NFR-8: <=400). */
export function excerpt(text: string, maxChars = 400): string {
  const clean = normalizeWhitespace(text);
  // Reserve one char for the ellipsis so the result never exceeds maxChars
  // (G6: length > 400 is a gate violation).
  const cap = Math.max(1, maxChars - 1);
  if (clean.length <= cap) return clean;
  const cut = clean.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "\u2026";
}

const CORPORATE_SUFFIXES =
  /[, ]+(inc|inc\.|llc|l\.l\.c|ltd|ltd\.|limited|plc|corp|corp\.|corporation|co|co\.|company|gmbh|s\.?a\.?r\.?l|sa|sas|ag|bv|oy|ab|as|pty)\.?$/i;

/**
 * Normalize a company name for alias matching: lowercase, strip punctuation and
 * corporate suffixes so "Acme Robotics Inc." matches "acme robotics".
 */
export function normalizeName(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d'"`]/g, "")
    .replace(/[^a-z0-9+&.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // repeatedly strip trailing suffixes ("foo corp ltd")
  for (;;) {
    const next = s.replace(CORPORATE_SUFFIXES, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").replace(/^the /, "");
}

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how in is it its of on or that the to was were what when where which who will with".split(
    " ",
  )),
);

/** Cheap language guess from stopwords; not a replacement for real detection. */
export function guessLanguage(text: string): string {
  const words = text.toLowerCase().match(/\b[a-z']+\b/g) ?? [];
  if (words.length < 10) return "en";
  let hits = 0;
  for (const w of words) if (STOPWORDS.has(w)) hits++;
  const ratio = hits / words.length;
  if (ratio > 0.25) return "en";
  // tiny heuristics
  if (/\b(der|die|das|und|nicht|ist)\b/.test(text.toLowerCase())) return "de";
  if (/\b(le|les|des|une|est|pour)\b/.test(text.toLowerCase())) return "fr";
  if (/\b(el|la|los|las|una|para|con)\b/.test(text.toLowerCase())) return "es";
  return "en";
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\u2018\u201c])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + "\u2026";
}

/** Parse loose date formats seen in feeds/GDELT; returns null when unparseable. */
export function parseLooseDate(input?: string | null): Date | null {
  if (!input) return null;
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return new Date(t);
  // GDELT style: 20260821T091500Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(input.trim());
  if (m) {
    const g = m as RegExpMatchArray & { [k: number]: string };
    return new Date(
      Date.UTC(Number(g[1]), Number(g[2]) - 1, Number(g[3]), Number(g[4]), Number(g[5]), Number(g[6])),
    );
  }
  return null;
}
