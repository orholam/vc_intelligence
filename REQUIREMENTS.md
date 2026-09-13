# Intelligence Service — Requirements Document

> **Historical.** This was the original build spec (akta-parity, milestones,
> budget envelopes). The living product spec is [`source_of_truth.md`](./source_of_truth.md).
> The cleanup order is [`CLEANUP-PLAN.md`](./CLEANUP-PLAN.md). Where they
> conflict, **source of truth wins**. Do not treat the FR/NFR list below as
> a reason to keep code.

---

---

## 1. Purpose & Context

Copyr is a SaaS deal-flow CRM for VCs. This service provides the **market
intelligence layer** it will sit on top of: entity-resolved company news signals
and natural-language company list generation, in the style of akta.pro's
News & Signals + ListGen products.

**Reference product:** [akta.pro](https://akta.pro) by Wokelo AI.
- Public API surface observed at `https://api.akta.pro/api/v1/…` (docs: docs.akta.pro,
  OpenAPI spec: github.com/Wokelo-AI/Akta-API).
- Their published benchmark harness and company list (github.com/akta-pro/benchmark-company-news-retrieval)
  are the objective scoring target for this build.

**Parity goal:** ~70% of akta.pro News & Signals product value within 4 months,
under a constrained budget (see NFR-1). We deliberately do **not** replicate their
20M-entity company database as a product; we build a *basic* entity knowledge
base only as far as needed to support resolution for news + listgen.

### 1.1 Relationship to Copyr

| Aspect | Decision |
|---|---|
| Codebase | Independent repo/folder (`intelligence/`), own CI, own DB, own deploy |
| Coupling | Zero shared code or schema with `packages/*`. Integration = REST API + webhooks only |
| Auth | Own API-key table. Copyr gets a service key like any other client |
| Consumption by Copyr | Copyr resolves its `companies` rows → intelligence entity IDs once (stored locally), then queries news/signals/lists via REST. Optional webhook push later |

---

## 2. Goals / Non-Goals

### Goals
- G1. Continuously ingest business news from curated RSS/Atom feeds + GDELT.
- G2. Resolve every article to internal company entities (namesake-safe).
- G3. Enrich every kept article: event taxonomy (~80 types), sentiment + score,
  newsworthiness tier, industry tags (primary/secondary), geography, AI summary.
- G4. Deduplicate articles into distinct stories; support `unique_article=true`.
- G5. Serve a clean agent-ready REST API mirroring akta's response shapes.
- G6. ListGen: natural-language query → ranked, enriched company lists.
- G7. Bootstrap funding-stage data from our own classified funding events
      (self-reinforcing loop that improves ListGen over time).
- G8. Self-score against akta's published benchmark harness; publish results internally.

### Non-Goals (explicitly out of scope)
- NG1. Company database as a sellable product (75+ firmographic fields, revenue
  estimates, ownership graphs). Basic fields only, per §6.2.
- NG2. Historical archive before deployment date. Forward-looking only.
- NG3. People/founder tracking (DataForB2B territory). No professional-profile data.
- NG4. Licensed premium datasets (Crunchbase, S&P Cap IQ, etc.). Open sources only.
- NG5. Full-text redistribution rights beyond storing extracted text for internal
  enrichment; API returns excerpt + link by default (see NFR-8).

---

## 3. System Overview

```
                    ┌─────────────────────────────────────────────────┐
                    │                INGESTION LAYER                  │
                    │  RSS/Atom poller (200→1000 feeds)               │
                    │  GDELT DOC 2.0 poller (recall backbone)         │
                    │  robots-aware fetcher + extractor (full text)   │
                    └──────────────┬──────────────────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────────────────┐
                    │            FILTERING & RESOLUTION               │
                    │  noise filter (is real news? keep ~20-30%)      │
                    │  candidate entities (NER + alias index)         │
                    │  resolver: domain evidence + LLM adjudication   │
                    └──────────────┬──────────────────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────────────────┐
                    │              ENRICHMENT PIPELINE                │
                    │  tiered model router (mini bulk / big escalate) │
                    │  taxonomy · sentiment · newsworthiness ·        │
                    │  industry · geo · summary                       │
                    └──────────────┬──────────────────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────────────────┐
                    │           CLUSTERING & SIGNAL STORE             │
                    │  embedding dedup → story clusters               │
                    │  signal-derived facts (funding events → KB)     │
                    └──────────────┬──────────────────────────────────┘
                                   ▼
     Clients (Copyr, agents) ──► REST API v1 (+ OpenAPI spec) ──► Postgres
                                   │
                                   └──► Benchmark runner (akta harness clone)
```

Single VPS + managed-style Postgres (pgvector enabled). All async work via a
job queue on Postgres (pg-boss or equivalent). No Redis, no Kafka.

---

## 4. Functional Requirements

Priorities: **P0** = MVP-blocking, **P1** = required for parity target,
**P2** = nice-to-have. Every FR has acceptance criteria (AC).

### 4.A Ingestion

**FR-1 (P0) Source registry**
- Table-backed registry of sources: `{id, name, publisher, feed_url, tier(1|2|3),
  country, default_language, topics[], active, last_fetched_at, etag, failure_streak}`.
- Seeded with ≥150 tier-1 business/tech/general-news RSS feeds at M1; growth path to
  ≥800 curated feeds by M4 (curation is ongoing ops, not code).
- Admin endpoints: CRUD + bulk import from OPML/CSV; toggle activation.
- AC: registry seeded; adding a feed requires no code change; failures tracked per source.

**FR-2 (P0) RSS/Atom poller**
- Polls all active feeds on schedule: tier-1 every 15 min, tier-2 every 30 min,
  tier-3 every 2 h (raised from hourly/daily in the Aug 2026 RSS-inflow
  realignment so niche verticals get same-day coverage; conditional GETs keep
  the extra polls cheap).
- Conditional GET (ETag/Last-Modified); per-source backoff after failures (max backoff 24 h);
  never re-enqueue an item whose GUID/link hash was seen (dedup at ingestion).
- AC: 24h soak with ≥150 feeds produces zero duplicate raw items and no unbounded retry loops.

**FR-3 (P0) GDELT recall backbone**
- Poll GDELT DOC 2.0 API every 15 min for new English-language articles matching the
  monitored-entity watchlist (company names/domains from our entity KB) plus configurable topic queries.
- Store GDELT metadata (source domain, URL, title, seendate); enqueue full-text fetch
  only for URLs not already captured and whose domain passes a quality allowlist/blocklist.
- AC: GDELT contributes ≥25% of resolved articles in benchmark companies within 2 weeks of enablement.

**FR-4 (P0) Fetch & extract**
- robots.txt-aware fetcher; polite UA; per-domain rate limit (default 1 req/2 s); timeout 10 s.
- Extract title, byline, published_at (fallback: feed/GDELT timestamp), text body,
  language, outbound links (needed as resolution evidence), og: metadata.
- Store extracted full text internally (raw bucket/table), keep ≤180 days hot, then archive/drop.
- AC: extraction success rate ≥85% on tier-1 sources; failed extractions logged with reason and retried once.

### 4.B Filtering

**FR-5 (P0) Noise filter**
- Two stages: (a) cheap lexical/heuristic pre-filter (press-release directories, tag pages,
  non-news formats, <300 chars body), (b) LLM binary classifier "genuine company-relevant news?".
- Target: discard 60–80% of ingested volume (mirrors akta's "~80% noise filtered").
- Every discard recorded with stage + score (sampled audit view).
- AC: on a hand-labeled sample of 500 items, filter precision ≥90%, recall ≥95% vs. human labels.

### 4.C Entity Knowledge Base (basic)

**FR-6 (P0) Entity store**
- Entities: `{id (opaque, e.g. base32), canonical_name, legal_name, website(domain),
  aliases[], type(private|public|subsidiary|person-org|fund), country, hq, founded_year,
  industry_tags[], tickers[], status(active|acquired|closed), funding_stage?, total_raised?,
  last_funding_date?, source_refs[], confidence, merged_into?}`.
- Alias table drives candidate generation; domain is the primary join key.
- AC: entity CRUD + alias merge tooling; opaque IDs stable across renames.

**FR-7 (P0) Bootstrapped imports (open sources only)**
- Wikidata SPARQL extract: organizations with official website, industry (P452),
  headquarters, founding date, ticker(s). Projected yield: 500K–2M entities.
- SEC EDGAR `company_tickers.json` + submissions API: US public filers w/ CIK, tickers, SIC.
- UK Companies House free API: basic company profile + PSC signposts (rate-limit aware).
- Seed lists: YC directory scrape, Product Hunt, GitHub orgs (optional accelerators).
- Each record carries provenance (`source_refs`) and imports are idempotent/re-runnable.
- AC: ≥300K usable entities loaded at M2 exit; re-running an import creates zero duplicates.

**FR-8 (P1) On-demand entity creation**
- Given an unknown company name/domain/URL (from article resolution or API input), spawn an
  "extraction agent" job: fetch site, extract description/industry/socials, create entity
  with `confidence=low`, flag for review queue sampling.
- AC: unknown-name rate on benchmark set <10% after M3; auto-created entities resolve correctly in ≥70% of sampled audits.

**FR-9 (P1) Signal-derived facts**
- When enrichment classifies a funding/M&A/acquisition event with high confidence AND
  newsworthiness=high, write structured fact proposals to entity KB:
  `{funding_stage, amount_usd_est, lead_investors[], event_date, evidence_article_id}`.
- Facts require either two independent articles or one tier-1 source to promote
  from `proposed` → `accepted`; accepted facts update `funding_stage` etc.
- AC: after 30 days of live data, ≥60% of accepted funding facts match ground truth on a 50-item manual audit.

### 4.D Resolution

**FR-10 (P0) Candidate generation**
- Per article: run fast NER (small local model or LLM-lite pass) over title+lead;
  union candidates from exact/normalized alias n-gram match against alias index
  (trigram/GIN indexed), plus domain matches between article links and entity websites.
- AC: candidate recall (is true subject in candidate set?) ≥97% on labeled sample.

**FR-11 (P0) Resolver (the namesake problem)**
- Scoring pass combines deterministic evidence (alias match strength, domain overlap
  between article links/outlinks and entity website, ticker/country/industry coherence)
  then LLM adjudication ONLY for multi-candidate or low-margin cases, grounded on
  entity profile cards (name, domain, HQ, industry, aliases).
- Output: primary company + secondary mentioned companies, each with confidence + evidence trail.
- Articles with no confident match are dropped from entity-indexed views but retained in raw store.
- AC (M3 exit): entity precision ≥85% overall, ≥90% on tier-1 sources; measured via
  300-article human-labeled audit + benchmark harness subset.

### 4.E Enrichment

**FR-12 (P0) Tiered model router**
- All enrichment calls go through one router: `mini` model for classification/tagging;
  `big` model for summaries and ambiguous adjudications; hard monthly spend cap +
  per-stage cost accounting (see NFR-1/NFR-9). Provider-abstracted (OpenAI-compatible
  interface; mock provider for offline tests).
- AC: cost dashboard shows per-article blended cost; router respects caps by degrading gracefully (skip summary, keep classification).

**FR-13 (P0) Event taxonomy classifier**
- Taxonomy of ~80 event types grouped into families: funding (rounds, secondary,
  debt, grant), M&A (acquirer/target/rumor), leadership (hire/departure/board),
  partnership, product launch/update, legal/regulatory, risk/distress (layoffs,
  bankruptcy, lawsuit, recall, breach), financial results, expansion/restructuring,
  awards/recognition, research/publication. One primary tag (`is_primary`) + optional secondaries.
- Ship taxonomy as versioned config (JSON/YAML), editable without deploy.
- AC: ≥95% of kept articles carry ≥1 primary tag; agreement with human labels ≥80% on 300-item audit.

**FR-14 (P0) Sentiment & newsworthiness**
- Sentiment: {positive|negative|neutral} + continuous score [-1,1].
- Newsworthiness: {high|medium|low} tier from materiality signals (event family weight,
  source tier, entity prominence, exclusivity heuristics).
- AC: distribution sanity (no >70% single bucket); high-tier precision ≥75% on audit.

**FR-15 (P0) Industry & geography tagging**
- Industry: primary + secondary tags from a fixed sector taxonomy (seeded from
  GICS-like + startup-sector vocabulary; aligned to entity KB industries).
- Geography: countries referenced/affected (array), HQ country inherited from entity when absent.
- AC: ≥90% of kept articles have both fields populated.

**FR-16 (P1) AI summary**
- 1–2 sentence neutral summary per kept article (tier-1/high-newsworthiness mandatory;
  others budget-permitting). Stored alongside extracted text length hash to avoid regeneration.
- AC: present on 100% of high-tier, ≥70% of medium-tier articles.

### 4.F Clustering

**FR-17 (P1) Story clustering / dedup**
- Near-duplicate detection: embedding (cheap model) cosine similarity + same-day window
  + same-primary-entity gate; cluster representative = highest-tier source.
- Powers `unique_article=true` (one article per story cluster per entity) and future
  "story" objects.
- AC: on syndicated-event samples, ≥90% of true duplicates collapse into one cluster;
  false-merge rate ≤5%.

### 4.G API Surface (v1)

General: JSON REST under `/v1`, auth via `x-api-key` header (hashed keys in DB,
workspace-less single-tenant initially), errors as `{error:{code,message}}`,
pagination via `limit`(default 10, max 1000)+`offset`, always return `total/count/offset`.

**FR-18 (P0) News by company**
- `GET /v1/news/?company=<id|slug|domain|url>&start_date&end_date&category=a,b&
  unique_article=true|false&blacklisted=domain1,domain2&limit&offset`
- `GET /v1/news/latest` serves kept winners WITH a company attached. There is
  ONE resolved state: every kept article must go through resolution so it
  ends up attributed (even imperfectly); unattributed kept rows are a
  resolution backlog to re-drive, never a published state.
- Response mirrors reference shape per article: `{id, entity_id, title, url, publisher,
  published_date, language, ai_summary, sentiment, sentiment_score, newsworthiness,
  tags:[{name,is_primary}], industry_primary, industry_secondary[], countries[],
  excerpt (first ~400 chars), text_available:false}` plus envelope `{total,count,offset,data}`.
- `company` param resolution order: opaque ID → slug → domain → URL fetch-and-create (FR-8).
- AC: p95 < 3 s cached, < 8 s cold incl. on-demand entity creation; OpenAPI 3.1 spec generated from zod contracts and served at `/openapi.json`.

**FR-19 (P0) Companies lookup**
- `GET /v1/companies/:id` → entity card (basic KB fields §6.2 + derived stats:
  article_count_30d, last_news_date, top_event_types).
- `GET /v1/companies/search?q=&industry=&country=` → basic filtered search (P1).
- AC: search p95 < 500 ms on 1M+ entities.

**FR-20 (P1) ListGen**
- `POST /v1/list/generate/companies/ {"query": "<natural language>", "limit": 50}`
- Pipeline: NL → structured filters (LLM, zod-validated: sectors, geo, funding_stage,
  size proxies, keywords) → entity KB query → rank by signal recency/strength →
  attach per-company latest signals (top 3 headlines) → return
  `{count, companies:[{...entity_card, relevance_score, recent_signals[]}], interpreted_filters}`.
- Always echo `interpreted_filters` so clients can correct misinterpretation.
- AC: on a 25-query eval set, filter-interpretation accuracy ≥75%; returned lists are ≥60% relevant (human-judged).

**FR-21 (P1) Feed/monitoring convenience**
- `GET /v1/feed?entities=id1,id2&since=` for polling clients; optional HMAC-signed
  webhooks `POST {event:"article", ...}` per subscribed entity (deferred to M4+ if time-constrained).
- AC: feed endpoint supports incremental sync with cursor; webhook delivery retries 5× with backoff.

**FR-22 (P2) MCP server**
- Thin MCP wrapper exposing tools: `get_company_news`, `search_companies`,
  `generate_company_list` (same core functions; aligns with Copyr's agent-first principle).

### 4.H Benchmarking

**FR-23 (P0) Self-benchmark harness**
- Port akta's public methodology: their 133-company list + window protocol
  (github.com/akta-pro/benchmark-company-news-retrieval); judge = neutral LLM
  (different family than production models); validate stories via independent web-search check.
- Metrics computed identically: news precision, company-entity precision, overall
  precision, recall, F1, $/1K correct.
- Runs monthly from M2; results written to `benchmarks/YYYY-MM.md` with raw outputs archived.
- AC: harness reproduces end-to-end from one command; M4 exit targets hit (§8).

---

## 5. Non-Functional Requirements

**NFR-1 Budget envelope (hard constraint)**
- Compute: ONE small VPS-class machine (2–4 vCPU, 4–8 GB) + Postgres w/ pgvector.
  Target infra cost ≤ $40/mo.
- LLM: single-provider account, tiered routing (see FR-12). Blended enrichment cost
  ≤ $0.001/article average; hard monthly cap default $250, configurable; circuit-breaker
  degrades to classify-only mode at 90% cap. Local/small-model fallback documented but optional.

**NFR-2 Throughput & latency**
- Sustained ingestion ≥50K raw items/day capacity; post-filter 5–15K enriched articles/day.
- Query latency per FR-18 AC; enrichment pipeline lag (publish → searchable) p90 ≤ 15 min.

**NFR-3 Reliability**
- Ingestion survives restarts (idempotent jobs, at-least-once + content-hash dedup).
- Any single source failing must not stall the pipeline (per-source isolation).
- Daily automated backup of Postgres; RPO ≤ 24 h. Uptime target (best effort): 99% monthly.

**NFR-4 Observability**
- Structured logs (JSON) with request/job IDs; metrics: items/day by stage, filter
  discard rate, resolution confidence distribution, per-stage LLM token/cost, queue depth,
  source health. Cost + volume dashboard reviewed weekly.

**NFR-5 Quality gates in CI**
- Typecheck/lint/test pipelines green; contract tests lock API response schemas;
  golden-file tests for resolver/enrichment on fixture articles; mock LLM provider for offline runs.

**NFR-6 Security**
- API keys hashed at rest; rate limiting per key (default 60 req/min); CORS locked to
  configured origins; secrets via env only; no PII processed by design.

**NFR-7 Compliance & politeness**
- robots.txt honored; per-domain rate limits; identifiable UA with contact URL.
- Publisher attribution (name + link) on every article object. DMCA-style takedown
  endpoint: `DELETE /v1/articles/:url` removes from all indexes (log retained).

**NFR-8 Text handling policy**
- Internal: full extracted text stored for enrichment, ≤180 days hot retention.
- External API: headline + excerpt (≤400 chars) + link by default; full-text passthrough
  behind a license-flag feature toggle, OFF by default (matches NG5).

**NFR-9 Maintainability**
- Taxonomy, prompts, model routing, and filter thresholds are config, not code.
- Every LLM call logs prompt-template version + model id for reproducibility.

---

## 6. Data Schemas

### 6.1 Article (internal canonical)
```jsonc
{
  "id": "art_01J...",              // ULID
  "source_id": "src_...",          // registry FK
  "url": "https://…", "url_hash": "sha256",
  "publisher_domain": "example.com",
  "title": "...", "published_at": "2026-08-21T09:00:00Z", "language": "en",
  "extracted_text_path": "s3://…", // object storage ref
  "noise_stage": "kept",           // prefilter | llm_filter | kept
  "resolutions": [{ "entity_id": "ent_00000l1", "role": "primary", "confidence": 0.93,
                    "evidence": {"alias":"…","domain_overlap":true,"llm":"adjudicated"} }],
  "enrichment": {
    "primary_tag": "funding.series_a", "secondary_tags": [],
    "sentiment": "positive", "sentiment_score": 0.42,
    "newsworthiness": "high",
    "industry_primary": "fintech", "industry_secondary": ["payments"],
    "countries": ["US"],
    "summary": "…"
  },
  "story_cluster_id": "sto_…",
  "facts_proposed": [{"type":"funding_round","payload":{…},"status":"accepted"}],
  "created_at": "…"
}
```

### 6.2 Company entity (basic — deliberately shallow)
```jsonc
{
  "id": "ent_00000l1",             // opaque, stable
  "canonical_name": "Acme Robotics", "legal_name": "Acme Robotics Inc.",
  "website": "acme.ai",            // primary join key
  "aliases": ["Acme", "acme.ai"],
  "type": "private", "status": "operating",
  "country": "US", "hq_city": "San Francisco", "founded_year": 2021,
  "industry_tags": ["robotics", "industrial automation"],
  "tickers": [], "funding_stage": "series_a", "total_raised_usd": 12000000,
  "last_funding_date": "2026-06-01",
  "source_refs": ["wikidata:Q…","yc:S…"], "confidence": 0.9, "merged_into": null
}
```
Funding fields are populated ONLY by FR-9 signal-derived facts — we do not buy this data.

### 6.3 Source registry — see FR-1 field list.

---

## 7. Tech Stack (recommended; deviations need a written note in this doc)

| Layer | Choice | Rationale |
|---|---|---|
| Language/runtime | TypeScript (Node 22, strict) | Team consistency with Copyr patterns; contracts via zod |
| API | Fastify + OpenAPI generation from zod | Mirrors Copyr conventions; agent-friendly spec |
| DB | Postgres 16 + pgvector + Drizzle | One database; vector search for clustering |
| Jobs | pg-boss (Postgres-backed) | No Redis/Kafka; fits VPS budget |
| Storage | S3-compatible (MinIO locally) | Raw article bodies, archives |
| Ingestion | rss-parser + custom GDELT client | — |
| Extraction | Readability-family extractor (JS); **permitted Python sidecar using trafilatura if JS extraction success <85%** | Extraction quality is decisive |
| LLM access | OpenAI-compatible provider abstraction + mock provider | Offline dev + provider swaps |
| Embeddings | Cheap hosted embedding model or local MiniLM-class | Clustering only |

---

## 8. Milestones & Exit Criteria

| Milestone | Window | Deliverables | Exit criteria (measurable) |
|---|---|---|---|
| **M0 Scaffold** | wk 1 | Repo scaffold, docker-compose, config, DB migrations, mock LLM, CI | `pnpm test`/`typecheck` green offline end-to-end skeleton |
| **M1 Ingestion live** | wk 2–4 | FR-1..5, FR-12, storage | ≥150 feeds polled 7d clean; ≥5K raw items/day; noise filter hitting 60–80% discard; cost/article visible |
| **M2 Entities + first API** | wk 5–8 | FR-6..11, FR-18,19, FR-23 v1 | ≥300K entities imported; entity precision ≥75% (early); `/v1/news` serving resolved articles p95<8s; first benchmark baseline recorded |
| **M3 Enrichment parity** | wk 9–12 | FR-13..17, FR-16 | Full enrichment on all kept articles; entity precision ≥85%; F1 on harness ≥55; clustering live (`unique_article`) |
| **M4 ListGen + polish** | wk 13–16 | FR-9, FR-20, FR-21, FR-22 | Harness **F1 55–70**, overall precision ≥80%; ListGen eval ≥75%/≥60%; 30-day funding-fact accuracy ≥60%; monthly cost ≤ caps |

Success definition for the whole project = M4 exit criteria. That is the "≈70%
parity" line: monitoring use-case near-parity, discovery/ListGen partial,
archive/graph depth intentionally sacrificed.

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Entity resolution precision stalls below 85% | Core metric miss | Invest in domain-evidence features first (deterministic), LLM only for ties; expand alias curation; accept lower recall by dropping unconfident matches |
| GDELT noise floods pipeline | Cost overrun | Domain allowlist + aggressive prefilter before any LLM call; GDELT items pay a cheaper classification tier |
| LLM spend exceeds cap | Budget breach | Router circuit breaker (NFR-1); per-stage budgets; degrade to classify-only |
| JS extractor quality poor | Coverage loss | Pre-approved Python trafilatura sidecar (§7) |
| Copyright complaints on excerpts | Legal | Excerpt ≤400 chars + attribution + takedown endpoint (NFR-7/8) |
| Feed rot / source drift | Recall decay | Failure-streak alerts; quarterly source review ritual; GDELT as safety net |

---

## 10. Open Questions (decide before/at M1)

1. Provider/model shortlist for `mini` vs `big` tiers (cost/quality quotes needed).
2. Single global tenant vs multi-tenant keys from day one (affects API key scoping only).
3. Do we expose full-text passthrough ever (license-flag), or hard-remove (NG5)?
4. Webhooks: commit to M4 or explicitly punt to post-parity phase?

---

## 11. Realignment Addendum (c-plan, Aug 2026)

Targeting rule adopted: **private entities from incorporation through ~Series C
with fresh event activity** ("left edge of the magic zone"). Public entities
enter via watchlist/context only; pre-company projects remain out of scope.

### Implemented
- **Source re-tiering**: startup-native/regional press promoted to tier-1
  (55 feeds); consumer-tech block demoted to tier-3 context; risk GN verticals
  (`gn-layoffs/bankruptcy/data-breach/ransomware`) disabled by default.
  `pnpm sources:sync-tiers` applies seed-file tiers to the live registry.
- **SEC Form D ingestion** (FR-9 extension): EFTS full-text search → registry-
  keyed entity upserts (`registry_ids.sec_cik`) + ACCEPTED funding_round facts +
  auto-watchlist. Zero LLM cost. Idempotent on `formd:<accession>`.
- **Launch surfaces** (gated by crowd attention, not firehose): HN Show HN
  (Algolia, points ≥50) and Product Hunt (GraphQL, votes ≥100, `PH_TOKEN`)
  implemented; github_trending / yc_directory stubbed in config. Each accepted
  launch → confidence≤0.4 entity keyed by product domain (`launch:*`), a
  `product.launch` article with platform metadata, and an accepted
  product_launch fact. Escalation ladder: later press resolves to the same
  entity and activates tracking.
- **Scoring formula** (filters.json newsworthiness): score =
  family_weight×0.5 + source_tier×0.2 + prominence×0.2 + exclusivity×0.1,
  with fame-dampening (public+unwatchlisted caps family weight; prominence =
  1/(1+count30d/scale)) and first-coverage exclusivity. Prefilter gains an
  event-title rescue so thin wire copy reaches the LLM filter.
- **Serving**: `first_coverage` flag on all article DTOs (/v1/news, latest,
  feed); ListGen excludes low-signal launch entities; dashboard gains alignment
  KPIs (private-share % 7d, top-10 mention concentration %, launch-entity pool).

### Deferred decisions
- **X/Twitter as a source**: deferred. Read API pricing breaks NFR-1; scraping
  violates ToS. Revisit via licensed social-data vendor or narrow keyword tier
  when budget allows. Social-post signals remain DFB's lane, not ours.
- **Form D amounts**: require primary_doc.xml parse (per-filing fetch) — later
  enrichment pass, off the critical path.

---

## 12. Company Profile Parity Addendum (FR-25, Aug 2026)

User decision (2026-08-23): while news data remains the wedge against akta.pro,
every company we ingest must be enriched to the same degree as akta's Company
Data API (16 sections / 74 L2 fields). This **amends NG1** ("no 75+-field
company database") as follows — NG4 is unchanged:

### Scope amendment to NG1
- Deep profiles apply **only to entities we ingest** (our KB), not as a bulk
  20M-company sellable product. The shallow §6.2 card remains the *serving
  baseline*; profiles are a derived layer on top.
- No purchased/licensed data (NG4 intact): profile fields derive from (a) FR-9
  accepted facts, (b) FR-7 registry imports, and (c) LLM extraction over an
  evidence pack = our kept corpus + robots-aware polite crawl of the company
  site. Every cited source URL is validated against the evidence pack.

### Implemented
- **Storage**: `entity_profiles` table (migration 0003) — one row per
  (entity, section), payload JSONB shaped by zod contracts in
  `src/api/contracts-enrichment.ts` mirroring akta's public data dictionary;
  lifecycle pending → complete | failed (parked after max_attempts).
- **Engine** (`src/entities/profile.ts`): deterministic sections finalize free
  from facts/registry (location, hierarchy, funding_detail, mna_and_investment,
  management_profile); narrative sections run through same-tier chunked LLM
  calls (`company_profile` prompt, config-driven grouping/tiers) and merge over
  the deterministic floor. R05-analog: incomplete never serves; R09-analog:
  hard cap stops the sweep, soft cap degrades big→mini.
- **Serving**: `GET /v1/companies/:id/enrichment?sections=` (+MCP tool
  `get_company_enrichment`) returns complete sections with per-section
  provenance; `missing_sections` discloses gaps.
- **Ops**: hourly budget-guarded `company-profile-tick` over due entities
  (watchlist-first ordering); `pnpm profile:run` for manual backfill/retry;
  funnel_daily gains `profiles_complete`; progress probe via
  `profileProgress()`.

### Constraints kept
- Entities flagged `needs_backfill` (R06), merged entities, funds and
  person-orgs are not profiled until eligible.
- All spend flows through the existing llm_calls ledger + monthly cap (NFR-1).
- Config-not-code: sections, tiers, mandated set, freshness (90d), crawl paths,
  per-call grouping live in `config/company-profile.json`.

## 13. RSS Inflow & Coverage Realignment (Aug 2026)

User decision (2026-08-24/25): the source registry must be valuable to every
VC regardless of specialization, with a materially more frequent inflow.

### Changes
- **Cadence** (amends FR-2 above): tier-1 15 min, tier-2 30 min, tier-3 2 h
  (`POLL_CADENCE_MINUTES`). Conditional GET keeps the extra polls cheap.
- **Google News aggregator feeds are retired**: every `gn-*` seed row is
  `active:false` — news.google.com `/rss/articles/*` redirectors are
  robots.txt-blocked at article fetch, so yield is structurally zero. Seed
  importers honor the flag and `sync-source-tiers` only ever deactivates;
  reactivation is an explicit admin action. This kills the purge→re-import
  resurrection loop that re-created 24 redirector feeds on 08-24.
- **Vertical gap fill**: +24 verified direct-RSS sources across sectors that
  had no dedicated coverage (insurance/reinsurance/insurtech, legaltech,
  telecom, oil & gas, sports business, fashion business, restaurants,
  proptech, adtech/martech, HR, space-EU, capital-market wires, Japan) plus
  promotions of thin-vertical primaries (agfundernews, gamesindustry-biz,
  modernretail, freightwaves, pv-magazine) to tier 2.
- **Dead-endpoint fix**: CNBC `search.cnbc.com` combinedcms feeds return valid
  XML with zero items; swapped to the working `www.cnbc.com/id/<n>/device/rss`
  endpoints.
