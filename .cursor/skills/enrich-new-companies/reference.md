# Enrich New Companies — Reference

## Failures this skill exists to prevent

| Failure | What happened | Fix |
|---------|----------------|-----|
| Queue script "succeeded" | `queue.sh` only `nohup`s the runner | `pnpm enrich:run` answers claims in the foreground |
| Limit 50 + confidence sort | Newest mint ranked #65 | Newest-empty first, default limit **200** |
| `--days` / `--limit` ignored | Wrapper used env only | `queue.sh` / `run.sh` parse argv |
| `needs_backfill = true` | `generateEntityProfile` returns `entity_not_eligible` | Runner unlocks kept-coverage targets after baseline |
| Drain harness still running | Profile claims starve / timeout | `pnpm harness:stop` first |
| One placeholder section | Card with `management_profile=complete` (empty) sorted behind true empties | Leftover `profile:run --entity=` |
| Done = `sections_pending: 0` | 14k corpus debt | Done = `recent_empty: 0` |

## What `enrich:run` does

1. `enrich:queue` — baseline + crawl + enqueue `company_profile` (newest 0-section cards first)
2. `enrich:answer` — `answerProfileClaim` on each claim, POST `model: harness:agent` (not `editorial-brain`, which does not complete sections)
3. Prints `enrich:status`

Other LLM stages are **refused** so a drain batch_audit cannot be auto-answered.

## Status fields

- `recent_empty` — kept-coverage companies in the window with **0** complete profile sections
- `newest_empty` — names the user will click
- `recent_needs_backfill` — still blocked
- `progress.sections_pending` — ignore

## Leftover unlock (if runner skipped a row)

```sql
UPDATE entities SET
  funding_stage = COALESCE(NULLIF(btrim(funding_stage), ''), 'unknown'),
  industry_tags = CASE WHEN cardinality(industry_tags)=0 THEN ARRAY['other_diversified']::text[] ELSE industry_tags END,
  needs_backfill = false,
  updated_at = now()
WHERE id = 'ent_…';
```

Then `pnpm profile:run -- --entity=ent_…` with `pnpm enrich:answer` running.

## Verify SQL

```sql
SELECT e.canonical_name,
       e.needs_backfill,
       (SELECT COUNT(*) FROM entity_profiles ep
        WHERE ep.entity_id = e.id AND ep.status = 'complete') AS complete_sections
FROM entities e
WHERE e.merged_into IS NULL
  AND e.created_at >= now() - interval '2 days'
  AND EXISTS (
    SELECT 1 FROM article_entities ae
    JOIN articles a ON a.id = ae.article_id
    WHERE ae.entity_id = e.id AND ae.role = 'primary' AND a.noise_stage = 'kept'
  )
ORDER BY complete_sections ASC, e.created_at DESC
LIMIT 20;
```

## UI

Cards show "No profile yet" when `complete_sections.length === 0`. Any complete section (typically firmographic) removes that message.
