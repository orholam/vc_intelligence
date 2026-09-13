import { useEffect, useState } from "react";
import {
  ENRICHMENT_SECTION_LABELS,
  STAGE_LABELS,
  fetchEnrichment,
  fmtUsd,
  type Company,
  type EnrichmentResponse,
  type EnrichmentSection,
} from "./company-data";

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function absoluteUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

async function fetchCompany(id: string): Promise<Company> {
  const res = await fetch(`/v1/companies/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Company;
}

type Story = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  published_date: string;
  sentiment: "positive" | "negative" | "neutral" | null;
  newsworthiness: "high" | "medium" | "low" | null;
};

async function fetchCompanyNews(id: string): Promise<{ total: number; data: Story[] }> {
  const p = new URLSearchParams({ company: id, limit: "8", unique_article: "true" });
  const res = await fetch(`/v1/news/?${p.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { total: number; data: Story[] };
}

const storyDotCls: Record<string, string> = {
  high: "bg-brand-500",
  medium: "bg-brand-300",
  low: "bg-paper-300",
};

const storySentimentCls: Record<string, string> = {
  positive: "text-emerald-700",
  negative: "text-red-700",
  neutral: "text-paper-500",
};

function CoveragePanel({ id, name }: { id: string; name?: string }) {
  const [state, setState] = useState<{
    feed: { total: number; data: Story[] } | null;
    error: string | null;
  }>({ feed: null, error: null });

  useEffect(() => {
    let alive = true;
    fetchCompanyNews(id).then(
      (feed) => alive && setState({ feed, error: null }),
      () => alive && setState((s) => ({ ...s, error: "Could not load coverage." })),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  if (state.error) return <p className="text-[13px] text-paper-600">{state.error}</p>;
  if (!state.feed) return <p className="animate-pulse font-serif italic text-paper-500">Loading coverage…</p>;

  const { total, data } = state.feed;
  if (data.length === 0) {
    return (
      <p className="text-[13px] italic text-paper-500">
        No indexed stories{name ? ` for ${name}` : ""} yet.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-paper-900/[0.06]">
        {data.map((s) => (
          <li key={s.id} className="flex gap-2.5 py-2 first:pt-0 last:pb-0">
            <div className="num w-14 shrink-0 pt-0.5 text-right text-[11px] leading-snug text-paper-400">
              {fmtDate(s.published_date)}
            </div>
            <div className="min-w-0 flex-1">
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="line-clamp-2 text-[13px] font-medium leading-snug text-paper-900 underline-offset-2 hover:text-brand-700 hover:underline"
              >
                {s.title}
              </a>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-paper-500">
                <span className="font-mono">{s.publisher}</span>
                {s.newsworthiness && (
                  <span className="inline-flex items-center gap-1">
                    <i className={`h-1.5 w-1.5 rounded-full ${storyDotCls[s.newsworthiness]}`} />
                  </span>
                )}
                {s.sentiment && (
                  <span className={`capitalize ${storySentimentCls[s.sentiment]}`}>{s.sentiment}</span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {total > data.length && (
        <p className="num mt-2 border-t border-paper-900/[0.06] pt-2 text-[11px] text-paper-400">
          +{(total - data.length).toLocaleString()} older stories in the index
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-paper-400">{label}</dt>
      <dd className="mt-0.5 text-[13px] leading-snug text-paper-800">{children}</dd>
    </div>
  );
}

// ------------------------------------------------------- FR-25 deep-profile panel

/** Best human label for an arbitrary payload value (akta {code,label} aware). */
function valueText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(valueText).filter((s): s is string => s !== null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const label = valueText(o.label ?? o.title ?? o.headline ?? o.name ?? o.value);
    if (label) {
      const code = valueText(o.code);
      return code && code !== label ? `${label} (${code})` : label;
    }
    return null;
  }
  return null;
}

const KEY_LABELS: Record<string, string> = {
  legal_name: "Legal name", company_type: "Type", founded_year: "Founded",
  company_description: "", company_description_short: "",
  operating_status: "Operating status", ownership_category: "Ownership",
  headcount_range: "Headcount", website_screenshot: "Screenshot",
  core_offering: "Core offering", differentiator: "Differentiator",
  functional_benefit: "Functional benefit", problem_solved: "Problem solved",
  product_overview: "Overview", product_category: "Category",
  gtm_type: "GTM", market_position: "Market position",
  customer_concentration: "Customer concentration", core_technology: "Core technology",
  number_of_profiles: "", is_technology_focussed: "Tech-focused",
  total_funding_usd: "Total raised", amount_usd: "Amount", pre_money_valuation: "Pre-money",
};

function titleishKey(o: Record<string, unknown>): string | null {
  for (const k of ["headline", "title", "name", "profile", "platform"]) {
    const t = valueText(o[k]);
    if (t) return t;
  }
  return null;
}

function EntryCard({ entry }: { entry: Record<string, unknown> }) {
  const head = titleishKey(entry);
  const rest = Object.entries(entry).filter(
    ([k, v]) =>
      !["headline", "title", "name", "profile", "platform", "source"].includes(k) &&
      valueText(v) !== null,
  );
  return (
    <div className="rounded-lg border border-paper-900/[0.08] bg-paper-50 px-3 py-2">
      {head !== null && <p className="text-[13px] font-semibold text-paper-900">{head}</p>}
      <dl className="mt-0.5 space-y-0.5">
        {rest.map(([k, v]) => {
          const label = KEY_LABELS[k] ?? k.replaceAll("_", " ");
          return (
            <div key={k}>
              {label !== "" && (
                <dt className="inline text-[10px] font-bold uppercase tracking-wider text-paper-400">
                  {label}:{" "}
                </dt>
              )}
              <dd className="inline text-[12.5px] leading-snug text-paper-700">{valueText(v)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function SectionView({ data }: { data: Record<string, unknown> }) {
  const blocks: React.ReactNode[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "source") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const entries = v.filter(
        (x): x is Record<string, unknown> => x !== null && typeof x === "object",
      );
      if (entries.length > 0) {
        blocks.push(
          <div key={k} className="space-y-1.5">
            {entries.map((e, i) => (
              <EntryCard key={i} entry={e} />
            ))}
          </div>,
        );
      } else {
        const strings = v.map(valueText).filter((s): s is string => s !== null);
        if (strings.length)
          blocks.push(
            <div key={k} className="flex flex-wrap gap-1.5">
              {strings.map((s, i) => (
                <span key={i} className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800">
                  {s}
                </span>
              ))}
            </div>,
          );
      }
      continue;
    }
    if (v !== null && typeof v === "object") {
      const inner = valueText(v);
      if (inner !== null) {
        const label = KEY_LABELS[k] ?? k.replaceAll("_", " ");
        blocks.push(
          <Field key={k} label={label}>
            {inner}
          </Field>,
        );
      }
      continue;
    }
    const text = valueText(v);
    if (text === null) continue;
    const long = KEY_LABELS[k] === "" || text.length > 220;
    if (long) {
      blocks.push(
        <p key={k} className="whitespace-pre-line text-[13px] leading-relaxed text-paper-700">
          {text}
        </p>,
      );
    } else {
      const label = KEY_LABELS[k] ?? k.replaceAll("_", " ");
      blocks.push(
        <Field key={k} label={label}>
          {text}
        </Field>,
      );
    }
  }
  return (
    <div className="space-y-2.5">
      {blocks.length ? blocks : <p className="text-[13px] text-paper-500">No structured fields.</p>}
    </div>
  );
}

/** Display priority for profile sections — identity first, signals last. */
const SECTION_ORDER: EnrichmentSection[] = [
  "firmographic",
  "location",
  "funding_detail",
  "mna_and_investment",
  "management_profile",
  "product_offering",
  "business_model",
  "industry",
  "customer_profile",
  "technology",
  "digital_presence",
  "trust_signal",
  "strategic_signal",
  "financial_estimate",
  "company_assessment",
  "company_hierarchy",
];

/**
 * The single company report: every complete enrichment section rendered in a
 * fixed order under one consistent heading style. No tabs, no collapse — the
 * modal is one continuous document about the company.
 */
function ProfileSections({
  data,
}: {
  data: EnrichmentResponse;
}) {
  const sections = data.sections as Partial<Record<EnrichmentSection, Record<string, unknown>>>;
  const complete = new Set(data.complete_sections);
  const ordered = [
    ...SECTION_ORDER.filter((s) => complete.has(s)),
    ...(data.complete_sections as EnrichmentSection[]).filter((s) => !SECTION_ORDER.includes(s)),
  ];
  return (
    <div className="space-y-4">
      {ordered.map((s) => (
        <div key={s}>
          <p className="text-[10px] font-bold uppercase tracking-wider text-paper-400">
            {ENRICHMENT_SECTION_LABELS[s] ?? s}
          </p>
          <div className="mt-1.5">
            <SectionView data={sections[s] ?? {}} />
          </div>
        </div>
      ))}
      {data.missing_sections.length > 0 && (
        <p
          title={`Pending enrichment: ${data.missing_sections.join(", ")}`}
          className="text-[11px] text-paper-400"
        >
          +{data.missing_sections.length} section{data.missing_sections.length === 1 ? "" : "s"} pending — built
          hourly from accepted events, our corpus and the company's site.
        </p>
      )}
      {data.generated_at && (
        <p className="text-[10.5px] text-paper-400">
          Deep profile generated {new Date(data.generated_at).toISOString().slice(0, 10)}
          {" · "}sources cited per field in the API response
        </p>
      )}
    </div>
  );
}

export function CompanyCardModal({
  id,
  initialName,
  onClose,
}: {
  id: string;
  initialName?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ id: string; company: Company | null; error: string | null }>(() => ({
    id,
    company: null,
    error: null,
  }));
  const [enrich, setEnrich] = useState<{ data: EnrichmentResponse | null; failed: boolean }>({
    data: null,
    failed: false,
  });
  if (state.id !== id) {
    setState({ id, company: null, error: null });
    setEnrich({ data: null, failed: false });
  }
  const company = state.company;
  const error = state.error;

  useEffect(() => {
    let alive = true;
    fetchCompany(state.id).then(
      (c) =>
        alive &&
        setState((s) => (s.id === state.id ? { ...s, company: c } : s)),
      () =>
        alive &&
        setState((s) => (s.id === state.id ? { ...s, error: "Could not load this company card." } : s)),
    );
    fetchEnrichment(state.id).then(
      (d) => alive && setEnrich({ data: d, failed: false }),
      () => alive && setEnrich({ data: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [state.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const stageLabel = company?.funding_stage ? (STAGE_LABELS[company.funding_stage] ?? company.funding_stage) : null;
  const completeSet = new Set(enrich.data?.complete_sections ?? []);
  const hasSections = (enrich.data?.complete_sections.length ?? 0) > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-paper-900/40 p-4 backdrop-blur-sm sm:p-10"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={initialName ?? "Company card"}
        onClick={(e) => e.stopPropagation()}
        className="my-auto w-full max-w-xl rounded-xl border border-paper-900/[0.14] bg-white shadow-[0_12px_40px_rgba(23,22,19,0.18)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-paper-900/[0.08] px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate font-serif text-xl tracking-tight text-paper-900">
              {company?.canonical_name ?? initialName ?? id}
            </h3>
            {company && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-paper-500">
                <span className="rounded-md bg-paper-100 px-1.5 py-px font-medium capitalize text-paper-700">{company.type}</span>
                <span className="capitalize">{company.status}</span>
                {stageLabel && <span className="font-medium text-brand-700">{stageLabel}</span>}
                {company.tickers.length > 0 && <span className="font-mono">{company.tickers.join(", ")}</span>}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-paper-400 transition hover:bg-paper-100 hover:text-paper-900"
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="p-5">
            <p className="text-sm text-paper-600">{error}</p>
          </div>
        )}

        {!error && company === null && (
          <div className="p-10 text-center">
            <p className="animate-pulse font-serif italic text-paper-500">Loading card…</p>
          </div>
        )}

        {company && (
          <div className="space-y-5 px-5 py-4">
            <div className="grid grid-cols-3 divide-x divide-paper-900/[0.08] rounded-lg border border-paper-900/[0.1] bg-paper-50">
              {[
                ["Articles · 30d", company.derived.article_count_30d.toLocaleString()],
                [
                  "Last news",
                  company.derived.last_news_date === null
                    ? "—"
                    : fmtDate(company.derived.last_news_date),
                ],
                ["Confidence", `${Math.round(company.confidence * 100)}%`],
              ].map(([label, value]) => (
                <div key={label} className="px-3 py-2.5">
                  <p className="num text-sm font-semibold text-paper-900">{value}</p>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-paper-500">{label}</p>
                </div>
              ))}
            </div>

            {/* Overview — card basics only where no profile section already covers them */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-paper-400">Overview</p>
              <dl className="mt-1.5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                <Field label="Website">
                  {company.website ? (
                    <a
                      href={absoluteUrl(company.website)}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-brand-700 underline-offset-2 hover:underline"
                    >
                      {company.website.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    "—"
                  )}
                </Field>
                {!completeSet.has("location") && (
                  <Field label="Location">
                    {[company.hq_city, company.country].filter(Boolean).join(", ") || "—"}
                  </Field>
                )}
                {!completeSet.has("firmographic") && (
                  <>
                    <Field label="Founded">{company.founded_year ?? "—"}</Field>
                    <Field label="Legal name">{company.legal_name ?? "—"}</Field>
                  </>
                )}
                {!completeSet.has("funding_detail") && (
                  <Field label="Funding">
                    {company.total_raised_usd !== null || company.last_funding_date !== null
                      ? [
                          company.total_raised_usd !== null ? fmtUsd(company.total_raised_usd) : null,
                          company.last_funding_date !== null ? `last ${fmtDate(company.last_funding_date)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "—"}
                  </Field>
                )}
                <Field label="Sources">{company.source_refs.length.toLocaleString()}</Field>
              </dl>
            </div>

            {company.industry_tags.filter((t) => t !== "unclassified").length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {company.industry_tags.filter((t) => t !== "unclassified").map((t) => (
                  <span key={t} className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800">
                    {t}
                  </span>
                ))}
              </div>
            )}

            {company.derived.top_event_types.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-paper-400">Top event types · 90d</p>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  {company.derived.top_event_types.map((t) => (
                    <span key={t.tag} className="text-[12px] text-paper-600">
                      <span className="num font-semibold text-paper-900">{t.count}</span> {t.tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-paper-900/[0.07] pt-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-paper-400">Profile</p>
              <div className="mt-2">
                {enrich.failed ? (
                  <p className="text-[13px] text-paper-500">Deep profile unavailable right now.</p>
                ) : enrich.data === null ? (
                  <p className="animate-pulse font-serif italic text-paper-500">Loading profile…</p>
                ) : hasSections ? (
                  <ProfileSections data={enrich.data} />
                ) : (
                  <p className="text-[13px] leading-relaxed text-paper-600">
                    No profile yet — run enrich on recently published companies to build this from
                    news, the company site, and accepted events.
                  </p>
                )}
              </div>
            </div>

            <div className="border-t border-paper-900/[0.07] pt-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-paper-400">
                Related stories{company.derived.article_count_30d > 0 ? " · newest first" : ""}
              </p>
              <div className="mt-2">
                <CoveragePanel id={state.id} name={company.canonical_name} />
              </div>
            </div>

            {(company.aliases.length > 0 || company.merged_into !== null) && (
              <div className="border-t border-paper-900/[0.07] pt-3 text-[11px] text-paper-500">
                {company.aliases.length > 0 && (
                  <p>
                    Also known as{" "}
                    <span className="text-paper-700">{company.aliases.slice(0, 6).join(" · ")}</span>
                  </p>
                )}
                {company.merged_into !== null && (
                  <p className="mt-1">
                    Merged into <span className="font-mono text-paper-700">{company.merged_into}</span>
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
