/* eslint-disable no-console -- this file IS an evaluation report */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import { opaqueId } from "../../src/lib/ulid.js";
import { sha256Hex, canonicalizeUrl } from "../../src/lib/hash.js";
import { entities, aliases, articles, articleEntities } from "../../src/db/schema.js";
import { TICKER_STOPWORDS } from "../../src/lib/quality.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { LocalStorage } from "../../src/storage.js";
import { handleFilterArticle, type PipelineDeps } from "../../src/queue/jobs.js";
import { resolveArticle, persistResolution } from "../../src/resolution/resolver.js";
import { enrichArticle } from "../../src/enrichment/pipeline.js";
import { llmNoiseFilter } from "../../src/filtering/llm-filter.js";

/**
 * Offline quality regression for the FR-24 precision overhaul: replays the
 * real production failure modes observed in the week-34 ingestion sample
 * (misattributed mega-cap rows, fake funding tags on finance columns,
 * syndicated duplicates, entertainment slop) plus genuine event rows that
 * MUST survive. Every fixture runs the live pipeline: filter -> resolve ->
 * enrich. Scores mirror the akta-style precision definitions used by the
 * FR-23 benchmark: gate accuracy x attribution precision x event precision.
 */

interface Outcome {
  kept: boolean;
  discardReason: string | null;
  stage: string | null;
  primaryEntityId: string | null;
  primaryConfidence: number | null;
  primaryTag: string | null;
}

interface FixtureJudgement {
  /** undefined = do not judge */
  gate?: boolean;
  attr: boolean;
  evt?: boolean;
}

interface Fixture {
  name: string;
  title: string;
  body: string;
  url?: string;
  pub: string;
  outlinks?: string[];
  judge: (o: Outcome, ids: Record<string, string>) => FixtureJudgement;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

let tdb: TestDb;
let deps: PipelineDeps;

const IDS: Record<string, string> = {};

async function insertFixtureArticle(f: Fixture, ageHours: number): Promise<string> {
  const id = opaqueId("art");
  const url = f.url ?? `https://${f.pub}/${slugify(f.title)}`;
  const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR ?? "/tmp/opencode/intel-eval-store");
  const path = await storage.put(`articles/${id}.txt`, f.body);
  await tdb.db.insert(articles).values({
    id,
    url: canonicalizeUrl(url),
    urlHash: sha256Hex(canonicalizeUrl(url)),
    publisherDomain: f.pub,
    title: f.title,
    publishedAt: new Date(Date.now() - ageHours * 3600_000),
    language: "en",
    extractedTextPath: path,
    extractedTextChars: f.body.length,
    extractedTextHash: sha256Hex(f.body),
    excerptText: f.body.slice(0, 400),
    outlinkDomains: f.outlinks ?? [],
    noiseStage: "pending",
    sourceId: null,
  });
  return id;
}

async function seedEntity(opts: {
  key: string;
  name: string;
  website: string;
  aliasList?: string[];
  tickers?: string[];
  monitored?: boolean;
}): Promise<void> {
  const id = opaqueId("ent");
  IDS[opts.key] = id;
  const aliasList = opts.aliasList ?? [];
  await tdb.db.insert(entities).values({
    id,
    canonicalName: opts.name,
    website: opts.website,
    type: "private",
    status: "operating",
    country: "US",
    industryTags: [],
    tickers: opts.tickers ?? [],
    aliases: aliasList,
    confidence: 0.95,
    isMonitored: opts.monitored ?? false,
  });
  for (const [alias, kind] of [
    ...[opts.name, ...aliasList].map((a) => [a, "name"] as const),
    // Mirror the FR-24 ticker-name backfill: non-stopword tickers are
    // promoted to name-kind aliases so they can anchor candidacy; stopworded
    // tickers stay ticker-only.
    ...(opts.tickers ?? []).map((t) => [t, TICKER_STOPWORDS.has(t.toLowerCase()) ? "ticker" : "name"] as const),
  ]) {
    await tdb.db.insert(aliases).values({
      id: opaqueId("als"),
      entityId: id,
      alias,
      aliasNormalized: alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      kind,
    });
  }
}

