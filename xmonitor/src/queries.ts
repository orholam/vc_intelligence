/**
 * Launch-query construction for X advanced search.
 *
 * Strategy (from research): serious indie/product launches on X follow a
 * recognizable pattern — an announcement phrase ("Introducing…", "just
 * launched…") paired with a native product video. X's search operators let a
 * single authenticated query cover ALL accounts, so discovery scales without
 * maintaining a watchlist.
 */

export interface LaunchQuery {
  /** Stable identifier used in the polls table and logs. */
  id: string;
  /** Full X search query string. */
  text: string;
}

const VIDEO_FILTER = "filter:native_video";
const NOISE_FILTERS = ["-filter:replies", "-filter:retweets"];
const LANG = "lang:en";

/** Announcement phrases that precede real launch posts. */
export const LAUNCH_PHRASES = [
  "introducing",
  "we're launching",
  "just launched",
  "proud to announce",
  "launching today",
  "now live",
] as const;

export function buildLaunchQuery(phrase: string, opts?: { minFaves?: number }): string {
  const parts = [phrase];
  if (opts?.minFaves && opts.minFaves > 0) parts.push(`min_faves:${opts.minFaves}`);
  parts.push(VIDEO_FILTER, ...NOISE_FILTERS, LANG);
  return parts.join(" ");
}

function slugify(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildLaunchQueries(
  phrases: readonly string[] = LAUNCH_PHRASES,
  opts?: { minFaves?: number },
): LaunchQuery[] {
  return phrases.map((p) => ({ id: slugify(p), text: buildLaunchQuery(p, opts) }));
}

/**
 * Extra user-supplied queries from XM_QUERIES: either a JSON array of strings
 * or a comma-separated list (commas inside queries are not supported).
 */
export function parseCustomQueries(raw: string | undefined): LaunchQuery[] {
  if (!raw || raw.trim() === "") return [];
  const items = parseList(raw);
  return items.map((text) => ({ id: `custom-${slugify(text.slice(0, 40))}`, text }));
}

function parseList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((s) => s.trim());
      }
    } catch {
      // fall through to comma splitting
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** Default launch queries plus any user-supplied extras, deduped by text. */
export function mergeQueries(extraRaw?: string, opts?: { minFaves?: number }): LaunchQuery[] {
  const defaults = buildLaunchQueries(LAUNCH_PHRASES, opts);
  const custom = parseCustomQueries(extraRaw);
  const seen = new Set<string>();
  const out: LaunchQuery[] = [];
  for (const q of [...custom, ...defaults]) {
    const key = q.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}
