import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Eyebrow } from "../components/chrome";
import { CompanyCardModal } from "../components/company-card";
import { STAGE_LABELS, STAGE_ORDER, fmtUsd, type Company } from "../components/company-data";

type Article = {
  id: string;
  entity_id: string;
  entity_name: string;
  entities: Array<{ id: string; name: string; role: "primary" | "secondary" }>;
  title: string;
  url: string;
  publisher: string;
  published_date: string;
  language: string;
  ai_summary: string | null;
  sentiment: "positive" | "negative" | "neutral" | null;
  sentiment_score: number | null;
  newsworthiness: "high" | "medium" | "low" | null;
  tags: Array<{ name: string; is_primary: boolean }>;
  industry_primary: string | null;
  industry_secondary: string[];
  countries: string[];
  excerpt: string;
  text_available: boolean;
  fact_id: string | null;
  fact: {
    id: string;
    type: string;
    status: string;
    funding_stage: string | null;
    amount_usd_est: number | null;
    lead_investors: string[];
    event_date: string | null;
  } | null;
  related_sources: Array<{ id: string; url: string; publisher: string; published_date: string }>;
};

type Feed = { total: number; count: number; offset: number; data: Article[] };

type SourceStat = { source: string; articles: number; companies: number; last_published: string };
type SurfaceStat = { surface: string; articles: number; companies: number; last_published: string };
type ModuleStat = { module: string; articles: number; companies: number; last_published: string };
type SourceBreakdown = {
  total_articles: number;
  total_sources: number;
  by_publisher: SourceStat[];
  by_surface: SurfaceStat[];
  by_module: ModuleStat[];
};

type Stats = {
  total_entities: number;
  total_news: number;
  news_24h: number;
  covered_entities: number;
  monitored_entities: number;
  total_publishers: number;
  by_funding_stage: Array<{ stage: string; count: number }>;
};

type CompanyFeed = { total: number; count: number; offset: number; data: Company[] };

type GrowthPoint = { date: string; added: number; cumulative: number };
type Growth = { granularity: string; total: number; points: GrowthPoint[] };
type Industries = {
  total_companies: number;
  total_classified: number;
  industries: Array<{ industry: string; count: number }>;
};
type Overview = {
  days: number;
  volume: Array<{ date: string; total: number; high: number; medium: number; low: number }>;
  lifecycle: Array<{ stage: string; count: number }>;
  topics: Array<{ tag: string; count: number }>;
};
type CompanyMix = {
  total: number;
  by_venture_band: Array<{ band: string; count: number }>;
  by_country: Array<{ country: string; count: number }>;
  by_type: Array<{ type: string; count: number }>;
};

const MODULE_LABELS: Record<string, string> = {
  "rss-feeds": "RSS feeds",
  gdelt: "GDELT watchlist",
  "web-search": "Search index",
  launchmonitor: "Launch Library (Okara)",
  "hacker-news": "Hacker News",
  xmonitor: "X monitor",
};

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export type Filters = {
  category: string;
  startDate: string;
  endDate: string;
  publisher: string;
  surface: string;
  module: string;
  uniqueArticle: boolean;
};

const EMPTY_FILTERS: Filters = {
  category: "",
  startDate: "",
  endDate: "",
  publisher: "",
  surface: "",
  module: "",
  uniqueArticle: true,
};

/** Serialize non-empty filters into API query params. */
function filterParams(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (f.category.trim()) p.set("category", f.category.trim());
  if (f.startDate) p.set("start_date", f.startDate);
  if (f.endDate) p.set("end_date", f.endDate);
  if (f.publisher) p.set("publisher", f.publisher);
  if (f.surface) p.set("surface", f.surface);
  if (f.module) p.set("module", f.module);
  if (f.uniqueArticle) p.set("unique_article", "true");
  return p.toString();
}

