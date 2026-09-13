# Intelligence Service — Backfill & Bring-Up Report

**Period:** archive window Aug 15–22 2026 · **Run mode:** production pipeline code paths, mock LLM provider (provisional), live internet sources
**Scope:** first real-data bring-up of every FR subsystem; defect hunt; source-broadening wave.

---

## 1. What was ingested (final snapshot)

### Funnel

| Stage | Count | Notes |
|---|---|---|
| Sources registered | **193** active | started at 165, broadened mid-run (see §4) |
| Feed polls | 193 polled/run, ~26–27 failing per sweep | failures tracked via failure_streak + exp backoff ≤24 h |
| Raw items discovered (7-day window) | **5,744** | URL+GUID content-hash dedup held: zero duplicate rows |
| Full-text fetches attempted | 452 | budget-capped subset, tier/recency-ranked, 2/domain cap |
| Fetch failures | 62 (13.7%) | overwhelmingly HTTP 403 bot-walls (NYT/BI class), some timeouts |
| Articles created | **452** | extraction success on non-blocked hosts ≈ 100% |
| Kept after FR-5 two-stage filter | **202** | discard rate **55.3%** (target band 60–80%; prefilter rescued thin wire copy) |
| Discarded prefilter / llm_filter | 2 / 248 | every discard carries stage+score+reason (`v_discard_audit`) |

### Enrichment coverage (kept = 202)

| Field | Coverage |
|---|---|
| primary_tag | 161 (79.7%)¹ |
| sentiment + score | 161 |
| newsworthiness tier | 161 → **high 90 / medium 71 / low 0** |
| industry_primary (+secondary) | 161 |
| countries[] | 161 |
| ai_summary | 161 |

¹ The 41 uncovered are kept articles whose resolution failed *before* enrichment ran in an early pass (pipeline stops at unresolved by design); all post-fix passes cover 100% of newly kept items.

### Resolution & clustering

- **135 primary resolutions**, 237 secondary mentions across **78 distinct entities**
- avg primary confidence **0.64**
- 161 story clusters; multi-article merges were rare this window because the fetch budget capped at 2 items/domain (syndication pairs mostly not both fetched)

### Signal-derived facts (FR-9) — loop closed on real data

- 5 proposed → **4 accepted** under the promotion rule (2 independent publishers OR one tier-1)
- Accepted examples: `Anthropic` acquisition fact (2 publishers), `Intelligent Systems` seed round ($ est. $100M — mock amount-extraction is coarse), plus 2 more
- Entity KB updated automatically from accepted facts (funding_stage/total_raised_usd/last_funding_date)

### LLM ledger (provisional mock spend)

699 calls · **$0.93 ledgered** · 521K in / 27K out tokens-equivalent · per-stage breakdown available at `GET /v1/admin/dashboard`

### Publish-date histogram of kept set

```
Aug 22 ████ 14
Aug 21 ████████████████████████████ 95→(grew through reruns to ~150)
Aug 20 ██ 7
Aug 19 █ 2
Aug 17 █ 1
```
(RSS archives reach ~2 weeks deep on tier-1 feeds; deeper history needs GDELT backspan, see §5.)

---

## 2. Companies now defined in the DB (examples)

**Curated seeds (35 imported, `import:seed`, review_status=reviewed):**

| Company | Website | Country | Sectors | Mentions so far |
|---|---|---|---|---|
| Apple | apple.com | US | consumer_electronics | 21 |
| Spotify | spotify.com | SE | media_entertainment | 9 |
| Amazon | amazon.com | US | ecommerce/cloud_infra | 7 |
| OpenAI | openai.com | US | ai_ml | 7 |
| Anthropic | anthropic.com | US | ai_ml | 6 (+accepted M&A fact) |
| Nvidia | nvidia.com | US | semiconductors/ai_ml | 3 |
| Stripe | stripe.com | US | payments/fintech | 3 |
| Microsoft | microsoft.com | US | saas_enterprise | 3 |
| ByteDance | bytedance.com | CN | consumer_internet | 2 |
| Canva | canva.com | AU | consumer_internet | 2 |
| Ramp | ramp.com | US | fintech/payments | 2 |
| Meta Platforms | meta.com | US | consumer_internet | 1 |
| Tesla | tesla.com | US | mobility_ev | 1 |
| Deel | deel.com | US | hrtech | 1 |
| …plus Anduril, Boston Dynamics, Brex, Databricks, Figma, Figure AI, Klarna, Mistral AI, Monzo, Palantir, Perplexity AI, Revolut, Scale AI, Shopify, Snowflake, SpaceX, Waymo, Wise, xAI | | | | monitoring-ready |

