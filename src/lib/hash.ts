import { createHash, createHmac } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
]);

/** Canonicalize a URL for dedup hashing: strip fragments + tracking params. */
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

export function urlHash(raw: string): string {
  return sha256Hex(canonicalizeUrl(raw));
}

/** Registrable-ish domain of a URL/host string (subdomain-stripped heuristically). */
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

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