async function fetchLatest(f: Filters, limit: number, offset: number): Promise<Feed> {
  const res = await fetch(`/v1/news/latest?${filterParams(f, { limit: String(limit), offset: String(offset) })}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Feed;
}

/** Breakdown ignores the publisher selection so sources stay comparable. */
async function fetchSources(f: Filters): Promise<SourceBreakdown> {
  const res = await fetch(`/v1/news/sources?${filterParams({ ...f, publisher: "" }, { limit: "50" })}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SourceBreakdown;
}

async function fetchStats(): Promise<Stats> {
  const res = await fetch(`/v1/news/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Stats;
}

async function fetchCompanies(
  q: string,
  stage: string,
  offset: number,
  industry: string | null,
  band: string | null,
  country: string | null,
): Promise<CompanyFeed> {
  const p = new URLSearchParams({ limit: "24", offset: String(offset) });
  if (q.trim()) p.set("q", q.trim());
  if (stage) p.set("funding_stage", stage);
  if (industry) p.set("industry", industry);
  if (band) p.set("venture_band", band);
  if (country) p.set("country", country);
  const res = await fetch(`/v1/companies/search?${p.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CompanyFeed;
}

async function fetchGrowth(granularity: Granularity): Promise<Growth> {
  const p = new URLSearchParams({ granularity, buckets: String(GROWTH_BUCKETS[granularity]) });
  const res = await fetch(`/v1/companies/growth?${p.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Growth;
}

async function fetchIndustries(): Promise<Industries> {
  const res = await fetch(`/v1/companies/industries?limit=100`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Industries;
}

async function fetchOverview(): Promise<Overview> {
  const res = await fetch(`/v1/news/overview?days=30&topic_limit=15`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Overview;
}

async function fetchMix(): Promise<CompanyMix> {
  const res = await fetch(`/v1/companies/mix?country_limit=10`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CompanyMix;
}

const sentimentCls: Record<string, string> = {
  positive: "border-emerald-300 bg-emerald-50 text-emerald-800",
  negative: "border-red-300 bg-red-50 text-red-800",
  neutral: "border-paper-900/15 bg-paper-50 text-paper-600",
};

const newsDotCls: Record<string, string> = {
  high: "bg-brand-500",
  medium: "bg-brand-300",
  low: "bg-paper-300",
};

const LIMITS = [25, 50, 100];
const CATEGORY_CHIPS = ["product launch", "funding"];

const inputCls =
  "h-9 rounded-md border border-paper-900/[0.16] bg-white px-2 text-[13px] text-paper-900 outline-none focus:border-brand-400";

/* ------------------------------------------------------------ shared bits */

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-paper-900/[0.14] bg-white shadow-[0_1px_2px_rgba(23,22,19,0.06)]">
      {children}
    </div>
  );
}

function PanelHead({
  title,
  right,
}: {
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-paper-900/[0.1] bg-paper-100 px-4 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-paper-700">{title}</p>
      {right}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] font-medium text-paper-600">
      {children}
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`relative h-5.5 w-10 rounded-full transition ${checked ? "bg-brand-500" : "bg-paper-300"}`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-all ${
            checked ? "left-5" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

function Pager({
  page,
  pages,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
}: {
  page: number;
  pages: number;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
}) {
  const btn =
    "rounded-md border border-paper-900/[0.14] bg-white px-3 py-1.5 text-[13px] font-medium text-paper-900 transition hover:border-paper-900/30 disabled:opacity-40";
  return (
    <div className="flex items-center justify-between border-t border-paper-900/[0.1] bg-paper-100 px-4 py-2.5">
      <button onClick={onPrev} disabled={prevDisabled} className={btn}>
        ← Prev
      </button>
      <span className="num text-[11px] font-medium text-paper-500">
        page {page} of {pages}
      </span>
      <button onClick={onNext} disabled={nextDisabled} className={btn}>
        Next →
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

type Granularity = "day" | "week" | "month";
type GrowthMetric = "added" | "cumulative";

/** How many buckets to show per granularity — roughly a comparable span. */
const GROWTH_BUCKETS: Record<Granularity, number> = { day: 30, week: 26, month: 12 };

/**
 * KB-compilation growth with one emphasized measure and one contextual pane.
 * The selected measure answers the user's question; the secondary pane keeps
 * the relationship between total size and new additions visible.
 */
function GrowthChart({
  points,
  granularity,
  metric,
}: {
  points: GrowthPoint[];
  granularity: Granularity;
  metric: GrowthMetric;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 216;
  const PAD_X = 42;
  const PAD_TOP = 12;
  const SPLIT = H - 60;
  const BASE = H - 20;
  const n = points.length;
  const maxTotal = Math.max(1, points[n - 1]?.cumulative ?? 1);
  const maxAdded = Math.max(1, ...points.map((p) => p.added));
  const maxMetric = metric === "added" ? maxAdded : maxTotal;
  const windowAdded = points.reduce((a, p) => a + p.added, 0);
  const x = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / Math.max(1, n - 1);
  const value = (p: GrowthPoint) => (metric === "added" ? p.added : p.cumulative);
  const yTop = (v: number) => SPLIT - (v / (maxMetric * 1.06)) * (SPLIT - PAD_TOP);
  const yContext = (v: number) => BASE - (v / (maxTotal * 1.06)) * (BASE - SPLIT - 10);
  const barTop = (v: number) => BASE - (v / maxAdded) * (BASE - SPLIT - 10);
  const bw = Math.min(14, ((W - PAD_X * 2) / Math.max(1, n)) * 0.55);
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yTop(value(p)).toFixed(1)}`)
    .join(" ");
  const contextLine = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yContext(p.cumulative).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${SPLIT} L${PAD_X},${SPLIT} Z`;
  const contextArea = `${contextLine} L${x(n - 1).toFixed(1)},${BASE} L${PAD_X},${BASE} Z`;
  const tickLbl = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleString("en-US", {
      month: "short",
      ...(granularity === "day" ? { day: "numeric" } : {}),
      timeZone: "UTC",
    });
  const tipLbl = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleString("en-US",
      granularity === "month"
        ? { month: "long", year: "numeric", timeZone: "UTC" }
        : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
    );
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || n <= 1) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const step = (W - PAD_X * 2) / (n - 1);
    setHover(Math.max(0, Math.min(n - 1, Math.round((vx - PAD_X) / step))));
  };
  const h = hover !== null ? points[hover] : null;
  const tooltipY = h === null ? 0 : yTop(value(h));
  const tooltipBelow = tooltipY < 62;
  const tooltipTop = tooltipBelow ? Math.min(H - 48, tooltipY + 12) : Math.max(48, tooltipY - 10);
  return (
    <div className="relative mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-52 w-full cursor-crosshair touch-none"
        preserveAspectRatio="none"
        role="img"
        aria-label={metric === "added" ? "Companies added per period" : "Companies tracked over time"}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_X} x2={W - PAD_X} y1={yTop(maxMetric * f)} y2={yTop(maxMetric * f)} className="stroke-paper-200" strokeWidth={1} strokeDasharray="3 4" />
            <text x={PAD_X - 6} y={yTop(maxMetric * f) + 3} textAnchor="end" className="num fill-paper-400 text-[10px]">
              {Math.round(maxMetric * f).toLocaleString()}
            </text>
          </g>
        ))}
        <line x1={PAD_X} x2={W - PAD_X} y1={SPLIT} y2={SPLIT} className="stroke-paper-300" strokeWidth={1} />
        <path d={area} className={metric === "cumulative" ? "fill-brand-100/70" : "fill-brand-100/25"} />
        <path d={line} fill="none" className={metric === "cumulative" ? "stroke-brand-600" : "stroke-brand-500/60"} strokeWidth={metric === "cumulative" ? 2.5 : 1.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(hover ?? n - 1)} cy={yTop(value(points[hover ?? n - 1]))} r={hover !== null ? 4.5 : 3.5} className={metric === "cumulative" ? "fill-brand-700 stroke-white" : "fill-brand-500/60 stroke-white"} strokeWidth={hover !== null ? 1.5 : 0} />
        <text x={PAD_X} y={PAD_TOP - 3} className="num fill-paper-500 text-[10px] font-semibold">{value(points[0]).toLocaleString()}</text>
        <text x={W - PAD_X} y={PAD_TOP - 3} textAnchor="end" className="num fill-brand-700 text-[10px] font-bold">{value(points[n - 1]).toLocaleString()}</text>

        {metric === "cumulative" ? (
          <>
            <text x={PAD_X} y={SPLIT + 11} className="num fill-paper-400 text-[9px] uppercase tracking-wide">added / {granularity}</text>
            <text x={W - PAD_X} y={SPLIT + 11} textAnchor="end" className="num fill-brand-600 text-[10px] font-semibold">max +{maxAdded.toLocaleString()}</text>
            {points.map((p, i) =>
              p.added > 0 ? <rect key={p.date} x={x(i) - bw / 2} y={barTop(p.added)} width={bw} height={Math.max(1.5, BASE - barTop(p.added))} rx={1.5} className={hover === i ? "fill-brand-600" : "fill-brand-500/60"} /> : null,
            )}
          </>
        ) : (
          <>
            <text x={PAD_X} y={SPLIT + 11} className="num fill-paper-400 text-[9px] uppercase tracking-wide">total tracked</text>
            <text x={W - PAD_X} y={SPLIT + 11} textAnchor="end" className="num fill-paper-500 text-[10px] font-semibold">{maxTotal.toLocaleString()} max</text>
            <path d={contextArea} className="fill-paper-100/80" />
            <path d={contextLine} fill="none" className="stroke-paper-400" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(hover ?? n - 1)} cy={yContext(points[hover ?? n - 1].cumulative)} r={hover !== null ? 3.5 : 2.5} className="fill-paper-500 stroke-white" strokeWidth={hover !== null ? 1 : 0} />
          </>
        )}
        <line x1={PAD_X} x2={W - PAD_X} y1={BASE} y2={BASE} className="stroke-paper-300" strokeWidth={1} />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_TOP - 6} y2={BASE} className="stroke-paper-300" strokeWidth={1} />}
        {points.map((p, i) =>
          i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2) ? (
            <text key={p.date} x={x(i)} y={H - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className={`num text-[10px] ${hover === i ? "fill-paper-700 font-semibold" : "fill-paper-400"}`}>{tickLbl(p.date)}</text>
          ) : null,
        )}
      </svg>
      {h !== null && (
        <div
          className="pointer-events-none absolute z-10 w-48 max-w-[calc(100%-16px)] rounded-md border border-paper-900/[0.14] bg-white px-2 py-1 shadow-md"
          style={{
            left: `${Math.min(72, Math.max(28, (x(hover!) / W) * 100))}%`,
            top: `${(tooltipTop / H) * 100}%`,
            transform: `translateX(-50%)${tooltipBelow ? "" : " translateY(-100%)"}`,
          }}
        >
          <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-paper-500">{tipLbl(h.date)}</p>
          <p className="num whitespace-nowrap text-[12px] font-bold text-paper-900">{h.cumulative.toLocaleString()} tracked</p>
          <p className="num whitespace-nowrap text-[11px] font-medium text-brand-700">+{h.added.toLocaleString()} added{windowAdded > 0 && ` · ${Math.round((h.added / windowAdded) * 100)}% of window`}</p>
          <p className="mt-0.5 whitespace-nowrap text-[10px] text-paper-400">{metric === "added" ? "Addition view" : "Cumulative view"}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Ranked industry mix — a readable ranked bar list (replacing the bubble
 * cloud): top industries by company count with share %, a classified vs
 * unclassified split bar on top, and an "other" roll-up for the tail.
 */
function IndustryMix({
  data,
  selected,
  onSelect,
}: {
  data: Industries;
  selected: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = data.industries;
  const visible = expanded ? items : items.slice(0, 10);
  const maxCount = Math.max(1, items[0]?.count ?? 1);
  const pctOf = (c: number) =>
    data.total_classified > 0 ? Math.round((c / data.total_classified) * 100) : 0;
  const untagged = Math.max(0, data.total_companies - data.total_classified);
  const pretty = (slug: string) =>
    slug
      .replace(/_/g, " ")
      .split(" ")
      .map((word) => ({ ai: "AI", ml: "ML", saas: "SaaS", mna: "M&A", api: "API" })[word] ?? word.replace(/^./, (m) => m.toUpperCase()))
      .join(" ");
  const top = items[0];
  const topThreeTags = items.slice(0, 3).reduce((sum, item) => sum + item.count, 0);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-paper-500">
        <div className="flex min-w-32 flex-1 overflow-hidden rounded-full bg-paper-100">
          <div
            className="h-2 bg-brand-500"
            style={{ width: `${data.total_companies > 0 ? (data.total_classified / data.total_companies) * 100 : 0}%` }}
          />
          <div
            className="h-2 bg-paper-300"
            style={{ width: `${data.total_companies > 0 ? (untagged / data.total_companies) * 100 : 0}%` }}
          />
        </div>
        <span className="num shrink-0">
          {data.total_classified.toLocaleString()} tagged · {untagged.toLocaleString()} untagged
        </span>
      </div>
      {top && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-paper-900/[0.08] bg-paper-50 px-2.5 py-2">
            <p className="num text-sm font-semibold text-paper-900">{pctOf(top.count)}%</p>
            <p className="text-[10px] uppercase tracking-wider text-paper-400">largest · {pretty(top.industry)}</p>
          </div>
          <div className="rounded-md border border-paper-900/[0.08] bg-paper-50 px-2.5 py-2">
            <p className="num text-sm font-semibold text-paper-900">{topThreeTags.toLocaleString()}</p>
            <p className="text-[10px] uppercase tracking-wider text-paper-400">top 3 tag counts</p>
          </div>
          <div className="hidden rounded-md border border-paper-900/[0.08] bg-paper-50 px-2.5 py-2 sm:block">
            <p className="num text-sm font-semibold text-paper-900">{untagged.toLocaleString()}</p>
            <p className="text-[10px] uppercase tracking-wider text-paper-400">need classification</p>
          </div>
        </div>
      )}

      <div className="mt-2 space-y-0.5">
        {visible.map((item, idx) => {
          const active = selected === item.industry;
          const isUnclassified = item.industry === "unclassified";
          return (
            <button
              key={item.industry}
              onClick={() => onSelect(active ? null : item.industry)}
              title={active ? "Clear industry filter" : "Filter companies by industry"}
              aria-pressed={active}
              className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-brand-50 ${active ? "bg-brand-50" : ""}`}
            >
              <span className={`num w-5 shrink-0 text-right text-[10px] ${active ? "font-bold text-brand-700" : "font-medium text-paper-300"}`}>
                {idx + 1}
              </span>
              <span
                className={`w-32 shrink-0 truncate text-[12px] font-medium sm:w-40 ${
                  active ? "text-brand-800" : isUnclassified ? "text-paper-500" : "text-paper-800"
                }`}
              >
                {pretty(item.industry)}
              </span>
              <span className="h-2 flex-1 rounded-full bg-paper-100">
                <span
                  className={`block h-2 rounded-full transition-colors ${
                    active
                      ? "bg-brand-600"
                      : isUnclassified
                        ? "bg-paper-300 group-hover:bg-paper-400"
                        : "bg-brand-400 group-hover:bg-brand-500"
                  }`}
                  style={{ width: `${Math.max(2, Math.round((item.count / maxCount) * 100))}%` }}
                />
              </span>
              <span className="num w-12 shrink-0 text-right text-[12px] font-semibold text-paper-900 sm:w-14">
                {item.count.toLocaleString()}
              </span>
              <span className="num w-8 shrink-0 text-right text-[10px] text-paper-400 sm:w-9">{pctOf(item.count)}%</span>
            </button>
          );
        })}
      </div>
      {items.length > 10 && (
        <button
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 text-[11px] font-semibold text-brand-700 underline-offset-2 hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? "show top 10" : `show all ${items.length} industries`}
        </button>
      )}
    </div>
  );
}

