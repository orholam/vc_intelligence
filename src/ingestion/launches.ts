import { sql } from "drizzle-orm";
import { getFilters } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articleEntities, articles, entities } from "../db/schema.js";
import { canonicalizeUrl, hostToDomain, sha256Hex } from "../lib/hash.js";
import { isUtilityDomain } from "../lib/domains.js";
import { entityNameRejectionReason } from "../lib/quality.js";
import { normalizeWebsite } from "../entities/kb.js";
import { opaqueId } from "../lib/ulid.js";
import { recordTrace } from "../ops/traces.js";
import { politeFetch } from "./fetcher.js";

/**
 * Launch-surface ingestion (c-plan "left edge of the magic zone").
 *
 * Product launches surface FIRST on gated community platforms — the crowd's
 * votes are a pre-computed traction filter, so we ingest the leaderboard, not
 * the firehose. Each accepted observation becomes:
 *   - an entity at confidence <= 0.4 (created_by `launch:<surface>`, NOT
 *     watchlisted) keyed by product domain — the escalation ladder means later
 *     press coverage resolves to this same entity and activates full tracking
 *   - a WAITING-ROOM article with platform metadata (no LLM spend); domain
 *     attribution is stamped deterministically so the harness keeps it
 *   - the product_launch fact is DEFERRED to harness part 3 (card updates),
 *     carried in platform_meta.launch
 *
 * X/Twitter deliberately deferred: API pricing breaks NFR-1 and scraping
 * violates ToS (see REQUIREMENTS.md realignment addendum).
 */

export interface LaunchObservation {
  surface: string;
  /** Stable platform item id for dedup. */
  itemId: string;
  title: string;
  tagline?: string | null;
  itemUrl: string;
  externalUrl?: string | null;
  votes?: number;
  points?: number;
  rank?: number;
  createdAt: Date;
}

export interface LaunchSurfaceResult {
  surface: string;
  enabled: boolean;
  seen: number;
  ingested: number;
  entitiesCreated: number;
  duplicates: number;
  skippedNoUrl: number;
  note?: string;
}

interface SurfaceGate {
  enabled: boolean;
  min_points?: number;
  min_votes?: number;
  /** github_trending: minimum stargazers within window_days of repo creation. */
  min_stars?: number;
  window_days?: number;
  max_age_hours?: number;
  token_env?: string;
}

/** Canonical platform domains for article attribution (never guess `<surface>.com`). */
const SURFACE_PUBLISHER_DOMAINS: Record<string, string> = {
  hn: "news.ycombinator.com",
  producthunt: "producthunt.com",
  github_trending: "github.com",
};