beforeAll(async () => {
  isolateConfig();
  tdb = await createTestDb();
  const normalized = normalizeExecuteShape(tdb.db) as never;
  deps = {
    db: normalized,
    registry: new SourceRegistry(normalized),
    router: new LlmRouter(normalized, makeProvider()),
    storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
  };

  await seedEntity({ key: "apple", name: "Apple Inc.", website: "apple.com", aliasList: ["Apple"], tickers: ["AAPL"] });
  await seedEntity({ key: "amazon", name: "Amazon.com", website: "amazon.com", aliasList: ["Amazon"], tickers: ["AMZN"] });
  // Real-KB shape: the short name exists ONLY as a ticker-kind alias row.
  await seedEntity({ key: "uber", name: "Uber Technologies, Inc", website: "uber.com", tickers: ["UBER"] });
  await seedEntity({ key: "meta", name: "Meta Platforms", website: "meta.com", aliasList: ["Meta"] });
  await seedEntity({ key: "ziff", name: "Ziff Davis", website: "ziffdavis.com", aliasList: ["Ziff Davis Group"] });
  await seedEntity({ key: "bostondynamics", name: "Boston Dynamics", website: "bostondynamics.com" });
  await seedEntity({ key: "tiktok", name: "TikTok", website: "tiktok.com" });
  await seedEntity({ key: "scaleai", name: "Scale AI", website: "scale.ai" });
  await seedEntity({ key: "acme", name: "Acme Robotics", website: "acme.ai", monitored: true });
});

// ------------------------------------------------------------------ fixtures
// Rows 1..19 replay the actual failure sample; rows 20..25 are genuine events
// that must survive the tightened funnel.

