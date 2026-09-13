import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ago,
  compact,
  useLivePipeline,
  type JourneyPackage,
  type JourneyStep,
} from "./live-pipeline";

/**
 * Waiting-room console. Answers four questions:
 * 1. How much is piling up in the waiting room?
 * 2. What never reached the room, and why?
 * 3. How is the harness resolving the room?
 * 4. Is it making mistakes? (examples + durable flags)
 *
 * Keeps RUN HARNESS, discard reasons, and the claim loop (off-page HTTP).
 */

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

function NODE_COLOR(node: string): string {
  const colors: Record<string, string> = {
    waiting_room: "#22d3ee",
    winners: "#34d399",
    fetch_failed: "#fbbf24",
    prefilter_discards: "#fb7185",
    harness_discards: "#fb7185",
    dedupe: "#fbbf24",
    facts: "#f472b6",
  };
  return colors[node] ?? "#818cf8";
}

export default function Exoskeleton() {
  const { snap, conn, journeys } = useLivePipeline();
  const [now, setNow] = useState(() => Date.now());
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [ghosting, setGhosting] = useState(false);
  const [ghostMsg, setGhostMsg] = useState<string | null>(null);
  const [harnessBusyLocal, setHarnessBusyLocal] = useState(false);
  const journeysByRef = useRef(new Map<string, JourneyPackage>());
  const [flags, setFlags] = useState<MisflagRow[]>([]);
  const [flagBusy, setFlagBusy] = useState(false);
  const [inspectorPkg, setInspectorPkg] = useState<JourneyPackage | null>(null);
  const [peekNode, setPeekNode] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    for (const pkg of journeys) journeysByRef.current.set(pkg.ref_id, pkg);
  }, [journeys]);

  useEffect(() => {
    let alive = true;
    fetch("/v1/exoskeleton/flags")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { flags?: MisflagRow[] } | null) => {
        if (alive && Array.isArray(body?.flags)) setFlags(body.flags!);
      })
      .catch(() => {
        /* offline */
      });
    return () => {
      alive = false;
    };
  }, []);

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
      /* leave in place */
    }
  }, []);

  const s = snap;
  const harnessRunning = Boolean(s?.harness.running_now) || harnessBusyLocal;

  const runHarness = useCallback(async () => {
    if (harnessBusyLocal || s?.harness.running_now) return;
    setHarnessBusyLocal(true);
    try {
      const res = await fetch("/v1/exoskeleton/harness/run", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setGhostMsg(body?.error?.message ?? `harness HTTP ${res.status}`);
        setTimeout(() => setGhostMsg(null), 8000);
      }
    } catch {
      setGhostMsg("harness trigger failed");
      setTimeout(() => setGhostMsg(null), 8000);
    } finally {
      setTimeout(() => setHarnessBusyLocal(false), 5000);
    }
  }, [harnessBusyLocal, s]);

  const sendGhost = useCallback(async () => {
    if (ghosting) return;
    setGhosting(true);
    setGhostMsg(null);
    try {
      const res = await fetch("/v1/exoskeleton/ghost", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { rawItemId?: string; error?: { message?: string } } | null;
      if (!res.ok) setGhostMsg(body?.error?.message ?? `HTTP ${res.status}`);
      else setGhostMsg(body?.rawItemId ? `queued ${body.rawItemId}` : "queued");
      setTimeout(() => setGhostMsg(null), 8000);
    } catch (e) {
      setGhostMsg(e instanceof Error ? e.message : "send failed");
    } finally {
      setGhosting(false);
    }
  }, [ghosting]);

  const connPill =
    conn === "live"
      ? { cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300", dot: "bg-emerald-400 animate-pulse", text: "LIVE" }
      : conn === "poll"
        ? { cls: "border-amber-400/40 bg-amber-400/10 text-amber-300", dot: "bg-amber-400", text: "POLL" }
        : conn === "connecting"
          ? { cls: "border-slate-500/40 bg-slate-500/10 text-slate-300", dot: "bg-slate-400 animate-pulse", text: "…" }
          : { cls: "border-red-400/40 bg-red-400/10 text-red-300", dot: "bg-red-400", text: "OFFLINE" };

  const selectedItem =
    selectedRef !== null
      ? (inspectorPkg ?? journeysByRef.current.get(selectedRef) ?? undefined)
      : undefined;
  const selectedFlag = selectedRef ? flagByRef.get(selectedRef) : undefined;
  const prefilterReasons = (s?.discard_reasons_24h ?? []).filter((r) => r.stage !== "harness");
  const harnessReasons = (s?.discard_reasons_24h ?? []).filter((r) => r.stage === "harness");
  const fetchFailedNow = s ? s.inbound.backlog_by_channel.reduce((a, c) => a + c.failed, 0) : 0;
  const last = s?.harness.last_run ?? null;

  return (
    <div className="min-h-screen bg-[#0a0b12] font-sans text-slate-200">
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#0a0b12]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <h1 className="font-mono text-lg font-bold tracking-[0.22em] text-slate-100">WAITING ROOM</h1>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${connPill.cls}`}>
            <i className={`h-1.5 w-1.5 rounded-full ${connPill.dot}`} />
            {connPill.text}
          </span>
          {s && (
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <HeaderStat label="waiting" value={s.stages.waiting_now} warn={s.stages.waiting_now > s.harness.batch_limit} />
              <HeaderStat label="flagged" value={flags.length} warn={flags.length > 0} />
              <button
                type="button"
                disabled={harnessRunning}
                onClick={() => void runHarness()}
                className={`rounded px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider transition ${
                  harnessRunning
                    ? "cursor-wait border border-violet-400/60 bg-violet-400/15 text-violet-200"
                    : "border border-emerald-400/50 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                }`}
              >
                {s.harness.running_now ? "HARNESS RUNNING…" : harnessBusyLocal ? "QUEUEING…" : "▶ RUN HARNESS"}
              </button>
              <button
                type="button"
                disabled={ghosting}
                onClick={() => void sendGhost()}
                className="rounded border border-white/15 px-2 py-0.5 font-mono text-[10px] text-slate-400 hover:text-slate-200 disabled:opacity-60"
              >
                {ghosting ? "…" : "ghost"}
              </button>
              {ghostMsg && <span className="max-w-xs truncate font-mono text-[10px] text-amber-300">{ghostMsg}</span>}
            </div>
          )}
        </div>
      </header>

      {!s && (
        <div className="flex min-h-[70vh] items-center justify-center">
          <p className="animate-pulse font-mono text-sm tracking-widest text-slate-500">LOADING…</p>
        </div>
      )}

      {s && (
        <main className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <Panel title="1 · waiting room" right={<span className="font-mono text-[10px] text-slate-500">passed rules, awaiting harness</span>}>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="num font-mono text-4xl font-semibold text-cyan-200">{compact(s.stages.waiting_now)}</p>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    batch limit {s.harness.batch_limit}
                    {s.harness.oldest_waiting_at ? ` · oldest ${ago(s.harness.oldest_waiting_at, now)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPeekNode("waiting_room")}
                  className="rounded border border-white/15 px-3 py-1 font-mono text-[11px] text-slate-300 hover:border-cyan-400/40"
                >
                  inspect pile
                </button>
              </div>
            </Panel>

            <Panel title="2 · never reached the room" right={<span className="font-mono text-[10px] text-slate-500">24h · with reasons</span>}>
              <div className="mb-3 grid grid-cols-3 gap-2">
                <SinkStat
                  label="fetch failed"
                  value={s.inbound.failed_discovered_24h}
                  parked={fetchFailedNow}
                  onClick={() => setPeekNode("fetch_failed")}
                />
                <SinkStat
                  label="rules / prefilter"
                  value={s.stages.prefilter_24h}
                  parked={s.stages.backlog["prefilter"] ?? 0}
                  onClick={() => setPeekNode("prefilter_discards")}
                />
                <SinkStat
                  label="raw pending"
                  value={s.inbound.backlog_by_channel.reduce((a, c) => a + c.pending, 0)}
                />
              </div>
              <ReasonBars reasons={prefilterReasons} />
            </Panel>

            <Panel
              title="3 · harness outcomes"
              right={
                last ? (
                  <span className="font-mono text-[10px] text-slate-500">
                    {s.harness.running_now
                      ? `chunk ${last.chunk_done ?? 0}/${last.chunks_total ?? "?"}`
                      : last.finished_at
                        ? `finished ${ago(last.finished_at, now)} ago`
                        : last.run_id}
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-slate-500">no run yet</span>
                )
              }
            >
              {last ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <Metric label="scanned" value={last.scanned} color="text-slate-100" />
                  <Metric label="corrected" value={last.corrected} color="text-violet-300" />
                  <Metric label="discarded" value={last.relevance_discards} color="text-rose-300" />
                  <Metric label="published" value={last.published} color="text-emerald-300" />
                  <Metric label="new companies" value={last.new_companies_deep_searched} color="text-cyan-300" />
                  <Metric label="facts" value={last.facts_proposed + last.facts_accepted} color="text-pink-300" />
                </div>
              ) : (
                <p className="font-mono text-[12px] text-slate-500">Fire RUN HARNESS. Keep GET /internal/llm/claim answering while it runs.</p>
              )}
              {last?.skip_reason && <p className="mt-2 font-mono text-[11px] text-amber-300">skipped: {last.skip_reason}</p>}
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="card updates" value={last?.cards_updated ?? 0} color="text-slate-300" />
                <Metric label="facts accepted 24h" value={s.entities.facts_accepted_24h} color="text-pink-300" />
                <Metric label="published 24h" value={s.stages.published_24h} color="text-emerald-300" />
                <Metric label="harness discards 24h" value={s.stages.harness_discards_24h} color="text-rose-300" />
              </div>
              {harnessReasons.length > 0 && (
                <div className="mt-3 border-t border-white/[0.06] pt-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">harness discard reasons</p>
                  <ReasonBars reasons={harnessReasons} />
                </div>
              )}
            </Panel>

            <LiveFeedPanel
              rows={feedRows}
              flags={flags}
              flagByRef={flagByRef}
              now={now}
              busy={flagBusy}
              onOpen={(refId) => {
                setInspectorPkg(null);
                setSelectedRef(refId);
              }}
              onOpenFlag={(flag) => {
                setInspectorPkg(flagToPackage(flag));
                setSelectedRef(flag.ref_id);
              }}
              onFlag={flagItem}
              onUnflag={unflagItem}
            />
          </div>

          <aside className="space-y-5">
            {peekNode && <StagePeek nodeId={peekNode} now={now} onClose={() => setPeekNode(null)} />}
            {selectedRef && (
              <ItemInspector
                pkg={selectedItem}
                refId={selectedRef}
                now={now}
                flag={selectedFlag}
                busy={flagBusy}
                onFlag={selectedItem ? (note) => flagItem(selectedItem, note) : undefined}
                onUnflag={selectedFlag ? () => unflagItem(selectedFlag) : undefined}
                onClose={() => {
                  setSelectedRef(null);
                  setInspectorPkg(null);
                }}
              />
            )}
            <p className="font-mono text-[10px] leading-relaxed text-slate-600">
              Claim loop stays HTTP: GET /internal/llm/claim. Flags persist after journeys expire.
              Admin merge for duplicate cards: POST /v1/admin/entities/merge.
            </p>
          </aside>
        </main>
      )}
    </div>
  );
}

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

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0d0f17]">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{title}</p>
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

function SinkStat({
  label,
  value,
  parked,
  onClick,
}: {
  label: string;
  value: number;
  parked?: number;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <p className="num font-mono text-lg font-semibold text-slate-100">{compact(value)}</p>
      <p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
      {parked !== undefined && <p className="font-mono text-[10px] text-slate-600">{compact(parked)} parked</p>}
    </>
  );
  if (!onClick) return <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-2">{inner}</div>;
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-2 text-left hover:border-white/20">
      {inner}
    </button>
  );
}

function ReasonBars({ reasons }: { reasons: Array<{ stage: string; reason: string; n: number }> }) {
  const max = Math.max(1, ...reasons.map((r) => r.n));
  const stageColor = (stage: string) => (stage === "harness" ? "#fb7185" : "#f472b6");
  return (
    <ul className="space-y-1.5">
      {reasons.length === 0 && <li className="font-mono text-[11px] text-slate-600">nothing discarded in the window.</li>}
      {reasons.map((r) => (
        <li key={`${r.stage}-${r.reason}`} className="flex items-center gap-2">
          <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: stageColor(r.stage) }} />
          <span className="w-48 shrink-0 truncate font-mono text-[11px] text-slate-300" title={r.reason}>
            {r.reason}
          </span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full" style={{ width: `${(r.n / max) * 100}%`, backgroundColor: stageColor(r.stage) }} />
          </div>
          <span className="num w-10 shrink-0 text-right font-mono text-[11px] text-slate-400">{compact(r.n)}</span>
        </li>
      ))}
    </ul>
  );
}

function StagePeek({ nodeId, now, onClose }: { nodeId: string; now: number; onClose: () => void }) {
  const [items, setItems] = useState<Array<{ id: string; title: string; detail: string | null; ts: string; url: string | null }>>([]);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/v1/exoskeleton/stage/${encodeURIComponent(nodeId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { count?: number; items?: Array<{ id: string; title: string; detail: string | null; ts: string; url: string | null }> } | null) => {
        if (!alive || !body) return;
        setCount(Number(body.count ?? body.items?.length ?? 0));
        setItems(body.items ?? []);
      })
      .catch(() => {
        /* offline */
      });
    return () => {
      alive = false;
    };
  }, [nodeId]);
  return (
    <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/[0.07] p-4">
      <button type="button" onClick={onClose} className="float-right font-mono text-[13px] text-slate-500" aria-label="close">
        ✕
      </button>
      <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-indigo-300/80">stage · {nodeId.replace(/_/g, " ")}</p>
      <p className="num mt-1 font-mono text-2xl font-bold text-indigo-100">{count === null ? "…" : count.toLocaleString()}</p>
      <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto border-t border-white/[0.07] pt-2">
        {items.map((a) => (
          <li key={a.id} className="flex items-baseline gap-2">
            {a.url ? (
              <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-300">
                {a.title}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-300">{a.title}</span>
            )}
            <span className="num shrink-0 font-mono text-[9px] text-slate-600">{ago(a.ts, now)}</span>
          </li>
        ))}
        {items.length === 0 && <li className="font-mono text-[10px] text-slate-600">empty.</li>}
      </ul>
    </div>
  );
}

function verdictChip(node: string): { text: string; cls: string } {
  switch (node) {
    case "winners":
      return { text: "PUBLISHED", cls: "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" };
    case "harness_discards":
      return { text: "HARNESS DISCARD", cls: "border-rose-400/50 bg-rose-400/10 text-rose-300" };
    case "prefilter_discards":
      return { text: "RULE DISCARD", cls: "border-rose-400/50 bg-rose-400/10 text-rose-300" };
    case "dedupe":
      return { text: "DUPLICATE", cls: "border-amber-400/50 bg-amber-400/10 text-amber-300" };
    case "fetch_failed":
      return { text: "FETCH FAILED", cls: "border-amber-400/50 bg-amber-400/10 text-amber-300" };
    case "waiting_room":
      return { text: "WAITING", cls: "border-cyan-400/50 bg-cyan-400/10 text-cyan-300" };
    default:
      return { text: node.replace(/_/g, " ").toUpperCase(), cls: "border-white/15 text-slate-300" };
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
      <button type="button" disabled={busy} onClick={onRemove} className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px font-mono text-[9px] font-bold text-amber-200">
        ⚑ FLAGGED ✕
      </button>
    );
  }
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className="rounded border border-white/10 px-1.5 py-px font-mono text-[9px] text-slate-500 hover:text-amber-200">
        ⚑ disagree
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
        className="w-44 rounded border border-amber-400/30 bg-[#0a0b12] px-1.5 py-0.5 font-mono text-[9.5px] text-slate-200"
      />
      <button type="button" disabled={saving} onClick={() => void save()} className="rounded border border-amber-400/50 px-1.5 py-0.5 font-mono text-[9px] text-amber-200">
        SAVE
      </button>
    </span>
  );
}

function flagToPackage(f: MisflagRow): JourneyPackage {
  const step: JourneyStep = { node: f.terminal_node ?? "unknown", ts: f.created_at, label: f.title ?? f.ref_id, detail: f.detail };
  return {
    id: f.id,
    ref_id: f.ref_id,
    terminal_node: f.terminal_node ?? "unknown",
    title: f.title,
    steps: f.steps && f.steps.length > 0 ? f.steps : [step],
    created_at: f.created_at,
  };
}

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
  const chip = verdictChip(pkg?.terminal_node ?? "");
  return (
    <div className="rounded-xl border border-white/15 bg-[#0d0f17] p-4">
      <button type="button" onClick={onClose} className="float-right font-mono text-[13px] text-slate-500" aria-label="close">
        ✕
      </button>
      <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">example</p>
      <h3 className="mt-1 pr-5 text-sm font-semibold text-slate-100">{pkg?.title ?? refId}</h3>
      <p className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{refId}</p>
      <p className={`mt-2 inline-block rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${chip.cls}`}>{chip.text}</p>
      {flag?.note && <p className="mt-2 font-mono text-[11px] text-amber-200">“{flag.note}”</p>}
      <ol className="mt-3 space-y-1.5 border-t border-white/[0.07] pt-2.5">
        {[...steps].reverse().map((st, idx) => (
          <li key={`${st.ts}-${st.node}-${idx}`} className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[9px] uppercase text-slate-500">{st.node.replace(/_/g, " ")}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-400">{st.detail ?? st.label ?? ""}</span>
            <span className="num shrink-0 font-mono text-[9px] text-slate-600">{ago(st.ts, now)}</span>
          </li>
        ))}
      </ol>
      {pkg && (
        <div className="mt-3 border-t border-white/[0.07] pt-2.5">
          <FlagControl flagged={Boolean(flag)} busy={Boolean(busy)} onSave={onFlag ?? (async () => false)} onRemove={onUnflag ?? (() => {})} />
        </div>
      )}
    </div>
  );
}

type FeedTypeFilter = "all" | "winners" | "prefilter_discards" | "harness_discards" | "dedupe" | "fetch_failed";

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
  const [type, setType] = useState<FeedTypeFilter>("all");
  const [showParked, setShowParked] = useState(false);
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  const stale = useMemo(() => flags.filter((f) => !flagByRef.has(f.ref_id)), [flags, flagByRef]);
  const shown = useMemo(() => {
    const base = filter === "flagged" ? rows.filter((r) => flagByRef.has(r.ref_id)) : rows;
    return base.filter((r) => (showParked || r.terminal_node !== "waiting_room") && (type === "all" || r.terminal_node === type));
  }, [rows, filter, flagByRef, showParked, type]);

  return (
    <Panel
      title="4 · examples"
      right={
        <span className="flex items-center gap-1 font-mono text-[10px]">
          <button type="button" onClick={() => setFilter("all")} className={filter === "all" ? "text-slate-200" : "text-slate-500"}>
            feed
          </button>
          <button type="button" onClick={() => setFilter("flagged")} className={filter === "flagged" ? "text-amber-200" : "text-slate-500"}>
            ⚑ {flags.length}
          </button>
        </span>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(["all", "winners", "prefilter_discards", "harness_discards", "dedupe", "fetch_failed"] as const).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setType(n)}
            className={`rounded border px-2 py-0.5 font-mono text-[9.5px] ${type === n ? "border-indigo-400/50 text-indigo-200" : "border-white/10 text-slate-500"}`}
          >
            {n === "all" ? "all" : verdictChip(n).text.toLowerCase()}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowParked((v) => !v)}
          className={`rounded border px-2 py-0.5 font-mono text-[9.5px] ${showParked ? "border-cyan-400/50 text-cyan-200" : "border-white/10 text-slate-500"}`}
        >
          waiting {showParked ? "on" : "hidden"}
        </button>
      </div>
      {filter === "flagged" && stale.length > 0 && (
        <ul className="mb-3 space-y-1 rounded border border-amber-400/25 bg-amber-400/[0.06] p-2">
          {stale.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => onOpenFlag(f)} className="truncate font-mono text-[11px] text-amber-100">
                {f.title ?? f.ref_id}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto">
        {shown.map((pkg) => {
          const flag = flagByRef.get(pkg.ref_id);
          const last = pkg.steps[pkg.steps.length - 1];
          const chip = verdictChip(pkg.terminal_node);
          return (
            <li key={pkg.id} className={`rounded-lg border px-3 py-2 ${flag ? "border-amber-400/30" : "border-white/[0.05]"}`}>
              <button type="button" onClick={() => onOpen(pkg.ref_id)} className="flex w-full items-baseline gap-2 text-left">
                <i className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: NODE_COLOR(pkg.terminal_node) }} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-100">{pkg.title ?? pkg.ref_id}</span>
                <span className={`shrink-0 rounded border px-1.5 py-px font-mono text-[9px] font-bold ${chip.cls}`}>{chip.text}</span>
                <span className="num shrink-0 font-mono text-[10px] text-slate-500">{ago(pkg.created_at || last?.ts || "", now)}</span>
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-4">
                {(last?.detail || last?.label) && (
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-400">{last?.detail ?? last?.label}</span>
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
        {shown.length === 0 && <li className="py-4 text-center font-mono text-[11px] text-slate-600">no examples this session yet.</li>}
      </ul>
    </Panel>
  );
}