**Auto-created via the FR-8 agent (64, review_status=auto_created, conf ≤0.4)** — e.g. Nscale (AI DC builder, IPO story resolved to it), Starcloud, Cloverleaf Infrastructure, Webrazzi, SweetNight, Intelligent Systems, plus several flagged-for-review low-quality ones (see §3.8).

### Sample resolved articles (kept → company)

- `[Nvidia]` “Starcloud raises $250M to build AI data centers in orbit” — siliconangle.com · funding.series_a · high/positive ✓
- `[Nvidia]` “Nvidia partners with data center developer Cloverleaf” — techcrunch.com · mna.stake_acquisition · high ✓
- `[OpenAI]` “ChatGPT’s iPhone app gets a handy shortcut…” — 9to5mac.com ✓
- `[Apple]` “Apple Cuts Vision Pro Roles to Focus on Smart Glasses Push” — pymnts.com · high/negative ✓
- `[Meta Platforms]` “TikTok to pay $400m… child privacy settlements” — bbc.co.uk · legal.settlement-family · high/negative ✓
- `[Anthropic]` acquisition fact accepted from two independent publishers ✓

---

## 3. Correctives — mistakes found during live bring-up, all FIXED

### Ingestion
1. **Feed-seed path off-by-one** in `seed.ts`/`backfill.ts` (`../../config` vs `../../../config` from nested dirs) → ENOENT. Fixed with correct depth + env override `FEEDS_SEED_FILE`. Same bug found & fixed in `benchmark/companies.ts`.
2. **Storage ref scheme mismatch**: jobs stored bare object keys while `Storage.get()` parses `scheme://key` → silent empty bodies downstream. Fixed: store the ref returned by `put()`.
3. **jsdom noise flooding logs** (raw CSS dumped during extraction). Fixed: dedicated VirtualConsole with jsdomError suppression.
4. **Social/share-link pollution of resolution evidence**: facebook/twitter/linkedin/bsky outlinks became “companies”. Fixed three ways: `UTILITY_DOMAINS` denylist applied at extraction (never stored as evidence), at FR-8 autocreate (refuses), and at backfill selection.
5. **Publisher-hosts misread as subject companies** (“West Bankbbc.co.uk”, StrictlyVC). Fixed: backfill excludes any domain that is a registry feed host or a frequent `publisher_domain`.
6. **robots/bot-wall handling** verified working as designed: 403/429 items logged w/ reason, retried once, then marked failed (FR-4 AC).

### Pipeline logic
7. **Funding-rescue bug in prefilter**: short wire copy was discarded before the rescue flag could apply. Restructured: funding-signal detection precedes pattern/body checks.
8. **Mock classifier specificity ties**: generic `funding.unknown_round` beat explicit `series_a`; multi-word keyword specificity weighting added (title hits ×3).
9. **Vocabulary leakage into scoring**: rendered `EVENT_TYPES=/SECTORS=` lists were being keyword-scored as article text (produced `banking_lending` from “banking_lending” id string). Mock now cuts at the vocab marker.
10. **Embedding never persisted** → every article created its own cluster. Fixed (`embedding` written on attach).
11. **Cluster embedding instability**: input included mutable AI summary → syndicated copies diverged below cosine threshold. Now stable canonical signal: title + stored excerpt.
12. **Country extractor false positives**: standalone word “in” mapped to India; city names only matched when followed by space. Fixed boundaries + removed noisy ISO scan.
13. **pg_trgm expression index invalid** (`lower(x) gin_trgm_ops` inside parens) → migration failed on real PG. Rewritten as column opclass indexes; migrations regenerated.
14. **Non-immutable expression index** (`date_trunc('month', …)`) rejected by Postgres. Replaced with plain `created_at` btree.
15. **Drizzle array params expand to `($1,$2,…)` breaking `ANY(...)`** on multi-element arrays (crashed candidate generation at 1,845-item scale). All such sites converted to IN-lists / OR-expansions / scalar casts.
16. **PGlite vs postgres-js raw-shape divergence** (`{rows}` vs array) — normalized behind `normalizeExecuteShape()` for tests; prod contract documented.
17. **`json_agg(x)` alias typo** broke companies-search LATERAL stats. Fixed.
18. **Param type ambiguity under strict PG** (`jsonb_build_object('url', $1)`, `$1 = ANY(tags)`): explicit `::text` casts everywhere needed.