const FIXTURES: Fixture[] = [
  // ---- misattributed mega-cap noise (was: resolved to Apple/Amazon/etc.)
  {
    name: "iran-oil-tankers (was tagged Apple)",
    title: "Iran grants permission for Iraqi oil tankers to pass through Strait of Hormuz",
    body:
      "Iran has granted permission for a convoy of Iraqi oil tankers to pass through the Strait of Hormuz, easing weeks of tension over regional shipping lanes. " +
      "Maritime authorities confirmed the corridor remains open under naval supervision, and insurance costs for Gulf carriers eased slightly on the announcement. " +
      "Energy analysts cautioned that shipping volumes remain well below seasonal norms. Separately, several large technology exporters noted modest logistics delays on components routed through the region.",
    pub: "indiatimes.com",
    judge: (o) => ({
      gate: !o.kept || o.primaryEntityId == null,
      attr: o.primaryEntityId == null || (o.primaryEntityId !== IDS.apple && o.primaryEntityId !== IDS.amazon),
      evt: o.kept ? o.primaryTag == null : true,
    }),
  },
  {
    name: "hdfc-gold-etf-column (was tagged Apple/funding)",
    title: "HDFC and Axis Mutual Fund resume subscriptions in gold ETFs and gold ETF FoFs",
    body:
      "HDFC Mutual Fund and Axis Mutual Fund have reopened subscriptions in several gold exchange-traded funds and gold fund-of-funds after a brief suspension window. " +
      "Advisers said the reopening gives systematic-transfer investors a fresh entry point, though treasury desks warned that premium-to-spot spreads remain elevated. " +
      "Distributors expect flows to normalise over the next few dealing cycles as arbitrage desks rebuild inventory.",
    pub: "indiatimes.com",
    judge: (o) => ({
      gate: !o.kept || o.primaryEntityId == null,
      attr: o.primaryEntityId !== IDS.apple,
      evt: o.kept ? o.primaryTag == null : true,
    }),
  },
  {
    name: "delhi-university-phd (was tagged Apple)",
    title: "Delhi University opens direct PhD route for first FYUP batch as one-time measure",
    body:
      "Delhi University approved a one-time direct admission route to doctoral programmes for the first four-year undergraduate programme cohort. " +
      "Officials said the exemption applies only to students who completed the revised degree structure with the required research credits. " +
      "Department chairs were asked to publish seat matrices before counselling begins next month.",
    pub: "indiatimes.com",
    judge: (o) => ({ gate: !o.kept, attr: o.primaryEntityId !== IDS.apple, evt: true }),
  },
  {
    name: "sip-retirement-advice (was tagged Apple/legal.fine_penalty)",
    title: "Planning a Rs 10 crore retirement corpus? Know the mutual fund SIP amount you need",
    body:
      "Building a retirement corpus of Rs 10 crore looks daunting, but a disciplined monthly SIP makes it achievable for most salaried investors. " +
      "Assuming a 12% annualised return over 25 years, planners estimate a monthly contribution near Rs 32,000 gets you there, stepping up contributions annually. " +
      "Advisers caution against stopping instalments during drawdowns and recommend reviewing asset allocation every two years instead of reacting to headlines.",
    pub: "indiatimes.com",
    judge: (o) => ({
      gate: !o.kept,
      attr: o.primaryEntityId !== IDS.apple,
      evt: o.kept ? o.primaryTag == null : true,
    }),
  },
  {
    name: "braves-injured-list (sports wire, was product.launch)",
    title: "Braves vs. Brewers Series Injured List - Aug. 23-23 | 1049 Fox Sports Upstate",
    body:
      "The Atlanta Braves enter the weekend set against Milwaukee with two relievers day-to-day and a catcher still recovering from a wrist sprain. " +
      "Milwaukee's trainer room is quieter, though their starting pitcher remains on the 15-day injured list after a shoulder strain. " +
      "Roster moves are expected ahead of Saturday's game, with corresponding transactions to be announced once batting practice wraps up.",
    pub: "iheart.com",
    judge: (o) => ({ gate: !o.kept, attr: true, evt: true }),
  },
  {
    name: "pakistan-heart-centre (was funding.unknown_round)",
    title: "Pakistan s first heart transplant centre opened",
    body:
      "The country's first dedicated cardiac transplantation facility began receiving patients this week, staffed by a surgical team trained abroad. " +
      "Health officials described the unit as a milestone for organ-failure treatment, with an initial capacity of forty procedures a year. " +
      "A national donor registry is expected to follow, funded through a public-private health partnership framework signed earlier this year.",
    pub: "com.pk",
    judge: (o) => ({ gate: !o.kept, attr: true, evt: true }),
  },
  {
    name: "moon-phase-explainer (was tagged Ziff Davis/product.launch)",
    title: "Moon phase today explained: What the Moon will look like on August 22, 2026",
    body:
      "Tonight's moon sits between its last quarter and waning crescent, rising after midnight and fading into the eastern dawn sky. " +
      "Skywatchers with clear horizons can catch earthshine on the dark portion shortly before sunrise. " +
      "Almanac notes: illumination sits near 18% and declines through the week toward the new moon on August 27.",
    pub: "mashable.com",
    judge: (o) => ({ gate: !o.kept, attr: o.primaryEntityId !== IDS.ziff, evt: true }),
  },
  {
    name: "maher-hunter-interview (was tagged Canva/funding)",
    title: "Bill Maher Puts Hunter Biden in the Hot Seat: \u2018I\u2019ve Seen You With Your Dick Out\u2019",
    body:
      "The late-night host pressed the former president's son on his controversies during a combative half-hour conversation that ranged from addiction recovery to art-world dealings. " +
      "Audience laughter punctuated several exchanges, and the guest repeatedly accused media outlets of inflating the story. " +
      "Clips circulated widely online within the hour, dominating political social feeds into the night.",
    pub: "variety.com",
    judge: (o) => ({ gate: !o.kept, attr: true, evt: true }),
  },
  {
    name: "brex-job-posting (was tagged Reddit)",
    title: "Private Equity Partnerships Associate - Brex",
    body:
      "Location: New York, NY. About the role: own relationships with private equity firms and family offices evaluating corporate card and treasury products. " +
      "Responsibilities include coordinating diligence requests, preparing portfolio-company rollouts, and supporting quarterly business reviews with strategic accounts. " +
      "Qualifications: three-plus years in institutional sales or capital formation; travel up to 30%. Compensation ranges listed on the careers page alongside benefits details.",
    pub: "builtinsf.com",
    judge: (o) => ({ gate: !o.kept, attr: true, evt: true }),
  },
  {
    name: "odyssey-ott-release (entertainment, was tagged Apple/product.launch)",
    title: "The Odyssey OTT release date and platform details: When and where to watch Christopher Nolan's epic",
    body:
      "Christopher Nolan's mythic adventure finally has a streaming window after its record-breaking theatrical run. " +
      "Here's when subscribers can stream the blockbuster at home, which tiers include it, and whether a dubbed cut ships alongside the original. " +
      "Digital listings for Apple TV buyers show a purchase option arriving the same week, with rental pricing expected to follow standard studio windows.",
    pub: "indiatimes.com",
    judge: (o) => ({
      gate: !o.kept || o.primaryEntityId == null,
      attr: o.primaryEntityId !== IDS.apple,
      evt: true,
    }),
  },
  {
    name: "vision-pro-naming-trivia (was research.paper)",
    title: "Apple Vision Pro Was Almost Called 'Reality Pro'",
    body:
      "A new oral history reveals the headset nearly shipped under a different banner, with executives divided over the naming until late in development. " +
      "Marketing documents show internal debates about whether leading with the reality branding would confuse shoppers accustomed to the computer-maker's usual conventions. " +
      "The anecdote lands as the device approaches its second anniversary on shelves.",
    pub: "macrumors.com",
    judge: (o) => ({
      gate: !o.kept || o.primaryTag == null,
      attr: o.primaryEntityId == null || o.primaryEntityId === IDS.apple,
      evt: o.kept ? o.primaryTag == null : true,
    }),
  },
  {
    name: "imagen-awards-listicle (was tagged Tumblr)",
    title: "Imagen Awards: \u2018Acapulco\u2019 Leads As \u2018Brownsville Bred,\u2019 \u2018Will Trent\u2019 & \u2018Scrubs\u2019 Take Top Prizes \u2013 Full List",
    body:
      "The annual celebration honoring Latino representation in television handed its biggest prize to the Apple-backed comedy set at a coastal resort. " +
      "Winners across acting and writing categories reflected a broad spread among streaming platforms and broadcast networks alike. " +
      "Organizers also honored a lifetime-achievement recipient whose credits span four decades of bilingual programming.",
    pub: "deadline.com",
    judge: (o) => ({ gate: !o.kept, attr: true, evt: true }),
  },
  {
    name: "harry-meghan-celebrity (was tagged Apple/funding.late_stage)",
    title: "Is this the end of Harry and Meghan's American dream?",
    body:
      "Rumours of strained ties with their California neighbours and shrinking production slates have reignited speculation about the couple's future in Montecito. " +
      "Insiders describe stalled projects and a pivot toward personal-brand ventures rather than scripted television. " +
      "Neither camp commented, though a spokesperson dismissed the reports as recycled gossip ahead of a busy autumn season.",
    pub: "aol.co.uk",
    judge: (o) => ({ gate: !o.kept, attr: o.primaryEntityId !== IDS.apple, evt: true }),
  },
  {
    name: "spy-thriller-review (was tagged Apple/funding.late_stage)",
    title: "Apple TV's 6-Part Spy Thriller Is a Rare Streaming Gem With Zero Bad Episodes",
    body:
      "Every installment earns its place in a tightly plotted espionage drama that trusts its audience and never wastes a scene. " +
      "Performances across the ensemble elevate familiar genre beats, and the direction keeps loyalties deliciously ambiguous until the finale. " +
      "It's the kind of slow-burn commission that critics begged streaming services to make more of.",
    pub: "collider.com",
    judge: (o) => ({ gate: !o.kept, attr: true, evt: true }),
  },
  {
    name: "nbc-royalty-nostalgia (was tagged Amazon/token_sale)",
    title: "NBC Made a Huge Mistake Cancelling This Modern Royalty Series 17 Years Ago",
    body:
      "Fifteen years before prestige television embraced palace intrigue, this overlooked court drama was doing it weekly on network primetime. " +
      "Its cancellation remains a cautionary tale about scheduling against established comedies and marketing a costume piece to the wrong audience. " +
      "Retrospective rankings keep placing it atop lists of shows rescued from obscurity by streaming libraries.",
    pub: "collider.com",
    judge: (o) => ({ gate: !o.kept, attr: o.primaryEntityId !== IDS.amazon, evt: true }),
  },
  {
    name: "tepper-stock-commentary (was tagged Uber/funding)",
    title: "Billionaire David Tepper Sells Lyft in Favor of Its Biggest Rival, Which Has 30% Upside, According to Wall Street",
    body:
      "Billionaire David Tepper's hedge fund exited its stake in the smaller ride-hailing operator last quarter and bought its larger competitor instead, a fresh filing shows. " +
      "Uber Technologies now counts the activist-friendly money manager among holders, and its shares rose modestly on the disclosure. " +
      "Analysts cited pricing discipline and a fast-growing advertising arm when explaining why the Street sees roughly 30% upside from current levels.",
    pub: "fool.com",
    judge: (o, ids) => ({
      gate: true, // kept-or-rejected both acceptable; harm only via wrong tagging
      attr: o.primaryEntityId == null || o.primaryEntityId !== ids.uber,
      evt: o.primaryTag?.startsWith("funding") ? false : true,
    }),
  },

  // ---- syndicated wire copy (must collapse)
  {
    name: "tepper-stock-commentary-DUPLICATE (syndicated copy)",
    title: "Billionaire David Tepper Sells Lyft in Favor of Its Biggest Rival, Which Has 30% Upside, According to Wall Street",
    body:
      "Billionaire David Tepper's hedge fund exited its stake in the smaller ride-hailing operator last quarter and bought its larger competitor instead, a fresh filing shows. " +
      "Uber Technologies now counts the activist-friendly money manager among holders, and its shares rose modestly on the disclosure. " +
      "Analysts cited pricing discipline and a fast-growing advertising arm when explaining why the Street sees roughly 30% upside from current levels.",
    pub: "kxlx.iheart.com",
    judge: (o) => ({
      gate: !o.kept || /duplicate/i.test(o.discardReason ?? ""),
      attr: true,
      evt: true,
    }),
  },

  {
    name: "sweetnight-mattress-launch (wire release; must NOT attach to Amazon)",
    title: "SweetNight Unveils CoolNest Ultra Cooling Memory Foam Mattress for Hot Sleepers",
    body:
      "The sleep brand introduced a cooling mattress engineered around a phase-change cover and open-cell foam core aimed at hot sleepers. " +
      "SweetNight said the line expands its cooling portfolio alongside adjustable bases and pillows sold through its own site and major retail partners. " +
      "Availability begins immediately, with launch pricing undercutting comparable memory-foam rivals by roughly fifteen percent.",
    pub: "prnewswire.com",
    judge: (o, ids) => ({
      attr: o.primaryEntityId == null || o.primaryEntityId !== ids.amazon,
      evt: true,
    }),
  },
  {
    name: "genesis-gv90-reveal (was tagged Amazon/product.launch)",
    title: "Genesis Ushers In A New Age of Fully Electric Luxury with the Flagship GV90 SUV",
    body:
      "The Korean luxury marque pulled the covers off its largest electric sport-utility to date at a private preview for dealers and press. " +
      "Executives billed the flagship as a technology showcase, citing a dual-motor powertrain, a curved widescreen cockpit, and hands-free highway assist. " +
      "Orders open this fall with deliveries beginning early next year, positioning the three-row model against established German rivals.",
    pub: "cleantechnica.com",
    judge: (o) => ({
      gate: !o.kept || o.primaryEntityId == null,
      attr: o.primaryEntityId !== IDS.amazon,
      evt: true,
    }),
  },

  // ---- genuine events that MUST survive
  {
    name: "GOOD: apple layoffs",
    title: "Apple cuts 200+ jobs across Siri and Vision Pro teams amid AI realignment",
    body:
      "Apple Inc. confirmed it eliminated just over 200 positions spanning its Siri and Vision Pro software groups as part of a broader artificial-intelligence realignment. " +
      "The layoffs concentrate in testing and operations roles in San Diego and Cupertino, though the iPhone maker said it keeps hiring machine-learning engineers. " +
      "Affected employees receive severance and internal transfer windows, and the restructuring follows January's leadership shake-up of the voice-assistant group.",
    pub: "adgully.com",
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.apple && (o.primaryConfidence ?? 0) >= 0.55,
      evt: o.primaryTag != null && o.primaryTag.startsWith("risk."),
    }),
  },
  {
    name: "GOOD: acme series A",
    title: "Acme Robotics raises $12M Series A led by Sequoia Capital",
    body:
      "Acme Robotics, the San Francisco warehouse-automation startup, closed a $12 million Series A round led by Sequoia Capital with participation from existing angels. " +
      "The company will expand manufacturing of its picking robots and double its engineering team over the next year. " +
      "Founders said demand from third-party logistics operators tripled year over year, with deployments now running across eleven fulfillment centers nationwide.",
    pub: "techcrunch.com",
    outlinks: ["acme.ai"],
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.acme,
      evt: o.primaryTag != null && o.primaryTag.startsWith("funding."),
    }),
  },
  {
    name: "GOOD: meta invests in scale ai",
    title: "Meta invests $14.8 bln in Scale AI, hires its 28-year-old CEO",
    body:
      "Meta invests $14.8 billion for a 49% stake in the data-labeling startup Scale AI and recruits founder Alexandr Wang to co-lead a new superintelligence lab. " +
      "Meta Platforms described the transaction as its largest outside bet ever, structured as tender offers for existing shares rather than a traditional round. " +
      "Scale AI will keep serving enterprise customers while Wang departs day-to-day duties to join the lab reporting to Mark Zuckerberg.",
    pub: "thedailystar.net",
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.meta,
      evt: o.primaryTag != null && (o.primaryTag.startsWith("mna.") || o.primaryTag.startsWith("funding.")),
    }),
  },
  {
    name: "GOOD: tiktok settlement",
    title: "TikTok reaches US$400 million settlement with US Justice Department over children's privacy",
    body:
      "TikTok will pay $400 million to resolve Justice Department claims that the short-video platform violated children's privacy law, according to a court filing made public Tuesday. " +
      "TikTok admitted no wrongdoing in the settlement, which additionally mandates independent audits of its youth-safety controls for three years. " +
      "The agreement ends a multiyear probe into how the service handled private messages from users under 13.",
    pub: "jamaica-gleaner.com",
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.tiktok,
      evt: o.primaryTag != null && o.primaryTag.startsWith("legal."),
    }),
  },
  {
    name: "GOOD: ziff davis divestiture",
    title: "Ziff Davis Sells Speedtest and Downdetector for $1.2 Billion: What's Next?",
    body:
      "Ziff Davis agreed to sell Speedtest and Downdetector to Littlestar Capital in a deal valued at $1.2 billion, ending the brands' long run inside the digital publisher. " +
      "Ziff Davis said proceeds will fund buybacks and its health-technology portfolio, while the connectivity tools move to an independent home under Littlestar ownership. " +
      "Both services will keep their teams and headquarters, with closing expected by early October pending regulatory review.",
    pub: "controversyexplained.com",
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.ziff,
      evt: o.primaryTag != null && o.primaryTag.startsWith("mna."),
    }),
  },
  {
    name: "GOOD: boston dynamics ceo departure",
    title: "Boston Dynamics CEO Robert Playter Steps Down: What's Next for the Robotics Giant?",
    body:
      "Boston Dynamics said chief executive Robert Playter will step down after five years leading the robotics maker, transitioning to an advisory role on the board. " +
      "Boston Dynamics named chief operating officer Dana Okafor as successor effective October 1, calling the handoff planned rather than reactive. " +
      "Playter guided the company through its commercial pivot toward warehouse robots and the electric Atlas platform.",
    pub: "chennaiclassifiedads.com",
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.bostondynamics,
      evt: o.primaryTag != null && o.primaryTag.startsWith("leadership."),
    }),
  },
  {
    name: "GOOD: uber robotaxi (short name lives only in ticker-kind alias)",
    title: "Uber and Pony.ai plan to bring 2,000 robotaxis to Europe",
    body:
      "Ride-hailing company Uber announced a multiyear partnership with Chinese autonomous-driving startup Pony.ai to deploy over 2,000 robotaxis across European cities starting next year. " +
      "The agreement makes Pony.ai the anchor supplier for Uber's European autonomous fleet, expanding a pilot that has operated in California since 2024. " +
      "Executives said safety drivers will ride along during the initial deployment phase.",
    pub: "techcrunch.com",
    judge: (o, ids) => ({
      gate: o.kept,
      attr: o.primaryEntityId === ids.uber,
      evt: o.primaryTag != null && o.primaryTag.startsWith("partnership."),
    }),
  },
];

