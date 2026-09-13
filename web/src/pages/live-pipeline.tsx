import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Waiting-room console data plane: snapshot polling/SSE + journey packages.
 * The page answers four questions — depth, pre-room loss, harness outcomes,
 * examples — without a plant schematic or packet animation.
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
