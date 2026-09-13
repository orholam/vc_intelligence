# Copyr Intelligence

A standalone news-intelligence API service: **entity-resolved company news signals**
and **natural-language company list generation (ListGen)** — the market-intelligence
layer for Copyr (and any other API-keyed client).

Per `REQUIREMENTS.md` §1.1 this is a fully independent service: own package.json +
lockfile, own Postgres (pgvector), own object storage, own CI, zero imports from the
Copyr monorepo (`apps/*`, `packages/*`). Integration is REST + webhooks only.

---

## Quickstart (offline-capable)

```bash
pnpm install
cp .env.example .env.local          # defaults work; LLM_PROVIDER=mock runs offline
docker compose up -d postgres minio minio-init
pnpm db:migrate                     # extensions + drizzle migrations + audit view
pnpm db:seed                        # loads 165 curated feeds (FR-1 AC: >=150)
pnpm key:create my-client           # mint an API key (raw shown once)
pnpm dev                            # API on :4600 + pipeline workers
```

With `LLM_PROVIDER=mock` the entire pipeline runs end-to-end offline using a
deterministic lexical provider (same zod contracts as real calls). Point it at any
OpenAI-compatible backend via `LLM_BASE_URL`/`LLM_API_KEY`.

### Two LLM paths (+ auto)

- **Path 1 — hosted key**: `LLM_PROVIDER=openai-compatible`. The service calls the
  configured OpenAI-compatible endpoint directly under budget governance.
- **Path 2 — agent harness**: `LLM_PROVIDER=harness`. No model key needed for chat:
  completions are written to a `llm_requests` work queue and **Cursor** (or any
  external agent) answers them. In this repo, invoke the **`drain-waiting-room`**
  skill (`@drain-waiting-room`) — the agent long-polls claim, applies editorial
  judgment, and POSTs results with model `harness:agent`. Prep infra with
  `pnpm harness:prepare`. Deep company profiles use **`@enrich-new-companies`**
  (hourly profile tick is disabled in harness mode). Protocol:

  ```bash
  # claim work (long-poll up to 30s; loopback allowed by default, else x-harness-key)
  curl -s 'http://localhost:4600/internal/llm/claim?wait=10'
  # answer it (data validated against response_schema before acceptance)
  curl -s -X POST "http://localhost:4600/internal/llm/<id>/result" \
       -H 'content-type: application/json' -H 'x-harness-key: ...' \
       -d '{"ok":true,"data":{...},"model":"<your-model>"}'
  ```

- **auto (recommended)**: `LLM_PROVIDER=auto` — every completion is first offered
  to a connected harness (`LLM_AUTO_CLAIM_WAIT_MS`, default 5s claim window);
  if an agent claims it we commit and wait patiently, otherwise the request is
  cancelled and falls back to the hosted key (or mock without one). One launch
  command forever — attach or detach an opencode loop at any time without
  touching config. Per-run override without env edits: `pnpm dev -- --llm=harness`.

  Zod contracts, prompt templates and the `llm_calls` ledger are enforced exactly
  as on path 1 (`harness:<model>` rows, $0 service-side cost). Unanswered calls
  time out fail-open (`LLM_HARNESS_TIMEOUT_MS`, default 180s) and degrade like
  budget-degraded calls — a sleeping harness never wedges the pipeline.
  Embeddings stay hosted by default (`LLM_HARNESS_HOSTED_EMBED=true`) because
  clustering needs semantic vectors; without a usable key they fall back to
  deterministic lexical vectors. Queue state: `GET /internal/llm/stats`.

Quality gates:

```bash
pnpm typecheck && pnpm lint && pnpm test   # 40 tests incl. PGlite integration suite
pnpm build                                  # emits dist/ (api + worker + mcp bins)
```