describe("FR-24 offline quality eval (failure-sample regression)", () => {
  const outcomes = new Map<string, Outcome>();

  it(
    "runs the full pipeline over the failure-sample fixtures and scores >= 60",
    async () => {
      let age = 0;
      for (const f of FIXTURES) {
        age += 2; // stagger creation times
        const id = await insertFixtureArticle(f, age);
        const filterRes = await handleFilterArticle(deps, id);
        const [row] = await tdb.db.select().from(articles).where(eq(articles.id, id));
        const o: Outcome = {
          kept: filterRes.waiting,
          discardReason: (row?.discardReason as string | null) ?? null,
          stage: (row?.noiseStage as string | null) ?? null,
          primaryEntityId: null,
          primaryConfidence: null,
          primaryTag: null,
        };
        if (filterRes.waiting && row) {
          // Harness part 1: corrections (relevance + resolution) + enrichment.
          const stored = (await deps.storage.get(row.extractedTextPath ?? "")) ?? "";
          const verdict = await llmNoiseFilter(deps.router, {
            title: row.title,
            body: stored || row.title,
            publisher: row.publisherDomain,
          });
          if (!verdict.kept) {
            o.kept = false;
            o.discardReason = verdict.reason;
            outcomes.set(f.name, o);
            continue;
          }
          const resolution = await resolveArticle(
            deps.db,
            deps.router,
            { articleId: id, title: row.title, lead: stored.slice(0, 1600) || row.title, outlinkDomains: row.outlinkDomains },
          );
          await persistResolution(deps.db, id, resolution);
          if (f.name.includes("uber robotaxi")) {
            const links = await tdb.db.select().from(articleEntities).where(eq(articleEntities.articleId, id));
            console.log("[dbg] uber robotaxi:", JSON.stringify(resolution),
              "links:", links.length,
              "| excerptText head:", (row.excerptText ?? "").slice(0, 140));
          }
          if (resolution.primaryEntityId != null && resolution.primaryConfidence != null) {
            await enrichArticle(deps.db, deps.router, {
              articleId: id,
              title: row.title,
              body: stored || row.title,
              publisherDomain: row.publisherDomain,
              sourceTier: null,
            });
            const links = await tdb.db.select().from(articleEntities).where(eq(articleEntities.articleId, id));
            const primary = links.find((l) => l.role === "primary");
            const [after] = await tdb.db.select().from(articles).where(eq(articles.id, id));
            o.primaryEntityId = primary?.entityId ?? null;
            o.primaryConfidence = primary?.confidence ?? null;
            o.primaryTag = (after?.primaryTag as string | null) ?? null;
          }
        }
        outcomes.set(f.name, o);
      }

      // ------------------------------------------------------------- scoring
      let gateTotal = 0, gateOk = 0;
      let attrTotal = 0, attrOk = 0;
      let evtTotal = 0, evtOk = 0;
      const detail: string[] = [];
      for (const f of FIXTURES) {
        const o = outcomes.get(f.name)!;
        const j = f.judge(o, IDS);
        detail.push(
          `${j.gate === false || j.attr === false ? "FAIL" : "ok  "} | ${f.name} | kept=${o.kept}` +
            ` stage=${o.stage}${o.discardReason ? ` (${o.discardReason.slice(0, 40)})` : ""}` +
            ` entity=${o.primaryEntityId ?? "-"}(${o.primaryConfidence ?? "-"})` +
            ` tag=${o.primaryTag ?? "-"}`,
        );
        if (j.gate !== undefined) {
          gateTotal++;
          if (j.gate) gateOk++;
        }
        if (j.attr !== undefined) {
          attrTotal++;
          if (j.attr) attrOk++;
        }
        if (j.evt !== undefined) {
          evtTotal++;
          if (j.evt) evtOk++;
        }
      }
      console.log("\n=== FR-24 quality eval detail ===\n" + detail.join("\n"));

      const gatePct = gateTotal ? (gateOk / gateTotal) * 100 : 100;
      const attrPct = attrTotal ? (attrOk / attrTotal) * 100 : 100;
      const evtPct = evtTotal ? (evtOk / evtTotal) * 100 : 100;
      const overallPct = (gatePct * attrPct * evtPct) / 10_000;
      console.log(
        `\ngate=${gatePct.toFixed(1)}% (${gateOk}/${gateTotal})  attr=${attrPct.toFixed(1)}% (${attrOk}/${attrTotal})  event=${evtPct.toFixed(1)}% (${evtOk}/${evtTotal})  OVERALL=${overallPct.toFixed(1)}%`,
      );

      expect(attrPct).toBeGreaterThanOrEqual(60);
      expect(overallPct).toBeGreaterThanOrEqual(60);
    },
  );
});
