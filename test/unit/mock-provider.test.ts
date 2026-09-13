import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockProvider } from "../../src/llm/mock.js";
import { cosine } from "../../src/clustering/cluster.js";

const provider = new MockProvider();
const opts = (stage: string) => ({ stage, tier: "mini" as const });

const NoiseSchema = z.object({
  is_company_news: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});

function noiseUser(title: string, body: string): string {
  return `TITLE: ${title}\nPUBLISHER: example.com\nTEXT:\n${body}\nEVENT_TYPES funding.seed\nSECTORS ai_ml`;
}

async function noiseVerdict(
  title: string,
  body: string,
): Promise<{ is_company_news: boolean; confidence: number; reason: string }> {
  const res = await provider.chatJson(NoiseSchema, "sys", noiseUser(title, body), opts("noise_filter"));
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("noise_filter call failed");
  return res.data;
}

describe("mock noise_filter subject-event gate (v4)", () => {
  // Real headlines cut by the v3 lexical gate during the 2026-08 discard
  // audit (>=10% measured false-positive rate incl. A2 gold misses).
  const MUST_KEEP: Array<[string, string]> = [
    [
      "ApartmentIQ Announces 8M Customer Units and a $25 Million Follow-On Investment from Susquehanna Growth Equity",
      "ApartmentIQ, the property-technology platform, said the follow-on investment brings total funding to $40 million.",
    ],
    [
      "Icelandic SnerpaPower secures €3.4M to expand electricity management platform in Europe",
      "The Reykjavik-based startup will use the capital to enter three new markets.",
    ],
    ["Function Health Lands $450M Growth Round From General Catalyst", "The round values the health startup at $2.5B."],
    ["Antora snags $550M for heat batteries to run data centers and factories", " investors include..."],
    ["Marico Reports ₹630 Crore Q1 Profit, EBITDA Growth Hits 7-Year High", "Revenue rose 8% year over year."],
    ["TAQA H1 2026 Net Income Rises 9.7% to AED 4.1 Billion", "The utility attributed growth to renewables."],
    ["Subaru Sales Fall 12% in Canada as Global Quarterly Profit Drops 44%", "The automaker cited tariffs."],
    ["ByteDance signs first AI copyright deal with Hollywood’s MPA", "The agreement covers AI training data."],
    ["Masdar and EPCG sign agreements for 150 MW of solar in Montenegro", "The pact includes pumped hydro storage."],
    ["Khazna breaks ground on two data centre facilities in Abu Dhabi", "Capacity comes online in 2028."],
    ["Zigazoo Promotes President Ashley Mady To CEO", "Founder Tastad becomes executive chairman."],
    ["Zigazoo taps entertainment veteran as CEO to lead Gen Alpha expansion", "She joins from the studio world."],
    ["Big Green Egg Transitions Flexible Latitude Attorney to General Counsel", "The grill maker also named a COO."],
    ["Canva cuts revenue forecast by a third as it tackles high AI costs", "The design company lowered its outlook."],
    ["Sakana AI Tapped by Japan's Defense Ministry", "The Tokyo lab will supply AI systems."],
    ["Khazna, Presight sign long-term AI facility management contract", "The deal spans five years."],
  ];

  it("keeps genuine company events the previous gate discarded", async () => {
    for (const [title, body] of MUST_KEEP) {
      const v = await noiseVerdict(title, body);
      expect(v.is_company_news, `should KEEP: ${title}`).toBe(true);
    }
  });

  const MUST_DISCARD: Array<[string, string, RegExp]> = [
    [
      "Stocks to Watch: Profit-rise plays for the week ahead",
      "Analysts screen for companies whose profits rise fastest this quarter.",
      /markets_commentary/,
    ],
    [
      "Planning a Rs 10 crore retirement corpus? Know the mutual fund SIP amount you need",
      "A disciplined monthly SIP makes a large corpus achievable for salaried investors.",
      /markets_commentary/,
    ],
    [
      "Earnings calendar: week of August 24",
      "A day-by-day rundown of when every listed company reports results this week.",
      /markets_commentary/,
    ],
    [
      "The camera I always have with me keeps paying dividends",
      "A love letter to pocket photography, metaphorically profitable in joy only.",
      /no_subject_event/,
    ],
    [
      "Moon phase today explained: What the Moon will look like on August 22, 2026",
      "Tonight's moon sits between its last quarter and waning crescent.",
      /no_subject_event/,
    ],
    [
      "LWiAI Podcast #242 - ChatGPT Images 2.0, Qwen 3.6 Max, Kimi-K2.6",
      "This week's episode rounds up model releases and benchmarks.",
      /(nonnews|slop_title|no_subject_event)/,
    ],
    [
      "Nothing Headphone (a) is nearly 50% off today-only – yes, you should buy",
      "A limited-time discount on consumer headphones.",
      /retail_promo/,
    ],
    [
      "iOS 27 reveals Apple TV 4K, HomePod may get powerful new features",
      "Rumors about upcoming Apple hardware features.",
      /product_rumor/,
    ],
    [
      "Why Anthropic's $30 trillion sales pitch ahead of its IPO could make sense",
      "Commentary on valuation narratives ahead of a potential public offering.",
      /markets_commentary/,
    ],
  ];

  it("still discards commentary and evergreen content under the broadened gate", async () => {
    for (const [title, body, reasonRe] of MUST_DISCARD) {
      const v = await noiseVerdict(title, body);
      expect(v.is_company_news, `should DISCARD: ${title}`).toBe(false);
      expect(v.reason, `reason for: ${title}`).toMatch(reasonRe);
    }
  });
});

