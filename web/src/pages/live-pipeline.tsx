import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live Pipeline data plane: snapshot polling/SSE + journey packages + the
 * SVG diagram machinery (geometry, ribbons, animated item dots).
 *
 * Journeys are ONE package per item, emitted by the backend when the item
 * reaches a terminal bucket, carrying every step it took. The console
 * replays each packaged path exactly once, on receipt. There is NO history
 * backpropagation — a fresh page load starts silent until real items land;
 * the poll-fallback cursor is forward-only from mount time.
 */

/* ------------------------------------------------------------------ types */

export interface Activity {
  id: string;
  kind: string;
  ts: string;
  title: string;
  detail?: string;
  url?: string | null;
  node: string;
}

export interface JourneyStep {
  node: string;
  ts: string;
  label?: string | null;
  detail?: string | null;
}

export interface JourneyPackage {
  id: string;
  ref_id: string;
  terminal_node: string;
  title: string | null;
  steps: JourneyStep[];
  created_at: string;
}

export interface HarnessRunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  scanned: number;
  corrected: number;
  relevance_discards: number;
  incomplete_skipped: number;
  published: number;
  stories_clustered: number;
  facts_proposed: number;
  facts_accepted: number;
  cards_updated: number;
  new_companies_deep_searched: number;
  skip_reason?: string;
  chunk_done?: number;
  chunks_total?: number;
}

export interface Snapshot {
  ts: string;
  build_ms: number;
  sources: {
    tiers: Array<{ tier: number; total: number; active: number; failing: number; last_fetch: string | null }>;
    due_now: number;
    total: number;
    active_total: number;
  };
  inbound: {
    backlog_by_channel: Array<{ channel: string; pending: number; fetched: number; failed: number }>;
    discovered_24h_by_channel: Array<{ channel: string; n: number }>;
    failed_discovered_24h: number;
    recent: Activity[];
  };
  stages: {
    backlog: Record<string, number>;
    created_24h: number;
    published_24h: number;
    prefilter_24h: number;
    harness_discards_24h: number;
    resolved_24h: number;
    enriched_24h: number;
    clustered_24h: number;
    pending_now?: number;
    waiting_now: number;
  };
  harness: {
    running_now: boolean;
    last_run: HarnessRunSummary | null;
    batch_limit: number;
    llm_provider?: string;
    oldest_waiting_at: string | null;
  };
  discard_reasons_24h: Array<{ stage: string; reason: string; n: number }>;
  hourly_24h: Array<{ hour: string; discovered: number; extracted: number; published: number; discarded: number }>;
  queues: Array<{ name: string; waiting: number; active: number; failing: number }>;
  webhooks: { subscriptions_active: number; delivered_24h: number; failed_24h: number; pending_now: number };
  entities: { live_entities: number; needs_backfill_outstanding: number; created_24h: number; banded: number; facts_proposed_24h: number; facts_accepted_24h: number; profiles_complete_24h: number };
  side_channels: { launches_by_surface_24h: Array<{ surface: string; n: number }>; formd_facts_24h: number };
  llm: {
    budget: { month: string; spent_usd: number; cap_usd: number; soft_limit_usd: number; classify_only_mode: boolean };
    stages: Array<{ stage: string; calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
    blended_article_cost_usd: number | null;
    degrade_events: Array<{ kind: string; message: string; created_at: string }>;
  };
  activity: Activity[];
}

export type Conn = "connecting" | "live" | "poll" | "offline";

/* -------------------------------------------------------------- data hook */

export function useLivePipeline(): {
  snap: Snapshot | null;
  conn: Conn;
  journeys: JourneyPackage[];
} {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [journeys, setJourneys] = useState<JourneyPackage[]>([]);
  const seenJourneys = useRef(new Set<string>());
  /** Forward-only cursor: initialized at mount so history never replays. */
  const cursor = useRef(new Date().toISOString());

  const accept = useCallback((pkg: JourneyPackage) => {
    if (seenJourneys.current.has(pkg.id)) return;
    seenJourneys.current.add(pkg.id);
    if (seenJourneys.current.size > 4000) seenJourneys.current.clear();
    const ts = pkg.created_at || pkg.steps[pkg.steps.length - 1]?.ts;
    if (ts && ts > cursor.current) cursor.current = ts;
    setJourneys((cur) => [...cur, pkg].slice(-300));
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const res = await fetch("/v1/exoskeleton/snapshot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Snapshot;
      setSnap(body);
      setConn("poll");
    } catch {
      setConn("offline");
      return;
    }
    try {
      const res = await fetch(`/v1/exoskeleton/journeys?since=${encodeURIComponent(cursor.current)}&limit=60`);
      if (res.ok) {
        const body = (await res.json()) as { journeys?: JourneyPackage[] };
        for (const j of body.journeys ?? []) accept(j);
      }
    } catch {
      /* snapshot already succeeded; journeys can wait a tick */
    }
  }, [accept]);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;

    const startPolling = () => {
      if (pollTimer !== null || !alive) return;
      setConn((c) => (c === "offline" ? "offline" : "poll"));
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), 4000);
    };

    try {
      es = new EventSource("/v1/exoskeleton/stream");
      es.addEventListener("snapshot", (e) => {
        if (!alive) return;
        failures = 0;
        setConn("live");
        try {
          setSnap(JSON.parse((e as MessageEvent).data) as Snapshot);
        } catch {
          /* malformed frame — ignore */
        }
      });
      es.addEventListener("journey", (e) => {
        if (!alive) return;
        try {
          accept(JSON.parse((e as MessageEvent).data) as JourneyPackage);
        } catch {
          /* malformed frame — ignore */
        }
      });
      es.onopen = () => {
        failures = 0;
        if (alive) setConn("live");
      };
      es.onerror = () => {
        if (!alive) return;
        failures += 1;
        if (failures >= 3) {
          es?.close();
          es = null;
          startPolling();
        }
      };
    } catch {
      startPolling();
    }

    return () => {
      alive = false;
      es?.close();
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }, [accept, pollOnce]);

  return { snap, conn, journeys };
}

