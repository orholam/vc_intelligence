import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eyebrow } from "../components/chrome";

/* ------------------------------ endpoint defs ------------------------------- */

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "date" | "number" | "select";
  options?: string[];
  required?: boolean;
};

type EndpointDef = {
  id: string;
  method: "GET" | "POST";
  path: string;
  name: string;
  blurb: string;
  pathParam?: Field;
  params?: Field[];
  bodyTemplate?: string;
};

const ENDPOINTS: EndpointDef[] = [
  {
    id: "news",
    method: "GET",
    path: "/v1/news/",
    name: "News by company",
    blurb:
      "Resolved, enriched articles for one company. `company` accepts an opaque id, slug, domain or article URL — unknown URLs are fetched and created on the fly.",
    params: [
      { key: "company", label: "company", placeholder: "acme.ai", required: true },
      { key: "unique_article", label: "unique_article", type: "select", options: ["", "true", "false"] },
      { key: "start_date", label: "start_date", type: "date" },
      { key: "end_date", label: "end_date", type: "date" },
      { key: "category", label: "category", placeholder: "funding.series_a,mna.acquisition" },
      { key: "blacklisted", label: "blacklisted", placeholder: "substack.com,medium.com" },
      { key: "limit", label: "limit", type: "number", placeholder: "10" },
      { key: "offset", label: "offset", type: "number", placeholder: "0" },
    ],
  },
  {
    id: "company",
    method: "GET",
    path: "/v1/companies/:id",
    name: "Company card",
    blurb:
      "The basic entity record plus derived stats: articles in the last 30 days, latest coverage date and top event types.",
    pathParam: { key: "id", label: "id", placeholder: "ent_00000l1", required: true },
  },
  {
    id: "search",
    method: "GET",
    path: "/v1/companies/search",
    name: "Company search",
    blurb:
      "Filtered search over the entity knowledge base. Grab an `ent_…` id from the results to open a full company card.",
    params: [
      { key: "q", label: "q", placeholder: "robotics" },
      { key: "industry", label: "industry", placeholder: "fintech" },
      { key: "country", label: "country", placeholder: "US" },
      { key: "limit", label: "limit", type: "number", placeholder: "10" },
      { key: "offset", label: "offset", type: "number", placeholder: "0" },
    ],
  },
  {
    id: "listgen",
    method: "POST",
    path: "/v1/list/generate/companies/",
    name: "ListGen · natural-language list",
    blurb:
      "A plain-language query becomes structured filters, then a ranked company list with recent signals attached. The response echoes interpreted_filters so you can correct misreads.",
    bodyTemplate: JSON.stringify(
      { query: "Series A robotics companies in the US", limit: 25 },
      null,
      2,
    ),
  },
  {
    id: "latest",
    method: "GET",
    path: "/v1/news/latest",
    name: "All-news feed",
    blurb:
      "Recent kept news across the index, not just one company. Every row has at least one company. Use unique_article to collapse a story cluster.",
    params: [
      { key: "unique_article", label: "unique_article", type: "select", options: ["", "true", "false"] },
      { key: "start_date", label: "start_date", type: "date" },
      { key: "end_date", label: "end_date", type: "date" },
      { key: "category", label: "category", placeholder: "funding.series_a,mna.acquisition" },
      { key: "limit", label: "limit", type: "number", placeholder: "10" },
      { key: "offset", label: "offset", type: "number", placeholder: "0" },
    ],
  },
  {
    id: "facts",
    method: "GET",
    path: "/v1/events/",
    name: "Structured facts",
    blurb:
      "Typed objects (funding round, acquisition, …) with amount, stage, and related fields. News of those types points at a row here.",
    params: [
      { key: "type", label: "type", placeholder: "funding_round,acquisition" },
      { key: "stage", label: "stage", placeholder: "series_a" },
      { key: "country", label: "country", placeholder: "US" },
      { key: "start_date", label: "start_date", type: "date" },
      { key: "end_date", label: "end_date", type: "date" },
      { key: "limit", label: "limit", type: "number", placeholder: "10" },
      { key: "offset", label: "offset", type: "number", placeholder: "0" },
    ],
  },
  {
    id: "feed",
    method: "GET",
    path: "/v1/feed",
    name: "Incremental feed",
    blurb:
      "Cursor-based incremental sync for polling clients: pass the next_cursor from the previous response as cursor.",
    params: [
      { key: "entities", label: "entities", placeholder: "ent_00000l1,ent_00000l2", required: true },
      { key: "since", label: "since", placeholder: "2026-08-01T00:00:00Z" },
      { key: "cursor", label: "cursor" },
      { key: "limit", label: "limit", type: "number", placeholder: "100" },
    ],
  },
];

