# Scrub Kept Quality — Reference

## Why secondaries matter

`/v1/news/latest` hydrates **all** entity links on each article. `entity_name` in the API response is the primary, but the UI and company chips can show secondaries. A correct primary does not excuse a garbage secondary.

Real failure (2026-08-29):

| Field | Value |
|-------|-------|
| Title | Trump administration attempts to punish, ban Anthropic were unlawful, judge rules |
| Primary | Anthropic ✅ |
| Secondary | Trump administration attempts to punish ❌ |

Primary-only scrub missed this entirely.

## Audit SQL

Bad links on kept articles (primary **and** secondary):

```sql
SELECT ae.role, e.canonical_name, a.id, left(a.title, 80) AS title
FROM articles a
JOIN article_entities ae ON ae.article_id = a.id
JOIN entities e ON e.id = ae.entity_id
WHERE a.noise_stage = 'kept'
ORDER BY a.published_at DESC;
```

Filter in application code with `entityNameRejectionReason()` and `isHeadlineFragmentEntity(name, title)` from `src/lib/quality.ts`.

Quick psql one-liner (uses DATABASE_URL from `.env.local`):

```bash
export DATABASE_URL=$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')
psql "$DATABASE_URL" -c "
SELECT ae.role, e.canonical_name, left(a.title, 70)
FROM articles a
JOIN article_entities ae ON ae.article_id = a.id
JOIN entities e ON e.id = ae.entity_id
WHERE a.noise_stage = 'kept'
  AND (
    e.canonical_name ~* 'attempts to|administration|^investors$|^how$|^title$|securities fraud'
    OR length(e.canonical_name) > 40
  )
ORDER BY a.published_at DESC
LIMIT 50;
"
```

Orphan kept (no entities — should be 0):

```sql
SELECT id, left(title, 80) FROM articles a
WHERE noise_stage = 'kept'
  AND NOT EXISTS (SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id);
```

## Anti-patterns (never valid company names)

| Headline snippet | ❌ Wrong entity | ✅ Correct |
|------------------|-----------------|------------|
| Trump administration attempts to punish, ban Anthropic… | Trump administration attempts to punish | Anthropic (only) |
| …Investors with Losses…Lead Microvast…Lawsuit | K Have Opportunity, Investors | Microvast |
| PETER PIPER PIZZA UNVEILS $1 MILLION… | PETER PIPER PIZZA UNVEILS | Peter Piper Pizza |
| NASA's Nancy Grace Roman Telescope: How to watch live | How, NASA's | drop — no company subject |
| PLAB Investors…Lead Photronics… | PLAB Investors | Photronics |

## Scripts

| Script | Scope |
|--------|-------|
| `src/scripts/scrub-kept-quality.ts` | **Canonical** — all kept links, dry-run, `--hours=N` |
| `src/scripts/fix-drain-session-quality.ts` | Session-specific manual FIXES + same scrub pass |
| `src/scripts/scrub-harness-junk.ts` | Recent harness mints (`--hours=4`) |
| `src/scripts/fix-latest-quality.ts` | One-shot manual fixes (older) |
| `src/scripts/revalidate-quality.ts` | Slop title demotion + autocreate purge |

## Guard functions (`src/lib/quality.ts`)

| Function | Purpose |
|----------|---------|
| `entityNameRejectionReason(name)` | Generic junk: prompt labels, generic words, domains, etc. |
| `isHeadlineFragmentEntity(name, title?)` | Title-prefix fragments, "attempts to", administration |
| `looksLikeLegalEntityName(name)` | Exempt `… LLC`, `… Fund, Lp` from fragment heuristics |

When a new failure mode appears, add the pattern to `quality.ts` first, then re-run scrub.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Garbage on `/latest` after scrub | Only checked primaries | Run `@scrub-kept-quality` (scans all roles) |
| Legitimate LLC unlinked | Over-aggressive fragment regex | `looksLikeLegalEntityName` exemption — verify in dry-run |
| Article vanished from `/latest` | Bad primary removed, no inference | Manual relink or requeue for drain |
| Scrub says 0 but user still sees junk | Browser cache / stale API | Hard refresh; re-run audit SQL |
| Same junk returns after drain | Bad `discover_subject` answers | Fix drain editorial + run scrub post-drain |

## npm

```bash
pnpm quality:scrub-kept              # live
pnpm quality:scrub-kept -- --dry-run # preview
pnpm quality:scrub-kept -- --dry-run --hours=24
```