function nameFromDomain(domain: string): string {
  const labels = domain.replace(/^www\./, "").split(".");
  const core = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
  return core
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Deterministic, LLM-free pipeline for one launch observation. */
async function ingestLaunchItem(
  db: Db,
  obs: LaunchObservation,
  gate: SurfaceGate,
): Promise<{ ingested: boolean; entityCreated: boolean; duplicate: boolean; skippedNoUrl: boolean }> {
  const out = { ingested: false, entityCreated: false, duplicate: false, skippedNoUrl: false };

  const external = obs.externalUrl?.trim() || null;
  if (!external || !/^https?:\/\//i.test(external)) {
    out.skippedNoUrl = true;
    return out; // no product site -> no join key -> invisible in serving anyway
  }

  const domain = hostToDomain(external);
  if (!domain || isUtilityDomain(domain)) {
    out.skippedNoUrl = true;
    return out;
  }

  // ---- entity: find or create lite (no LLM, confidence floor) ------------------
  let entityId: string | null = null;
  let entityCreated = false;
  const found = await db.execute<{ id: string }>(sql`
    SELECT id FROM entities
    WHERE merged_into IS NULL AND website = ${normalizeWebsite(domain)}
    LIMIT 1
  `);
  if (found[0]) {
    entityId = String(found[0].id);
  } else {
    const candidateName = nameFromDomain(domain);
    if (!entityNameRejectionReason(candidateName)) {
      entityId = opaqueId("ent");
      await db.insert(entities).values({
        id: entityId,
        canonicalName: candidateName,
        website: normalizeWebsite(domain),
        aliases: [candidateName],
        type: "private",
        status: "operating",
        industryTags: [],
        tickers: [],
        confidence: 0.4,
        isMonitored: false, // escalates only when corroborating coverage appears
        reviewStatus: "auto_created",
        createdBy: `launch:${obs.surface}`,
      });
      entityCreated = true;
    }
  }
  if (!entityId) {
    out.skippedNoUrl = true;
    return out;
  }

  // Platform item URL is our article identity (dedup across re-polls).
  const itemUrl = canonicalizeUrl(obs.itemUrl);
  const urlHash = sha256Hex(itemUrl);
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM articles WHERE url_hash = ${urlHash} LIMIT 1
  `);
  if (existing[0]) {
    out.duplicate = true;
    return out;
  }

  // Newsworthiness from attention strength: >= 3x gate floor => high.
  // min_stars wins when present (per-surface metric); else votes vs points gates.
  const gateFloor =
    gate.min_stars ??
    (obs.votes != null ? (gate.min_votes ?? 100) : (gate.min_points ?? 50));
  const attention = obs.votes ?? obs.points ?? 0;
  const newsworthiness = attention >= gateFloor * 3 ? "high" : "medium";
  const excerpt = (obs.tagline ?? obs.title).slice(0, 400);
  void newsworthiness; // applied by the harness enrichment pass

  const articleId = opaqueId("art");
  await db.insert(articles).values({
    id: articleId,
    url: itemUrl,
    urlHash,
    publisherDomain: SURFACE_PUBLISHER_DOMAINS[obs.surface] ?? `${obs.surface}.com`,
    title: obs.title.replace(/^Show HN:\s*/i, "").slice(0, 500),
    publishedAt: obs.createdAt,
    language: "en",
    extractedTextPath: null,
    extractedTextChars: excerpt.length,
    excerptText: excerpt,
    outlinkDomains: [domain],
    // Waiting room: the harness batch owns LLM work and publication. The
    // deferred launch fact rides along in platform_meta.launch.
    noiseStage: "waiting",
    primaryTag: "product.launch",
    secondaryTags: [],
    allTags: ["product.launch", "product"],
    aiSummary: obs.tagline ? obs.tagline.slice(0, 400) : null,
    platformMeta: {
      surface: obs.surface,
      ...(obs.votes != null ? { votes: obs.votes } : {}),
      ...(obs.points != null ? { points: obs.points } : {}),
      ...(obs.rank != null ? { rank: obs.rank } : {}),
      external_url: external,
      launch: {
        surface: obs.surface,
        itemId: obs.itemId,
        domain,
        day: obs.createdAt.toISOString().slice(0, 10),
      },
    },
  });
  void recordTrace(db, {
    node: "waiting_room",
    refId: articleId,
    kind: "article",
    label: obs.title,
    detail: `express lane · ${obs.surface}`,
  });

  await db.insert(articleEntities).values({
    articleId,
    entityId,
    role: "primary",
    confidence: 0.75, // exact-domain attribution
    evidence: { domain_overlap: true, llm: "not_needed", notes: [`launch_surface:${obs.surface}`] },
  });

  out.ingested = true;
  out.entityCreated = entityCreated;
  return out;
}

// ------------------------------------------------------------------ adapters

/** Hacker News Show HN via the free Algolia API. */
async function fetchHn(gate: SurfaceGate, sinceHours: number): Promise<LaunchObservation[]> {
  const minPoints = gate.min_points ?? 50;
  const sinceSec = Math.floor(Date.now() / 1000) - Math.min(gate.max_age_hours ?? sinceHours, sinceHours) * 3600;
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn` +
    `&numericFilters=points%3E${minPoints},created_at_i%3E${sinceSec}&hitsPerPage=50`;
  const res = await politeFetch(url, { accept: "application/json", skipRobots: true });
  if (res.status !== 200) throw new Error(`HN Algolia ${res.status}`);
  const json = JSON.parse(res.body) as {
    hits?: Array<{
      objectID: string;
      title?: string;
      url?: string | null;
      points?: number;
      created_at: string;
    }>;
  };
  return (json.hits ?? [])
    .filter((h) => h.title && h.objectID)
    .map((h) => ({
      surface: "hn",
      itemId: h.objectID,
      title: h.title!,
      itemUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
      externalUrl: h.url ?? null,
      points: h.points,
      createdAt: new Date(h.created_at),
    }));
}

/** Product Hunt GraphQL v2 — requires a developer token (env, see token_env). */
async function fetchProductHunt(db: Db, gate: SurfaceGate): Promise<LaunchObservation[]> {
  const envKey = gate.token_env ?? "PH_TOKEN";
  const token = process.env[envKey];
  if (!token) {
    throw new Error(`PH_TOKEN missing (${envKey}) — skipping producthunt`);
  }
  void db;
  const query = `
    query { posts(first: 20, order: VOTES) {
      edges { node {
        name tagline url votesCount website domain createdAt
      } }
    } }`;
  const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ProductHunt ${res.status}`);
  const json = (await res.json()) as {
    data?: {
      posts?: {
        edges?: Array<{
          node?: {
            name: string;
            tagline: string;
            url: string;
            votesCount: number;
            website?: string | null;
            domain?: string | null;
            createdAt: string;
          };
        }>;
      };
    };
  };
  const minVotes = gate.min_votes ?? 100;
  return (json.data?.posts?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is NonNullable<typeof n> => Boolean(n?.url))
    .filter((n) => n.votesCount >= minVotes)
    .map((n) => ({
      surface: "producthunt",
      itemId: n.url,
      title: n.name,
      tagline: n.tagline,
      itemUrl: n.url,
      externalUrl: n.website ?? n.domain ?? null,
      votes: n.votesCount,
      createdAt: new Date(n.createdAt),
    }));
}

/**
 * Build the GitHub Search API URL for repos created within `windowDays` that
 * already cleared `minStars` — star velocity on a brand-new repo is a
 * crowd-computed traction signal (same philosophy as HN points / PH votes).
 */
export function buildGithubSearchUrl(minStars: number, windowDays: number): string {
  const since = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>${since} stars:${minStars}..*`);
  return `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=50`;
}

