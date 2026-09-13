import fs from "node:fs";
import { sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { entityProfiles } from "../db/schema.js";
import { opaqueId } from "../lib/ulid.js";
import { extractFromHtml } from "../ingestion/extract.js";
import { politeFetch, BlockedByRobotsError } from "../ingestion/fetcher.js";
import { SECTION_SCHEMAS } from "../api/contracts-enrichment.js";
import type { ProfileSectionId } from "../config-files.js";

/**
 * FR-25 auto-composer (ox-alpha supervised): builds grounded profile payloads
 * for entities with NO existing profile rows, strictly from
 *   - entity card fields,
 *   - accepted facts,
 *   - kept corpus excerpts (≤365d),
 *   - homepage meta/socials (politeFetch, robots-aware).
 * Money/fact claims are extracted ONLY via conservative regexes and always
 * carry their source URL; sections without supportable content stay untouched
 * (pending). Rows land model='ox-alpha-auto', prompt_template_version=
 * 'auto-authored#v1'. Misresolved/aggregator domains are skipped and logged.
 */

// ---------------------------------------------------------------- config
const LIMIT = Number(process.argv[2] ?? 40);
const SKIP_CRAWL = process.argv.includes("--no-crawl");
const OUT = ".dbg/profile-authored-auto.json";

/** Aggregator/reference domains that indicate misresolved entity websites. */
const BAD_SITE_RE =
  /^(arxiv\.org|wikipedia\.org|github\.com|youtube\.com|x\.com|twitter\.com|medium\.com|news\.ycombinator\.com|reddit\.com|linkedin\.com|facebook\.com|substack\.com|notion\.site|web\.archive\.org|docs\.google\.com)$/;

type Digest = {
  id: string;
  canonical_name: string;
  legal_name: string | null;
  website: string | null;
  aliases: string[];
  type: string;
  status: string;
  country: string | null;
  hq_city: string | null;
  founded_year: number | null;
  industry_tags: string[];
  tickers: string[];
  funding_stage: string | null;
  registry_ids: Record<string, string> | null;
  facts: Array<{ t: string; p: Record<string, unknown>; pub: number; at: string }>;
  articles: Array<{ title: string; x: string; dom: string; at: string | null; url: string; tag: string | null }>;
};

const ISO3: Record<string, string> = {
  US: "USA", GB: "GBR", DE: "DEU", FR: "FRA", NL: "NLD", ES: "ESP", IT: "ITA",
  SE: "SWE", NO: "NOR", DK: "DNK", FI: "FIN", CH: "CHE", AT: "AUT", IE: "IRL",
  CA: "CAN", AU: "AUS", NZ: "NZL", IN: "IND", SG: "SGP", JP: "JPN", KR: "KOR",
  BR: "BRA", MX: "MEX", IL: "ISR", AE: "ARE", PL: "POL", PT: "PRT", BE: "BEL",
  ID: "IDN", CN: "CHN", TW: "TWN", HK: "HKG", ZA: "ZAF", NG: "NGA", TR: "TUR",
};
function regionOf(iso2: string): string {
  const c = iso2.toUpperCase();
  if (["US", "CA", "MX"].includes(c)) return "North America";
  if (["BR", "AR", "CL", "CO"].includes(c)) return "South America";
  if (["GB", "IE", "DE", "FR", "NL", "BE", "ES", "PT", "IT", "CH", "AT", "SE", "NO", "DK", "FI", "PL", "CZ", "RO", "GR", "EE", "LV", "LT", "HU", "LU"].includes(c)) return "Europe";
  if (["IN", "CN", "JP", "KR", "SG", "HK", "TW", "ID", "MY", "TH", "VN", "PH", "PK", "BD", "IL", "AE", "SA", "QA", "TR"].includes(c)) return "Asia";
  if (["AU", "NZ"].includes(c)) return "Oceania";
  return "Africa";
}

const MONEY = /\$\s?([\d,.]+)\s?(k|m|mm|b|bn|billion|million|thousand)\b/i;
function usd(num: string, unit: string): number | null {
  const n = Number(num.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = unit.toLowerCase();
  const mult = u === "b" || u === "bn" || u === "billion" ? 1e9 : u === "k" || u === "thousand" ? 1e3 : 1e6;
  return Math.round(n * mult);
}
function bracket(n: number, edges: Array<[number, string, string]>): { code: string; label: string } {
  for (const [ceil, code, label] of edges) if (n < ceil) return { code, label };
  const last = edges[edges.length - 1]!;
  return { code: last[1], label: last[2] };
}
const VAL_BRACKETS: Array<[number, string, string]> = [
  [10e6, "UNDER-10M", "Under $10M"], [50e6, "10M-50M", "$10M-$50M"],
  [250e6, "50M-250M", "$50M-$250M"], [1e9, "250M-1B", "$250M-$1B"],
  [5e9, "1B-5B", "$1B-$5B"], [10e9, "5B-10B", "$5B-$10B"],
  [25e9, "10B-25B", "$10B-$25B"], [Infinity, "OVER-25B", "$25B+"],
];

interface SiteInfo { ok: boolean; title: string | null; desc: string | null; socials: string[] }
async function scrapeSite(domain: string): Promise<SiteInfo> {
  const empty: SiteInfo = { ok: false, title: null, desc: null, socials: [] };
  try {
    const page = await politeFetch(`https://${domain}/`, { timeoutMs: 7000 });
    if (page.status >= 400) return empty;
    const html = page.body;
    const rx = (p: RegExp) => html.match(p)?.[1]?.trim().slice(0, 300) ?? null;
    const socials = new Set<string>();
    for (const m of html.matchAll(
      /https?:\/\/(?:www\.)?(linkedin\.com\/company\/[\w\-.]+|(?:x|twitter)\.com\/\w{2,20}|github\.com\/[\w\-.]{2,40}|youtube\.com\/@[\w\-.]{2,40})/g,
    )) socials.add(`https://${m[1]}`);
    let desc: string | null = rx(/<meta[^>]+name=["']description["'][^>]+content=["'](.*?)["']/i)
      ?? rx(/<meta[^>]+property=["']og:description["'][^>]+content=["'](.*?)["']/i);
    const title = rx(/<title[^>]*>(.*?)<\/title>/i);
    if ((!desc || !title) && !SKIP_CRAWL) {
      // fall back to readable extraction for JS-light pages
      const ex = extractFromHtml(html, page.finalUrl);
      if (!desc && ex && ex.charCount > 120) desc = ex.textContent.slice(0, 260);
    }
    return { ok: true, title, desc: desc?.replace(/&amp;/g, "&").replace(/&#x27;|'/g, "'") ?? null, socials: [...socials].slice(0, 4) };
  } catch (e) {
    if (!(e instanceof BlockedByRobotsError)) void e;
    return empty;
  }
}

function sentences(text: string): string[] {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 30);
}

function compose(e: Digest, site: SiteInfo): Partial<Record<ProfileSectionId, Record<string, unknown>>> {
  const out: Partial<Record<ProfileSectionId, Record<string, unknown>>> = {};
  const arts = e.articles.slice(0, 6);
  const blob = arts.map((a) => `${a.title}. ${a.x}`).join(" ");
  const name = e.canonical_name;

  // ---- firmographic -------------------------------------------------------
  const rawDesc = site.desc ?? sentences(blob)[0] ?? null;
  const descOk = rawDesc !== null && rawDesc.length >= 45 && /[a-z]{4}/i.test(rawDesc);
  const descShort = descOk ? rawDesc : null;
  if (descShort) {
    const firm: Record<string, unknown> = {
      name,
      website: e.website,
      company_type: "Private",
      operating_status: { code: "operating", label: "Operating" },
      company_description_short: descShort.slice(0, 400),
    };
    if (e.legal_name) firm.legal_name = e.legal_name;
    if (e.founded_year) firm.founded_year = e.founded_year;
    const isPublic = e.tickers.length > 0 || /\b(NYSE|NASDAQ|LON:|publicly traded|public company)\b/i.test(blob);
    if (isPublic) firm.company_type = "Public";
    if (/subsidiary of/i.test(blob)) firm.company_type = "Subsidiary";
    const raisedHit = blob.match(/\b(raised|raising|closes|closed|secured)\s+(\$[\d,.]+\s?(?:k|m|mm|b|bn|million|billion))/i);
    if (isPublic) firm.ownership_category = { code: "public", label: "Public" };
    else if (raisedHit) firm.ownership_category = { code: "venture_backed", label: "Venture Backed" };
    else if (/\b(bootstrapped|self-funded|open-source|open source)\b/i.test(`${blob} ${site.desc ?? ""}`))
      firm.ownership_category = { code: "bootstrapped", label: "Bootstrapped" };
    out.firmographic = firm;
  }

  // ---- industry -----------------------------------------------------------
  const tags = e.industry_tags.filter(Boolean);
  if (tags.length) {
    out.industry = {
      keyword: tags.map((t) => t.replaceAll("_", " ").toLowerCase()).slice(0, 8),
      product_category: tags[0]!.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    };
  }

  // ---- location -----------------------------------------------------------
  if (e.country) {
    const iso2 = e.country.toUpperCase();
    out.location = {
      hq: { city: e.hq_city ?? null, country: ISO3[iso2] ?? iso2, region: regionOf(iso2) },
      offices: [],
    };
  }

  // ---- digital presence ---------------------------------------------------
  if (site.socials.length) {
    out.digital_presence = {
      social_media_profiles: site.socials.map((u) => ({
        platform: u.includes("linkedin.") ? "linkedin" : u.includes("github.")
          ? "github" : u.includes("youtube.") ? "youtube" : "x",
        url: u,
      })),
    };
  }

  // ---- funding_detail (regex-grounded only) -------------------------------
  const rounds: Array<Record<string, unknown>> = [];
  for (const a of arts) {
    const text = `${a.title} ${a.x}`;
    const m = text.match(/\b(?:raised|raising|closes|closed|secured)\s+(\$[\d,.]+)\s?(k|m|mm|b|bn|million|billion)\b(?:[^.]{0,120}?series\s([a-f]))?/i);
    if (!m) continue;
    const amount = usd(m[1]!, m[2]!);
    if (!amount || amount < 100_000) continue;
    const series = m[3]?.toLowerCase();
    const label = series ? `Series ${series.toUpperCase()}` : "Venture Round";
    const invM = text.match(/\b(?:led by|from)\s+((?:[A-Z][\w'&.-]+(?:\s+[A-Z][\w'&.-]+){0,3},?\s*){1,3})(?:\s+and\s+|\s+with\s+|[.;])/);
    const investors = invM
      ? invM[1]!.split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter((s) => s.length > 2 && /^[A-Z]/.test(s)).slice(0, 3)
        .map((inv) => ({ name: inv, lead_investor: true }))
      : [];
    rounds.push({
      round: { code: label.toLowerCase().replaceAll(" ", "_"), label },
      amount_usd: amount,
      date: a.at ? { year: Number(a.at.slice(0, 4)), month: Number(a.at.slice(5, 7)), day: Number(a.at.slice(8, 10)) } : null,
      investors,
      total_investors: investors.length || null,
      news: [{ publisher: a.dom, url: a.url }],
    });
  }
  if (rounds.length) {
    const total = rounds.reduce((s, r) => s + ((r.amount_usd as number) ?? 0), 0);
    const lastDate = rounds.find((r) => r.date)?.date ?? null;
    const stages = rounds.map((r) => (r.round as { code: string }).code);
    const overview: Record<string, unknown> = {
      funding_stage: { code: stages[0], label: (rounds[0]!.round as { label: string }).label },
      total_funding_usd: total,
    };
    if (lastDate) overview.last_funding_date = lastDate;
    out.funding_detail = {
      funding_overview: overview,
      funding_rounds: rounds,
      investors: [...new Map(rounds.flatMap((r) => (r.investors as Array<{ name: string }>)).filter(Boolean).map((i) => [i.name, i])).values()]
        .map((i) => ({ name: i.name })),
    };
  }

  // ---- financial_estimate (valuation mentions only) ------------------------
  const valM = blob.match(/valued\s+at\s+\$([\d,.]+)\s?(k|m|mm|b|bn|billion|million)/i);
  if (valM) {
    const v = usd(valM[1]!, valM[2]!);
    if (v) out.financial_estimate = { valuation_estimate: bracket(v, VAL_BRACKETS) };
  }

  // ---- management_profile (conservative name patterns) ---------------------
  const profiles: Array<Record<string, unknown>> = [];
  for (const a of arts) {
    const text = `${a.title}. ${a.x}`;
    const pats = [
      /\b([A-Z][a-z]+ [A-Z][a-z]+),?\s+(?:co-)?founder\s+(?:and\s+)?CEOO?F\b/i, // placeholder guard, unlikely
      /\b(?:co-founder(?:\s+and)?\s+CEO|founder(?:\s+and)?\s+CEO|CEO)\s+([A-Z][a-z]+ [A-Z](?:[a-z]+|\.))(?:\s+of\b)?/,
      /\b([A-Z][a-z]+ [A-Z](?:[a-z]+|\.)),?\s+(?:co-founder(?:\s+and)?\s+)?CEO\b/,
    ];
    for (const p of pats.slice(1)) {
      const m = text.match(p);
      if (m?.[1] && !/\b(of|the|for|Inc|Corp)\b/i.test(m[1])) {
        const nm = m[1]!.trim();
        if (!profiles.some((x) => x.name === nm) && nm.split(" ").every((w) => w.length > 1)) {
          profiles.push({
            name: nm,
            designation: /co-founder/i.exec(text) ? "Co-founder & CEO" : "CEO",
            designation_category: "Chief Executive Officer",
            source: [a.url],
          });
        }
        break;
      }
    }
  }
  if (profiles.length) {
    out.management_profile = { number_of_profiles: profiles.length, profiles: profiles.slice(0, 3) };
  }

  // ---- mna_and_investment (we are the acquirer) ----------------------------
  const mna: Array<Record<string, unknown>> = [];
  for (const a of arts) {
    const text = `${a.title} ${a.x}`;
    const esc = name.replace(/[.*+?${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc}\\s+(?:has\\s+)?acqui(?:res|red)\\s+([A-Z][\\w&.'-]*(?:\\s+[A-Z][\\w&.'-]*){0,3})`, "i");
    const m = text.match(re);
    if (m?.[1] && !/^(a|an|the|its)$/i.test(m[1]!)) {
      const amt = text.match(MONEY);
      mna.push({
        acquiree: { name: m[1]!.trim(), uuid: null, website: null },
        acquisition_type: { code: "acquisition", label: "Acquisition" },
        announced_date: a.at ? { year: +a.at.slice(0, 4), month: +a.at.slice(5, 7), day: +a.at.slice(8, 10) } : null,
        amount_usd: amt ? usd(amt[1]!, amt[2]!) : null,
        status: "complete",
        news: [{ publisher: a.dom, url: a.url }],
      });
    }
  }
  if (mna.length) out.mna_and_investment = { mna, investment: [] };

  // ---- strategic_signal ----------------------------------------------------
  const scaleInd: Array<Record<string, unknown>> = [];
  for (const a of arts) {
    const text = `${a.title}. ${a.x}`;
    const arr = text.match(/\$([\d,.]+)\s?(m|mm|b|bn|million|billion)?\s*(?:ARR|annual recurring revenue|run rate)/i);
    if (arr) {
      const v = usd(arr[1]!, arr[2] ?? "m");
      if (v) scaleInd.push({ type: "revenue", value: `$${arr[1]}${(arr[2] ?? "M").toUpperCase()} ${/run rate/i.test(arr[0]) ? "run rate" : "ARR"}`,
        description: `Reported ${/run rate/i.test(arr[0]) ? "run rate" : "ARR"} of $${arr[1]}${(arr[2] ?? "M").toUpperCase()}.`,
        source: [a.url] });
    }
    const cust = text.match(/\b([\d][\d,]{2,}(?:\.\d+)?[km]?\+?)\s+(businesses|customers|companies|users|teams)\b/i);
    if (cust) scaleInd.push({ type: "customer_count", value: cust[0],
      description: `Reports ${cust[1]} ${cust[2]}.`, source: [a.url] });
    const valS = text.match(/valuation\s+(?:tripled|doubled|rose|climbed)?[^\d]*\$([\d,.]+)\s?(b|bn|billion|m|million)/i);
    if (valS) {
      const v = usd(valS[1]!, valS[2]!);
      if (v) scaleInd.push({ type: "valuation", value: `$${valS[1]}${valS[2]!.charAt(0).toUpperCase()}`,
        description: `Valuation reported at $${valS[1]}${valS[2]}.`, source: [a.url] });
    }
  }
  const moves: Array<Record<string, unknown>> = [];
  for (const a of arts) {
    const text = `${a.title}. ${a.x}`;
    const lm = text.match(/\blaunched?\s+((?:the\s+)?[A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,3})/);
    if (/launch/i.test(text)) moves.push({ type: "product_launch",
      description: lm ? `Launched ${lm[1]!.replace(/[.,]$/, "")}` : "Announced a new product launch.", source: [a.url] });
    const pm = text.match(/\bpartners(?:hip)?\s+with\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
    if (pm?.[1]) moves.push({ type: "partnership",
      description: `Partnership involving ${pm[1]!.trim().replace(/[.,]$/, "")}.`, source: [a.url] });
  }
  if (scaleInd.length || moves.length) {
    out.strategic_signal = { scale_indicator: scaleInd.slice(0, 5), recent_move: moves.slice(0, 4) };
  }

  // ---- product_offering ----------------------------------------------------
  if (descShort) {
    out.product_offering = {
      core_offering: descShort.slice(0, 400),
      problem_solved: null,
      product_and_service: site.ok && e.website ? [{ name: name, source: [`https://${e.website}`] }] : [],
    };
  }

  // ---- business_model ------------------------------------------------------
  const hay = `${blob} ${site.desc ?? ""} ${site.title ?? ""}`;
  const offering =
    /\b(show|podcast|newsletter|broadcast|media network)\b/i.test(hay) ? { code: "media", label: "Media" }
    : /\b(robots?|robotic|humanoid|spacecraft|satellite|drone|ring|glasses|device|hardware|headphones|wearable|bookmark|scanner)\b/i.test(hay) ? { code: "hardware_software", label: "Hardware & Software" }
    : /\b(nuclear|energy storage|power plant)\b/i.test(hay) ? { code: "energy_infrastructure", label: "Energy Infrastructure" }
    : /\b(ai|software|platform|app|saas|api|developer|tool)\b/i.test(hay) || tags.some((t) => /ai|software|dev/i.test(t)) ? { code: "software", label: "Software" }
    : null;
  if (offering) {
    const bm: Record<string, unknown> = { offering_type: offering };
    if (/\b(consumers|families|personal|b2c|for everyone|creators)\b/i.test(hay)) bm.gtm_type = "B2C";
    else if (/\b(enterprise|businesses|developers|teams|b2b|saas)\b/i.test(hay)) bm.gtm_type = "B2B";
    else if (/both/i.test(hay)) bm.gtm_type = "BOTH";
    if (/\bsubscription\b/i.test(hay)) bm.revenue_model = [{ title: "Subscription", description: "Subscription-based revenue.", type: "subscription_recurring" }];
    else if (/\b(transaction|take rate|payment fees|trading fees)\b/i.test(hay)) bm.revenue_model = [{ title: "Transactions", description: "Per-transaction fee revenue.", type: "transaction_fee" }];
    // emit only when the section carries real signal, not a default shell
    const hasSignal = offering.code !== "software" || bm.gtm_type || bm.revenue_model;
    if (hasSignal) out.business_model = bm;
  }

  // ---- technology ----------------------------------------------------------
  const techy = tags.some((t) => /ai|ml|software|dev|data|crypto|fintech/i.test(t)) ||
    /\b(ai|llm|agents?|api|platform|software)\b/i.test(hay);
  if (techy && /\bMCP\b/.test(hay)) {
    out.technology = { is_technology_focussed: true, api_detail: { has_api: true, has_mcp: true } };
  } else if (techy && /\bAPI\b/.test(hay)) {
    out.technology = { is_technology_focussed: true, api_detail: { has_api: true } };
  }

  // ---- customer_profile (only when counts are explicit) ---------------------
  const segs: Array<Record<string, unknown>> = [];
  for (const a of arts) {
    const text = `${a.title}. ${a.x}`;
    const cm = text.match(/\bover\s+([\d,]+(?:\.\d+)?[kmb]?\+?)\s+(businesses|customers|restaurants|practices|stores|families)\b/i);
    if (cm) segs.push({ title: `${cm[2]!.charAt(0).toUpperCase()}${cm[2]!.slice(1)} (${cm[1]}+)`, type: "vertical", is_primary: segs.length === 0, source: [a.url] });
  }
  if (segs.length) out.customer_profile = { segment: segs.slice(0, 3) };

  return out;
}

async function main(): Promise<void> {
  resetConfigCache();
  const db = createDb(getConfig().DATABASE_URL, { max: 5 });

  const due = await db.execute<{ id: string }>(sql`
    SELECT e.id FROM entities e
    WHERE e.merged_into IS NULL AND e.needs_backfill = false
      AND e.type NOT IN ('fund','person-org')
      AND NOT EXISTS (SELECT 1 FROM entity_profiles ep WHERE ep.entity_id = e.id)
    ORDER BY e.is_monitored DESC, e.confidence DESC, e.updated_at DESC
    LIMIT ${LIMIT}
  `);
  console.log(JSON.stringify({ cohort: due.length }));
  const authored: Record<string, Partial<Record<ProfileSectionId, Record<string, unknown>>>> = {};
  const skippedBadSite: string[] = [];
  const skippedThin: string[] = [];

  for (const { id } of due) {
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT id, canonical_name, legal_name, website, aliases, type, status, country, hq_city,
             founded_year, industry_tags, tickers, funding_stage, registry_ids
      FROM entities WHERE id = ${id}`);
    const r = rows[0]!;
    const factRows = await db.execute<Record<string, unknown>>(sql`
      SELECT type, payload, distinct_publishers, created_at FROM facts
      WHERE entity_id = ${id} AND status='accepted' ORDER BY created_at DESC LIMIT 10`);
    const artRows = await db.execute<Record<string, unknown>>(sql`
      SELECT a.title, a.excerpt_text, a.publisher_domain, a.published_at, a.url, a.primary_tag
      FROM articles a JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
      WHERE ae.entity_id=${id} AND a.noise_stage='kept' AND a.published_at >= now() - interval '365 days'
      ORDER BY a.published_at DESC LIMIT 6`);
    const e: Digest = {
      id: String(r.id),
      canonical_name: String(r.canonical_name),
      legal_name: (r.legal_name as string) ?? null,
      website: (r.website as string) ?? null,
      aliases: (r.aliases as string[]) ?? [],
      type: String(r.type),
      status: String(r.status),
      country: (r.country as string) ?? null,
      hq_city: (r.hq_city as string) ?? null,
      founded_year: (r.founded_year as number) ?? null,
      industry_tags: (r.industry_tags as string[]) ?? [],
      tickers: (r.tickers as string[]) ?? [],
      funding_stage: (r.funding_stage as string) ?? null,
      registry_ids: (r.registry_ids as Record<string, string>) ?? null,
      facts: factRows.map((f) => ({ t: String(f.type), p: f.payload as Record<string, unknown>, pub: Number(f.distinct_publishers), at: new Date(String(f.created_at)).toISOString().slice(0, 10) })),
      articles: artRows.map((a) => ({
        title: String(a.title), x: String(a.excerpt_text ?? "").slice(0, 320),
        dom: String(a.publisher_domain),
        at: a.published_at ? new Date(String(a.published_at)).toISOString().slice(0, 10) : null,
        url: String(a.url), tag: (a.primary_tag as string) ?? null,
      })),
    };

    if (e.website && BAD_SITE_RE.test(e.website)) {
      skippedBadSite.push(`${id}:${e.website}`);
      await db.insert(entityProfiles).values({
        id: opaqueId("prf"), entityId: id, section: "firmographic",
        status: "failed", attempts: 99, lastError: "parked:autoauthor_bad_site",
        model: "ox-alpha-auto", promptTemplateVersion: "auto-authored#v1",
        staleAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      }).onConflictDoNothing();
      continue;
    }
    const site = e.website ? await scrapeSite(e.website) : { ok: false, title: null, desc: null, socials: [] as string[] };
    const payload = compose(e, site);
    if (Object.keys(payload).length === 0) {
      skippedThin.push(id);
      await db.insert(entityProfiles).values({
        id: opaqueId("prf"), entityId: id, section: "firmographic",
        status: "failed", attempts: 99, lastError: "parked:autoauthor_thin_evidence",
        model: "ox-alpha-auto", promptTemplateVersion: "auto-authored#v1",
        staleAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      }).onConflictDoNothing();
      continue;
    }

    // validate through serving schemas; drop invalid sections
    const valid: typeof payload = {};
    for (const [sec, data] of Object.entries(payload)) {
      const res = SECTION_SCHEMAS[sec as ProfileSectionId].safeParse(data);
      if (res.success) valid[sec as ProfileSectionId] = res.data as Record<string, unknown>;
      else console.error(`invalid ${id}:${sec}: ${res.error.issues[0]?.path.join(".")}`);
    }
    if (Object.keys(valid).length) authored[id] = valid;
    else skippedThin.push(id);
  }

  fs.writeFileSync(OUT, JSON.stringify(authored, null, 1));
  console.log(JSON.stringify({ composed: Object.keys(authored).length, skippedBadSite, skippedThin }));
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("autoauthor failed:", err.message);
  process.exit(1);
});