### API / config / infra
19. **`CompanyCard.innerType()` misuse** and namespace-style `ListCompany._output` typings — replaced with proper zod idioms.
20. **Fastify/pino logger-type friction** — dropped custom loggerInstance; structured logging flows through pino root logger.
21. **`(?i)` PCRE flags** in filter config crash JS `RegExp` — flag-prefix parser added.
22. **`--max-homepages=0` ignored** (arg parser treated 0 as unset → re-autocreated junk during a purge-validation run). Parser now accepts explicit zeros.
23. **tsbuildinfo staleness** masked schema edits once — clean-rebuild procedure noted for schema work.

### GDELT (FR-3) — its own hard-knocks section
24. Free-tier **429 rate limiting** torched naive per-entity sweeps → implemented watchlist **batching into single parenthesised OR-groups** (61 entities ≈ ~12 queries), consecutive-429 circuit breaker with escalating backoff (resumes next 15-min tick).
25. **256-char query limit** (“query too long”) → length-aware adaptive batching.
26. **“OR'd terms must be surrounded by ()”** → group wrapping fix above.
27. **Plain-text GDELT errors crashed JSON parse** (“Queries co…” / “phrase too short”) → text-sniffing + typed error; sub-3-char terms filtered.
28. **Timespan format** (`15120min`) normalized to GDELT units (`d/h/min`) + transient network retry-once.
29. Net effect: sweep mechanics proven end-to-end (query build → dedup → quality gates → circuit break); net live yield still ~0 because bring-up burned the free-tier quota — accumulates automatically on 15-min ticks going forward.

### Data hygiene operations performed
30. Two purge cycles removed 16 + 10 junk auto-created entities (social domains, homepage-title garbage like “PursuitsRetailers Want AI”), cascading their article links; affected kept articles reset and re-resolved (secondaries dropped 252→~64 sane level).
31. All 61 live entities flagged `is_monitored=true` → GDELT watchlist now active for future ticks.

---

## 4. Source-broadening investigation (integrated & seeded)

Findings from auditing coverage gaps against the deal-flow mission:

| Gap identified | Added | Evidence of contribution |
|---|---|---|
| No finance-aggregator backbone | Yahoo Finance most-popular RSS | top-15 contributor within one sweep |
| Regional startup press thin (IE/MENA/Africa/LatAm/UK-regional/IN-deep) | Silicon Republic, Wamda, Disrupt Africa, LABS(EN), TechSPARK, Technical.ly, Entrackr | feeding new geos into funnel |
| Vertical recall too dependent on generic queries | 14 targeted Google News verticals: fintech-EU funding, biotech series, climate raises, space, semis/fabs, EV expansion, ransomware, completed-M&A, tech IPO, EU layoffs, wire-funding proxy, Japan & Germany startups | GN query family already supplies 9 of top-14 contributors; verticals widen that |
| Dead wire URLs (GlobeNewswire guess) | removed; PRNewswire demoted to tier-3; wire flow proxied via targeted GN query | eliminates guaranteed-failure source |
| Research-lab product news | DeepMind blog, Amazon Science, Last Week in AI, The Diff | breadth for AI-sector tagging |

Registry now: **193 feeds** (was 165). New-feed contribution visible already (Yahoo Finance among top contributors in its first sweep; regional/vertical feeds accumulating).

---

## 5. Known limitations / next correctives (for production run)

1. **Mock-provider precision ceiling**: mis-tags exist on real prose (e.g., an Apple TV show item tagged `funding.series_a`; PRNewswire mattress launch resolved to Amazon via retail link). Expected to collapse with a real LLM behind the same contracts; resolver confidence floor + drop-below rules already bound damage.
2. **Bot-blocked publishers (~14%)**: 403 walls on premium outlets. Options: trafilatura sidecar (pre-approved §7), paywalled-source licensing decision, or accept coverage gap. Robots/politeness fully honored meanwhile.
3. **Fetch backlog**: 5,230 pending raw items remain (budget-capped runs); rerun `pnpm backfill` or let scheduled workers drain gradually.
4. **GDELT free-quota recovery**: mechanics fixed & proven; yield accrues on 15-min ticks now that batching/breaker are in.
5. **Clustering sparsity**: multi-source stories ≈ 0 because per-domain caps limited syndicate pairs fetched; will light up as pending backlog drains.
6. **Fact amount extraction** (mock regex) produced one implausible $100M “seed” — real model + sanity bands next.
7. **Watchers coexistence**: user-side `tsx watch src/index.ts` processes run mode=all against the same DB; idempotent design made this safe, but production should use a single worker owner (systemd) — documented in README ops note.