/** GitHub Search API — free, unauthenticated (optional token via token_env lifts rate limits). */
async function fetchGithubTrending(gate: SurfaceGate): Promise<LaunchObservation[]> {
  const url = buildGithubSearchUrl(gate.min_stars ?? 100, gate.window_days ?? 7);
  const token = process.env[gate.token_env ?? "GITHUB_TOKEN"];
  const res = await politeFetch(url, {
    accept: "application/vnd.github+json",
    skipRobots: true,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub rate-limited (${res.status}) — set ${gate.token_env ?? "GITHUB_TOKEN"}`);
  }
  if (res.status !== 200) throw new Error(`GitHub Search ${res.status}`);
  const json = JSON.parse(res.body) as {
    items?: Array<{
      full_name: string;
      html_url: string;
      homepage?: string | null;
      description?: string | null;
      stargazers_count?: number;
      created_at: string;
    }>;
  };
  return (json.items ?? []).map((r, i) => ({
    surface: "github_trending",
    itemId: r.full_name,
    title: r.description ? `${r.full_name}: ${r.description}` : r.full_name,
    itemUrl: r.html_url,
    // Repo website is the entity join key; repos without one have no resolvable
    // product domain and are skipped downstream (skippedNoUrl), by design.
    externalUrl: /^https?:\/\//i.test(r.homepage ?? "") ? r.homepage! : null,
    points: r.stargazers_count,
    rank: i + 1,
    createdAt: new Date(r.created_at),
  }));
}

const ADAPTERS: Record<string, (db: Db, gate: SurfaceGate) => Promise<LaunchObservation[]>> = {
  hn: (_db, gate) => fetchHn(gate, 72),
  producthunt: fetchProductHunt,
  github_trending: (_db, gate) => fetchGithubTrending(gate),
};

/**
 * Ingest all enabled launch surfaces. Per-surface isolation: one failing
 * adapter never blocks the others (NFR-3).
 */
export async function ingestLaunchSurfaces(
  db: Db,
  opts: { surfaces?: string[] } = {},
): Promise<LaunchSurfaceResult[]> {
  const cfg = getFilters().launch_surfaces ?? {};
  const results: LaunchSurfaceResult[] = [];

  for (const [surface, gateRaw] of Object.entries(cfg)) {
    const gate = gateRaw as SurfaceGate;
    if (opts.surfaces && !opts.surfaces.includes(surface)) continue;
    const base: LaunchSurfaceResult = {
      surface,
      enabled: Boolean(gate.enabled),
      seen: 0,
      ingested: 0,
      entitiesCreated: 0,
      duplicates: 0,
      skippedNoUrl: 0,
    };
    if (!gate.enabled) {
      results.push(base);
      continue;
    }
    const adapter = ADAPTERS[surface];
    if (!adapter) {
      base.note = "adapter not implemented";
      results.push(base);
      continue;
    }
    try {
      const observations = await adapter(db, gate);
      base.seen = observations.length;
      for (const obs of observations) {
        const r = await ingestLaunchItem(db, obs, gate);
        if (r.ingested) base.ingested++;
        if (r.entityCreated) base.entitiesCreated++;
        if (r.duplicate) base.duplicates++;
        if (r.skippedNoUrl) base.skippedNoUrl++;
      }
    } catch (e) {
      base.note = (e as Error).message.slice(0, 160);
    }
    results.push(base);
  }
  return results;
}
