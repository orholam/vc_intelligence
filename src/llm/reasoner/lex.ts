/**
 * Reasoning-engine lexical primitives (offline LLM emulation, FR-12/NFR-5).
 *
 * Everything here is pure + deterministic (R14): same input + same config
 * version ⇒ same output. These helpers back every emulated stage in
 * src/llm/mock.ts — noise filtering, classification, summarization, fact
 * extraction, adjudication and ListGen interpretation.
 */

// ------------------------------------------------------------------ sections

/** Extract a labeled section ("TITLE:", "TEXT:", …) up to the next marker. */
export function section(text: string, startMarker: string, endMarkers: string[]): string {
  const i = text.indexOf(startMarker);
  if (i < 0) return "";
  let end = text.length;
  for (const em of endMarkers) {
    const j = text.indexOf(em, i + startMarker.length);
    if (j >= 0 && j < end) end = j;
  }
  return text.slice(i + startMarker.length, end).trim();
}

/** Cut rendered vocabulary blocks ("EVENT_TYPES = …") out of scorable text. */
export function cutVocabTail(text: string, marker = "\nEVENT_TYPES ="): string {
  const i = text.indexOf(marker);
  return i >= 0 ? text.slice(0, i) : text;
}

// ------------------------------------------------------- weighted term match

const escapeRe = (s: string): string => s.replace(/[.*+?${}()|[\]\\]/g, "\\$&");

export interface TermHit {
  count: number;
  titleHits: number;
  leadHits: number;
  firstPos: number;
}

/**
 * Count word-bounded occurrences of a term across zones.
 * Zones: title (weight 4), lead/first 400 chars of body (×2), rest (×1).
 * Multi-word terms match as phrases; single words require boundaries so
 * "ico" never fires inside "silicon".
 */
export function findTerm(
  titleLower: string,
  leadLower: string,
  bodyLower: string,
  rawTerm: string,
): TermHit {
  const term = rawTerm.toLowerCase().trim();
  const hit: TermHit = { count: 0, titleHits: 0, leadHits: 0, firstPos: Number.MAX_SAFE_INTEGER };
  if (!term) return hit;
  const re = new RegExp(`\\b${escapeRe(term).replaceAll(/\\?\s+/g, "\\s+")}\\b`, "g");
  const scan = (zone: string, zoneWeight: number, offsetBase: number): void => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(zone)) !== null) {
      hit.count += zoneWeight;
      if (offsetBase === 0) {
        hit.titleHits++;
        hit.firstPos = Math.min(hit.firstPos, m.index);
      } else if (offsetBase === 1) hit.leadHits++;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  };
  scan(titleLower, 4, 0);
  scan(leadLower, 2, 1);
  scan(bodyLower, 1, 2);
  return hit;
}

/** Score a keyword list against zoned text; longer phrases are more specific. */
export function scoreKeywordList(
  zones: { title: string; lead: string; body: string },
  keywords: string[],
): number {
  let s = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    const spec = kw.includes(" ") ? Math.max(2, Math.min(6, kw.length / 3)) : 1;
    const h = findTerm(zones.title, zones.lead, zones.body, kw);
    s += h.count * spec;
  }
  return s;
}

export function lowerZones(title: string, body: string): { title: string; lead: string; body: string } {
  const flat = body.toLowerCase();
  return {
    title: title.toLowerCase(),
    lead: flat.slice(0, 400),
    body: flat.length > 400 ? flat.slice(400) : "",
  };
}

// ------------------------------------------------------------------ amounts

const FX_TO_USD: Record<string, number> = { "$": 1, "€": 1.08, "£": 1.27, "¥": 0.0067, "₹": 0.012 };

function unitMultiplier(unit: string): number {
  const u = unit.toLowerCase().replace(/\./g, "");
  if (/^(b|bn|billion)/.test(u)) return 1_000_000_000;
  if (/^(m|mn|million)/.test(u)) return 1_000_000;
  if (/^(k|thousand)/.test(u)) return 1_000;
  return 1;
}

/**
 * Parse money amounts near a verb/pattern. Returns USD estimates found in the
 * clause, largest first. Handles "$10M", "€5.5 million", "$10-12M" (upper
 * bound), "$1.2 billion", bare "10 billion" after a currency word context.
 */
export function parseAmounts(clause: string): number[] {
  const out: number[] = [];
  for (const m of clause.matchAll(
    /([€£$¥₹])\s?([\d][\d.,]*)\s*(million|billion|billion\b|bn\b|mm\b|m\b|mn\b|k\b)?((?:\s*(?:-|–|to)\s*[$€£¥₹]?\s*[\d][\d.,]*)\s*(million|billion|bn\b|m\b|mn\b|k\b)?)?/gi,
  )) {
    const sym = m[1] ?? "$";
    const first = Number((m[2] ?? "").replaceAll(",", ""));
    if (!Number.isFinite(first) || first === 0) continue;
    // Range "…-12M": prefer the stated upper bound unit, else first unit.
    const rangeEnd = m[4];
    let value = first;
    let unitWord = m[3] ?? "";
    if (rangeEnd) {
      const endNum = Number(rangeEnd.replace(/[^\d.,]/g, "").replaceAll(",", ""));
      if (Number.isFinite(endNum) && endNum > 0) value = endNum;
      unitWord = m[5] || unitWord;
    }
    let usd = value * (FX_TO_USD[sym] ?? 1) * (unitWord ? unitMultiplier(unitWord) : 1);
    usd = Math.round(usd);
    if (usd >= 1_000) out.push(usd);
  }
  return out.sort((a, b) => b - a);
}