*Report generated 2026-08-22; raw counters reproducible via `.dbg/report.mts`, dashboard at `/v1/admin/dashboard`.*

---

## 6. Addendum — Keenable discovery wave (2026-08-22, post-report)

User flagged "<100 companies is low". Integrated **Keenable** (independent agent-first
web index) as a third discovery channel via its **keyless MCP endpoint**
(`https://api.keenable.ai/mcp`, tools `search_web_pages` / `fetch_page_content`;
optional `KEENABLE_API_KEY` lifts rate limits).

**New systems:** `src/ingestion/keenable.ts` (stateless MCP client, SSE/JSON dual
parse, text-block result parser, 429 backoff-retry), `src/scripts/discover-search.ts`
(`pnpm discover`) — per-monitored-entity recency-filtered searches → `raw_items`
(`discovered_via='search'`) → identical production pipeline; plus a **markdown
extraction fallback** inside FR-4 for bot-blocked pages (403/timeout → Keenable
fetch → clean text → normal article path; robots-blocked hosts stay blocked).

**Results of one sweep (52 monitored entities):**

| Metric | Before wave | After wave |
|---|---|---|
| Distinct companies linked to news | 89 | **110** |
| Entities in KB | 99 | **119** |
| Raw items | ~5.7K | **6,352** (+296 via search channel alone) |
| Kept articles | 210 | **324** |
| Accepted facts | 4 | **8** |
| Notional LLM ledger | $0.93 | $1.35 |

Notable: search hits bypass RSS entirely — regional business journals (kentucky.com,
thestate.com McClatchy network), trade press and IR pages that no feed in the
registry carries. The fetch-fallback recovered several bot-blocked pages that RSS
runs had lost.

Ops note: schedule `pnpm discover --days=1` alongside the RSS ticks for continuous
discovery; keyless tier has an hourly cap — set `KEENABLE_API_KEY` (free signup)
when scaling past ~70 entities/sweep.

---

## 7. Addendum 2 — Quality-gate round: slop elimination (2026-08-22)

User found entertainment/celebrity slop (Variety/THR class, "Jason Bateman on If He
Considers Himself an Actor…") and garbage entities ("AI As") in the kept corpus.

### Root causes found
1. **Entertainment-vertical feeds in the registry** (Variety, THR, MusicBusinessWorldwide, Polygon) — off-mission sources.
2. **Weak lexical gates**: mock noise-filter's "company event" regex matched generic words ("series", "launch") inside pure-culture headlines; no negative entertainment signal existed.
3. **Entity-name guard gaps**: shipped STOPWORD_TAIL omitted "You"; no domain-token rule ("reuters.com", "West Bankbbc.co.uk"); generic-first-word only banned single-word names ("Digital Advertising Alliance"); block-page artefacts ("Access Denied You" from businesswire/gm.com fetches) and media/aggregator names unchecked.
4. **Garbage aliases**: rejected names still leaked into `aliases` rows, poisoning FR-10 candidate matching.

### Fixes shipped (all config/code, gates green)
- `src/lib/quality.ts` hardened: STOPWORD_TAIL +You/-Your/-My/-Our; new DOMAIN_TOKEN_RE, MEDIA_OR_AGGREGATOR_RE (reuters/businesswire/prnewswire/flipboard/threads/mastodon/ign/polygon…), BLOCK_PAGE_RE (access denied/just a moment/security verification…); generic-leading-word now requires a corporate marker later in the name. Unit-checked rejection matrix for every real offender class.
- Prefilter rejects slop titles (with hard business-signal rescue: $ amounts, rounds, M&A, exec changes, breaches…).
- Mock noise-filter: entertainment markers dominate weak event words → is_company_news=false.
- Entity creation: `kb.create` throws on guarded names; autocreate falls back to domain brand, refuses utility/media/aggregator domains entirely, sanitizes aliases.
- Discovery channel skips slop hits at insert time.
- Registry: Variety/THR/MBW/Polygon deactivated (config + live DB).
- New ops command: `pnpm quality:revalidate` re-applies all rules over the existing corpus idempotently.

### Corpus impact (measured)
| Metric | Before | After |
|---|---|---|
| Entertainment-slop articles in KEPT | 8 | **0** |
| Jason Bateman / Emmy pieces | present | demoted to discard w/ reason |
| Junk entities ("AI As", "Inc.", "Nast The", "The Pitt Season", "Access Denied You", camel-glitch titles…) | 27 across two purge waves + stragglers | **0 remaining pass the guard** (43 entities scanned post-hardening: 0 flagged) |
| Kept corpus | 324 | 318 (slop demoted audit-preservingly) |

### Verification status
✅ Typecheck 0 · Lint clean · **Tests 42/42** (PGlite-based, Docker-independent)
⏳ One final live-corpus rescan pending: user's Docker Desktop engine went down mid-round
(daemon socket returning 500s; Postgres unreachable). Re-run
`pnpm quality:revalidate && pnpm discover --days=1` once Docker is healthy — rules are
already active for every ingest path, so no further slop can enter meanwhile.

---

## 8. Addendum 3 — Month-window ingestion + corpus expansion & deep cleaning (2026-08-22)

Closes §7's pending item (Docker Desktop engine recovered via `docker-desktop.service`
restart; named volumes intact; Postgres/MinIO healthy). Goal: extend ingestion from the
prior week to the **full month window (Jul 22 → Aug 22)** and post-clean everything.

