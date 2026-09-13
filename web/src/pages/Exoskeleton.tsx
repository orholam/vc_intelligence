import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FlowLink,
  ago,
  compact,
  usd,
  useLivePipeline,
  journeyToHops,
  LiveDots,
  N,
  NODE_BLURB,
  NODE_TO_QUEUES,
  ID_TO_NODE,
  DIAGRAM_WIDTH,
  DIAGRAM_HEIGHT,
  type Activity,
  type Hop,
  type JourneyStep,
  type JourneyPackage,
  type LinkSpec,
  type NodeDef,
  type Snapshot,
} from "./live-pipeline";

/**
 * EXOSKELETON — the Live Pipeline console.
 *
 * Programmatic chain (no LLM): sources → raw intake → fetch/extract → rules
 * prefilter → wire dedupe → WAITING ROOM. The room accumulates indefinitely
 * until an operator fires THE HARNESS — one batched LLM job (corrections ·
 * new-company deep search · card updates) that publishes winners to /latest.
 *
 * Movement = journey packages: one per item at its terminal bucket, replayed
 * once on receipt. Refreshing the page replays nothing.
 */

const SINK_NODES = new Set(["fetch_failed", "prefilter_discards", "harness_discards"]);

/** One row from GET /v1/exoskeleton/flags — the durable miscategorization trail. */
interface MisflagRow {
  id: string;
  ref_id: string;
  kind: string;
  title: string | null;
  terminal_node: string | null;
  detail: string | null;
  steps: JourneyStep[] | null;
  note: string | null;
  created_at: string;
}

const KIND_COLOR: Record<string, string> = {
  discovered: "#818cf8",
  fetch_failed: "#fbbf24",
  discarded: "#fb7185",
  kept: "#34d399",
  fact: "#f472b6",
  source_event: "#94a3b8",
  pipeline_event: "#f97316",
};

