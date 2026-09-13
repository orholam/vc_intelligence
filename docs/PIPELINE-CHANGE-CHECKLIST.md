# Pipeline change checklist (R11/R12 compliance)

Any change that alters derived outputs — prompt edit, model swap, resolver
scoring change, taxonomy/filter/threshold change, enrichment fallback policy —
MUST ship with this checklist completed in the PR description. "Derived
outputs" = anything written by filter, resolve, enrich, cluster, facts, or
banding stages.

## Pre-merge

- [ ] Contracts / golden tests updated and green (`pnpm typecheck && pnpm lint && pnpm test`)
- [ ] Double-run idempotence proven for touched stages (replay or CI fixture)
- [ ] Config values externalized in `config/*.json` + version bumped (NFR-9/R08)
- [ ] Prompt template `v` bumped when wording/vars changed; version lands in `llm_calls.prompt_template_version`

## Backfill plan (R11)

State explicitly:

1. **Affected row populations** — which tables/columns does the new rule
   change for historical rows? (e.g. `articles.primary_tag` for kept rows,
   `entities.funding_stage`, story clusters)
2. **Recompute path** — the script that replays them, e.g.
   `pnpm reenrich --all`, `pnpm reresolve`, `pnpm recluster-facts`,
   `pnpm refilter-legacy --days=31`, `pnpm rubric:remediate`
3. **Budget cap** — chunked + resumable; respects NFR-1 monthly cap; bounded
   batches per run (drain-style convergence, no unbounded single pass)
4. **Determinism** — same input + config ⇒ same output (R14); replay test
   added where a new decision function was introduced

## Post-merge evidence

- [ ] Before/after FR-23 benchmark numbers attached (`benchmarks/YYYY-MM.md` diff or excerpt)
- [ ] Funnel counters reconcile end-to-end after backfill (R04 probe: raw_items ≈ kept + audited discards + parked)
- [ ] Scorecard regenerated (`pnpm rubric:score`) with deltas noted on the wall triple (C2) and lead time (C3)

## Notes

- Backfills run against the live DB must be **audit-preserving**: demote with
  reasons, never delete history; merges fold cards rather than dropping rows.
- If a change intentionally trades recall vs precision (or vice versa), state
  the expected direction and magnitude here so the next scorecard can verify it.