Tests run **without Docker**: the integration suite uses in-process Postgres
(PGlite/WASM with pgvector) plus the mock LLM provider.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm db:migrate` / `db:seed` | migrations; seed source registry + GDELT topic queries |
| `pnpm sources:import f.opml\|f.csv [tier]` | bulk feed import (FR-1 admin parity) |
| `pnpm import:wikidata -- --limit=20000` | FR-7 Wikidata SPARQL bootstrap (paged/resumable) |
| `pnpm import:edgar -- --enrich=500` | FR-7 SEC EDGAR filers (+submissions enrichment) |
| `pnpm import:companies-house -- --queries="fintech london"` | FR-7 UK Companies House |
| `pnpm import:seeds` | FR-7 curated seed lists from `config/seeds/*.json\|csv` |
| `pnpm benchmark:run -- --window-days=7` | FR-23 self-benchmark vs akta methodology |
| `pnpm pipeline:replay -- --article=<id> [--from=enrich]` | R02: re-drive one article through the uniform stage chain |
| `pnpm profile:run -- [--entity=ent_x] [--limit=50] [--no-crawl]` | FR-25: manual company-profile sweep (same engine as the hourly tick) |
| `pnpm pipeline:reconcile -- --window-days=31` | R04/G5/R05: raw-item reconciliation + zero-row enrichment assertions (exit 1 on fail) |
| `pnpm rubric:probes -- --window-days=31` | OUTPUT-RUBRIC probe pack (P0-P13, gates G1/G2/G4, R05/R06/R07/R09/R10) as markdown |
| `pnpm rubric:sample -- --window-days=31` | §8 judgment protocol: stratified samples + fixed-column `rubric/YYYY-MM/judgments.csv` |
| `pnpm mcp:start` | FR-22 MCP server (stdio): 3 agent tools |
| `tsx src/scripts/backup.ts` | NFR-3 daily `pg_dump` w/ 14-day rotation |

## HTTP API v1 (auth: `x-api-key`; errors `{error:{code,message}}`; envelope `{total,count,offset,data}`)

| Endpoint | FR |
|---|---|
| `GET /v1/news/?company=<id\|slug\|domain\|url>&start_date&end_date&category=a,b&unique_article&blacklisted=d1,d2&limit&offset` | FR-18 |
| `GET /v1/news/overview?days&topic_limit` — state-of-the-index aggregates: deduped daily kept volume (by newsworthiness), noise-stage lifecycle snapshot, top event tags | FR-18 |
| `GET /v1/companies/:id` · `GET /v1/companies/search?q&industry&country&venture_band` | FR-19 |
| `GET /v1/companies/mix` — canonical-set venture-band / HQ-country / entity-type distributions for monitoring views | FR-19 |
| `GET /v1/companies/:id/enrichment?sections=firmographic,location,…` — 16-section akta-parity deep profile (complete sections only; `missing_sections` disclosed) | FR-25 |
| `POST /v1/list/generate/companies/ {"query","limit"}` → `{count,companies[],interpreted_filters}` | FR-20 |
| `GET /v1/feed?entities=id1,id2&cursor=` (cursor-based incremental sync) | FR-21 |
| `POST/GET/DELETE /v1/webhooks/subscriptions` (HMAC-signed delivery, 5× backoff) | FR-21 |
| `DELETE /v1/articles/:url` (DMCA-style takedown; audit retained) | NFR-7 |
| `GET/POST/PATCH/DELETE /v1/admin/sources*` (+OPML/CSV import) | FR-1 |
| `POST/PATCH /v1/admin/entities*`, aliases, `POST /v1/admin/entities/merge` | FR-6 |
| `POST /v1/admin/api-keys` | auth |
| `GET /v1/admin/dashboard` (budget state, per-stage LLM $, volumes, discard rate) | NFR-4 |
| `GET /openapi.json` — OpenAPI **3.1** generated from the same zod contracts that validate requests/responses | FR-18 AC |

MCP tools mirror the core: `get_company_news`, `search_companies`,
`generate_company_list`, `get_company_enrichment`.

## Pipeline (pg-boss on Postgres — no Redis/Kafka)

```
sources(tier1 15m/tier2 1h/tier3 24h, ETag conditional GET, exp backoff ≤24h)
  └─ fetch-feed ─ raw_items(url/guid hash dedup)
       ├─ GDELT DOC 2.0 sweep (watchlist entities + topic queries, domain allow/block gate)
       └─ fetch-article (robots.txt-aware, polite UA, 1req/2s/domain, 10s timeout)
            └─ filter (heuristics → LLM binary classifier; every discard scored+auditable via v_discard_audit)
                 └─ resolve (NER + alias n-gram/trigram + domain evidence → deterministic score → LLM adjudication only on ties)
                      └─ enrich (mini: taxonomy(86 types)/sentiment/newsworthiness/industry/geo · big: summary for high+medium tiers)
                           ├─ cluster (pgvector cosine + same-entity + ±36h window → stories, unique_article)
                           ├─ facts (funding/M&A proposals → accepted at 2 publishers OR tier-1 → updates entity KB)
                           └─ webhooks fan-out (per-subscription retries)
retention sweep daily: hot text ≤180d (NFR-8); excerpt-only externally by default

company-profile-tick hourly (FR-25): due entities → evidence pack
  (accepted facts + kept corpus + robots-aware polite site crawl)
  └─ deterministic sections finalize free (facts/registry: funding, M&A,
     leadership, hq) · narrative sections via same-tier chunked LLM calls,
     source-cited and evidence-validated, merged over the deterministic floor
  └─ R05-analog lifecycle (pending→complete|failed-parked), budget-guarded:
     hard cap stops the sweep, soft cap degrades big→mini (R09-analog)
```

## Budget & cost controls (NFR-1)

Single ledger table `llm_calls` records every call (stage, tier, model,
prompt-template version, tokens, $, latency). The router enforces a hard monthly
cap ($250 default): at the soft cap (90%) big-tier work degrades to classify-only;
at the cap everything stops gracefully. Live view: `GET /v1/admin/dashboard`.
Prompts live in `config/prompts.json`, taxonomy/thresholds/model pricing in
`config/*.json` — all editable without deploy (mtime-cached).

## Benchmarks (FR-23)

`config/benchmark.companies.json` carries akta-pro's published 133-company list
(pulled from their public benchmark repo, attributed in-file). The harness runs the
window protocol over our index AND GDELT as second provider, judges with a neutral
model family, validates via optional Serper web-search (cross-provider corroboration
substitutes when no key), then computes their metric definitions (news precision,
company-entity precision, overall precision = product of the two, recall over
validated stories, F1, $/1K correct) into `benchmarks/YYYY-MM.md` + raw archive +
a `benchmark_runs` row.

## Requirement coverage map

FR-1..23 implemented as: registry+seed (src/sources), RSS/GDELT/fetch/extract
(src/ingestion), rules prefilter + wire dedupe (src/filtering), waiting room +
manual harness batch (src/harness/run.ts: corrections → new-company deep search
→ card updates → publish; the ONLY inline LLM surface), entity
KB+imports+autocreate+facts (src/entities), candidates+resolver
(src/resolution), router+enrichment (src/llm, src/enrichment), clustering
(src/clustering), API+contracts+OpenAPI (src/api), ListGen (src/listgen),
webhooks (src/webhooks), MCP (src/mcp), benchmark harness (src/benchmark),
queue+retention+backup (src/queue, src/ops).
FR-25 (REQUIREMENTS §12 addendum): akta-parity company profiles —
entity_profiles store + evidence-pack profiler (src/entities/profile.ts),
config/policy (config/company-profile.json), enrichment API + MCP tool;
profile sections for NEW companies run inside the harness batch (part 2).
Non-functional: budget/cost ledger (NFR-1/4/9), idempotent jobs + content-hash
dedup + per-source isolation (NFR-3), hashed keys/rate-limit/CORS/env-secrets
(NFR-6), robots+UA+takedown+attribution fields on every article object (NFR-7),
excerpt-only external text policy with feature flag (NFR-8), config-not-code
(NFR-9), contract+golden tests with offline providers (NFR-5).

## Pipeline invariants (OUTPUT-RUBRIC R01-R14)

The rubric (`docs/OUTPUT-RUBRIC.md`) gates the monthly corpus on structural
invariants. Each is enforced by code + a named verifier:

| Invariant | Mechanism | Verifier |
|---|---|---|
| R01 registry-only ingestion | every feed/GDELT query enters via `sources` | `pnpm rubric:probes` publisher-domain check; admin CRUD only |
| R02 uniform stage chain | fetch-feed → fetch-article → filter (rules + wire dedupe) → WAITING ROOM → harness-run → publish, for ALL origins incl. express lanes routed through the waiting room | journey packages on /exoskeleton; `pnpm pipeline:replay --article=<id>` |
| R03 idempotent everywhere | content-hash unique indexes + per-stage guards | golden double-run test (`test/integration/invariants.test.ts`) |
| R04 nothing dies silently | discards carry stage+reason; failed fetches park (retained); duplicate-consumed marked | `pnpm pipeline:reconcile` (exit 1 if <99% accounted) |
| R05 enriched-or-unpublished | harness completeness validator leaves incomplete rows in the waiting room (`enrichedAt` cleared, bounded attempts then parked); they never serve half-filled | zero-row assertion in reconcile; waiting-room test |
| R06 minimum viable card | `entities.needs_backfill` gate: baseline worker fills ≥1 industry tag + non-null `funding_stage` (`unknown`/`bootstrapped` policy — null is a defect) then unflags; flagged entities excluded from search/ListGen | `baselineSatisfactionRate()` probe in `pnpm rubric:probes`; backfill-tick drains to ~0 weekly |
| R07 facts → KB within SLA | accepted funding facts write stage/raise/date **and** `source_refs` immediately; self-healing repair pass | probe "accepted facts lacking derived fields = 0" |
| R08 judgment in config | thresholds/prompts/taxonomy in mtime-cached `config/*.json`; every LLM call logs prompt template + version | ledger spot-check test; `llm_calls.prompt_template_version` |
| R09 disclosed degradation | soft-cap/hard-cap transitions recorded once per month in `pipeline_events`, shown on dashboard + benchmark report disclosure section | dashboard `degrade_events`; benchmark artifact section |
| R10 source lifecycle | hourly tick prunes failure-streak sources inactive, throttles high-discard-rate feeds a tier, flags never-fetched onboardees — all audited in `source_events` | lifecycle tests; `pnpm rubric:probes` event listing |
| R11 replayable history | PR template mandates backfill plan + before/after benchmark diff; imports chunked/resumable | `.github/PULL_REQUEST_TEMPLATE.md` |
| R12 contracts + goldens | zod contracts drive API + OpenAPI; golden invariants suite offline (PGlite + mock LLM) | `pnpm typecheck && pnpm lint && pnpm test` |
| R13 funnel observability | daily per-stage counters upserted into `funnel_daily`; WoW >30% deviations surface as alerts on the dashboard | `funnel_days`/`funnel_alerts` on `/v1/admin/dashboard`; alert unit test |
| R14 determinism | temperature 0 default on all classification/extraction; deterministic resolver scoring; mock provider fixed outputs | replay-identical-decisions test |

Truth-set files backing rubric measurement (Appendix B): `config/gold-events.json`,
`config/gold-merge-pairs.json`, `config/rubric.listgen.queries.json`,
`config/benchmark.companies.json`, plus declared thesis weights in
`config/thesis.json`. Venture-band classification (C0) lives in
`src/entities/banding.ts`.

## Deviations from §7 (as required, written notes)

1. **OpenAPI generation** — hand-rolled generator over `zod-to-json-schema`
   instead of a Fastify type-provider plugin: keeps one zod contract set driving
   validation *and* spec, avoids plugin version coupling.
2. **S3 client** — `@aws-sdk/client-s3` chosen over MinIO SDK for provider
   neutrality (MinIO/Garage/R2/Backblaze all work); local-FS driver included.
3. **Embeddings** — hosted OpenAI-compatible endpoint at fixed 256 dims
   (`text-embedding-3-small` supports `dimensions` natively). Local MiniLM-class
   remains pluggable via `LlmProvider.embed` but is not bundled (keeps the VPS
   image small); changing dims requires regenerating the vector column.
4. **Extraction** — JS Readability shipped; the Python trafilatura sidecar stays
   pre-approved (§7 note) if tier-1 extraction success drops below 85%.
