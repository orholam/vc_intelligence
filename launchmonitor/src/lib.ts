import { createHash, randomBytes } from "node:crypto";

/** JSON-serializable value (matches postgres-js `sql.json()` expectations). */
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

// ---------------------------------------------------------------------------
// ids — mirrors intelligence/src/lib/ulid.ts (monotonic ULID, Crockford b32)

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out += ENC[now % 32];
    now = Math.floor(now / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % 32);
}

export function ulid(): string {
  const now = Date.now();
  if (now === lastTime) {
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      const cur = lastRandom[i] ?? 31;
      if (cur < 31) {
        lastRandom[i]! += 1;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((n) => ENC[n]).join("");
}

/** Opaque prefixed id, e.g. ent_01J…, raw_01J…, art_01J…, als_01J…. */
export function opaqueId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

// ---------------------------------------------------------------------------
// hashing — mirrors intelligence/src/lib/hash.ts

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "fbclid", "mc_cid", "mc_eid", "ref", "referrer",
]);

export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  u.hash = "";
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams(keep);
  u.search = qs.toString() ? `?${qs.toString()}` : "";
  return u.toString();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function urlHash(raw: string): string {
  return sha256Hex(canonicalizeUrl(raw));
}

/** Registrable-ish domain of a URL/host string. */
export function hostToDomain(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {
    /* treat as bare host */
  }
  host = host.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const twoLevelTlds = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.nz", "co.jp", "co.in",
    "com.br", "com.mx", "co.za", "com.sg", "com.tr", "com.cn", "com.ar",
  ]);
  const last2 = parts.slice(-2).join(".");
  if (twoLevelTlds.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

// ---------------------------------------------------------------------------
// text — mirrors intelligence/src/lib/text.ts (excerpt + normalizeName)

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function excerpt(text: string, maxChars = 400): string {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "\u2026";
}

const CORPORATE_SUFFIXES =
  /[, ]+(inc|inc\.|llc|l\.l\.c|ltd|ltd\.|limited|plc|corp|corp\.|corporation|co|co\.|company|gmbh|s\.?a\.?r\.?l|sa|sas|ag|bv|oy|ab|as|pty)\.?$/i;

export function normalizeName(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d'"`]/g, "")
    .replace(/[^a-z0-9+&.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    const next = s.replace(CORPORATE_SUFFIXES, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}