/* ---------------------------------------------------------------- helpers */

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export const usd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

/* ------------------------------------------------------- diagram geometry */

export interface NodeDef {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const N = {
  srcRss: { id: "src_rss", label: "RSS FEEDS", x: 14, y: 64, w: 128, h: 56 },
  srcGdelt: { id: "src_gdelt", label: "GDELT", x: 14, y: 142, w: 128, h: 56 },
  srcSearch: { id: "src_search", label: "SEARCH", x: 14, y: 212, w: 128, h: 56 },
  srcLaunch: { id: "src_launch", label: "LAUNCH SURFACES", x: 14, y: 296, w: 128, h: 56 },
  srcFormd: { id: "src_formd", label: "FORM D · EDGAR", x: 14, y: 388, w: 128, h: 56 },
  raw: { id: "raw", label: "RAW INTAKE", x: 208, y: 84, w: 138, h: 152 },
  fetch: { id: "fetch", label: "FETCH + EXTRACT", x: 402, y: 96, w: 134, h: 128 },
  prefilter: { id: "prefilter", label: "RULES PREFILTER", x: 590, y: 104, w: 126, h: 112 },
  dedupe: { id: "dedupe", label: "WIRE DEDUPE", x: 770, y: 116, w: 110, h: 88 },
  waiting: { id: "waiting_room", label: "WAITING ROOM", x: 924, y: 70, w: 170, h: 180 },
  harness: { id: "harness", label: "HARNESS", x: 1140, y: 96, w: 140, h: 128 },
  winners: { id: "winners", label: "✦ WINNERS", x: 1336, y: 30, w: 150, h: 62 },
  webhooks: { id: "webhooks", label: "WEBHOOK FAN-OUT", x: 1336, y: 124, w: 150, h: 56 },
  facts: { id: "facts", label: "COMPANY CARDS", x: 1336, y: 218, w: 150, h: 62 },
  sinkFetchFail: { id: "fetch_failed", label: "FETCH FAILURES", x: 402, y: 474, w: 134, h: 54 },
  sinkRules: { id: "prefilter_discards", label: "RULE DISCARDS", x: 590, y: 474, w: 178, h: 54 },
  sinkHarness: { id: "harness_discards", label: "HARNESS DISCARDS", x: 1140, y: 474, w: 140, h: 54 },
} satisfies Record<string, NodeDef>;

export const DIAGRAM_WIDTH = 1500;
export const DIAGRAM_HEIGHT = 545;

export const NODE_BLURB: Record<string, { title: string; blurb: string; queues?: string[] }> = {
  sources: {
    title: "Sources",
    blurb:
      "The source registry (FR-1). Tiered feeds poll on cadence (T1 15m, T2 1h, T3 1d) with exponential backoff on failure streaks; the lifecycle tick demotes/prunes unhealthy feeds and reactivates recovered ones. GDELT polls on a watchlist of monitored entities.",
  },
  src_rss: { title: "RSS feeds", blurb: "polled via pg-boss cron ticks; conditional GET with ETag/Last-Modified; new GUID+URL-hash-deduped items become raw items.", queues: ["rss-poll-tick", "fetch-feed"] },
  src_gdelt: { title: "GDELT", blurb: "watchlist-driven news search over monitored entities; results enter as raw items with GDELT metadata (language, domain).", queues: ["gdelt-poll-tick"] },
  src_search: { title: "Search index", blurb: "on-demand discovery searches; same uniform stage contract as RSS/GDELT downstream.", queues: [] },
  src_launch: {
    title: "Launch surfaces",
    blurb:
      "Hacker News / Product Hunt / GitHub trending watchers. Attention-gated observations enter the WAITING ROOM directly with deterministic domain attribution stamped (express lane). The deferred product-launch card update happens in harness part 3.",
    queues: ["launch-poll-tick"],
  },
  src_formd: {
    title: "Form D · EDGAR",
    blurb:
      "Daily EDGAR sweep. SEC filings create registry-keyed entities and enter the WAITING ROOM as filing events with authoritative attribution (express lane). The accepted funding_round fact + company-card update happen in harness part 3.",
    queues: ["formd-poll-tick"],
  },
  raw: {
    title: "Raw intake",
    blurb:
      "Every discovery lands here first (FR-2/FR-3): content-hash dedup on canonical URL + feed GUID means zero duplicate raw items. Items wait in `pending` until a fetch job picks them up; failures park auditable rows (never silently vanished — R04 reconciliation depends on them).",
    queues: ["fetch-feed"],
  },
  fetch: {
    title: "Fetch + extract",
    blurb:
      "Polite, robots.txt-respecting fetching with per-domain pacing and one retry, then Readability extraction. Bot-blocked pages fall back to a search-index markdown fetch (never for robots-blocked hosts). Future/garbage publish dates are sanitized. Canonicalized URL hash collapses duplicates into one article row.",
    queues: ["fetch-article"],
  },
  prefilter: {
    title: "Rules prefilter",
    blurb:
      "Deterministic zero-cost gate: minimum body length, too-short titles, slop-title patterns, URL block patterns, stale-date resurfaces. Anything cut here never costs an LLM token. Discards keep their reason for audit.",
    queues: ["filter-article"],
  },
  dedupe: {
    title: "Wire dedupe",
    blurb:
      "Syndication collapse before any model spend: an identical normalized headline inside the configured window marks the later copy as title_duplicate_of:<id>. This is the end of the purely programmatic chain.",
    queues: ["filter-article"],
  },
  waiting_room: {
    title: "Waiting room",
    blurb:
      "Everything that passed ALL programmatic gates parks here — indefinitely. No LLM runs per-article anymore. The room simply accumulates until an operator fires THE HARNESS, which sweeps the whole batch in one three-part job: corrections → new-company deep search → card updates. Winners then appear on /latest.",
  },
  harness: {
    title: "The harness",
    blurb:
      "One manual, batched LLM job over the entire waiting room — never per-article queues. Part 1: small corrections on every waiting item (are the proper companies identified? is this actually relevant?) plus enrichment fields and story-match embeddings. Part 2: companies NEW to the database get a deep firmographics search. Part 3: significant data in the news itself (fundraises, launches…) updates company cards. Then survivors are published programmatically. Fire it with RUN HARNESS in the header.",
    queues: ["harness-run"],
  },
  winners: {
    title: "Winners ✦",
    blurb:
      "Events that survived the full gauntlet are ADDED TO THE DATABASE here — this is exactly what GET /v1/news/latest serves (entity-resolved, enriched, story-deduplicated). Each winner carries the ✦ blazon so you can correlate this view with the API.",
  },
  webhooks: {
    title: "Webhook fan-out",
    blurb:
      "Published winners are matched to active subscriptions (per-entity filters) and delivered with HMAC signatures; retries are bounded with backoff (FR-21), swept every minute.",
    queues: ["webhook-sweep"],
  },
  facts: {
    title: "Company cards",
    blurb:
      "Harness part 3 output: funding rounds, acquisitions, leadership changes, closures, launches proposed from the primary-entity signal (FR-9), promoted when corroborated (two publishers or a tier-1 source). Accepted facts update entity card fields; brand-new companies got their deep firmographics pass in part 2.",
  },
  fetch_failed: {
    title: "Fetch failures",
    blurb:
      "Parked, auditable failures: robots-blocked, extraction-empty, or repeated HTTP errors. Rows age out only after successful consumption so reconciliation always balances (R04).",
  },
  prefilter_discards: {
    title: "Rule discards",
    blurb: "Everything the deterministic gates rejected — free to discard, zero model spend. Top reasons are ranked in the panel below.",
  },
  harness_discards: {
    title: "Harness discards",
    blurb: "Items the batch corrections pass judged irrelevant or unpublishable. The LLM spend that protects the signal/noise ratio happens HERE — once per batch, never inline.",
  },
};

export const NODE_TO_QUEUES: Record<string, string[]> = Object.fromEntries(
  Object.entries(NODE_BLURB).map(([k, v]) => [k, v.queues ?? []]),
);

const TONE_COLOR: Record<string, string> = {
  flow: "#818cf8",
  pass: "#34d399",
  drop: "#fb7185",
  fail: "#fbbf24",
  express: "#22d3ee",
};

export interface LinkSpec {
  from: NodeDef;
  to: NodeDef;
  value: number;
  tone: keyof typeof TONE_COLOR;
  mode: "side" | "drop" | "arc";
  dashed?: boolean;
}

function sameColumn(a: NodeDef, b: NodeDef): boolean {
  return Math.abs(a.x - b.x) < 50;
}

/** True when a vertical centerline hop would cross another node's face. */
function columnBlocked(a: NodeDef, b: NodeDef): boolean {
  const midX = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
  const top = Math.min(a.y + a.h, b.y);
  const bot = Math.max(a.y + a.h, b.y);
  for (const n of Object.values(N) as NodeDef[]) {
    if (n.id === a.id || n.id === b.id) continue;
    if (midX < n.x - 6 || midX > n.x + n.w + 6) continue;
    if (n.y + n.h < top + 2 || n.y > bot - 2) continue;
    return true;
  }
  return false;
}

function dropPath(a: NodeDef, b: NodeDef): string {
  if (columnBlocked(a, b)) {
    // Left-edge → left-edge via the gutter so we never paint across box faces.
    const x1 = a.x;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const gx = Math.min(a.x, b.x) - 22;
    return `M ${x1} ${y1} C ${gx} ${y1}, ${gx} ${y2}, ${x2} ${y2}`;
  }
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

/** Edge-to-edge ribbon. Stacked nodes always drop (never a side-curve through the box). */
export function linkPath(a: NodeDef, b: NodeDef, mode: "side" | "drop" | "arc"): string {
  if (mode === "arc") {
    const x1 = a.x + a.w / 2;
    const y1 = a.y;
    const x2 = b.x + b.w * 0.25;
    const y2 = b.y;
    const mx = (x1 + x2) / 2;
    // Left-column express lanes fly over the main row into the waiting room.
    if (y1 > 220 && y2 < 180) {
      const xStart = a.x + a.w;
      const gx = a.x + a.w + 24;
      const lift = 50;
      const r = 14;
      return [
        `M ${xStart} ${y1}`,
        `L ${gx - r} ${y1}`,
        `Q ${gx} ${y1} ${gx} ${y1 - r}`,
        `L ${gx} ${lift + r}`,
        `Q ${gx} ${lift} ${gx + r} ${lift}`,
        `L ${x2 - r} ${lift}`,
        `Q ${x2} ${lift} ${x2} ${lift + r}`,
        `L ${x2} ${y2}`,
      ].join(" ");
    }
    const lift = Math.min(y1, y2) - 46;
    return `M ${x1} ${y1} C ${mx} ${lift}, ${mx} ${lift}, ${x2} ${y2}`;
  }
  if (mode === "drop" || (sameColumn(a, b) && b.y > a.y + 8)) {
    return dropPath(a, b);
  }
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function FlowLink({ spec }: { spec: LinkSpec }) {  const d = linkPath(spec.from, spec.to, spec.mode);
  const gap =
    spec.mode === "drop" || (sameColumn(spec.from, spec.to) && spec.to.y > spec.from.y)
      ? Math.max(10, spec.to.y - (spec.from.y + spec.from.h))
      : 80;
  const width = Math.min(gap * 0.45, 44, Math.max(2.5, Math.sqrt(Math.max(0, spec.value)) * 0.55));
  const color = TONE_COLOR[spec.tone];
  const gid = `g-${spec.from.id}-${spec.to.id}`.replace(/[^a-z0-9-]/gi, "");

  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={color} stopOpacity={0.05} />
          <stop offset="45%" stopColor={color} stopOpacity={spec.mode === "drop" ? 0.28 : 0.38} />
          <stop offset="100%" stopColor={color} stopOpacity={0.08} />
        </linearGradient>
      </defs>
      <path d={d} stroke={`url(#${gid})`} strokeWidth={width} fill="none" strokeLinecap="round" strokeDasharray={spec.dashed ? "7 7" : undefined} opacity={spec.value > 0 ? 1 : 0.25} />
    </g>
  );
}

/* -------------------------------------------------- journey → hop mapping */

export interface Hop {
  key: string;
  refId: string;
  fromNode: string;
  toNode: string;
  color: string;
}

export const ID_TO_NODE: Record<string, NodeDef> = Object.fromEntries(
  (Object.values(N) as NodeDef[]).map((n) => [n.id, n]),
);

const SINK_NODES = new Set(["fetch_failed", "prefilter_discards", "harness_discards"]);

const EDGE_MODE: Record<string, "side" | "drop" | "arc"> = {
  "src_rss|raw": "side",
  "src_gdelt|raw": "side",
  "src_search|raw": "side",
  "raw|fetch": "side",
  "fetch|prefilter": "side",
  "prefilter|dedupe": "side",
  "dedupe|waiting_room": "side",
  "waiting_room|harness": "side",
  "harness|winners": "side",
  "harness|harness_discards": "drop",
  "winners|webhooks": "drop",
  "harness|facts": "drop",
  "src_launch|waiting_room": "arc",
  "src_formd|waiting_room": "arc",
  "fetch|fetch_failed": "drop",
  "prefilter|prefilter_discards": "drop",
  "dedupe|prefilter_discards": "drop",
};

const PREV_NODE: Record<string, string> = {
  raw: "src_rss",
  fetch: "raw",
  prefilter: "fetch",
  dedupe: "prefilter",
  waiting_room: "dedupe",
  harness: "waiting_room",
  winners: "harness",
  webhooks: "winners",
  facts: "harness",
  fetch_failed: "fetch",
  prefilter_discards: "prefilter",
  harness_discards: "harness",
};

/** The linear spine of the programmatic chain + harness + publish. */
export const MAIN_CHAIN = ["raw", "fetch", "prefilter", "dedupe", "waiting_room", "harness", "winners"];

/** Nodes rendered as boxes the dot can travel between. Others are inspector-only detail. */
const ANIMATED_NODES = new Set([...MAIN_CHAIN, ...SINK_NODES, "src_rss", "src_gdelt", "src_search", "src_launch", "src_formd", "webhooks", "facts"]);

const NODE_DOT_COLOR: Record<string, string> = {
  raw: "#818cf8",
  fetch: "#818cf8",
  prefilter: "#818cf8",
  dedupe: "#818cf8",
  waiting_room: "#22d3ee",
  harness: "#a78bfa",
  winners: "#34d399",
  webhooks: "#c084fc",
  facts: "#f472b6",
  fetch_failed: "#fbbf24",
  prefilter_discards: "#fb7185",
  harness_discards: "#fb7185",
  src_launch: "#22d3ee",
  src_formd: "#22d3ee",
};

/**
 * Expand one journey package into consecutive hop pairs along real edges.
 * Steps at non-box nodes (cluster/facts annotations) are skipped for movement
 * but remain visible in the item inspector trail.
 */
export function journeyToHops(pkg: JourneyPackage): Hop[] {
  const steps = pkg.steps.filter((s) => ANIMATED_NODES.has(s.node));
  const hops: Hop[] = [];
  let prev: string | null = null;

  const pushHop = (from: string, to: string, i: number) => {
    hops.push({
      key: `${pkg.id}|${i}|${from}-${to}`,
      refId: pkg.ref_id,
      fromNode: from,
      toNode: to,
      color: NODE_DOT_COLOR[to] ?? NODE_DOT_COLOR[from] ?? "#818cf8",
    });
  };

  for (let i = 0; i < steps.length; i++) {
    const target = steps[i]!.node;
    if (prev === null) {
      const origin = inferOrigin(steps[i]!, pkg.terminal_node);
      if (origin && ID_TO_NODE[origin]) pushHop(origin, target, i);
      prev = target;
      continue;
    }
    if (target === prev) continue;
    // Same edge? direct.
    if (EDGE_MODE[`${prev}|${target}`]) {
      pushHop(prev, target, i);
      prev = target;
      continue;
    }
    // Spine walk when both ends sit on the main chain.
    const fromIdx = MAIN_CHAIN.indexOf(prev);
    const toIdx = MAIN_CHAIN.indexOf(target);
    if (fromIdx >= 0 && toIdx > fromIdx) {
      for (let j = fromIdx; j < toIdx; j++) pushHop(MAIN_CHAIN[j]!, MAIN_CHAIN[j + 1]!, i);
      prev = target;
      continue;
    }
    // Fall back to the canonical predecessor of the target.
    const via = PREV_NODE[target];
    if (via && ID_TO_NODE[via]) {
      if (via !== prev && !EDGE_MODE[`${prev}|${via}`]) {
        pushHop(via, target, i);
      } else {
        pushHop(via, target, i);
      }
      prev = target;
      continue;
    }
    prev = target;
  }
  return hops;
}

function inferOrigin(step: JourneyStep, terminalNode: string): string | null {
  const detail = (step.detail ?? "").toLowerCase();
  if (detail.includes("express lane")) return step.node === "waiting_room" ? "src_launch" : step.node === "src_formd" ? "src_formd" : "src_launch";
  if (step.node === "src_formd") return "src_formd";
  if (detail.startsWith("form d")) return "src_formd";
  if (step.node === "raw") {
    if (detail.includes("gdelt")) return "src_gdelt";
    if (detail.includes("search") || detail.includes("manual")) return "src_search";
    if (detail.includes("form d")) return "src_formd";
    return "src_rss";
  }
  if (terminalNode === "winners" && step.node === "waiting_room" && detail.includes("express")) return "src_launch";
  return PREV_NODE[step.node] ?? null;
}

/* -------------------------------------------------------------- LiveDots */

interface RunningDot {
  g: SVGGElement;
  halo: SVGCircleElement;
  core: SVGCircleElement;
  path: SVGPathElement;
  len: number;
  travel: number;
  bornAt: number;
}

const MAX_CONCURRENT_DOTS = 14;
const SPAWN_GAP_MS = 110;
const DOT_FADE_MS = 600;

/**
 * Real items walking the ribbons. One dot per item at a time: its next hop
 * starts only after the current one lands, so a traced article is visibly
 * carried edge to edge through the stages it actually passed through.
 */
export function LiveDots({ hops, onPickItem }: { hops: Hop[]; onPickItem: (refId: string) => void }) {
  const hostRef = useRef<SVGGElement>(null);
  const queues = useRef(new Map<string, Hop[]>());
  const running = useRef(new Map<string, RunningDot>());
  const queued = useRef(new Set<string>());
  const queuedOrder = useRef<string[]>([]);
  const lastSpawn = useRef(0);
  const onPickRef = useRef(onPickItem);

  useEffect(() => {
    onPickRef.current = onPickItem;
  }, [onPickItem]);

  useEffect(() => {
    for (const hop of hops) {
      if (queued.current.has(hop.key)) continue;
      queued.current.add(hop.key);
      queuedOrder.current.push(hop.key);
      const q = queues.current.get(hop.refId);
      if (q) q.push(hop);
      else queues.current.set(hop.refId, [hop]);
    }
    // `hops` is capped well below this, so evicted keys can never reappear.
    if (queuedOrder.current.length > 2000) {
      for (const key of queuedOrder.current.splice(0, 1000)) queued.current.delete(key);
    }
  }, [hops]);

  useEffect(() => {
    const svgNS = "http://www.w3.org/2000/svg";
    const live = running.current;

    const spawn = (hop: Hop, now: number): boolean => {
      const host = hostRef.current;
      const from = ID_TO_NODE[hop.fromNode];
      const to = ID_TO_NODE[hop.toNode];
      if (!host || !from || !to) return false;

      const mode = EDGE_MODE[`${hop.fromNode}|${hop.toNode}`]
        ? EDGE_MODE[`${hop.fromNode}|${hop.toNode}`]
        : SINK_NODES.has(hop.toNode)
          ? "drop"
          : "side";
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", linkPath(from, to, mode));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "none");
      path.setAttribute("pointer-events", "none");
      host.appendChild(path);
      const len = Math.max(1, path.getTotalLength());
      const origin = path.getPointAtLength(0);

      const g = document.createElementNS(svgNS, "g");
      g.style.cursor = "pointer";
      g.style.pointerEvents = "auto";
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        onPickRef.current(hop.refId);
      });
      const halo = document.createElementNS(svgNS, "circle");
      halo.setAttribute("r", "7");
      halo.setAttribute("fill", hop.color);
      halo.setAttribute("opacity", "0.3");
      const core = document.createElementNS(svgNS, "circle");
      core.setAttribute("r", "3.4");
      core.setAttribute("fill", hop.color);
      core.setAttribute("stroke", "#0a0b12");
      core.setAttribute("stroke-width", "0.8");
      for (const c of [halo, core]) {
        c.setAttribute("cx", String(origin.x));
        c.setAttribute("cy", String(origin.y));
      }
      g.append(halo, core);
      host.appendChild(g);

      live.set(hop.refId, {
        g,
        halo,
        core,
        path,
        len,
        travel: Math.max(1500, Math.min(6000, len * 7)),
        bornAt: now,
      });
      return true;
    };

    const retire = (refId: string, r: RunningDot) => {
      r.g.remove();
      r.path.remove();
      live.delete(refId);
    };

    let raf = 0;
    const tick = () => {
      if (!hostRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const now = Date.now();
      const continuing: string[] = [];

      for (const [refId, r] of live) {
        const t = now - r.bornAt;
        const p = Math.min(1, t / r.travel);
        const pt = r.path.getPointAtLength(p * r.len);
        r.core.setAttribute("cx", String(pt.x));
        r.core.setAttribute("cy", String(pt.y));
        r.halo.setAttribute("cx", String(pt.x));
        r.halo.setAttribute("cy", String(pt.y));
        if (t <= r.travel) continue;
        // Landed. If the item has another traced stage, keep walking without
        // fading — otherwise this is where its journey currently ends.
        if ((queues.current.get(refId)?.length ?? 0) > 0) {
          continuing.push(refId);
          continue;
        }
        const fade = 1 - (t - r.travel) / DOT_FADE_MS;
        r.g.style.opacity = String(Math.max(0, fade));
        if (fade <= 0) retire(refId, r);
      }

      for (const refId of continuing) {
        const r = live.get(refId);
        const next = queues.current.get(refId)?.shift();
        if (!r || !next) continue;
        retire(refId, r);
        spawn(next, now);
      }

      if (now - lastSpawn.current >= SPAWN_GAP_MS) {
        for (const [refId, q] of queues.current) {
          if (q.length === 0) {
            queues.current.delete(refId);
            continue;
          }
          if (live.has(refId)) continue;
          if (live.size >= MAX_CONCURRENT_DOTS) break;
          if (spawn(q.shift()!, now)) {
            lastSpawn.current = now;
            break;
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const r of live.values()) {
        r.g.remove();
        r.path.remove();
      }
      live.clear();
    };
  }, []);

  return <g ref={hostRef} />;
}