describe("FR-12 mock provider stages", () => {
  it("classifies a funding article into the taxonomy with sentiment + geo", async () => {
    const Schema = z.object({
      primary_tag: z.string(),
      secondary_tags: z.array(z.string()),
      sentiment: z.enum(["positive", "negative", "neutral"]),
      sentiment_score: z.number(),
      newsworthiness: z.enum(["high", "medium", "low"]),
      industry_primary: z.string().nullable(),
      industry_secondary: z.array(z.string()),
      countries: z.array(z.string()),
    });
    const user = `Enrich this article.

TITLE: Acme Robotics raises $12M Series A led by Sequoia
PUBLISHER: techcrunch.com
TEXT:
Acme Robotics, a San Francisco based robotics company, announced today that it raised $12 million in Series A funding led by Sequoia Capital. The startup will use the new funding to expand manufacturing and hire across engineering. Investors praised the strong growth and record demand.
EVENT_TYPES = funding.series_a
SECTORS = robotics_hardware`;
    const res = await provider.chatJson(Schema, "sys", user, opts("classify_enrich"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.primary_tag).toBe("funding.series_a");
    expect(res.data.sentiment).toBe("positive");
    expect(res.data.countries).toContain("US");
    expect(res.data.industry_primary).toBe("robotics_hardware");
  });

  it("extracts structured funding facts incl. amount + lead investors", async () => {
    const Schema = z.object({
      has_event: z.boolean(),
      type: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
    });
    const user = `From this article, extract the key event facts for the PRIMARY company (Acme Robotics, website acme.ai).

TITLE: Acme raises $12 million Series A
TEXT:
Acme Robotics announced a $12 million Series A round on 2026-06-01. The round was led by Sequoia Capital and Index Ventures.`;
    const res = await provider.chatJson(Schema, "s", user, opts("fact_extract"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.has_event).toBe(true);
    expect(res.data.type).toBe("funding_round");
    const payload = res.data.payload as Record<string, unknown>;
    expect(payload.funding_stage).toBe("series_a");
    expect(payload.amount_usd_est).toBe(12_000_000);
    expect(payload.lead_investors).toContain("Sequoia Capital");
  });

  it("interprets listgen filters lexically", async () => {
    const Schema = z.object({
      sectors: z.array(z.string()),
      countries: z.array(z.string()),
      funding_stage: z.array(z.string()),
      founded_after: z.number().nullable(),
      founded_before: z.number().nullable(),
      keywords: z.array(z.string()),
      exclude_keywords: z.array(z.string()),
      signals: z.array(z.string()),
    });
    const user = `Request: AI startups in the US that raised recently
Allowed sectors (ids): ai_ml robotics_hardware
Allowed funding stages: pre_seed, seed, series_a, series_b, series_c, late_stage, unknown

Extract filters.`;
    const res = await provider.chatJson(Schema, "s", user, { stage: "listgen_interpret", tier: "big" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sectors).toContain("ai_ml");
    expect(res.data.countries).toContain("US");
    expect(res.data.signals).toContain("raised_recently");
  });

  it("mock embeddings make near-duplicate headlines cluster", async () => {
    const a = "Acme Robotics raises $12M Series A led by Sequoia Capital";
    const b = "Acme Robotics raises $12M Series A led by Sequoia Capital (update)";
    const c = "UK weather brings rain to London again this weekend";
    const emb = await provider.embed([a, b, c], { stage: "test" });
    expect(emb.ok).toBe(true);
    if (!emb.ok) return;
    const [va, vb, vc] = emb.vectors;
    const simDup = cosine(va!, vb!);
    const simUn = cosine(va!, vc!);
    expect(simDup).toBeGreaterThan(0.9);
    expect(simUn).toBeLessThan(simDup - 0.3);
  });

  it("counterparty_extract ignores prompt field labels like Title:", async () => {
    const Schema = z.object({
      companies: z.array(z.object({ name: z.string(), role: z.string() })),
    });
    const user = `Title: Breedr Raises €23 Million for Global Expansion

Text: Livestock tech platform Breedr announced a €23 million round led by investors.

List every operating company named, with its role in the event.`;
    const res = await provider.chatJson(Schema, "s", user, opts("counterparty_extract"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = res.data.companies.map((c) => c.name);
    expect(names).not.toContain("Title");
    expect(names.some((n) => /breedr/i.test(n))).toBe(true);
  });

  it("judges stories for the benchmark harness", async () => {
    const Schema = z.object({
      results: z.array(
        z.object({
          index: z.number(),
          is_real_news: z.boolean(),
          is_about_company: z.boolean(),
          is_in_window: z.boolean(),
          reason: z.string(),
        }),
      ),
    });
    const user = `BENCHMARK TASK: verify retrieved news stories for company "Acme Robotics" within window 2026-08-01..2026-08-07.

RETRIEVED STORIES (one per line): 
1. [2026-08-02] Acme Robotics raises $12M Series A
2. [2026-09-30] Totally different company headline about Globex
3. undefined null nan

JSON: {"results":[...]}`;
    const res = await provider.chatJson(Schema, "s", user, { stage: "judge_story", tier: "judge" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.data.results;
    expect(r[0]?.is_about_company).toBe(true);
    expect(r[0]?.is_in_window).toBe(true);
    expect(r[1]?.is_about_company).toBe(false);
    expect(r[2]?.is_real_news).toBe(false);
  });
});

describe("mock batch_audit (pile as a set)", () => {
  it("returns one verdict per ITEM block using the same keep/tag reasoners", async () => {
    const Schema = z.object({
      items: z.array(
        z.object({
          index: z.number(),
          keep: z.boolean(),
          reason: z.string(),
          primary_tag: z.string().nullable(),
        }),
      ),
    });
    const user = `EVENT_TYPES = funding.series_a
SECTORS = robotics_hardware
ITEMS:
### ITEM 0
PUBLISHER: techcrunch.com
TITLE: Acme Robotics raises $12M Series A
LEAD: Acme Robotics announced a $12 million Series A round.

### ITEM 1
PUBLISHER: example.com
TITLE: Weekly market wrap and stocks to watch
LEAD: Analysts list names for the week ahead.`;
    const res = await provider.chatJson(Schema, "s", user, opts("batch_audit"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items).toHaveLength(2);
    const byIndex = new Map(res.data.items.map((i) => [i.index, i]));
    expect(byIndex.get(0)?.keep).toBe(true);
    expect(byIndex.get(0)?.primary_tag).toBe("funding.series_a");
    expect(byIndex.get(1)?.keep).toBe(false);
  });
});