### Coverage result

| Metric | Session start | Session end |
|---|---|---|
| Raw items | 6,388 | **7,039** |
| Articles | 638 | **3,313** |
| Kept (post-filter) | 318 | **1,682** (5.3×) |
| Discard rate | — | 49.2% |
| Primary resolutions | ~440 | **1,143** (avg conf 0.62) |
| Distinct companies linked to news | 69 | **179** |
| Story clusters | 236 | **1,615** (31 multi-source) |
| Accepted facts | 8 | **19** (after sanity rejections) |
| Live entities in KB | 78 | **~1,230** (EDGAR filer universe) |
| Monitored watchlist | 43 | **46** |
| LLM ledger (mock, notional) | $1.46 | $8.75 |

Kept-article publish-day histogram now spans **every day of the month** (Jul 22 → Aug 22;
e.g. Jul 30 = 22, Aug 5 = 33, Aug 13 = 46, Aug 21 = 372) instead of one deep week plus dust.

### How the month depth was reached

1. **Five backfill passes over `--days=31`** with a progressive per-domain fetch cap
   (2→3→10→25→30→40) to drain the pending backlog without letting big publishers
   monopolise slots; aggregator wrappers (`news.google.com`, `news.yahoo.com`) and the
   NYT bot-wall excluded by policy. Pending in-window fell 3,119 → ~500 real items
   (remainder is google-news redirect wrappers + exhausted tails).
   New backfill flags: `--per-domain=N`, `--exclude-domains=a,b`.
2. **Keenable search discovery at `--days=30`**: 43/43 monitored entities searched,
   +187 raw → +124 kept through the production pipeline.