const DEFAULTS: Record<string, Record<string, string>> = {
  news: { company: "acme.ai", unique_article: "true" },
  company: {},
  search: { q: "robotics" },
  listgen: {},
  latest: { unique_article: "true" },
  facts: { type: "funding_round" },
  feed: { entities: "ent_00000l1" },
};

/* -------------------------------- presets ----------------------------------- */

type Preset = {
  title: string;
  desc: string;
  endpointId: string;
  values?: Record<string, string>;
  body?: string;
};

const PRESETS: Preset[] = [
  {
    title: "Watch a company",
    desc: "Every resolved story about Acme Robotics, deduplicated to one article per story cluster.",
    endpointId: "news",
    values: { company: "acme.ai", unique_article: "true" },
  },
  {
    title: "Source new companies",
    desc: "Search the knowledge base by keyword, sector or country — then pull a full card by ent_ id.",
    endpointId: "search",
    values: { q: "robotics", country: "US" },
  },
  {
    title: "Shortlist by thesis",
    desc: "One sentence in, a ranked list out — with the filters the model inferred echoed back.",
    endpointId: "listgen",
  },
  {
    title: "Scan the index",
    desc: "Recent kept news across every company, one row per story.",
    endpointId: "latest",
    values: { unique_article: "true" },
  },
  {
    title: "List raises",
    desc: "Structured funding facts — amount, stage, date — not a pile of headlines.",
    endpointId: "facts",
    values: { type: "funding_round" },
  },
];

/* ------------------------------- json viewer -------------------------------- */

function JsonView({ data }: { data: unknown }) {
  const nodes = useMemo<ReactNode[]>(() => {
    const json = JSON.stringify(data, null, 2);
    const out: ReactNode[] = [];
    const re =
      /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0;
    let k = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(json)) !== null) {
      if (m.index > last) out.push(json.slice(last, m.index));
      const cls = m[1]
        ? "text-brand-300"
        : m[2]
          ? "text-emerald-300"
          : m[3]
            ? "text-violet-400"
            : "text-amber-300";
      out.push(
        <span key={k++} className={cls}>
          {m[0]}
        </span>,
      );
      last = m.index + m[0].length;
    }
    if (last < json.length) out.push(json.slice(last));
    return out;
  }, [data]);
  return (
    <pre className="max-h-[520px] overflow-auto p-4 font-mono text-[12px] leading-relaxed text-paper-200">
      {nodes}
    </pre>
  );
}

/* ------------------------------- request logic ------------------------------ */

type ApiResult =
  | { kind: "ok"; status: number; ms: number; body: unknown }
  | { kind: "network"; message: string };

function buildQuery(ep: EndpointDef, values: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const p of ep.params ?? []) {
    const v = (values[p.key] ?? "").trim();
    if (v !== "") qs.set(p.key, v);
  }
  return qs.toString();
}

function curlFor(ep: EndpointDef, values: Record<string, string>, apiKey: string, bodyText: string): string {
  let target = ep.path;
  if (ep.pathParam) target = target.replace(":id", encodeURIComponent(values["__path"]?.trim() || ":id"));
  const qs = buildQuery(ep, values);
  const url = `${window.location.origin}${target}${qs ? `?${qs}` : ""}`;
  const lines = [`curl -X ${ep.method} "${url}"`];
  if (apiKey.trim()) lines.push(`  -H "x-api-key: ${apiKey.trim()}"`);
  if (ep.method === "POST") {
    lines.push(`  -H "content-type: application/json"`);
    lines.push(`  -d '${bodyText.replace(/\n\s*/g, " ")}'`);
  }
  return lines.join(" \\\n");
}

