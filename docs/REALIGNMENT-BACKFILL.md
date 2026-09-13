# Realignment Backfill Report — c-plan (Aug 15–22, 2026)

> Goal: implement the full c) realignment plan (left edge of the magic zone)
> and backfill the past week through the reoriented pipeline.
> LLM_PROVIDER=mock throughout (notional ledger costs, zero real spend).

## 1. What was implemented

| Area | Change | Files |
|---|---|---|
| Source re-tiering | 46 feed changes: startup-native/regional → tier-1 (55 total), consumer-tech block → tier-3 context, 5 risk GN verticals disabled. Live-registry sync via `pnpm sources:sync-tiers` | `config/feeds.seed.json`, `src/scripts/sync-source-tiers.ts` |
| SEC Form D ingestion | EDGAR daily-index parser (`form.YYYYMMDD.idx`, fixed-width) → registry-keyed entity upserts (`registry_ids.sec_cik`) + ACCEPTED funding_round facts + auto-watchlist. Zero LLM calls. Idempotent on accession | `src/ingestion/formd.ts` |
| Launch surfaces | HN Show HN via Algolia (points ≥50) + Product Hunt GraphQL (votes ≥100; skips gracefully without `PH_TOKEN`); github_trending / yc_directory stubbed in config. Crowd-gate = ingestion filter; accepted observations become conf≤0.4 entities + product.launch articles + product_launch facts | `src/ingestion/launches.ts`, `config/filters.json` |
| Scoring formula | `score = family×0.5 + tier×0.2 + prominence×0.2 + exclusivity×0.1`; fame-dampening (public+unwatchlisted caps family weight; prominence=1/(1+n30d/scale)); first-coverage exclusivity. Prefilter event-title rescue for thin wire copy (case-insensitive) | `src/enrichment/pipeline.ts`, `src/filtering/prefilter.ts`, `config/filters.json` v2026.08.12 |
| Serving | `first_coverage` flag on all article DTOs (/v1/news, /v1/news/latest, /v1/feed); ListGen excludes low-signal launch entities (`launch_entity_min_signal`); dashboard alignment KPIs (private-share %, top-10 concentration %, launch pool) | routes + contracts + `src/api/routes/admin.ts` |
| Schema | migration 0001: `entities.registry_ids` jsonb (+CIK/CH expression indexes), `entities.created_by` index, `articles.platform_meta` jsonb, facts type += `product_launch` | `migrations/0001_foamy_mercury.sql` |
| Tests | Helper applies all migrations in order; gates stay green | `test/helpers/db.ts` |

**Quality gates:** typecheck ✓ · lint ✓ · tests **48/48** ✓ · offline quality eval
**OVERALL 78.4%** (gate 92% / attr 92.3%) — recovered from 45% mid-refactor.

**X/Twitter:** deferred by design (API pricing breaks NFR-1 budget; scraping is a
ToS violation). Documented in REQUIREMENTS.md §11.

## 2. Backfill funnel (Aug 15–22 window)

| Stage | Count | Notes |
|---|---|---|
| Raw items (cumulative) | 8,008 | dedup held across re-runs |
| Articles | 3,714 | |
| Kept after filter | **997** | 73% discard rate (target band hit) |
| Entities total | **2,153** | was 99 before this goal |
| — Form D entities | 692 | 32% of the KB, created with zero LLM spend |
| — Launch-surface entities | 6 | HN only (PH needs token) |
| Linked kept articles | 812 | |
| Accepted facts | **703** | 692 Form D + 11 press-derived |
| First-coverage articles | **809 (81% of kept)** | exclusivity signal live |
| Launch articles (platform-meta) | 247 | HN Show HN gate survivors |
| Notional LLM cost (ledger, all runs) | $21.99 | mock-priced; real-provider projection pending |

## 3. Alignment KPIs (the numbers that replaced "entity count")

| KPI | Before c-plan | After |
|---|---|---|
| Private-share of kept articles (7d) | ~55–60% (Apple-dominated era) | **81.1%** |
| Top-10 mention concentration | extreme (Apple alone 21) | tracked on `/v1/admin/dashboard` |
| Entity base relevant to VC sourcing | 35 seeds (mega-caps) | +692 Form D filers + launch pool |
| Earliest-signal capability | none (press-only) | Form D T+1 + same-day launch gates |

## 4. Issues found & fixed during bring-up

1. EFTS full-text search does not index Form D documents (0 hits) → switched to
   EDGAR daily-index fixed-width files (165 D-filings/day observed).
2. CIK space-padding broke the first parser regex → normalize to 10 digits.
3. SEC transiently 403s individual daily-index files → per-day fault isolation
   (`dayErrors[]`), window survives (NFR-3).
4. Test helper applied only migration 0000 → now iterates all `migrations/*.sql`;
   tolerates trgm/hnsw extension gaps incl. DROP statements.
5. Feed route missed required `first_coverage` on ArticleDto → wired.
6. Parallel-session edits (news.ts multi-entity hydration, deep-clean.ts lint
   errors, filters.json newsworthiness section) reconciled without loss.

## 5. Known gaps / next steps

- **PH_TOKEN missing**: Product Hunt adapter ready but inert until a developer
  token is added to `.env.local`.
- **Form D amounts**: require per-filing `primary_doc.xml` fetch — scheduled as
  a later enrichment pass.
- **Fetch backlog**: ~3.9K pending in-window items remain (bot-wall 403/429s
  dominate failures); drain incrementally or widen keenable fallback usage.
- **Real LLM provider**: everything still runs on mock; flip `LLM_PROVIDER`
  when budget approved — cost model projects ≈$150–250/mo at current volume.
- 3 of 7 backfill days had SEC 403s; they self-heal on next daily run.