3. **GDELT month backspan**: free-tier quota was pinned at session start (yesterday's
   bring-up burn + the live watcher's 15-min ticks compete for the same per-IP budget).
   A slow-paced batched sweep (`~39d` span) harvested **+237 watchlist articles** from
   the one query that got through; persistent retries kept hitting 429s. Mechanics
   proven; deeper history accrues automatically on watcher ticks as quota recycles.
4. **Wikidata SPARQL bootstrap deferred**: endpoint returned 502/504 all session.
   Re-run `pnpm import:wikidata -- --limit=3000` when it recovers.

### KB expansion (FR-7)

- **SEC EDGAR import**: fixed a bulk-import defect where a single name-guard rejection
  ("ExxonMobil Holdings Corp" → camel_glitch) aborted the entire run;
  `imports/base.ts importOne()` now skips-and-logs rejects. Imported **1,164 US filers**
  (1,152 with tickers, 676 industry-enriched via submissions API). ~80 legitimate
  camel-brand names (EnerSys, OceanaGold…) are guard-skipped and ledgered for retry if
  the heuristic is ever relaxed.
- Watchlist expanded with verified-real survivors (Moog, Wamda Capital, Coinbase, …).

### Deep cleaning (audit → act → verify)

Audit tooling added: `.dbg/clean-audit.mts` (junk/dup/fact-sanity/gap diagnostics).

- **98 junk autocreated entities purged** — publisher-host misreads that outran the FR-8
  feed-host guard (dronedj.com → "Airwise Solutions" [70 links], 9to5toys.com →
  "Anniversary Sale" [68]), homepage-title garbage ("Inc. All", "Please", "Upcoming
  Events Sep"), bylines ("Mark Warren", "By Anthony Crupi Media"), utility/link domains
  ("Share Buttons" addtoany.com, "brand amzn.to", wa.me, eepurl.com), and article-title
  fragments ("VMAs She", "Cloudflare Why"). Cascades cleaned their article/fact links.
- **13 duplicate merges**: EDGAR registry rows folded into curated survivors (Apple,
  Amazon, Microsoft, Nvidia, Meta, Figma, Palantir, Rivian, Shopify, Snap, Moog), the
  Rio Tinto dual-listing collapse, product→company consolidation ("Chatgpt" → OpenAI),
  and "Coinbase. Limited" renamed. Merge pre-collapse handles the primary/secondary
  unique-index edge that aborts naive re-pointing.
- **Fact sanity bands**: 9 out-of-band `funding_round` facts rejected (missing stage or
  amount outside $1M–$20B), with KB rollback of accepted amounts — removes mock-era
  artifacts like Stripe's stage-less "$7.5B round".
- **Final gates**: `quality:revalidate` over all 1,682 kept → 0 slop demotions, 0 junk
  entities remaining; finalize pass resolved remaining orphans (55 newly resolved; the
  rest are genuinely non-company pieces left unresolved by design); every kept article
  is embedded and clustered.

*Report generated 2026-08-22 · raw counters reproducible via `.dbg/report.mts`,
cleaning audit via `.dbg/clean-audit.mts`, dashboard at `/v1/admin/dashboard`.*

---

## 8. Addendum 3 — Syndication-flood & resolution-precision round (2026-08-22, later)

User surfaced the live "Latest resolved articles" view: one AP wire story (TikTok
$400M settlement) syndicated across ~40 local NBC/McClatchy sites appeared as 40
"articles" each attributed to a different wrong company ("brand fcc.gov",
Microsoft, Apple, Tumblr, "One Tech Tip"), plus personal-finance/celebrity/sports
slop and phantom countries. Ten failure classes identified; all fixed:

| # | Failure | Fix |
|---|---|---|
| 1 | Whole-DOM outlink scraping → footer domains (fcc.gov etc.) became PRIMARY via domain_overlap | `extract.ts` now harvests links from **Readability article content only** |
| 2 | `brand fcc.gov` fallback entities | autocreate bans `.gov/.edu/.mil/.int` TLDs + live publisher-host guard inside the agent itself; existing junk purged |
| 3 | 40 copies = 40 stories | ingest-time normalized-title collapse (`dedup_window_hours=48`) + clustering exact-title shortcut + full-corpus dedup sweep (57+ demoted) |
| 4 | "Ramp"→Bitcoin story ("ramp up") | resolver focus-gate: body-only mentions can never carry a primary *(landed by agent-B)* |
| 5 | Jobs / sports / moon-phase / personal-finance explainers | prefilter veto patterns v2 (+4 config classes) |
| 6 | Catch-all mis-tags on non-company content | subject-event gating in noise filter + null-tag policy *(agent-B)* |
| 7 | "IN"/"KR" appended to US-only local news | standalone ISO-token scan removed; name/city matching only, cap 3 |
| 8 | Sentiment pinned at ±1.00 on trivia | neutral band ±0.35, cap ±0.9, ≥3 lexicon hits required |
| 9 | Deactivated-feed backlog kept ingesting | pending queue purged; kept demoted with audit reason |
| 10 | Rival mentions beating absent subjects | covered by #4 focus-gate |

**Corpus remediation:** legacy rows re-resolved under new rules via suspect-sweep
(title-anchor criterion) + BACKFILL_REPROCESS cycles — convergence 426 → 54
queued; 690 orphaned resolution links removed; final spot-checks correct:
`AWS Releases Aws-Bench → Amazon ✓`, `Vision Pro naming → Apple ✓`,
`CEO steps down → Boston Dynamics ✓`, `Iran oil tankers → unresolved (correct)`,
`TikTok settlement → ByteDance ✓ (alias-level anchoring)`.

**Post-round state:** kept ≈1,572 · distinct linked companies 87 (honest count;
prior higher numbers included junk entities) · slop-in-kept 0 · junk entities 0.
Collaboration note: resolver/classifier precision pass landed concurrently by
second agent (see AGENT-COORDINATION.md); lanes were deconflicted live.
