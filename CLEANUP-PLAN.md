# Cleanup plan

North star: `source_of_truth.md`. This file is the **order of work** so we
do not flatten the product or break the waiting-room loop.

Do not start a later phase by deleting something an earlier phase still
needs. If a change fails a §8 guardrail in the source of truth, revert it.

---

## Phase 0 — Freeze the spec *(done)*

- [x] `source_of_truth.md` written and iterated
- [x] Independent of Copyr; ignore CRM integration for now
- [x] Facts stay; news must point at them
- [x] Publics mostly out; all funding series; goldilocks is a sweet spot
- [x] Early funnel: miss fewer companies than you over-filter

---

## Phase 1 — Say what we are, without breaking the machine *(done)*

- [x] Frontend IA (Updates / Analytics / Playground / landing)
- [x] News → fact pointer (`articles.fact_id`)
- [x] Docs point at the source of truth

---

## Phase 2 — Admin console that answers four questions *(done)*

`/exoskeleton` is a waiting-room console, not a plant schematic.

- [x] Q1 waiting-room depth + inspect pile
- [x] Q2 never reached the room (fetch / prefilter / reasons)
- [x] Q3 harness outcomes (create / update / publish / discard / facts)
- [x] Q4 examples + durable ⚑ flags
- [x] RUN HARNESS kept; HTTP claim loop kept (`GET /internal/llm/claim`)
- [x] Packet animation, SVG plant, queue/budget/webhook widgets removed from the page

---

## Phase 3 — Database: publics out, names honest *(done, no table rename)*

- [x] Shared `TRACKED_COMPANY_SQL` excludes `public` / `fund` / `person-org`
- [x] Default search, ListGen, stats, mix, growth, MCP `kb.search` use it
- [x] `?entity_type=public` still returns publics; news counterparties unchanged
- [x] Duplicate finder: `tsx src/scripts/find-duplicate-companies.ts`
- [x] Merge remains `POST /v1/admin/entities/merge` (no mass purge, no `entities` rename)

Live public *rows* stay in the KB until an operator merges/drops them.

---

## Phase 4 — Shrink what did not earn its keep *(done, modules gated not erased)*

- [x] GDELT / Form D / launch surfaces **opt-in** (`GDELT_ENABLED`, `FORMD_ENABLED`, `LAUNCH_SURFACES_ENABLED` default false). RSS remains the backbone.
- [x] Useful card: mandated profile sections shrunk to firmographic, location, industry, funding_detail, management_profile. Extra sections still exist.
- [x] Homemade `pg_dump` (`src/ops/backup.ts`) removed — host backups are enough
- [x] Akta benchmark scripts remain optional eval, not a success bar
- [x] Source registry, RSS, waiting room, harness, facts, product API, landing look kept

---

## Phase 5 — Product polish *(done)*

- [x] Keep `GET /v1/news/latest` path (all-news feed)
- [x] `related_sources` on news / latest / feed DTOs (story-cluster siblings)
- [x] Editorial MCP: `list_waiting_room`, `run_waiting_room_harness` — claim loop stays HTTP
- [x] Webhooks: **commit**. Create response now returns `secret` once
- [x] Seeding: do not run bulk Wikidata/EDGAR dumps; mint-from-news + small seeds. Finder for website dupes.
