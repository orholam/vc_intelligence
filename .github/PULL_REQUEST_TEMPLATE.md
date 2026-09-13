# Pull request — pipeline / corpus change

Closes #____

## OUTPUT-RUBRIC invariant checklist (§12)

Any change that alters derived outputs MUST check every applicable box. Reviewer:
tick these against artifacts, not vibes.

### Definition of Done — pipeline change (R11/R12)

- [ ] Contracts/golden tests updated + green (`pnpm typecheck && pnpm lint && pnpm test`) — **R12**
- [ ] Double-run idempotence proven for touched stages (zero row-count deltas) — **R03**
- [ ] Backfill plan for affected historical rows, chunked + resumable, within the NFR-1 budget cap — **R11**
      Affected row populations: ____
      Backfill command/worker: ____
- [ ] Before/after FR-23 benchmark numbers attached (`benchmarks/YYYY-MM.md` diff or raw JSON) — **R11/FR-23**
- [ ] Config values externalized in `config/*.json`, `version` bumped — **R08**
- [ ] Funnel counters still reconcile end-to-end (`pnpm pipeline:reconcile` exit 0) — **R04/R13**

### If the change touches ingestion sources (R01/R10)

- [ ] New feeds enter via the `sources` registry (admin API / OPML/CSV import), zero deploy
- [ ] Onboard health check ran within 24h; lifecycle transitions audited in `source_events`

### If the change touches entity cards (R06/D3)

- [ ] Baseline predicate holds incl. non-null `funding_stage`
      (`SELECT ... FROM entities WHERE needs_backfill = false AND (funding_stage IS NULL ...)`) = 0 rows
- [ ] Surface queries still exclude `needs_backfill = true`

## Verification evidence

```
<paste typecheck/lint/test tails, reconcile output, probe rows>
```