/** Reusable horizontal-bar list: label, share bar, count. Rows with `disabled`
 *  are informational only; the rest toggle a filter when clicked. */
function HBarList({
  rows,
  selected,
  onSelect,
}: {
  rows: Array<{ id: string; label: string; count: number; color?: string; disabled?: boolean; labelClass?: string }>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="mt-1 space-y-1">
      {rows.map((r) => {
        const active = selected === r.id;
        const clickable = !r.disabled;
        const body = (
          <span
            className={`flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left ${clickable ? "transition hover:bg-brand-50" : ""} ${active ? "bg-brand-50" : ""}`}
          >
            <span
              className={`w-36 shrink-0 truncate text-[11px] text-paper-700 ${r.labelClass ?? ""} ${
                active ? "font-semibold text-brand-800" : ""
              }`}
            >
              {r.label}
            </span>
            <span className="h-1.5 flex-1 rounded-full bg-paper-100">
              <span
                className={`block h-1.5 rounded-full ${r.color ?? "bg-brand-400"}`}
                style={{ width: `${Math.max(2, Math.round((r.count / maxCount) * 100))}%` }}
              />
            </span>
            <span className="num w-12 shrink-0 text-right text-[11px] text-paper-600">{r.count.toLocaleString()}</span>
          </span>
        );
        if (!clickable) return <div key={r.id}>{body}</div>;
        return (
          <button
            key={r.id}
            onClick={() => onSelect(active ? null : r.id)}
            title={active ? "Clear filter" : "Filter companies"}
            className="block w-full"
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

/** Round a max up to a friendly 1/2/5×10^k axis ceiling. */
function niceCeil(v: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const d = v / pow;
  return (d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10) * pow;
}

const NW_CLS: Record<string, string> = {
  high: "fill-brand-600",
  medium: "fill-brand-400",
  low: "fill-paper-300",
};

/** Kept-articles-per-day stacked by newsworthiness — hand-rolled SVG. */
function VolumeBars({
  volume,
  dayFilter,
  onDay,
}: {
  volume: Array<{ date: string; total: number; high: number; medium: number; low: number }>;
  /** "YYYY-MM-DD" when the feed is pinned to a single day. */
  dayFilter: string | null;
  onDay: (date: string | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 152;
  const PAD_X = 34;
  const PAD_TOP = 8;
  const BASE = H - 22;
  const n = volume.length;
  const top = niceCeil(Math.max(1, ...volume.map((v) => v.total)));
  const y = (v: number) => BASE - (v / top) * (BASE - PAD_TOP);
  const x = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / Math.max(1, n - 1);
  const bw = Math.min(18, ((W - PAD_X * 2) / Math.max(1, n)) * 0.72);
  const tickLbl = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || n <= 1) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const step = (W - PAD_X * 2) / (n - 1);
    setHover(Math.max(0, Math.min(n - 1, Math.round((vx - PAD_X) / step))));
  };
  const h = hover !== null ? volume[hover] : null;
  const tooltipY = h === null ? 0 : y(h.total);
  const tooltipBelow = tooltipY < 48;
  const tooltipTop = tooltipBelow ? Math.min(H - 48, tooltipY + 10) : Math.max(42, tooltipY - 8);
  const pinned = dayFilter !== null ? volume.findIndex((v) => v.date === dayFilter) : -1;
  const step = Math.max(1, Math.ceil(n / 6));
  return (
    <div className="relative mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full cursor-crosshair touch-none"
        preserveAspectRatio="none"
        role="img"
        aria-label="Kept articles per day by newsworthiness"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_X} x2={W - PAD_X} y1={y(top * f)} y2={y(top * f)} className="stroke-paper-200" strokeWidth={1} strokeDasharray="3 4" />
            <text x={PAD_X - 6} y={y(top * f) + 3} textAnchor="end" className="num fill-paper-400 text-[10px]">
              {Math.round(top * f).toLocaleString()}
            </text>
          </g>
        ))}
        <line x1={PAD_X} x2={W - PAD_X} y1={BASE} y2={BASE} className="stroke-paper-300" strokeWidth={1} />
        {volume.map((v, i) => {
          const pinnedDay = pinned === i;
          return (
            <g
              key={v.date}
              onClick={() => onDay(dayFilter === v.date ? null : v.date)}
              onPointerEnter={() => setHover(i)}
              className={`cursor-pointer ${pinnedDay ? "" : ""}`}
            >
              <rect x={x(i) - bw / 2} y={y(v.low)} width={bw} height={BASE - y(v.low)} className={NW_CLS.low} />
              <rect x={x(i) - bw / 2} y={y(v.low + v.medium)} width={bw} height={y(v.low) - y(v.low + v.medium)} className={NW_CLS.medium} />
              <rect x={x(i) - bw / 2} y={y(v.total)} width={bw} height={y(v.low + v.medium) - y(v.total)} className={NW_CLS.high} />
              {pinnedDay && (
                <rect
                  x={x(i) - bw / 2 - 1.5}
                  y={y(v.total) - 2}
                  width={bw + 3}
                  height={BASE - y(v.total) + 4}
                  rx={2}
                  fill="none"
                  className="stroke-brand-700"
                  strokeWidth={1.5}
                />
              )}
            </g>
          );
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={BASE} className="stroke-paper-300" strokeWidth={1} />}
        {volume.map((v, i) =>
          i % step === 0 || i === n - 1 ? (
            <text
              key={v.date}
              x={x(i)}
              y={H - 7}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className={`num text-[10px] ${hover === i ? "fill-paper-700 font-semibold" : "fill-paper-400"}`}
            >
              {tickLbl(v.date)}
            </text>
          ) : null,
        )}
      </svg>
      {h !== null && (
        <div
          className="pointer-events-none absolute z-10 w-52 max-w-[calc(100%-16px)] rounded-md border border-paper-900/[0.14] bg-white px-2 py-1 shadow-md"
          style={{
            left: `${Math.min(72, Math.max(28, (x(hover!) / W) * 100))}%`,
            top: `${(tooltipTop / H) * 100}%`,
            transform: `translateX(-50%)${tooltipBelow ? "" : " translateY(-100%)"}`,
          }}
        >
          <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-paper-500">{tickLbl(h.date)}</p>
          <p className="num whitespace-nowrap text-[12px] font-bold text-paper-900">{h.total.toLocaleString()} kept</p>
          <p className="num whitespace-nowrap text-[11px] text-paper-500">
            <span className="font-semibold text-brand-700">{h.high}</span> high ·{" "}
            <span className="font-semibold text-brand-500">{h.medium}</span> medium ·{" "}
            <span className="font-semibold text-paper-400">{h.low}</span> low
          </p>
          {dayFilter === h.date && <p className="mt-0.5 whitespace-nowrap text-[10px] font-medium text-brand-700">filtering the feed to this day — click again to clear</p>}
        </div>
      )}
    </div>
  );
}

const LIFE_STAGE_CLS: Record<string, string> = {
  kept: "bg-brand-500",
  waiting: "bg-amber-400",
  pending: "bg-paper-400",
  prefilter: "bg-paper-300",
  llm_filter: "bg-red-400/80",
  quarantined: "bg-red-600/70",
};
const LIFE_ORDER = ["kept", "waiting", "pending", "prefilter", "llm_filter", "quarantined"];

/** Snapshot of where every article row currently sits in the pipeline. */
function LifecycleBlock({ lifecycle }: { lifecycle: Array<{ stage: string; count: number }> }) {
  const total = lifecycle.reduce((a, l) => a + l.count, 0);
  const kept = lifecycle.find((l) => l.stage === "kept")?.count ?? 0;
  const sorted = [...lifecycle]
    .sort((a, b) => LIFE_ORDER.indexOf(a.stage) - LIFE_ORDER.indexOf(b.stage))
    .filter((l) => l.count > 0);
  return (
    <div className="mt-1">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-paper-100">
        {sorted.map((l) => (
          <div
            key={l.stage}
            className={LIFE_STAGE_CLS[l.stage] ?? "bg-paper-300"}
            style={{ width: `${(l.count / total) * 100}%` }}
            title={`${l.stage}: ${l.count.toLocaleString()}`}
          />
        ))}
      </div>
      <ul className="mt-2.5 space-y-1">
        {sorted.map((l) => (
          <li key={l.stage} className="flex items-center gap-2 text-[11px] text-paper-600">
            <i className={`h-2 w-2 shrink-0 rounded-sm ${LIFE_STAGE_CLS[l.stage] ?? "bg-paper-300"}`} />
            <span className="capitalize">{l.stage.replace("_", " ")}</span>
            <span className="num ml-auto font-semibold text-paper-900">{l.count.toLocaleString()}</span>
            <span className="num w-10 shrink-0 text-right text-paper-400">{Math.round((l.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
      <p className="num mt-2 border-t border-paper-900/[0.07] pt-1.5 text-[11px] text-paper-400">
        {kept.toLocaleString()} kept of {total.toLocaleString()} articles indexed · {total > 0 ? Math.round((kept / total) * 100) : 0}% kept
      </p>
    </div>
  );
}

const BAND_LABELS: Record<string, string> = {
  E3: "E3 · swarm",
  E2: "E2 · validated",
  E1: "E1 · emerging",
  E0: "E0 · basement",
  unbanded: "unbanded",
};
const BAND_COLORS: Record<string, string> = {
  E3: "bg-brand-600",
  E2: "bg-brand-500",
  E1: "bg-brand-400",
  E0: "bg-paper-400",
  unbanded: "bg-paper-300",
};

/** Small stacked bar + legend for the entity-type mix (display-only). */
function TypeMix({ byType }: { byType: Array<{ type: string; count: number }> }) {
  const total = byType.reduce((a, t) => a + t.count, 0);
  const colors: Record<string, string> = {
    private: "bg-brand-500",
    public: "bg-brand-400",
    subsidiary: "bg-paper-400",
    other: "bg-paper-300",
  };
  return (
    <div className="mt-1">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-paper-100">
        {byType.map((t) => (
          <div
            key={t.type}
            className={colors[t.type] ?? "bg-paper-300"}
            style={{ width: `${(t.count / total) * 100}%` }}
            title={`${t.type}: ${t.count.toLocaleString()}`}
          />
        ))}
      </div>
      <ul className="mt-2.5 space-y-1">
        {byType.map((t) => (
          <li key={t.type} className="flex items-center gap-2 text-[11px] text-paper-600">
            <i className={`h-2 w-2 shrink-0 rounded-sm ${colors[t.type] ?? "bg-paper-300"}`} />
            <span className="capitalize">{t.type}</span>
            <span className="num ml-auto font-semibold text-paper-900">{t.count.toLocaleString()}</span>
            <span className="num w-10 shrink-0 text-right text-paper-400">{Math.round((t.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Latest({ view }: { view: "updates" | "analytics" }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [sources, setSources] = useState<SourceBreakdown | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [draftCategory, setDraftCategory] = useState("");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [auto, setAuto] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [openCompanyId, setOpenCompanyId] = useState<string | null>(null);
  const [companyFeed, setCompanyFeed] = useState<CompanyFeed | null>(null);
  const [draftCompanyQ, setDraftCompanyQ] = useState("");
  const [companyQ, setCompanyQ] = useState("");
  const [companyStage, setCompanyStage] = useState("");
  const [companyIndustry, setCompanyIndustry] = useState<string | null>(null);
  const [companyOffset, setCompanyOffset] = useState(0);
  const [growth, setGrowth] = useState<Growth | null>(null);
  const [growthGran, setGrowthGran] = useState<Granularity>("day");
  const [growthMetric, setGrowthMetric] = useState<GrowthMetric>("cumulative");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [mix, setMix] = useState<CompanyMix | null>(null);
  const [companyBand, setCompanyBand] = useState<string | null>(null);
  const [companyCountry, setCompanyCountry] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const run = () =>
      Promise.all([fetchLatest(filters, limit, offset), fetchSources(filters), fetchStats()]).then(
        ([feedBody, sourceBody, statsBody]) => {
          if (!alive) return;
          setFeed(feedBody);
          setSources(sourceBody);
          setStats(statsBody);
          setError(null);
          setLastFetched(Date.now());
        },
        () => {
          if (!alive) return;
          setError("Could not reach the service — is the API running?");
        },
      );
    void run().finally(() => {
      if (alive) setBusy(false);
    });
    if (!auto)
      return () => {
        alive = false;
      };
    const id = setInterval(run, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [filters, limit, offset, auto, nonce]);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    fetchCompanies(companyQ, companyStage, companyOffset, companyIndustry, companyBand, companyCountry).then(
      (body) => alive && setCompanyFeed(body),
      () => alive && setCompanyFeed(null),
    );
    return () => {
      alive = false;
    };
  }, [companyQ, companyStage, companyIndustry, companyBand, companyCountry, companyOffset]);

  useEffect(() => {
    let alive = true;
    fetchGrowth(growthGran).then(
      (body) => alive && setGrowth(body),
      () => alive && setGrowth(null),
    );
    return () => {
      alive = false;
    };
  }, [growthGran]);

  const [industries, setIndustries] = useState<Industries | null>(null);
  useEffect(() => {
    let alive = true;
    fetchIndustries().then(
      (body) => alive && setIndustries(body),
      () => alive && setIndustries(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchOverview().then(
      (body) => alive && setOverview(body),
      () => alive && setOverview(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchMix().then(
      (body) => alive && setMix(body),
      () => alive && setMix(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setOffset(0);
  };

  const data = feed?.data ?? [];
  const from = offset + 1;
  const to = offset + data.length;
  const maxSourceArticles = Math.max(1, ...(sources?.by_publisher ?? []).map((s) => s.articles));
  const growthLatestAdded = growth?.points[growth.points.length - 1]?.added ?? 0;
  const growthStartTotal = growth?.points[0]?.cumulative ?? 0;
  const growthEndTotal = growth?.total ?? 0;
  const growthWindowDelta = Math.max(0, growthEndTotal - growthStartTotal);
  // The feed is pinned to one day when the volume chart's day filter is active.
  const dayFilter =
    filters.startDate && filters.startDate === filters.endDate ? filters.startDate : null;
  const dayPinned = dayFilter !== null;

  const kpis: Array<{ label: string; value: string; sub: string | null }> = [
    {
      // Same canonical set the Companies panel below serves — the two
      // numbers always agree by construction.
      label: "Companies tracked",
      value: stats === null ? "—" : stats.total_entities.toLocaleString(),
      sub: stats === null ? null : `${stats.monitored_entities.toLocaleString()} on watchlist`,
    },
    {
      label: "In coverage",
      value: stats === null ? "—" : stats.covered_entities.toLocaleString(),
      sub:
        stats === null || stats.total_entities === 0
          ? null
          : `${Math.round((stats.covered_entities / stats.total_entities) * 100)}% of tracked companies`,
    },
    {
      label: "News articles",
      value: stats === null ? "—" : stats.total_news.toLocaleString(),
      sub: stats === null ? null : `+${stats.news_24h.toLocaleString()} last 24 h`,
    },
    {
      label: "Publishers",
      value: stats === null ? "—" : stats.total_publishers.toLocaleString(),
      sub: null,
    },
    {
      label: "Articles in view",
      value: feed === null ? "—" : feed.total.toLocaleString(),
      sub: `page shows ${data.length}`,
    },
  ];

  const anyFilter =
    filters.category || filters.startDate || filters.endDate || filters.publisher || filters.surface || filters.module;

  return (
    <main className="pb-24">
      {/* ------------------------------------------------------------ header */}
      <section className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
        <Eyebrow>Admin</Eyebrow>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <h1 className="font-serif text-3xl leading-tight tracking-tight text-paper-900 md:text-4xl">
              {view === "updates" ? (
                <>
                  What made it into the <em className="italic text-brand-700">index.</em>
                </>
              ) : (
                <>
                  Corpus health, not the <em className="italic text-brand-700">product.</em>
                </>
              )}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-paper-500">
              {view === "updates"
                ? "Published news records. Spot bad company names, missing facts, and types that should not have shipped."
                : "Volume, coverage, sources, mix. For us — not a VC-facing page."}
            </p>
            <div className="mt-4 flex gap-1 rounded-lg border border-paper-900/10 bg-white/70 p-1">
              <Link
                to="/updates"
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
                  view === "updates" ? "bg-paper-900 text-paper-50" : "text-paper-600 hover:text-paper-900"
                }`}
              >
                Updates
              </Link>
              <Link
                to="/analytics"
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
                  view === "analytics" ? "bg-paper-900 text-paper-50" : "text-paper-600 hover:text-paper-900"
                }`}
              >
                Analytics
              </Link>
            </div>
          </div>
          {view === "updates" && (
            <div className="flex items-center gap-2">
              <Toggle checked={auto} onChange={() => setAuto((v) => !v)}>
                auto-refresh
              </Toggle>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setOffset(0);
                }}
                className={inputCls}
              >
                {LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setBusy(true);
                  setNonce((n) => n + 1);
                }}
                disabled={busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-paper-900 px-3.5 text-[13px] font-medium text-paper-50 transition hover:bg-paper-800 disabled:opacity-40"
              >
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={busy ? "animate-spin" : ""}>
                  <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
                </svg>
                Refresh
              </button>
            </div>
          )}
        </div>

        {view === "updates" && (
        <div className="mt-5 rounded-xl border border-paper-900/10 bg-white/70 p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setFilter("category", draftCategory);
              }}
              className="flex items-center gap-2"
            >
              <input
                value={draftCategory}
                onChange={(e) => setDraftCategory(e.target.value)}
                placeholder="tag filter, e.g. product launch…"
                className={`${inputCls} w-56`}
              />
              <button
                type="submit"
                className="h-9 rounded-md border border-paper-900/[0.16] bg-paper-50 px-3 text-[13px] font-medium text-paper-700 transition hover:border-paper-900/30"
              >
                Filter
              </button>
            </form>
            {CATEGORY_CHIPS.map((chip) => (
              <button
                key={chip}
                onClick={() => {
                  setDraftCategory(chip);
                  setFilter("category", chip);
                }}
                className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${
                  filters.category === chip
                    ? "border-brand-400 bg-brand-50 text-brand-800"
                    : "border-paper-900/[0.16] bg-white text-paper-600 hover:border-paper-900/30"
                }`}
              >
                {chip}
              </button>
            ))}
            <span className="hidden h-5 w-px bg-paper-900/10 sm:block" />
            <label className="flex items-center gap-1.5 text-[13px] text-paper-600">
              from
              <input type="date" value={filters.startDate} onChange={(e) => setFilter("startDate", e.target.value)} className={inputCls} />
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-paper-600">
              to
              <input type="date" value={filters.endDate} onChange={(e) => setFilter("endDate", e.target.value)} className={inputCls} />
            </label>
            <span className="hidden h-5 w-px bg-paper-900/10 sm:block" />
            <Toggle checked={filters.uniqueArticle} onChange={() => setFilter("uniqueArticle", !filters.uniqueArticle)}>
              dedupe stories
            </Toggle>
            {anyFilter && (
              <button
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setDraftCategory("");
                  setOffset(0);
                }}
                className="text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline"
              >
                clear all
              </button>
            )}
          </div>
          {filters.publisher && (
            <p className="mt-2 text-[13px] text-paper-600">
              filtered to publisher{" "}
              <span className="rounded-md bg-paper-100 px-1.5 py-0.5 font-mono text-[12px] text-paper-800">{filters.publisher}</span>{" "}
              <button onClick={() => setFilter("publisher", "")} className="font-medium text-brand-700 hover:underline">
                remove
              </button>
            </p>
          )}
        </div>
        )}

        {view === "analytics" && (
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-paper-900/10 bg-paper-900/[0.08] sm:grid-cols-3 lg:grid-cols-5">
          {kpis.map(({ label, value, sub }) => (
            <div key={label} className="bg-white px-4 py-3">
              <p className="num text-xl font-semibold tracking-tight text-paper-900">{value}</p>
              <p className="text-[11px] font-medium uppercase tracking-wider text-paper-500">{label}</p>
              {sub && <p className="num mt-0.5 text-[11px] text-paper-400">{sub}</p>}
            </div>
          ))}
        </div>
        )}
      </section>

      {view === "updates" && (
      <section className="mx-auto mt-6 max-w-6xl px-4 sm:px-6">
        <Panel>
          <PanelHead
            title="Published news"
            right={
              <span className="num text-[11px] font-medium text-paper-500">
                {feed !== null && feed.total > 0
                  ? `showing ${from}–${to} of ${feed.total.toLocaleString()}`
                  : lastFetched !== null
                    ? `updated ${ago(new Date(lastFetched).toISOString(), tick)}`
                    : null}
              </span>
            }
          />

          {error && (
            <div className="m-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-800">{error}</p>
              <p className="mt-1 text-[13px] text-amber-700">
                Start it from the repo root with <code className="font-mono">pnpm dev</code> — this page proxies{" "}
                <code className="font-mono">/v1</code> to the API.
              </p>
            </div>
          )}

          {!error && feed === null && (
            <div className="p-8 text-center">
              <p className="animate-pulse font-serif text-lg italic text-paper-500">Reading the index…</p>
            </div>
          )}

          {!error && feed !== null && data.length === 0 && (
            <div className="p-8 text-center">
              <p className="font-serif text-lg italic text-paper-500">Nothing published yet.</p>
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-paper-500">
                No kept articles match the current filters — widen the date range or clear a filter.
              </p>
            </div>
          )}

          {data.length > 0 && (
            <ul className="divide-y divide-paper-900/[0.07]">
              {data.map((a) => {
                const primaryTag = a.tags.find((t) => t.is_primary) ?? a.tags[0];
                const companies2 = a.entities.length > 0
                  ? a.entities
                  : a.entity_name || a.entity_id
                    ? [{ id: a.entity_id, name: a.entity_name || a.entity_id, role: "primary" as const }]
                    : [];
                return (
                  <li key={a.id} className="flex gap-4 px-4 py-3 transition hover:bg-paper-50">
                    <div className="num w-20 shrink-0 pt-0.5 text-right text-[11px] leading-snug text-paper-500">
                      {ago(a.published_date, tick)}
                      <br />
                      <span className="text-paper-400">
                        {new Date(a.published_date).toISOString().slice(0, 10)}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        {companies2.map((e) => (
                          <button
                            key={e.id}
                            onClick={() => setOpenCompanyId(e.id)}
                            title="View company card"
                            className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold transition hover:bg-brand-50 hover:text-brand-800 ${
                              e.role === "primary"
                                ? "bg-paper-100 text-paper-700"
                                : "border border-paper-900/[0.12] bg-white text-paper-500"
                            }`}
                          >
                            {e.name || e.id}
                          </button>
                        ))}
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-sm font-medium text-paper-900 underline-offset-2 hover:text-brand-700 hover:underline"
                        >
                          {a.title}
                        </a>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-paper-500">
                        <span className="font-mono">{a.publisher}</span>
                        {primaryTag && (
                          <span className="rounded-full border border-brand-200 bg-brand-50 px-1.5 py-px font-medium text-brand-800">
                            {primaryTag.name}
                          </span>
                        )}
                        {a.newsworthiness && (
                          <span className="inline-flex items-center gap-1">
                            <i className={`h-1.5 w-1.5 rounded-full ${newsDotCls[a.newsworthiness]}`} />
                            {a.newsworthiness}
                          </span>
                        )}
                        {a.sentiment && (
                          <span className={`rounded-full border px-1.5 py-px font-medium ${sentimentCls[a.sentiment]}`}>
                            {a.sentiment}
                            {a.sentiment_score !== null && ` ${(a.sentiment_score as number).toFixed(2)}`}
                          </span>
                        )}
                        {a.fact && (
                          <span className="rounded-full border border-paper-900/[0.16] bg-paper-50 px-1.5 py-px font-medium text-paper-700">
                            fact · {a.fact.type.replace(/_/g, " ")}
                            {a.fact.funding_stage ? ` ${a.fact.funding_stage}` : ""}
                          </span>
                        )}
                        {(a.related_sources ?? []).length > 0 && (
                          <span className="text-paper-400">
                            also {(a.related_sources ?? []).map((s) => s.publisher).join(", ")}
                          </span>
                        )}
                        {a.countries.length > 0 && <span>{a.countries.join(", ")}</span>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {feed !== null && feed.total > limit && (
            <Pager
              page={Math.floor(offset / limit) + 1}
              pages={Math.ceil(feed.total / limit)}
              onPrev={() => setOffset((o) => Math.max(0, o - limit))}
              onNext={() => setOffset((o) => o + limit)}
              prevDisabled={offset === 0 || busy}
              nextDisabled={to >= feed.total || busy}
            />
          )}
        </Panel>
      </section>
      )}

      {view === "analytics" && (
      <>
      <section className="mx-auto mt-8 max-w-6xl px-4 sm:px-6">
        <Panel>
          <PanelHead
            title="Signal pulse"
            right={<span className="text-[11px] text-paper-500">30-day view · deduped like the feed</span>}
          />
          {overview === null ? (
            <div className="p-8 text-center">
              <p className="animate-pulse font-serif text-base italic text-paper-400">Reading the index…</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 divide-y divide-paper-900/[0.07] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
              {/* kept articles/day stacked by newsworthiness */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">
                    Kept articles / day
                  </p>
                  <p className="text-[11px] text-paper-400">
                    {dayPinned ? (
                      <button
                        onClick={() => {
                          setFilter("startDate", "");
                          setFilter("endDate", "");
                        }}
                        className="font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        pinned to {dayFilter} · clear
                      </button>
                    ) : (
                      "click a day to filter the feed"
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-paper-500">
                  <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-brand-600" /> high</span>
                  <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-brand-400" /> medium</span>
                  <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-paper-300" /> low</span>
                </div>
                <VolumeBars
                  volume={overview.volume}
                  dayFilter={dayFilter}
                  onDay={(date) => {
                    if (date === null) {
                      setFilter("startDate", "");
                      setFilter("endDate", "");
                    } else {
                      setFilter("startDate", date);
                      setFilter("endDate", date);
                    }
                  }}
                />
              </div>

              {/* top primary event tags — click to filter the feed */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">Top event types</p>
                  <p className="text-[11px] text-paper-400">trailing 30 days · click to filter the feed</p>
                </div>
                <HBarList
                  rows={overview.topics.map((t) => ({
                    id: t.tag,
                    label: t.tag,
                    count: t.count,
                    labelClass: "font-mono",
                  }))}
                  selected={filters.category || null}
                  onSelect={(id) => setFilter("category", id ?? "")}
                />
                {overview.topics.length === 0 && (
                  <p className="mt-4 text-center text-[12px] italic text-paper-400">No tagged events in the window.</p>
                )}
              </div>

              {/* where every article row currently sits in the pipeline */}
              <div className="px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">Index lifecycle</p>
                <p className="text-[11px] text-paper-400">every article row, by current stage</p>
                <LifecycleBlock lifecycle={overview.lifecycle} />
              </div>
            </div>
          )}
        </Panel>
      </section>

      {/* ----------------------------------------------------------- companies */}
      <section className="mx-auto mt-8 max-w-6xl px-4 sm:px-6">
        <Panel>
          <PanelHead
            title={`Companies${companyFeed !== null ? ` — ${companyFeed.total.toLocaleString()} tracked` : ""}`}
            right={
              <div className="flex flex-wrap items-center gap-2">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setCompanyQ(draftCompanyQ);
                    setCompanyOffset(0);
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    value={draftCompanyQ}
                    onChange={(e) => setDraftCompanyQ(e.target.value)}
                    placeholder="search companies…"
                    className={`${inputCls} w-44`}
                  />
                  <button
                    type="submit"
                    className="h-9 rounded-md border border-paper-900/[0.16] bg-white px-2.5 text-[13px] font-medium text-paper-700 transition hover:border-paper-900/30"
                  >
                    Search
                  </button>
                </form>
                <select
                  value={companyStage}
                  onChange={(e) => {
                    setCompanyStage(e.target.value);
                    setCompanyOffset(0);
                  }}
                  className={inputCls}
                >
                  <option value="">all stages</option>
                  {STAGE_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
                {companyIndustry && (
                  <button
                    onClick={() => {
                      setCompanyIndustry(null);
                      setCompanyOffset(0);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2 text-[12px] font-medium text-brand-800 transition hover:border-brand-400"
                    title="Clear industry filter"
                  >
                    {companyIndustry.replace(/_/g, " ")}
                    <span className="text-brand-500">✕</span>
                  </button>
                )}
                {companyBand && (
                  <button
                    onClick={() => {
                      setCompanyBand(null);
                      setCompanyOffset(0);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2 text-[12px] font-medium text-brand-800 transition hover:border-brand-400"
                    title="Clear venture-band filter"
                  >
                    {BAND_LABELS[companyBand] ?? companyBand}
                    <span className="text-brand-500">✕</span>
                  </button>
                )}
                {companyCountry && (
                  <button
                    onClick={() => {
                      setCompanyCountry(null);
                      setCompanyOffset(0);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2 text-[12px] font-medium text-brand-800 transition hover:border-brand-400"
                    title="Clear country filter"
                  >
                    {companyCountry}
                    <span className="text-brand-500">✕</span>
                  </button>
                )}
              </div>
            }
          />

          <div className="border-b border-paper-900/[0.07] px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">KB compilation growth</p>
                  <div className="flex overflow-hidden rounded-md border border-paper-900/[0.14] bg-white">
                    {(["day", "week", "month"] as Granularity[]).map((g) => (
                      <button
                        key={g}
                        onClick={() => setGrowthGran(g)}
                        className={`px-2.5 py-1 text-[11px] font-semibold capitalize transition ${
                          growthGran === g ? "bg-brand-500 text-white" : "text-paper-600 hover:bg-paper-50"
                        }`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <div className="flex overflow-hidden rounded-md border border-paper-900/[0.14] bg-white">
                    {(["added", "cumulative"] as GrowthMetric[]).map((metric) => (
                      <button
                        key={metric}
                        onClick={() => setGrowthMetric(metric)}
                        aria-pressed={growthMetric === metric}
                        className={`px-2.5 py-1 text-[11px] font-semibold capitalize transition ${
                          growthMetric === metric ? "bg-paper-900 text-white" : "text-paper-600 hover:bg-paper-50"
                        }`}
                      >
                        {metric === "added" ? "new" : "total"}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mt-1.5 max-w-xl text-[12px] text-paper-500">
                  {growthMetric === "added" ? "New companies entering the knowledge base" : "Total companies in the knowledge base"} · {growthGran} buckets
                </p>
              </div>
              {growth !== null && growth.points.length > 1 && (
                <div className="grid grid-cols-3 gap-4 text-right">
                  <div>
                    <p className="num text-base font-semibold text-paper-900">+{growthWindowDelta.toLocaleString()}</p>
                    <p className="text-[10px] uppercase tracking-wider text-paper-400">window additions</p>
                  </div>
                  <div>
                    <p className="num text-base font-semibold text-brand-700">+{growthLatestAdded.toLocaleString()}</p>
                    <p className="text-[10px] uppercase tracking-wider text-paper-400">latest bucket</p>
                  </div>
                  <div>
                    <p className="num text-base font-semibold text-paper-900">{growthEndTotal.toLocaleString()}</p>
                    <p className="text-[10px] uppercase tracking-wider text-paper-400">tracked now</p>
                  </div>
                </div>
              )}
            </div>
            {growth === null || growth.points.length <= 1 ? (
              <div className="flex h-40 items-center justify-center">
                <p className="animate-pulse font-serif text-base italic text-paper-400">Charting the KB…</p>
              </div>
            ) : (
              <GrowthChart points={growth.points} granularity={growthGran} metric={growthMetric} />
            )}
          </div>

          {industries !== null ? (
            <div className="border-b border-paper-900/[0.07] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">By industry</p>
                  <p className="mt-0.5 text-[12px] text-paper-500">Where the tracked company set is concentrated</p>
                </div>
                <p className="text-[11px] text-paper-400">click a row to filter the company list</p>
              </div>
              <IndustryMix
                data={industries}
                selected={companyIndustry}
                onSelect={(slug) => {
                  setCompanyIndustry(slug);
                  setCompanyOffset(0);
                }}
              />
            </div>
          ) : (
            <div className="border-b border-paper-900/[0.07] px-4 py-8 text-center">
              <p className="animate-pulse font-serif text-base italic text-paper-400">Reading industries…</p>
            </div>
          )}

          {stats !== null && stats.by_funding_stage.length > 0 && (
            <div className="border-b border-paper-900/[0.07] bg-paper-50 px-4 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">By funding stage</p>
                <p className="text-[11px] text-paper-400">click a row to filter the company list</p>
              </div>
              <HBarList
                rows={stats.by_funding_stage.map((s) => ({
                  id: s.stage,
                  label: STAGE_LABELS[s.stage] ?? s.stage,
                  count: s.count,
                  color: s.stage === "unknown" ? "bg-paper-300" : "bg-brand-400",
                }))}
                selected={companyStage || null}
                onSelect={(id) => {
                  setCompanyStage(id ?? "");
                  setCompanyOffset(0);
                }}
              />
              <p className="num pt-1 text-[11px] text-paper-400">
                Σ {stats.total_entities.toLocaleString()} companies tracked
              </p>
            </div>
          )}

          {companyFeed === null ? (
            <div className="p-8 text-center">
              <p className="animate-pulse font-serif text-lg italic text-paper-500">Reading the KB…</p>
            </div>
          ) : companyFeed.data.length === 0 ? (
            <div className="p-8 text-center">
              <p className="font-serif text-lg italic text-paper-500">No companies match.</p>
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-paper-500">
                Try a different name or clear the stage filter.
              </p>
            </div>
          ) : (
            <>
              <ul className="grid grid-cols-1 gap-px bg-paper-900/[0.07] sm:grid-cols-2 lg:grid-cols-3">
                {companyFeed.data.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => setOpenCompanyId(c.id)}
                      className="flex h-full w-full flex-col justify-between gap-2 bg-white px-4 py-3 text-left transition hover:bg-brand-50/60 focus:bg-brand-50/60 focus:outline-none"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-paper-900">{c.canonical_name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-paper-500">
                          {[c.hq_city, c.country].filter(Boolean).join(", ") || "—"}
                          {c.tickers.length > 0 && ` · ${c.tickers.join(", ")}`}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-paper-500">
                        {c.funding_stage && (
                          <span className="rounded-full bg-paper-100 px-1.5 py-px font-medium capitalize text-paper-700">
                            {STAGE_LABELS[c.funding_stage] ?? c.funding_stage}
                          </span>
                        )}
                        {c.total_raised_usd !== null && <span className="num">{fmtUsd(c.total_raised_usd)}</span>}
                        {c.industry_tags.slice(0, 2).map((t) => (
                          <span key={t} className="truncate text-brand-700">
                            {t}
                          </span>
                        ))}
                        <span className="num ml-auto shrink-0">
                          {c.derived.article_count_30d > 0
                            ? `${c.derived.article_count_30d}/30d`
                            : c.derived.last_news_date !== null
                              ? new Date(c.derived.last_news_date).toISOString().slice(0, 10)
                              : "—"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {companyFeed.total > 24 && (
                <Pager
                  page={Math.floor(companyOffset / 24) + 1}
                  pages={Math.ceil(companyFeed.total / 24)}
                  onPrev={() => setCompanyOffset((o) => Math.max(0, o - 24))}
                  onNext={() => setCompanyOffset((o) => o + 24)}
                  prevDisabled={companyOffset === 0}
                  nextDisabled={companyOffset + 24 >= companyFeed.total}
                />
              )}
            </>
          )}
        </Panel>
      </section>

      {/* ------------------------------------------------------ company mix */}
      <section className="mx-auto mt-8 max-w-6xl px-4 sm:px-6">
        <Panel>
          <PanelHead
            title={`Company mix${mix !== null ? ` — ${mix.total.toLocaleString()} tracked` : ""}`}
            right={<span className="text-[11px] text-paper-500">click a band or country to filter</span>}
          />
          {mix === null ? (
            <div className="p-8 text-center">
              <p className="animate-pulse font-serif text-base italic text-paper-400">Reading the KB…</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 divide-y divide-paper-900/[0.07] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
              {/* C0 venture band — the engine's own deal-readiness rating */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">C0 venture band</p>
                  <p className="text-[11px] text-paper-400">click a band to filter</p>
                </div>
                <HBarList
                  rows={mix.by_venture_band.map((b) => ({
                    id: b.band,
                    label: BAND_LABELS[b.band] ?? b.band,
                    count: b.count,
                    color: BAND_COLORS[b.band] ?? "bg-paper-300",
                    disabled: b.band === "unbanded",
                  }))}
                  selected={companyBand}
                  onSelect={(id) => {
                    setCompanyBand(id);
                    setCompanyOffset(0);
                  }}
                />
              </div>

              {/* HQ country mix — click to filter */}
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">HQ country</p>
                  <p className="text-[11px] text-paper-400">top 10 · click to filter</p>
                </div>
                <HBarList
                  rows={mix.by_country.map((c) => ({
                    id: c.country,
                    label: c.country === "unknown" ? "unknown" : c.country,
                    count: c.count,
                    color: c.country === "unknown" ? "bg-paper-300" : "bg-brand-400",
                    disabled: c.country === "unknown",
                  }))}
                  selected={companyCountry}
                  onSelect={(id) => {
                    setCompanyCountry(id);
                    setCompanyOffset(0);
                  }}
                />
              </div>

              {/* entity-type mix — display only */}
              <div className="px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-paper-600">Entity type</p>
                <p className="text-[11px] text-paper-400">funds &amp; person-orgs excluded from tracking</p>
                <TypeMix byType={mix.by_type} />
              </div>
            </div>
          )}
        </Panel>
      </section>

      {/* ------------------------------------------------- source effectiveness */}
      {sources !== null && (
        <section className="mx-auto mt-8 max-w-6xl px-4 sm:px-6">
          <Panel>
            <PanelHead
              title="Source effectiveness"
              right={
                <span className="text-[11px] text-paper-500">
                  {sources.total_articles.toLocaleString()} articles in view · click a row to filter the feed
                </span>
              }
            />

            {/* acquisition modules — how articles enter the pipeline */}
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-paper-900/[0.07] text-[11px] uppercase tracking-wider text-paper-500">
                  <th className="px-4 py-2 font-semibold">Acquisition module</th>
                  <th className="px-4 py-2 font-semibold">Articles</th>
                  <th className="px-4 py-2 font-semibold">Companies</th>
                  <th className="hidden px-4 py-2 font-semibold sm:table-cell">Share</th>
                  <th className="px-4 py-2 font-semibold">Latest</th>
                </tr>
              </thead>
              <tbody>
                {sources.by_module.map((m) => (
                  <tr
                    key={m.module}
                    onClick={() => setFilter("module", filters.module === m.module ? "" : m.module)}
                    className={`cursor-pointer border-b border-paper-900/[0.05] text-[13px] transition hover:bg-paper-50 ${
                      filters.module === m.module ? "bg-brand-50" : ""
                    }`}
                  >
                    <td className="px-4 py-2 font-medium text-paper-900">
                      {MODULE_LABELS[m.module] ?? m.module}
                      <span className="ml-2 rounded bg-paper-100 px-1 py-px font-mono text-[10px] text-paper-500">{m.module}</span>
                    </td>
                    <td className="num px-4 py-2 font-semibold text-paper-900">{m.articles.toLocaleString()}</td>
                    <td className="num px-4 py-2 text-paper-600">{m.companies.toLocaleString()}</td>
                    <td className="hidden px-4 py-2 sm:table-cell">
                      <div className="h-1.5 w-full min-w-24 rounded-full bg-paper-100">
                        <div
                          className="h-1.5 rounded-full bg-brand-400"
                          style={{ width: `${Math.round((m.articles / Math.max(1, sources.total_articles)) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className="num px-4 py-2 text-[12px] text-paper-500">{ago(m.last_published, tick)}</td>
                  </tr>
                ))}
                {sources.by_module.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[13px] italic text-paper-500">
                      No kept articles match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* publishers within the current selection */}
            <details className="border-t border-paper-900/[0.07]">
              <summary className="cursor-pointer select-none bg-paper-50 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-paper-600">
                Publishers in view ({sources.total_sources})
              </summary>
              <table className="w-full text-left">
                <tbody>
                  {sources.by_publisher.map((s) => (
                    <tr
                      key={s.source}
                      onClick={() => setFilter("publisher", filters.publisher === s.source ? "" : s.source)}
                      className={`cursor-pointer border-b border-paper-900/[0.05] text-[13px] transition hover:bg-paper-50 ${
                        filters.publisher === s.source ? "bg-brand-50" : ""
                      }`}
                    >
                      <td className="px-4 py-2 font-mono text-[12px] text-paper-800">{s.source}</td>
                      <td className="num px-4 py-2 font-semibold text-paper-900">{s.articles.toLocaleString()}</td>
                      <td className="num px-4 py-2 text-paper-600">{s.companies.toLocaleString()}</td>
                      <td className="hidden px-4 py-2 sm:table-cell">
                        <div className="h-1.5 w-full min-w-24 rounded-full bg-paper-100">
                          <div
                            className="h-1.5 rounded-full bg-brand-400"
                            style={{ width: `${Math.round((s.articles / maxSourceArticles) * 100)}%` }}
                          />
                        </div>
                      </td>
                      <td className="num px-4 py-2 text-[12px] text-paper-500">{ago(s.last_published, tick)}</td>
                    </tr>
                  ))}
                  {sources.by_publisher.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-[13px] italic text-paper-500">
                        No kept articles match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </details>
          </Panel>
        </section>
      )}
      </>
      )}

      {openCompanyId !== null && (
        <CompanyCardModal id={openCompanyId} onClose={() => setOpenCompanyId(null)} />
      )}

      <p className="mx-auto mt-10 max-w-6xl px-4 font-mono text-[10.5px] text-paper-400 sm:px-6">
        {view === "updates" ? "Published index · admin" : "Corpus analytics · admin"}
      </p>
    </main>
  );
}