/** First plausible deal amount in the clause, or null. */
export function firstAmount(clause: string): number | null {
  return parseAmounts(clause)[0] ?? null;
}

// --------------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Resolve an explicit or relative date expression against a reference date.
 * Returns YYYY-MM-DD or null. Never returns future-dated results for
 * month-name expressions (rolls back a year instead).
 */
export function resolveDateExpr(text: string, ref: Date): string | null {
  const isoM = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoM) {
    const d = new Date(`${isoM[1]}-${isoM[2]}-${isoM[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
  }
  const lower = text.toLowerCase();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  if (/\btoday\b/.test(lower)) return iso(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  for (let i = 0; i < dayNames.length; i++) {
    if (new RegExp(`\\b(on )?(last )?${dayNames[i]}\\b`).test(lower)) {
      const diff = (ref.getUTCDay() - i + 7) % 7 || 7;
      const d = new Date(ref.getTime() - diff * 86_400_000);
      return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }
  const relDays = /\b(\d+)\s+days? ago\b/.exec(lower);
  if (relDays) {
    const d = new Date(ref.getTime() - Number(relDays[1]) * 86_400_000);
    return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const mdY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})?\b/i.exec(text);
  if (mdY) {
    const mon = MONTHS[(mdY[1] ?? "").toLowerCase()] ?? 0;
    const day = Number(mdY[2] ?? 1);
    let year = mdY[3] ? Number(mdY[3]) : ref.getUTCFullYear();
    let cand = new Date(Date.UTC(year, mon, day));
    if (!mdY[3] && cand.getTime() > ref.getTime() + 86_400_000) {
      year -= 1;
      cand = new Date(Date.UTC(year, mon, day));
    }
    return iso(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate());
  }
  return null;
}

// ----------------------------------------------------------------- sentences

/** Strip leading datelines ("SAN FRANCISCO —", "London, Aug 12 -"). */
export function stripDateline(s: string): string {
  return s
    .replace(/^[A-Z][A-Z\s,.]{2,40}(?:—|-|–)\s*/, "")
    .replace(/^[A-Z][a-zA-Z.\s]+,\s*[A-Z]{2}\.?\s+[A-Z]?[a-z]{2}\.?\s+\d{1,2}\s*(?:—|-|–)?\s*/, "")
    .trim();
}

/** Split into sentences keeping abbreviations intact enough for ranking. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\u201C])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ----------------------------------------------------------------- sentiment

const POSITIVE = new Set(
  (
    "gain gains grew growth grow surge surged surges soar soared soars rise rises rose rally rallies record records strong stronger higher boost boosted boosts win wins won award awarded breakthrough profitable profitability raises raised upgrade upgraded expansion expands expand launch launches launched unveil unveiled unveils success successful partnership secures secured milestone beats topped exceeds approval approved approved resilient robust demand adoption expands expands valued unicorn surpass surpasses exceeds accelerates accelerating momentum thriving expands expands improves improved improvement optimistic upbeat bullish outperform outperformed efficiency efficiencies savings streamlined expands expands expands".split(
      " ",
    )
  ),
);
const NEGATIVE = new Set(
  (
    "loss losses lost fell fall falls drop dropped drops decline declined declines slump slumped plunge plunged crash crashed weak weaker lower cut cuts layoff layoffs lawsuit lawsuits sued sues fined penalty penalties breach breaches hacked hack outage outages recall recalls bankruptcy bankrupt insolvency distress warning warns misses missed downgrade downgraded fraud probe investigation halted halt shutdown shuts shut closes closed crisis concern concerns risk risks firing firings departures exits struggles struggling shortfall deficit writedown impairment delisting delisted default defaults liquidation receivership lawsuit settles settlement fined sued".split(
      " ",
    )
  ),
);

const NEGATORS = new Set(["not", "no", "never", "despite", "although", "though", "unlike", "denies", "denied"]);

export interface SentimentResult {
  sentiment: "positive" | "negative" | "neutral";
  score: number;
}

/**
 * Polarity with a small negation window and event-prior blending.
 * Deterministic; magnitude capped at ±0.9, neutral band ±0.35, ≥3 hits
 * required before leaving neutral (trivial items stay calm).
 */
export function sentimentOf(text: string, prior = 0): SentimentResult {
  const words = text.toLowerCase().match(/\b[a-z']+\b/g) ?? [];
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (POSITIVE.has(w)) {
      const prev = words[i - 1] ?? "";
      if (NEGATORS.has(prev)) neg++;
      else pos++;
    } else if (NEGATIVE.has(w)) {
      const prev = words[i - 1] ?? "";
      if (NEGATORS.has(prev)) pos++;
      else neg++;
    }
  }
  const total = pos + neg;
  let score = total >= 3 ? (pos - neg) / Math.sqrt(total * total) * (total > 8 ? 1.15 : 1) : 0;
  score = Math.max(-0.9, Math.min(0.9, score));
  // Blend the discrete-event prior (e.g. bankruptcy ⇒ negative) with lexicon.
  score = 0.55 * score + 0.45 * prior;
  score = Number(Math.max(-0.9, Math.min(0.9, score)).toFixed(2));
  return {
    sentiment: score > 0.35 ? "positive" : score < -0.35 ? "negative" : "neutral",
    score,
  };
}