async function queryApi(
  ep: EndpointDef,
  values: Record<string, string>,
  apiKey: string,
  body: string | undefined,
): Promise<ApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let target = ep.path;
    if (ep.pathParam) target = target.replace(":id", encodeURIComponent(values["__path"]!.trim()));
    const qs = buildQuery(ep, values);
    const t0 = performance.now();
    const res = await fetch(`${target}${qs ? `?${qs}` : ""}`, {
      method: ep.method,
      headers: {
        ...(apiKey.trim() ? { "x-api-key": apiKey.trim() } : {}),
        ...(ep.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body,
      signal: controller.signal,
    });
    const ms = Math.round(performance.now() - t0);
    const parsed: unknown = await res.json().catch(() => null);
    return { kind: "ok", status: res.status, ms, body: parsed };
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === "AbortError"
        ? "Request timed out after 15 s."
        : "Could not reach the service — is the API running?";
    return { kind: "network", message };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------- page ------------------------------------- */

const inputCls =
  "h-9 w-full rounded-md border border-paper-900/[0.16] bg-white px-3 font-mono text-[13px] text-paper-900 outline-none transition placeholder:text-paper-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-200";

export default function Playground() {
  const [endpointId, setEndpointId] = useState("news");
  const ep = ENDPOINTS.find((e) => e.id === endpointId) ?? ENDPOINTS[0];

  const [values, setValues] = useState<Record<string, string>>({ ...DEFAULTS[ep.id] });
  const [bodyText, setBodyText] = useState(ENDPOINTS.find((e) => e.bodyTemplate)?.bodyTemplate ?? "{}");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("intel.playground.key") ?? "");
  const [result, setResult] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("intel.playground.key", apiKey);
  }, [apiKey]);

  function switchEndpoint(id: string) {
    setEndpointId(id);
    setValues({ ...(DEFAULTS[id] ?? {}) });
    const target = ENDPOINTS.find((e) => e.id === id);
    if (target?.bodyTemplate) setBodyText(target.bodyTemplate);
    setResult(null);
    setBodyError(null);
  }

  function applyPreset(p: Preset) {
    switchEndpoint(p.endpointId);
    if (p.values) setValues((prev) => ({ ...prev, ...p.values }));
    const target = ENDPOINTS.find((e) => e.id === p.endpointId);
    if (target?.bodyTemplate) setBodyText(target.bodyTemplate);
    explorerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const requiredMissing =
    [ep.pathParam, ...(ep.params ?? [])].filter((f) => f?.required).some((f) => !(values[f!.key] ?? "").trim());

  async function send() {
    if (requiredMissing || busy) return;
    let parsedBody: string | undefined;
    if (ep.method === "POST") {
      try {
        JSON.parse(bodyText);
        setBodyError(null);
      } catch {
        setBodyError("Body is not valid JSON.");
        return;
      }
      parsedBody = bodyText;
    }
    setBusy(true);
    setResult(null);
    setResult(await queryApi(ep, values, apiKey, parsedBody));
    setBusy(false);
  }

  const statusPill = (s: number) =>
    s < 300
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : s < 500
        ? "border-amber-300 bg-amber-50 text-amber-800"
        : "border-red-300 bg-red-50 text-red-800";

  const qs = buildQuery(ep, values);
  const displayPath = ep.pathParam
    ? ep.path.replace(":id", values["__path"]?.trim() || ":id")
    : ep.path;

  return (
    <main className="pb-24">
      {/* header */}
      <section className="mx-auto max-w-6xl px-4 pt-14 sm:px-6">
        <Eyebrow>API playground</Eyebrow>
        <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-[1.08] tracking-tight text-paper-900 md:text-5xl">
          Query the news API <em className="italic text-brand-700">right here.</em>
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-paper-600">
          These are live requests against this deployment of the service, sent same-origin to{" "}
          <code className="rounded border border-paper-900/[0.14] bg-white px-1.5 py-0.5 font-mono text-[13px]">/v1</code>.
          Pick an endpoint, tweak the parameters, and read real responses — errors included, because
          they are part of the contract.
        </p>

        {/* what it can do */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((p, i) => (
            <div
              key={p.title}
              className="flex flex-col rounded-xl border border-paper-900/10 bg-white/60 p-5 transition hover:border-paper-900/20 hover:bg-white"
              style={{ transitionDelay: `${i * 40}ms` }}
            >
              <p className="font-serif text-lg tracking-tight text-paper-900">{p.title}</p>
              <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-paper-600">{p.desc}</p>
              <button
                onClick={() => applyPreset(p)}
                className="group mt-4 inline-flex items-center gap-1 self-start text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
              >
                Try it
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5">
                  <path d="M7 17 17 7M7 7h10v10" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* explorer */}
      <section ref={explorerRef} className="mx-auto mt-12 max-w-6xl scroll-mt-24 px-4 sm:px-6">
        <div className="grid items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          {/* builder */}
          <div className="overflow-hidden rounded-xl border border-paper-900/[0.14] bg-white shadow-[0_1px_2px_rgba(23,22,19,0.06)]">
            <p className="border-b border-paper-900/[0.1] bg-paper-100 px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-paper-700">
              Request builder
            </p>
            <div className="space-y-1 p-3">
              {ENDPOINTS.map((e) => (
                <button
                  key={e.id}
                  onClick={() => switchEndpoint(e.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                    e.id === ep.id
                      ? "border-brand-400 bg-brand-50 ring-1 ring-brand-200"
                      : "border-transparent hover:bg-paper-50"
                  }`}
                >
                  <span
                    className={`num rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${
                      e.method === "GET" ? "bg-brand-100 text-brand-800" : "bg-violet-400/20 text-violet-600"
                    }`}
                  >
                    {e.method}
                  </span>
                  <span className={`truncate text-sm ${e.id === ep.id ? "font-semibold text-paper-900" : "text-paper-700"}`}>
                    {e.name}
                  </span>
                </button>
              ))}
            </div>

            <div className="border-t border-paper-900/[0.09] p-4">
              <p className="text-[13px] leading-relaxed text-paper-600">{ep.blurb}</p>

              <div className="mt-4 space-y-3">
                {ep.pathParam && (
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-paper-600">
                      {ep.pathParam.label} *
                    </span>
                    <input
                      className={inputCls}
                      placeholder={ep.pathParam.placeholder}
                      value={values["__path"] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, __path: e.target.value }))}
                    />
                  </label>
                )}
                {(ep.params ?? []).map((f) => (
                  <label key={f.key} className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-paper-600">
                      {f.label}
                      {f.required ? " *" : ""}
                    </span>
                    {f.type === "select" ? (
                      <select
                        className={inputCls}
                        value={values[f.key] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      >
                        {(f.options ?? [""]).map((o) => (
                          <option key={o} value={o}>
                            {o === "" ? "— unset —" : o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={inputCls}
                        type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                        placeholder={f.placeholder}
                        value={values[f.key] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      />
                    )}
                  </label>
                ))}

                {ep.method === "POST" && (
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-paper-600">
                      JSON body
                    </span>
                    <textarea
                      rows={6}
                      spellCheck={false}
                      className={`${inputCls} h-auto resize-y py-2`}
                      value={bodyText}
                      onChange={(e) => setBodyText(e.target.value)}
                    />
                    {bodyError && <span className="mt-1 block text-xs font-medium text-red-700">{bodyError}</span>}
                  </label>
                )}

                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-paper-600">
                    Override API key
                  </span>
                  <input
                    className={inputCls}
                    type="password"
                    placeholder="optional — stored only in this browser"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <span className="mt-1 block text-[11px] leading-relaxed text-paper-500">
                    No key needed: this page proxies requests through the site, which attaches a shared
                    demo key automatically. Paste your own to override it.
                  </span>
                </label>
              </div>

              <button
                onClick={send}
                disabled={busy || requiredMissing}
                className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg bg-paper-900 text-sm font-medium text-paper-50 transition hover:bg-paper-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Querying…" : `Send ${ep.method} request`}
              </button>
              {requiredMissing && (
                <p className="mt-2 text-center text-[11px] font-medium text-paper-500">
                  Fill the * fields to send.
                </p>
              )}
            </div>
          </div>

          {/* response side */}
          <div className="flex min-w-0 flex-col gap-5">
            <div className="overflow-hidden rounded-xl border border-white/10 bg-black/40">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                <p className="font-mono text-[11px] text-paper-400">request preview</p>
                <button
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(curlFor(ep, values, apiKey, bodyText))
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1200);
                      })
                      .catch(() => {});
                  }}
                  className="rounded-md border border-white/15 bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-paper-300 transition hover:bg-white/[0.12]"
                >
                  {copied ? "copied ✓" : "copy curl"}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-paper-200">
{curlFor(ep, values, apiKey, bodyText)}
              </pre>
            </div>

            <div className="overflow-hidden rounded-xl border border-paper-900/[0.14] bg-white shadow-[0_1px_2px_rgba(23,22,19,0.06)]">
              <div className="flex flex-wrap items-center gap-3 border-b border-paper-900/[0.1] bg-paper-100 px-4 py-2.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-paper-700">Response</p>
                {result?.kind === "ok" && (
                  <>
                    <span className={`num rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusPill(result.status)}`}>
                      {result.status} {result.status === 200 ? "OK" : ""}
                    </span>
                    <span className="num text-[11px] font-medium text-paper-500">{result.ms} ms</span>
                  </>
                )}
                <span className="ml-auto truncate font-mono text-[11px] text-paper-500">
                  {ep.method} {displayPath}
                  {qs ? `?${qs}` : ""}
                </span>
              </div>

              {result === null && !busy && (
                <div className="p-8 text-center">
                  <p className="font-serif text-lg italic text-paper-500">
                    Pick a use case above or hit Send — responses render here.
                  </p>
                  <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-paper-500">
                    Lists come back as{" "}
                    <code className="rounded bg-paper-100 px-1 font-mono text-[12px]">{"{ total, count, offset, data }"}</code>{" "}
                    envelopes; every error is{" "}
                    <code className="rounded bg-paper-100 px-1 font-mono text-[12px]">{"{ error: { code, message } }"}</code>.
                  </p>
                </div>
              )}

              {busy && (
                <div className="p-8 text-center">
                  <p className="animate-pulse font-serif text-lg italic text-paper-500">Querying the pipeline…</p>
                </div>
              )}

              {result?.kind === "network" && (
                <div className="m-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-800">{result.message}</p>
                  <p className="mt-1 text-[13px] text-amber-700">
                    Start it from the repo root with <code className="font-mono">pnpm dev</code> — this page proxies{" "}
                    <code className="font-mono">/v1</code> to the API.
                  </p>
                </div>
              )}

              {result?.kind === "ok" && <JsonView data={result.body} />}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