export default function Exoskeleton() {
  const { snap, conn, journeys } = useLivePipeline();
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<{ kind: "node" | "item"; id: string } | null>(null);
  const [hops, setHops] = useState<Hop[]>([]);
  const [ghosting, setGhosting] = useState(false);
  const [ghostMsg, setGhostMsg] = useState<string | null>(null);
  const [harnessBusyLocal, setHarnessBusyLocal] = useState(false);
  const journeysById = useRef(new Map<string, JourneyPackage>());
  const journeysByRef = useRef(new Map<string, JourneyPackage>());
  const [flags, setFlags] = useState<MisflagRow[]>([]);
  const [flagBusy, setFlagBusy] = useState(false);
  /** Synthesized package for a flagged item from a previous session (no live journey). */
  const [inspectorPkg, setInspectorPkg] = useState<JourneyPackage | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Every new journey package becomes a hop chain. Nothing is animated from
  // snapshots or on load — movement only ever comes from completed packages.
  useEffect(() => {
    if (journeys.length === 0) return;
    const fresh: Hop[] = [];
    for (const pkg of journeys) {
      if (journeysById.current.has(pkg.id)) continue;
      journeysById.current.set(pkg.id, pkg);
      journeysByRef.current.set(pkg.ref_id, pkg);
      if (journeysById.current.size > 600) {
        const first = journeysById.current.keys().next().value;
        if (first) {
          const evicted = journeysById.current.get(first);
          journeysById.current.delete(first);
          if (evicted) journeysByRef.current.delete(evicted.ref_id);
        }
      }
      fresh.push(...journeyToHops(pkg));
    }
    if (fresh.length === 0) return;
    setHops((cur) => [...cur, ...fresh].slice(-400));
  }, [journeys]);

  // Durable operator flags: loaded once on mount. Flags survive the 2h
  // journey retention, so a marked verdict stays re-inspectable afterwards.
  useEffect(() => {
    let alive = true;
    fetch("/v1/exoskeleton/flags")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { flags?: MisflagRow[] } | null) => {
        if (alive && Array.isArray(body?.flags)) setFlags(body.flags!);
      })
      .catch(() => {
        /* offline console — flags just don't render */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Feed rows: latest terminal package per item (a waiting-room package is
  // superseded when the harness later publishes or discards the same ref).
  const pkgsByRef = useMemo(() => {
    const m = new Map<string, JourneyPackage>();
    for (const pkg of journeys) m.set(pkg.ref_id, pkg);
    return m;
  }, [journeys]);

  const feedRows = useMemo(
    () =>
      [...pkgsByRef.values()].sort((a, b) =>
        (b.created_at || b.steps[b.steps.length - 1]?.ts || "").localeCompare(
          a.created_at || a.steps[a.steps.length - 1]?.ts || "",
        ),
      ),
    [pkgsByRef],
  );

  const flagByRef = useMemo(() => {
    const m = new Map<string, MisflagRow>();
    for (const f of flags) m.set(f.ref_id, f);
    return m;
  }, [flags]);

  const flagItem = useCallback(async (pkg: JourneyPackage, note: string) => {
    setFlagBusy(true);
    try {
      const kind = pkg.ref_id.startsWith("fct_") ? "fact" : pkg.ref_id.startsWith("rit_") ? "raw" : "article";
      const res = await fetch("/v1/exoskeleton/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref_id: pkg.ref_id,
          kind,
          title: pkg.title,
          terminal_node: pkg.terminal_node,
          detail: pkg.steps[pkg.steps.length - 1]?.detail ?? pkg.steps[pkg.steps.length - 1]?.label ?? null,
          steps: pkg.steps,
          note: note || null,
        }),
      });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as { flag?: MisflagRow } | null;
      if (body?.flag) {
        setFlags((cur) => [body.flag!, ...cur.filter((f) => f.ref_id !== body.flag!.ref_id)]);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setFlagBusy(false);
    }
  }, []);

  const unflagItem = useCallback(async (flag: MisflagRow) => {
    try {
      const res = await fetch(`/v1/exoskeleton/flags/${encodeURIComponent(flag.id)}`, { method: "DELETE" });
      if (res.ok) setFlags((cur) => cur.filter((f) => f.id !== flag.id));
    } catch {
      /* offline — leave the flag in place */
    }
  }, []);

  const openItem = useCallback((refId: string) => {
    setInspectorPkg(null);
    setSelected({ kind: "item", id: refId });
  }, []);

  const openStoredFlag = useCallback((flag: MisflagRow) => {
    setInspectorPkg(flagToPackage(flag));
    setSelected({ kind: "item", id: flag.ref_id });
  }, []);

  const s = snap;

  const channelRate = useCallback(
    (ch: string) => s?.inbound.discovered_24h_by_channel.find((c) => c.channel === ch)?.n ?? 0,
    [s],
  );
  const backlogTotalPending = useMemo(
    () => (s ? s.inbound.backlog_by_channel.reduce((acc, c) => acc + c.pending, 0) : 0),
    [s],
  );
  const launchTotal24h = useMemo(
    () => (s ? s.side_channels.launches_by_surface_24h.reduce((a, b) => a + b.n, 0) : 0),
    [s],
  );
  const dupeCount24h = useMemo(
    () => s?.discard_reasons_24h.find((r) => r.reason === "title_duplicate_of")?.n ?? 0,
    [s],
  );

  const links: LinkSpec[] = useMemo(() => {
    if (!s) return [];
    const lastRun = s.harness.last_run;
    return [
      { from: N.srcRss, to: N.raw, value: channelRate("rss"), tone: "flow", mode: "side" },
      { from: N.srcGdelt, to: N.raw, value: channelRate("gdelt"), tone: "flow", mode: "side" },
      { from: N.srcSearch, to: N.raw, value: channelRate("search") + channelRate("manual"), tone: "flow", mode: "side" },
      { from: N.raw, to: N.fetch, value: s.stages.created_24h, tone: "flow", mode: "side" },
      { from: N.fetch, to: N.sinkFetchFail, value: s.inbound.failed_discovered_24h, tone: "fail", mode: "drop", dashed: true },
      { from: N.fetch, to: N.prefilter, value: s.stages.created_24h, tone: "flow", mode: "side" },
      { from: N.prefilter, to: N.dedupe, value: Math.max(0, s.stages.created_24h - s.stages.prefilter_24h), tone: "flow", mode: "side" },
      { from: N.prefilter, to: N.sinkRules, value: Math.max(0, s.stages.prefilter_24h - dupeCount24h), tone: "drop", mode: "drop" },
      { from: N.dedupe, to: N.sinkRules, value: dupeCount24h, tone: "drop", mode: "drop" },
      { from: N.dedupe, to: N.waiting, value: s.stages.backlog["waiting"] ?? s.stages.waiting_now, tone: "pass", mode: "side" },
      { from: N.waiting, to: N.harness, value: lastRun?.scanned ?? 0, tone: "express", mode: "side", dashed: true },
      { from: N.harness, to: N.winners, value: lastRun?.published ?? s.stages.published_24h, tone: "pass", mode: "side" },
      { from: N.harness, to: N.sinkHarness, value: s.stages.harness_discards_24h, tone: "drop", mode: "drop" },
      { from: N.harness, to: N.facts, value: lastRun?.cards_updated ?? s.entities.facts_accepted_24h, tone: "pass", mode: "drop" },
      { from: N.winners, to: N.webhooks, value: s.webhooks.delivered_24h + s.webhooks.pending_now, tone: "pass", mode: "drop" },
      { from: N.srcLaunch, to: N.waiting, value: launchTotal24h, tone: "express", mode: "arc", dashed: true },
      { from: N.srcFormd, to: N.waiting, value: s.side_channels.formd_facts_24h, tone: "express", mode: "arc", dashed: true },
    ];
  }, [s, channelRate, dupeCount24h, launchTotal24h]);

  const nodeMetrics = useCallback(
    (id: string): { primary: number | null; sub: string[] } => {
      if (!s) return { primary: null, sub: [] };
      const st = s.stages;
      const qn = (name: string, part: "all" | "active" = "all") => {
        const q = s.queues.find((x) => x.name === name);
        if (!q) return 0;
        return part === "active" ? q.active : q.waiting + q.active;
      };
      switch (id) {
        case N.srcRss.id:
          return { primary: channelRate("rss"), sub: [`T1–T3 · ${s.sources.active_total}/${s.sources.total} active`] };
        case N.srcGdelt.id:
          return { primary: channelRate("gdelt"), sub: [`watchlist · due ${s.sources.due_now}`] };
        case N.srcSearch.id:
          return { primary: channelRate("search") + channelRate("manual"), sub: ["on-demand discovery"] };
        case N.srcLaunch.id:
          return { primary: launchTotal24h, sub: [s.side_channels.launches_by_surface_24h.slice(0, 2).map((l) => l.surface).join(" · ") || "idle"] };
        case N.srcFormd.id:
          return { primary: s.side_channels.formd_facts_24h, sub: ["filing events / 24h"] };
        case N.raw.id:
          return { primary: backlogTotalPending, sub: ["waiting here now"] };
        case N.fetch.id:
          return { primary: qn("fetch-article"), sub: [`in flight · +${compact(st.created_24h)} extracted/24h`] };
        case N.prefilter.id:
          return { primary: Math.max(0, (st.pending_now ?? 0) - qn("filter-article", "active")), sub: [`waiting here · ${compact(st.prefilter_24h)} cut/24h`] };
        case N.dedupe.id:
          return { primary: dupeCount24h, sub: ["syndicated dupes / 24h"] };
        case N.waiting.id: {
          const oldest = s.harness.oldest_waiting_at ? `oldest ${ago(s.harness.oldest_waiting_at, now)}` : "empty";
          return { primary: st.waiting_now, sub: ["awaiting harness", oldest] };
        }
        case N.harness.id: {
          const run = s.harness.last_run;
          if (s.harness.running_now)
            return {
              primary: run?.published ?? 0,
              sub: [
                "RUNNING NOW…",
                run
                  ? `chunk ${run.chunk_done ?? 0}/${run.chunks_total ?? "?"} · ${run.relevance_discards} dropped · ${run.published} kept`
                  : "batch in flight",
              ],
            };
          if (run)
            return {
              primary: run.published,
              sub: [
                `last run ${ago(run.finished_at, now)} ago`,
                `${run.relevance_discards} discarded · ${run.new_companies_deep_searched} deep`,
              ],
            };
          return { primary: null, sub: ["idle · manual trigger", "fire it from the header"] };
        }
        case N.winners.id:
          return { primary: st.published_24h, sub: [`= GET /v1/news/latest`, `${compact(st.clustered_24h)} stories matched/24h`] };
        case N.facts.id:
          return { primary: s.entities.facts_accepted_24h, sub: [`${compact(s.entities.facts_proposed_24h)} proposed/24h`] };
        case N.webhooks.id:
          return { primary: s.webhooks.pending_now, sub: [`${compact(s.webhooks.delivered_24h)} delivered/24h`] };
        case N.sinkFetchFail.id:
          return { primary: s.inbound.backlog_by_channel.reduce((a, c) => a + c.failed, 0), sub: ["parked now · click to inspect"] };
        case N.sinkRules.id:
          return { primary: st.backlog["prefilter"] ?? 0, sub: [`in stage · ${compact(st.prefilter_24h)}/24h`] };
        case N.sinkHarness.id:
          return { primary: st.backlog["llm_filter"] ?? 0, sub: [`judged irrelevant · ${compact(st.harness_discards_24h)}/24h`] };
        default:
          return { primary: null, sub: [] };
      }
    },
    [s, channelRate, dupeCount24h, launchTotal24h, backlogTotalPending, now],
  );

  const activityByNode = useCallback(
    (nodeId: string | null) => (s?.activity ?? []).filter((a) => (nodeId ? a.node === nodeId : true)),
    [s],
  );

  const recentForNode =
    selected?.kind === "node"
      ? selected.id === "sources"
        ? activityByNode(null).filter((a) => a.kind === "source_event")
        : activityByNode(selected.id)
      : [];

  const queueMap = useMemo(() => {
    const m = new Map<string, { waiting: number; active: number; failing: number }>();
    for (const q of s?.queues ?? []) m.set(q.name, q);
    return m;
  }, [s]);

  const budgetPct = s ? Math.min(100, (s.llm.budget.spent_usd / Math.max(1, s.llm.budget.cap_usd)) * 100) : 0;
  const softPct = s ? Math.min(100, (s.llm.budget.soft_limit_usd / Math.max(1, s.llm.budget.cap_usd)) * 100) : 90;

  const hourlyMax = useMemo(
    () => Math.max(1, ...(s?.hourly_24h ?? []).map((h) => Math.max(h.published, h.discarded))),
    [s],
  );

  const connPill =
    conn === "live"
      ? { cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300", dot: "bg-emerald-400 animate-pulse", text: "LIVE · SSE stream" }
      : conn === "poll"
        ? { cls: "border-amber-400/40 bg-amber-400/10 text-amber-300", dot: "bg-amber-400", text: "POLLING · 4s fallback" }
        : conn === "connecting"
          ? { cls: "border-slate-500/40 bg-slate-500/10 text-slate-300", dot: "bg-slate-400 animate-pulse", text: "CONNECTING…" }
          : { cls: "border-red-400/40 bg-red-400/10 text-red-300", dot: "bg-red-400", text: "OFFLINE" };

  const selBlurb = selected?.kind === "node" ? (NODE_BLURB[selected.id] ?? null) : null;
  const selectedItem =
    selected?.kind === "item"
      ? (inspectorPkg ?? journeysByRef.current.get(selected.id) ?? journeysById.current.get(selected.id))
      : undefined;
  const selectedFlag = selected?.kind === "item" && selectedItem ? flagByRef.get(selectedItem.ref_id) : undefined;

  const sendGhost = useCallback(async () => {
    if (ghosting) return;
    setGhosting(true);
    setGhostMsg(null);
    try {
      const res = await fetch("/v1/exoskeleton/ghost", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; rawItemId?: string; title?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setGhostMsg(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setGhostMsg(body?.rawItemId ? `queued ${body.rawItemId}` : "queued");
      setTimeout(() => setGhostMsg(null), 8000);
    } catch (e) {
      setGhostMsg(e instanceof Error ? e.message : "send failed");
    } finally {
      setGhosting(false);
    }
  }, [ghosting]);

  const runHarness = useCallback(async () => {
    if (harnessBusyLocal || s?.harness.running_now) return;
    setHarnessBusyLocal(true);
    try {
      const res = await fetch("/v1/exoskeleton/harness/run", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; run_id?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setGhostMsg(body?.error?.message ?? `harness HTTP ${res.status}`);
        setTimeout(() => setGhostMsg(null), 8000);
      }
    } catch {
      setGhostMsg("harness trigger failed");
      setTimeout(() => setGhostMsg(null), 8000);
    } finally {
      // The running pill takes over from the snapshot; release the local lock either way.
      setTimeout(() => setHarnessBusyLocal(false), 5000);
    }
  }, [harnessBusyLocal, s]);

  const harnessRunning = Boolean(s?.harness.running_now) || harnessBusyLocal;

  return (
    <div className="min-h-screen bg-[#0a0b12] font-sans text-slate-200">
      {/* ---------------------------------------------------------- header */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#0a0b12]/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-lg font-bold tracking-[0.28em] text-slate-100">EXOSKELETON</h1>
            <span className="hidden text-[11px] uppercase tracking-[0.18em] text-slate-500 sm:inline">live pipeline observability</span>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${connPill.cls}`}>
            <i className={`h-1.5 w-1.5 rounded-full ${connPill.dot}`} />
            {connPill.text}
          </span>
          {s && (
            <>
              <span className="num hidden font-mono text-[11px] text-slate-500 md:inline">
                snapshot {ago(s.ts, now)} ago · built in {s.build_ms}ms
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
                <HeaderStat label="raw pending" value={backlogTotalPending} warn={backlogTotalPending > 400} />
                <HeaderStat label="waiting room" value={s.stages.waiting_now} warn={s.stages.waiting_now > s.harness.batch_limit} />
                <HeaderStat label="winners/24h" value={s.stages.published_24h} />
                <HeaderStat label="flagged" value={flags.length} warn={flags.length > 0} />
                <HeaderStat label="llm spend" value={usd(s.llm.budget.spent_usd)} warn={budgetPct > softPct} />
                {s.llm.budget.classify_only_mode && (
                  <span className="rounded border border-orange-400/50 bg-orange-400/10 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-orange-300">
                    CLASSIFY-ONLY MODE
                  </span>
                )}
                <button
                  type="button"
                  disabled={harnessRunning}
                  onClick={runHarness}
                  title="Fire the single batched LLM job over the entire waiting room (corrections → deep search → card updates → publish)"
                  className={`rounded px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider transition ${
                    harnessRunning
                      ? "cursor-wait border border-violet-400/60 bg-violet-400/15 text-violet-200"
                      : "border border-emerald-400/50 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                  }`}
                >
                  {s.harness.running_now ? "HARNESS RUNNING…" : harnessBusyLocal ? "QUEUEING…" : "▶ RUN HARNESS"}
                </button>
                <GhostButton sending={ghosting} message={ghostMsg} onSend={sendGhost} />
              </div>
            </>
          )}
        </div>
        {s?.harness.running_now && (
          <div className="mx-auto max-w-[1720px] px-5 pb-2">
            <div className="inline-flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-400/[0.08] px-2 py-1">
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-300" />
              <span className="font-mono text-[10px] tracking-wide text-violet-200">
                harness sweeping the waiting room — corrections → deep search → card updates → publish
              </span>
            </div>
          </div>
        )}
      </header>

      {!s && (
        <div className="flex min-h-[70vh] items-center justify-center">
          <p className="animate-pulse font-mono text-sm tracking-widest text-slate-500">BOOTING LIVE PIPELINE…</p>
        </div>
      )}

      {s && (
        <main className="mx-auto grid max-w-[1720px] grid-cols-1 gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* ------------------------------------------------- diagram card */}
          <section className="min-w-0 space-y-5">
            <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0d0f17] shadow-[0_0_40px_rgba(99,102,241,0.06)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-2.5">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">
                  live pipeline
                </p>
                <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-slate-500">
                  <Legend color="#818cf8" label="article flow" />
                  <Legend color="#34d399" label="surviving pass" />
                  <Legend color="#fb7185" label="discarded" />
                  <Legend color="#fbbf24" label="failures" />
                  <Legend color="#22d3ee" label="express / manual" dashed />
                  <span className="text-slate-400">· each dot is a real item's packaged journey — click it</span>
                </div>
              </div>
              <FlowDiagram
                links={links}
                nodeMetrics={nodeMetrics}
                queueMap={queueMap}
                activity={s.activity}
                now={now}
                hops={hops}
                journeysToday={journeys.length}
                selected={selected?.kind === "node" ? selected.id : null}
                onSelect={(id) => setSelected((cur) => (cur?.kind === "node" && cur.id === id ? null : { kind: "node", id }))}
                onPickItem={(refId) => {
                  setInspectorPkg(null);
                  setSelected({ kind: "item", id: refId });
                }}
              />
            </div>

            <LiveFeedPanel
              rows={feedRows}
              flags={flags}
              flagByRef={flagByRef}
              now={now}
              busy={flagBusy}
              onOpen={openItem}
              onOpenFlag={openStoredFlag}
              onFlag={flagItem}
              onUnflag={unflagItem}
            />

            {/* throughput + reasons */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Panel title="throughput · last 24h" right={<span className="font-mono text-[10px] text-slate-500">winners ▲ / discarded ▼ · UTC</span>}>
                <HourlyBars data={s.hourly_24h} max={hourlyMax} />
              </Panel>
              <Panel title="why things get cut · 24h" right={<span className="font-mono text-[10px] text-slate-500">{s.discard_reasons_24h.reduce((a, r) => a + r.n, 0).toLocaleString()} total</span>}>
                <ReasonBars reasons={s.discard_reasons_24h} />
              </Panel>
            </div>

            {/* sources health */}
            <Panel
              title="source registry health"
              right={
                <span className="font-mono text-[10px] text-slate-500">
                  {s.sources.active_total}/{s.sources.total} active · <span className="text-indigo-300">{s.sources.due_now} due now</span>
                </span>
              }
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {s.sources.tiers.map((t) => (
                  <div key={t.tier} className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[11px] font-bold tracking-wider text-slate-300">TIER {t.tier}</span>
                      <span className="num font-mono text-sm text-slate-100">{t.active}/{t.total}</span>
                    </div>
                    <div className="mt-1.5 h-1 rounded-full bg-white/[0.07]">
                      <div className="h-1 rounded-full bg-indigo-400/80" style={{ width: `${t.total ? (t.active / t.total) * 100 : 0}%` }} />
                    </div>
                    <p className="mt-1.5 font-mono text-[10px] text-slate-500">
                      {t.failing > 0 ? <span className="text-amber-400">{t.failing} failing · </span> : null}
                      {t.last_fetch ? `last poll ${ago(t.last_fetch, now)} ago` : "never polled"}
                    </p>
                  </div>
                ))}
              </div>
            </Panel>

            {s.harness.last_run && (
              <Panel
                title={s.harness.running_now ? "this harness run" : "last harness run"}
                right={
                  <span className="font-mono text-[10px] text-slate-500">
                    {s.harness.last_run.run_id}
                    {s.harness.running_now
                      ? ` · chunk ${s.harness.last_run.chunk_done ?? 0}/${s.harness.last_run.chunks_total ?? "?"}`
                      : s.harness.last_run.finished_at
                        ? ` · finished ${ago(s.harness.last_run.finished_at, now)} ago`
                        : ""}
                  </span>
                }
              >
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <Metric label="scanned" value={s.harness.last_run.scanned} color="text-slate-100" />
                  <Metric label="corrected" value={s.harness.last_run.corrected} color="text-violet-300" />
                  <Metric label="discarded" value={s.harness.last_run.relevance_discards} color="text-rose-300" />
                  <Metric label="published ✦" value={s.harness.last_run.published} color="text-emerald-300" />
                  <Metric label="deep searches" value={s.harness.last_run.new_companies_deep_searched} color="text-cyan-300" />
                  <Metric label="card updates" value={s.harness.last_run.cards_updated} color="text-pink-300" />
                </div>
                {s.harness.last_run.skip_reason && (
                  <p className="mt-2 font-mono text-[11px] text-amber-300">
                    skipped: {s.harness.last_run.skip_reason}
                    {s.harness.llm_provider ? ` · provider ${s.harness.llm_provider}` : ""}
                  </p>
                )}
              </Panel>
            )}
          </section>

          {/* ------------------------------------------------------ rail */}
          <aside className="space-y-5">
            {selected?.kind === "item" && (
              <ItemInspector
                pkg={selectedItem}
                refId={selected.id}
                now={now}
                flag={selectedFlag}
                busy={flagBusy}
                onFlag={selectedItem ? (note) => flagItem(selectedItem, note) : undefined}
                onUnflag={selectedFlag ? () => unflagItem(selectedFlag) : undefined}
                onClose={() => {
                  setSelected(null);
                  setInspectorPkg(null);
                }}
              />
            )}

            {selected?.kind === "node" && selBlurb && (
              <Drawer
                nodeId={selected.id}
                blurb={selBlurb}
                metrics={nodeMetrics(selected.id)}
                fallbackItems={recentForNode.slice(0, 14)}
                now={now}
                onClose={() => setSelected(null)}
              />
            )}

            <Panel title="live events" right={<span className="font-mono text-[10px] text-slate-500">{s.activity.length}</span>}>
              <ul className="max-h-80 space-y-px overflow-y-auto pr-1">
                {s.activity.map((a) => (
                  <li
                    key={a.id}
                    className="animate-fade-in cursor-default rounded px-1.5 py-1 transition hover:bg-white/[0.04]"
                    onClick={() => setSelected({ kind: "node", id: a.node })}
                  >
                    <div className="flex items-baseline gap-2">
                      <i className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: KIND_COLOR[a.kind] ?? "#94a3b8" }} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-snug text-slate-300" title={a.title}>
                        {a.kind === "kept" ? "✦ " : ""}{a.title}
                      </span>
                      <span className="num shrink-0 font-mono text-[10px] text-slate-600">{ago(a.ts, now)}</span>
                    </div>
                    {a.detail && <p className="ml-3.5 truncate pl-0.5 text-[10px] leading-snug text-slate-500">{a.detail}</p>}
                  </li>
                ))}
              </ul>
            </Panel>

            <QueueMonitor queues={s.queues} />

            <Panel
              title="llm budget"
              right={
                <span className="font-mono text-[10px] text-slate-500">
                  {s.llm.budget.month} · cap {usd(s.llm.budget.cap_usd)}
                </span>
              }
            >
              <div className="relative mt-1 h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${budgetPct > softPct ? "bg-gradient-to-r from-amber-400 to-rose-500" : "bg-gradient-to-r from-indigo-500 to-violet-400"}`}
                  style={{ width: `${budgetPct}%` }}
                />
                <div className="absolute inset-y-0 w-px bg-white/60" style={{ left: `${softPct}%` }} title="soft limit" />
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-500">
                <span className="text-slate-200">{usd(s.llm.budget.spent_usd)} spent ({budgetPct.toFixed(0)}%)</span>
                <span>{s.llm.blended_article_cost_usd !== null ? `${usd(s.llm.blended_article_cost_usd)}/article` : ""}</span>
              </div>
              {s.llm.degrade_events.length > 0 && (
                <div className="mt-2 rounded-md border border-orange-400/30 bg-orange-400/[0.07] px-2 py-1.5">
                  {s.llm.degrade_events.slice(0, 2).map((d) => (
                    <p key={d.created_at} className="truncate font-mono text-[10px] text-orange-300" title={d.message}>
                      ⚠ {d.kind.replace(/_/g, " ")}
                    </p>
                  ))}
                </div>
              )}
              <table className="mt-3 w-full">
                <tbody>
                  {s.llm.stages.slice(0, 6).map((st) => (
                    <tr key={st.stage} className="border-t border-white/[0.05]">
                      <td className="py-1 pr-2 font-mono text-[11px] text-slate-300">{st.stage}</td>
                      <td className="num py-1 text-right font-mono text-[11px] text-slate-500">{st.calls.toLocaleString()} calls</td>
                      <td className="num py-1 text-right font-mono text-[11px] text-slate-200">{usd(st.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel
              title="webhook fan-out"
              right={<span className="font-mono text-[10px] text-slate-500">{s.webhooks.subscriptions_active} subscriptions</span>}
            >
              <div className="grid grid-cols-3 gap-2 text-center">
                <Metric label="delivered 24h" value={s.webhooks.delivered_24h} color="text-emerald-300" />
                <Metric label="failed 24h" value={s.webhooks.failed_24h} color={s.webhooks.failed_24h > 0 ? "text-rose-300" : "text-slate-400"} />
                <Metric label="pending now" value={s.webhooks.pending_now} color={s.webhooks.pending_now > 20 ? "text-amber-300" : "text-slate-400"} />
              </div>
            </Panel>

            <Panel title="knowledge base">
              <div className="grid grid-cols-2 gap-2">
                <Metric label="entities · all types" value={s.entities.live_entities} color="text-slate-100" />
                <Metric label="created 24h" value={s.entities.created_24h} color="text-slate-300" />
                <Metric label="venture-banded" value={s.entities.banded} color="text-slate-300" />
                <Metric
                  label="needs backfill"
                  value={s.entities.needs_backfill_outstanding}
                  color={s.entities.needs_backfill_outstanding > 0 ? "text-amber-300" : "text-slate-400"}
                />
                <Metric label="facts proposed 24h" value={s.entities.facts_proposed_24h} color="text-pink-300" />
                <Metric label="profiles done 24h" value={s.entities.profiles_complete_24h} color="text-violet-300" />
              </div>
            </Panel>
          </aside>
        </main>
      )}

      <footer className="border-t border-white/[0.06] px-5 py-4">
        <p className="mx-auto max-w-[1720px] font-mono text-[10px] leading-relaxed text-slate-600">
          GET /v1/exoskeleton/snapshot · GET /v1/exoskeleton/stream (SSE: snapshot + one journey package per item) · GET /v1/exoskeleton/journeys?since=
          · GET/POST /v1/exoskeleton/flags · DELETE /v1/exoskeleton/flags/:id · POST /v1/exoskeleton/harness/run · POST /v1/exoskeleton/ghost
          — unauthenticated ops surface; admin gate pending. Click any node to inspect that stage, or a moving dot to read that item's full packaged journey.
          ✦ marks winners — what /v1/news/latest serves. The ⚑ feed flags verdicts you disagree with; those marks persist, the journeys themselves expire after 2h.
        </p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- components */

function HeaderStat({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`num font-mono text-sm font-semibold ${warn ? "text-amber-300" : "text-slate-100"}`}>
        {typeof value === "number" ? compact(value) : value}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
    </span>
  );
}

function GhostButton({
  sending,
  message,
  onSend,
}: {
  sending: boolean;
  message: string | null;
  onSend: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={sending}
        onClick={onSend}
        title="Inject a synthetic news item and watch its packaged journey land in the waiting room"
        className="rounded border border-fuchsia-400/50 bg-fuchsia-400/10 px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-fuchsia-200 transition hover:bg-fuchsia-400/20 disabled:cursor-wait disabled:opacity-60"
      >
        {sending ? "SENDING…" : "DEBUG · GHOST"}
      </button>
      {message && (
        <span className="max-w-[18rem] truncate font-mono text-[10px] text-fuchsia-300/80" title={message}>
          {message}
        </span>
      )}
    </span>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="6">
        <line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? "3 3" : undefined} strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0d0f17]">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">{title}</p>
        {right}
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-2 text-center">
      <p className={`num font-mono text-base font-semibold ${color}`}>{compact(value)}</p>
      <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
    </div>
  );
}

function ReasonBars({ reasons }: { reasons: Array<{ stage: string; reason: string; n: number }> }) {
  const max = Math.max(1, ...reasons.map((r) => r.n));
  const stageColor = (stage: string) => (stage === "harness" ? "#fb7185" : stage === "prefilter" ? "#f472b6" : "#94a3b8");
  return (
    <ul className="space-y-1.5">
      {reasons.length === 0 && <li className="font-mono text-[11px] text-slate-600">nothing discarded in the window.</li>}
      {reasons.map((r) => (
        <li key={`${r.stage}-${r.reason}`} className="flex items-center gap-2">
          <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: stageColor(r.stage) }} />
          <span className="w-56 shrink-0 truncate font-mono text-[11px] text-slate-300" title={r.reason}>{r.reason}</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(r.n / max) * 100}%`, backgroundColor: stageColor(r.stage) }} />
          </div>
          <span className="num w-12 shrink-0 text-right font-mono text-[11px] text-slate-400">{compact(r.n)}</span>
        </li>
      ))}
    </ul>
  );
}

function HourlyBars({ data, max }: { data: Snapshot["hourly_24h"]; max: number }) {
  return (
    <div className="flex h-36 items-stretch gap-[3px]">
      {data.map((h) => {
        const pubH = (h.published / max) * 100;
        const disH = (h.discarded / max) * 100;
        return (
          <div key={h.hour} className="group relative flex min-w-0 flex-1 flex-col justify-end" title={`${h.hour} UTC — published ${h.published} · discarded ${h.discarded} · discovered ${h.discovered} · extracted ${h.extracted}`}>
            <div className="flex flex-1 items-end">
              <div className="w-full rounded-t-sm bg-emerald-400/80 transition-all duration-500 group-hover:bg-emerald-300" style={{ height: `${Math.max(pubH, h.published > 0 ? 2 : 0)}%` }} />
            </div>
            <div className="h-px bg-white/25" />
            <div className="flex h-1/2 items-start pt-px">
              <div className="w-full rounded-b-sm bg-rose-400/60 transition-all duration-500 group-hover:bg-rose-300" style={{ height: `${Math.max(disH / 2, h.discarded > 0 ? 2 : 0)}%` }} />
            </div>
            <p className="mt-1 hidden text-center font-mono text-[8px] text-slate-600 group-hover:block sm:block">{h.hour.slice(0, 2)}</p>
          </div>
        );
      })}
    </div>
  );
}

function QueueMonitor({ queues }: { queues: Snapshot["queues"] }) {
  const priority = [
    "fetch-feed",
    "fetch-article",
    "filter-article",
    "harness-run",
    "webhook-sweep",
  ];
  const sorted = [...queues].sort((a, b) => {
    const ia = priority.indexOf(a.name);
    const ib = priority.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || b.waiting - a.waiting;
  });
  return (
    <Panel
      title="queue depths · pg-boss"
      right={
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-500">
          <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> working
        </span>
      }
    >
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {sorted.map((q) => {
          const busy = q.active > 0;
          const hot = q.waiting > 50 || q.failing > 0;
          return (
            <li key={q.name} className="flex items-center gap-1.5 border-b border-white/[0.04] pb-1">
              <i className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse bg-emerald-400" : hot ? "bg-amber-400/80" : "bg-slate-700"}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-400" title={q.name}>{q.name}</span>
              {q.failing > 0 && <span className="num font-mono text-[10px] font-bold text-amber-400">⚠{q.failing}</span>}
              <span className={`num font-mono text-[11px] font-semibold ${q.waiting > 0 ? "text-slate-100" : "text-slate-600"}`}>{q.waiting}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Drawer({
  nodeId,
  blurb,
  metrics,
  fallbackItems,
  now,
  onClose,
}: {
  nodeId: string;
  blurb: { title: string; blurb: string };
  metrics: { primary: number | null; sub: string[] };
  fallbackItems: Activity[];
  now: number;
  onClose: () => void;
}) {
  const [contents, setContents] = useState<{
    count: number;
    items: Array<{ id: string; title: string; detail: string | null; ts: string; url: string | null }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setContents(null);
    fetch(`/v1/exoskeleton/stage/${encodeURIComponent(nodeId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { count?: number; items?: Array<{ id: string; title: string; detail: string | null; ts: string; url: string | null }> } | null) => {
        if (!alive) return;
        if (body && Array.isArray(body.items)) {
          setContents({ count: Number(body.count ?? body.items.length), items: body.items });
        }
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [nodeId]);

  const listed = contents
    ? contents.items
    : fallbackItems.map((a) => ({ id: a.id, title: a.title, detail: a.detail ?? null, ts: a.ts, url: a.url ?? null }));
  const count = contents?.count ?? metrics.primary;
  const accentClass = nodeId === "winners" ? "border-emerald-400/30 from-emerald-500/[0.09]" : nodeId === "harness" ? "border-violet-400/30 from-violet-500/[0.09]" : "border-indigo-400/30 from-indigo-500/[0.09]";
  const countClass = nodeId === "winners" ? "text-emerald-200" : nodeId === "harness" ? "text-violet-200" : "text-indigo-200";

  return (
    <div className={`animate-fade-in relative rounded-xl border bg-gradient-to-br to-transparent p-4 ${accentClass}`}>
      <button onClick={onClose} className="absolute right-3 top-3 font-mono text-[13px] leading-none text-slate-500 transition hover:text-slate-200" aria-label="close">
        ✕
      </button>
      <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-indigo-300/80">stage inspector · in this stage</p>
      <h3 className="mt-1 text-sm font-semibold text-slate-100">{blurb.title}</h3>
      {count !== null && (
        <p className={`num mt-1 font-mono text-2xl font-bold ${countClass}`}>
          {count.toLocaleString()}
          <span className="ml-2 align-middle font-mono text-[10px] font-normal uppercase tracking-wider text-slate-500">
            {metrics.sub.join(" · ")}
          </span>
        </p>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{blurb.blurb}</p>
      {(NODE_TO_QUEUES[nodeId]?.length ?? 0) > 0 && (
        <p className="mt-2 font-mono text-[10px] text-slate-500">
          queues: {NODE_TO_QUEUES[nodeId]!.join(", ")}
        </p>
      )}
      {loading && listed.length === 0 && (
        <p className="mt-3 font-mono text-[10px] text-slate-600">loading items…</p>
      )}
      {listed.length > 0 && (
        <ul className="mt-3 max-h-64 space-y-px overflow-y-auto border-t border-white/[0.07] pt-2">
          {listed.map((a) => (
            <li key={a.id} className="flex items-baseline gap-2 py-0.5">
              <i className="mt-1 h-1 w-1 shrink-0 rounded-full bg-indigo-300" />
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-300 hover:text-indigo-200" title={a.title}>
                  {a.title}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-300" title={a.title}>{a.title}</span>
              )}
              <span className="num shrink-0 font-mono text-[9px] text-slate-600">{ago(a.ts, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {!loading && listed.length === 0 && (
        <p className="mt-3 font-mono text-[10px] text-slate-600">nothing sitting in this stage right now.</p>
      )}
    </div>
  );
}

/** Inspector for one item: its FULL packaged journey + terminal verdict blazon. */
function ItemInspector({
  pkg,
  refId,
  now,
  flag,
  busy,
  onFlag,
  onUnflag,
  onClose,
}: {
  pkg: JourneyPackage | undefined;
  refId: string;
  now: number;
  flag?: MisflagRow | null;
  busy?: boolean;
  onFlag?: (note: string) => Promise<boolean>;
  onUnflag?: () => void;
  onClose: () => void;
}) {
  const steps = pkg?.steps ?? [];
  const winner = pkg?.terminal_node === "winners";
  const verdictLabel =
    pkg?.terminal_node === "winners"
      ? "✦ WINNER · SERVED ON /LATEST"
      : pkg?.terminal_node === "waiting_room"
        ? "IN THE WAITING ROOM · AWAITING HARNESS"
        : pkg?.terminal_node === "dedupe"
          ? "DUPLICATE · SYNDICATED COPY"
          : pkg?.terminal_node === "fetch_failed"
            ? "FETCH FAILED · PARKED"
            : pkg?.terminal_node === "harness_discards"
              ? "DISCARDED BY HARNESS"
              : pkg?.terminal_node === "prefilter_discards"
                ? "RULE DISCARD"
                : null;
  const verdictColor = winner ? "text-emerald-300" : pkg?.terminal_node === "harness_discards" || pkg?.terminal_node === "prefilter_discards" || pkg?.terminal_node === "dedupe" ? "text-rose-300" : "text-cyan-300";

  return (
    <div className={`animate-fade-in relative rounded-xl border bg-gradient-to-br to-transparent p-4 ${winner ? "border-emerald-400/40 from-emerald-500/[0.12]" : "border-emerald-400/30 from-emerald-500/[0.09]"}`}>
      <button onClick={onClose} className="absolute right-3 top-3 font-mono text-[13px] leading-none text-slate-500 transition hover:text-slate-200" aria-label="close">
        ✕
      </button>
      <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-emerald-300/80">item inspector · packaged journey</p>
      <h3 className="mt-1 pr-5 text-sm font-semibold leading-snug text-slate-100">{pkg?.title ?? "Waiting for its terminal bucket…"}</h3>
      <p className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{refId}</p>
      {verdictLabel && (
        <p className={`mt-2 inline-block rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider ${winner ? "border-emerald-400/50 bg-emerald-400/10" : "border-white/10 bg-white/[0.04]"} ${verdictColor}`}>
          {verdictLabel}
        </p>
      )}
      {flag && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/[0.08] px-2 py-1.5">
          <span className="shrink-0 font-mono text-[10px] font-bold tracking-wider text-amber-200">⚑ FLAGGED MISCATEGORIZED</span>
          {flag.note && (
            <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-amber-200/90" title={flag.note}>
              “{flag.note}”
            </span>
          )}
        </div>
      )}
      <ol className="mt-3 space-y-1.5 border-t border-white/[0.07] pt-2.5">
        {[...steps].reverse().map((st, idx) => {
          const color = NODE_COLOR(st.node);
          return (
            <li key={`${st.ts}-${st.node}-${idx}`} className="flex items-baseline gap-2">
              <span
                className="shrink-0 rounded px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider"
                style={{ backgroundColor: `${color}22`, color }}
              >
                {st.node.replace(/_/g, " ")}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-400" title={st.detail ?? undefined}>{st.detail ?? st.label ?? ""}</span>
              <span className="num shrink-0 font-mono text-[9px] text-slate-600">{ago(st.ts, now)}</span>
            </li>
          );
        })}
        {steps.length === 0 && <li className="font-mono text-[11px] text-slate-600">this item landed before you opened the page — only post-load journeys carry packages.</li>}
      </ol>
      {pkg && (
        <div className="mt-3 border-t border-white/[0.07] pt-2.5">
          <FlagControl
            flagged={Boolean(flag)}
            busy={Boolean(busy)}
            onSave={onFlag ?? (async () => false)}
            onRemove={onUnflag ?? (() => {})}
          />
        </div>
      )}
    </div>
  );
}

/** Rebuild an inspectable package from a persisted flag (pre-session journeys). */
function flagToPackage(f: MisflagRow): JourneyPackage {
  const step: JourneyStep = {
    node: f.terminal_node ?? "unknown",
    ts: f.created_at,
    label: f.title ?? f.ref_id,
    detail: f.detail,
  };
  return {
    id: f.id,
    ref_id: f.ref_id,
    terminal_node: f.terminal_node ?? "unknown",
    title: f.title,
    steps: f.steps && f.steps.length > 0 ? f.steps : [step],
    created_at: f.created_at,
  };
}

function verdictChip(node: string): { text: string; cls: string; help: string } {
  switch (node) {
    case "winners":
      return {
        text: "✦ PUBLISHED",
        cls: "border-emerald-400/50 bg-emerald-400/10 text-emerald-300",
        help: "Survived every gate — this is what /v1/news/latest serves.",
      };
    case "harness_discards":
      return {
        text: "HARNESS DISCARD",
        cls: "border-rose-400/50 bg-rose-400/10 text-rose-300",
        help: "The batch audit judged it irrelevant or unpublishable — the why line is its reason.",
      };
    case "prefilter_discards":
      return {
        text: "RULE DISCARD",
        cls: "border-rose-400/50 bg-rose-400/10 text-rose-300",
        help: "Failed a deterministic rule (regex pattern, URL block, short title/body, slop title).",
      };
    case "dedupe":
      return {
        text: "DUPLICATE",
        cls: "border-amber-400/50 bg-amber-400/10 text-amber-300",
        help: "The same story was already ingested — the why line names what it duplicated against.",
      };
    case "fetch_failed":
      return {
        text: "FETCH FAILED",
        cls: "border-amber-400/50 bg-amber-400/10 text-amber-300",
        help: "Couldn't fetch or extract the article (robots-blocked, HTTP error, or empty body).",
      };
    case "waiting_room":
      return {
        text: "WAITING ROOM",
        cls: "border-cyan-400/50 bg-cyan-400/10 text-cyan-300",
        help: "Passed every programmatic gate — parked until the harness runs. NOT rejected.",
      };
    default:
      return {
        text: node.replace(/_/g, " ").toUpperCase(),
        cls: "border-white/15 bg-white/[0.05] text-slate-300",
        help: node,
      };
  }
}

function FlagControl({
  flagged,
  busy,
  onSave,
  onRemove,
}: {
  flagged: boolean;
  busy: boolean;
  onSave: (note: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  if (flagged) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={onRemove}
        title="Flagged as miscategorized — click to remove the flag"
        className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px font-mono text-[9px] font-bold tracking-wider text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-60"
      >
        ⚑ MISCATEGORIZED ✕
      </button>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        title="Mark this verdict as miscategorized — persisted beyond the 2h journey retention"
        className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-px font-mono text-[9px] tracking-wider text-slate-500 transition hover:border-amber-400/40 hover:text-amber-200 disabled:opacity-60"
      >
        ⚑ miscategorized
      </button>
    );
  }
  const save = async () => {
    setSaving(true);
    const ok = await onSave(note);
    setSaving(false);
    if (ok) {
      setOpen(false);
      setNote("");
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="I disagree because…"
        className="w-44 rounded border border-amber-400/30 bg-[#0a0b12] px-1.5 py-0.5 font-mono text-[9.5px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
      />
      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="rounded border border-amber-400/50 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-amber-200 disabled:opacity-60"
      >
        SAVE
      </button>
      <button type="button" onClick={() => setOpen(false)} className="font-mono text-[9px] text-slate-500 transition hover:text-slate-200">
        ✕
      </button>
    </span>
  );
}

const FEED_VERDICT_HELP: Array<{ node: string; help: string }> = [
  { node: "winners", help: "survived every gate → served on /latest" },
  { node: "prefilter_discards", help: "failed a deterministic rule (regex · URL · length · slop)" },
  { node: "harness_discards", help: "batch audit judged it irrelevant" },
  { node: "dedupe", help: "same story already ingested — why names it" },
  { node: "fetch_failed", help: "couldn't fetch or extract the article" },
  { node: "waiting_room", help: "passed all gates — waiting for the harness, not rejected" },
];

/** Verdict-type filters for the feed (waiting room is a separate opt-in toggle). */
type FeedTypeFilter = "all" | "winners" | "prefilter_discards" | "harness_discards" | "dedupe" | "fetch_failed";

const FEED_TYPE_OPTIONS: Array<{ node: FeedTypeFilter; text: string }> = [
  { node: "all", text: "all" },
  { node: "winners", text: "✦ published" },
  { node: "prefilter_discards", text: "rule discard" },
  { node: "harness_discards", text: "harness discard" },
  { node: "dedupe", text: "duplicate" },
  { node: "fetch_failed", text: "fetch failed" },
];

/** Plain-language legend so every verdict chip is self-explanatory. */
function FeedLegend() {
  return (
    <ul className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-white/[0.06] pb-2.5">
      {FEED_VERDICT_HELP.map((v) => {
        const chip = verdictChip(v.node);
        return (
          <li key={v.node} className="flex items-center gap-1.5" title={chip.help}>
            <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: NODE_COLOR(v.node) }} />
            <span className={`rounded border px-1.5 py-px font-mono text-[9px] font-bold tracking-wider ${chip.cls}`}>{chip.text}</span>
            <span className="font-mono text-[10px] text-slate-500">{v.help}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Live feed of item verdicts: every package received this session, latest
 * terminal per item, with the "why" (regex rule hit, duplicate target,
 * relevance reason…) and a ⚑ flag to mark verdicts the operator disagrees
 * with. Flags are durable — they survive the 2h journey retention.
 */
function LiveFeedPanel({
  rows,
  flags,
  flagByRef,
  now,
  busy,
  onOpen,
  onOpenFlag,
  onFlag,
  onUnflag,
}: {
  rows: JourneyPackage[];
  flags: MisflagRow[];
  flagByRef: Map<string, MisflagRow>;
  now: number;
  busy: boolean;
  onOpen: (refId: string) => void;
  onOpenFlag: (flag: MisflagRow) => void;
  onFlag: (pkg: JourneyPackage, note: string) => Promise<boolean>;
  onUnflag: (flag: MisflagRow) => void;
}) {
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  const [type, setType] = useState<FeedTypeFilter>("all");
  // Waiting-room items dominate the funnel (thousands parked vs a handful of
  // other verdicts) — hidden by default, opt back in with the toggle below.
  const [showParked, setShowParked] = useState(false);
  // Flags whose live package has already expired — the durable backlog the
  // 2h journey retention would otherwise have deleted the "why" for.
  const stale = useMemo(() => flags.filter((f) => !flagByRef.has(f.ref_id)), [flags, flagByRef]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.terminal_node] = (c[r.terminal_node] ?? 0) + 1;
    return c;
  }, [rows]);
  const shown = useMemo(() => {
    const base = filter === "flagged" ? rows.filter((r) => flagByRef.has(r.ref_id)) : rows;
    return base.filter(
      (r) => (showParked || r.terminal_node !== "waiting_room") && (type === "all" || r.terminal_node === type),
    );
  }, [rows, filter, flagByRef, showParked, type]);

  return (
    <Panel
      title="live feed · item verdicts"
      right={
        <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            {FEED_TYPE_OPTIONS.map((opt) => {
              const active = type === opt.node;
              const n = opt.node === "all" ? rows.length - (counts.waiting_room ?? 0) : (counts[opt.node] ?? 0);
              const chip = opt.node === "all" ? null : verdictChip(opt.node);
              return (
                <button
                  key={opt.node}
                  type="button"
                  onClick={() => setType(opt.node)}
                  className={`flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[9.5px] tracking-wider transition ${
                    active
                      ? "border-indigo-400/50 bg-indigo-400/15 text-indigo-200"
                      : "border-white/10 bg-white/[0.03] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {chip && <i className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: NODE_COLOR(opt.node) }} />}
                  {opt.text}
                  <span className="num text-[9px] text-slate-500">{n}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setShowParked((v) => !v)}
              title="Waiting-room items are hidden by default because they overwhelm the feed"
              className={`flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[9.5px] tracking-wider transition ${
                showParked
                  ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-200"
                  : "border-white/10 bg-white/[0.03] text-slate-500 hover:text-slate-300"
              }`}
            >
              <i className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#22d3ee" }} />
              waiting room {showParked ? "shown" : "hidden"}
              <span className="num text-[9px] text-slate-500">{counts.waiting_room ?? 0}</span>
            </button>
          </span>
          <span className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-[#0a0b12] p-0.5 font-mono text-[10px]">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`rounded px-1.5 py-0.5 transition ${filter === "all" ? "bg-white/10 text-slate-200" : "text-slate-500 hover:text-slate-300"}`}
            >
              feed {rows.length}
            </button>
            <button
              type="button"
              onClick={() => setFilter("flagged")}
              className={`rounded px-1.5 py-0.5 transition ${filter === "flagged" ? "bg-amber-400/20 text-amber-200" : "text-slate-500 hover:text-slate-300"}`}
            >
              ⚑ {flags.length}
            </button>
          </span>
        </span>
      }
    >
      <p className="mb-3 font-mono text-[10px] leading-relaxed text-slate-500">
        every item that reached a final verdict this session — the chip says how it ended, the line under it says why.
        hit <span className="text-amber-300/90">⚑</span> on anything that looks wrong; those marks persist, the journeys themselves expire after 2h.
      </p>
      <FeedLegend />
      {filter === "flagged" && stale.length > 0 && (
        <div className="mb-2 rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-2 py-1.5">
          <p className="mb-1 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-amber-300/90">persisted flags · previous sessions</p>
          <ul className="space-y-1">
            {stale.map((f) => (
              <FlaggedHistoryRow key={f.id} flag={f} now={now} busy={busy} onOpen={onOpenFlag} onUnflag={onUnflag} />
            ))}
          </ul>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="py-6 text-center font-mono text-[11px] text-slate-600">
          {filter === "flagged"
            ? "nothing flagged yet — hit ⚑ on any verdict you disagree with."
            : type !== "all"
              ? "no items with this verdict this session — try another filter, or toggle the waiting-room chip."
              : rows.length === 0
                ? "no item has reached a final verdict this session — wait for the pipeline or hit DEBUG · GHOST to inject one."
                : "nothing here — it's all parked waiting-room items this session; toggle the waiting-room chip to see them."}
        </p>
      ) : (
        <SmoothFeedList>
          {shown.map((pkg) => {
            const flag = flagByRef.get(pkg.ref_id);
            const last = pkg.steps[pkg.steps.length - 1];
            const why = last?.detail ?? last?.label ?? null;
            const chip = verdictChip(pkg.terminal_node);
            return (
              <li
                key={pkg.id}
                data-key={pkg.id}
                className={`rounded-lg border px-3 py-2 transition hover:bg-white/[0.04] ${flag ? "border-amber-400/30 bg-amber-400/[0.07]" : "border-white/[0.05] bg-white/[0.02]"}`}
              >
                <button type="button" onClick={() => onOpen(pkg.ref_id)} className="flex w-full items-baseline gap-2 text-left">
                  <i className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: NODE_COLOR(pkg.terminal_node) }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-snug text-slate-100" title={pkg.title ?? pkg.ref_id}>
                    {pkg.title ?? pkg.ref_id}
                  </span>
                  <span className={`shrink-0 rounded border px-1.5 py-px font-mono text-[9px] font-bold tracking-wider ${chip.cls}`} title={chip.help}>
                    {chip.text}
                  </span>
                  <span className="num shrink-0 font-mono text-[10px] text-slate-500">{ago(pkg.created_at || last?.ts || "", now)}</span>
                </button>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-4">
                  {why && (
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] leading-snug text-slate-400" title={why}>
                      {why}
                    </span>
                  )}
                  <FlagControl
                    flagged={Boolean(flag)}
                    busy={busy}
                    onSave={(note) => onFlag(pkg, note)}
                    onRemove={() => {
                      const f = flagByRef.get(pkg.ref_id);
                      if (f) onUnflag(f);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </SmoothFeedList>
      )}
    </Panel>
  );
}

/**
 * One-column feed with FLIP layout animation: rows already on screen glide
 * to their new position when a newer item is inserted above them instead of
 * jumping (pair with `.feed-enter` which pops brand-new rows in).
 */
function SmoothFeedList({ children }: { children: ReactNode }) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const prevTops = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const entries = new Map<string, HTMLElement>();
    for (const el of Array.from(list.children) as HTMLElement[]) {
      const k = el.dataset.key;
      if (k) entries.set(k, el);
    }
    // Measure settled layout tops (skip rows still mid-glide from last pass).
    const nowTops = new Map<string, number>();
    for (const [k, el] of entries) {
      if (el.style.transform && el.style.transform !== "none") continue;
      nowTops.set(k, el.getBoundingClientRect().top);
    }
    for (const [k, el] of entries) {
      const top = nowTops.get(k);
      if (top === undefined) continue;
      if (!prevTops.current.has(k)) {
        el.classList.add("feed-enter"); // brand-new row: fade + slide in
        continue;
      }
      const delta = prevTops.current.get(k)! - top;
      if (Math.abs(delta) <= 0.5) continue;
      // Snap to the old spot, then animate back to where it now belongs.
      el.style.transition = "none";
      el.style.transform = `translateY(${delta.toFixed(1)}px)`;
      const settle = el;
      requestAnimationFrame(() => {
        settle.style.transition = "transform 0.25s ease";
        settle.style.transform = "translateY(0)";
        window.setTimeout(() => {
          settle.style.transition = "";
          settle.style.transform = "";
        }, 300);
      });
    }
    prevTops.current = nowTops;
  });

  return (
    <ul ref={listRef} className="flex max-h-[34rem] flex-col gap-1.5 overflow-y-auto pr-1">
      {children}
    </ul>
  );
}

/** One row of the durable persisted-flag backlog (journey already expired). */
function FlaggedHistoryRow({
  flag,
  now,
  busy,
  onOpen,
  onUnflag,
}: {
  flag: MisflagRow;
  now: number;
  busy: boolean;
  onOpen: (flag: MisflagRow) => void;
  onUnflag: (flag: MisflagRow) => void;
}) {
  const chip = verdictChip(flag.terminal_node ?? "");
  return (
    <li className="rounded px-1 py-1 transition hover:bg-white/[0.04]">
      <button type="button" onClick={() => onOpen(flag)} className="flex w-full items-baseline gap-2 text-left">
        <i className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-200" title={flag.title ?? flag.ref_id}>
          {flag.title ?? flag.ref_id}
        </span>
        <span className="num shrink-0 font-mono text-[9px] text-slate-600">{ago(flag.created_at, now)}</span>
      </button>
      <div className="ml-3.5 mt-0.5 flex flex-wrap items-center gap-1.5">
        {flag.terminal_node && <span className={`rounded border px-1.5 py-px font-mono text-[8.5px] font-bold tracking-wider ${chip.cls}`}>{chip.text}</span>}
        {flag.note ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-amber-300/90" title={flag.note}>
            “{flag.note}”
          </span>
        ) : flag.detail ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-slate-500" title={flag.detail}>
            {flag.detail}
          </span>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => onUnflag(flag)}
          title="Remove flag"
          className="shrink-0 font-mono text-[9px] text-slate-600 transition hover:text-rose-300"
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function NODE_COLOR(node: string): string {
  const colors: Record<string, string> = {
    raw: "#818cf8",
    fetch: "#818cf8",
    prefilter: "#818cf8",
    dedupe: "#818cf8",
    waiting_room: "#22d3ee",
    harness: "#a78bfa",
    cluster: "#a78bfa",
    facts: "#f472b6",
    webhooks: "#c084fc",
    winners: "#34d399",
    fetch_failed: "#fbbf24",
    prefilter_discards: "#fb7185",
    harness_discards: "#fb7185",
    src_launch: "#22d3ee",
    src_formd: "#22d3ee",
  };
  return colors[node] ?? "#818cf8";
}

/* ------------------------------------------------------------ flow diagram */

function FlowDiagram({
  links,
  nodeMetrics,
  queueMap,
  activity,
  now,
  hops,
  journeysToday,
  selected,
  onSelect,
  onPickItem,
}: {
  links: LinkSpec[];
  nodeMetrics: (id: string) => { primary: number | null; sub: string[] };
  queueMap: Map<string, { waiting: number; active: number; failing: number }>;
  activity: Activity[];
  now: number;
  hops: Hop[];
  journeysToday: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onPickItem: (refId: string) => void;
}) {
  const nodes = Object.values(N) as NodeDef[];
  const lastActivityAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of activity) {
      const t = new Date(a.ts).getTime();
      const cur = m.get(a.node);
      if (cur === undefined || t > cur) m.set(a.node, t);
    }
    return m;
  }, [activity]);

  return (
    <svg viewBox={`0 0 ${DIAGRAM_WIDTH} ${DIAGRAM_HEIGHT}`} className="block w-full select-none" role="img" aria-label="Live pipeline diagram">
      {/* column captions */}
      {[
        ["SOURCE", 78],
        ["INTAKE", 277],
        ["FETCH", 469],
        ["RULES", 653],
        ["WAITING ROOM", 964],
        ["HARNESS", 1176],
        ["OUTPUT ✦", 1375],
      ].map(([label, x]) => (
        <text key={label as string} x={(x as number) - 14} y={20} fill="#475569" fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="3">
          {label}
        </text>
      ))}

      {links.map((l) => (
        <FlowLink key={`${l.from.id}->${l.to.id}`} spec={l} />
      ))}

      {nodes.map((nd) => {
        const m = nodeMetrics(nd.id);
        const qs = NODE_TO_QUEUES[nd.id] ?? [];
        const active = qs.some((q) => (queueMap.get(q)?.active ?? 0) > 0);
        const recent = (lastActivityAt.get(nd.id) ?? 0) > now - 90_000;
        const isSink = SINK_NODES.has(nd.id);
        const isSel = selected === nd.id;
        const baseTone = isSink ? "#fb7185" : nd.id.startsWith("src") ? "#334155" : "#141826";
        const accent = isSink ? "#fb7185" : nd.id === "winners" ? "#34d399" : nd.id === "waiting_room" ? "#22d3ee" : nd.id.startsWith("src") ? "#64748b" : active ? "#34d399" : "#818cf8";
        return (
          <g key={nd.id} onClick={() => onSelect(nd.id)} className="cursor-pointer" opacity={isSel ? 1 : 0.96}>
            {(active || recent) && !nd.id.startsWith("src_") && (
              <rect
                x={nd.x - 3}
                y={nd.y - 3}
                width={nd.w + 6}
                height={nd.h + 6}
                rx={12}
                fill="none"
                stroke={active ? "#34d399" : accent}
                strokeWidth={1}
                opacity={active ? 0.85 : 0.35}
                className={active ? "animate-pulse" : undefined}
              />
            )}
            <rect
              x={nd.x}
              y={nd.y}
              width={nd.w}
              height={nd.h}
              rx={10}
              fill={baseTone}
              stroke={isSel ? "#a5b4fc" : accent}
              strokeOpacity={isSel ? 0.9 : nd.id === "winners" ? 0.55 : 0.35}
              strokeWidth={isSel ? 1.6 : nd.id === "winners" ? 1.4 : 1}
            />
            {/* dark ink on the rose sink fill; gray elsewhere */}
            <text x={nd.x + 10} y={nd.y + 17} fill={isSink ? "#4c0519" : nd.id === "winners" ? "#facc15" : "#94a3b8"} fontSize="8.5" fontFamily="ui-monospace, monospace" letterSpacing="1.4">
              {nd.label}
            </text>
            <text
              x={nd.x + 10}
              y={nd.y + (nd.h >= 92 ? 42 : isSink ? 36 : 33)}
              fill={isSink ? "#4c0519" : accent}
              fontSize={nd.h >= 92 ? 21 : isSink ? 19 : 16}
              fontWeight="700"
              fontFamily="Inter, ui-sans-serif"
            >
              {m.primary === null ? "—" : compact(m.primary)}
            </text>
            {m.sub.map((line, i) => (
              <text
                key={i}
                x={nd.x + 10}
                y={nd.y + nd.h - (isSink ? 8 : 9) - (m.sub.length - 1 - i) * 11}
                fill={isSink ? "#881337" : "#64748b"}
                fontSize="8.5"
                fontFamily="ui-monospace, monospace"
              >
                {line.length > 26 ? `${line.slice(0, 25)}…` : line}
              </text>
            ))}
          </g>
        );
      })}

      {/* ------------------------------------ live item journeys (real entities) */}
      <LiveDots hops={hops} onPickItem={onPickItem} />

      {/* session counter — proof this page animates only post-load packages */}
      <text x={DIAGRAM_WIDTH - 12} y={DIAGRAM_HEIGHT - 8} textAnchor="end" fill="#334155" fontSize="8.5" fontFamily="ui-monospace, monospace">
        {journeysToday} journey{journeysToday === 1 ? "" : "s"} received this session
      </text>
    </svg>
  );
}

// Re-exported for tests/storybook convenience.
export { ID_TO_NODE };
