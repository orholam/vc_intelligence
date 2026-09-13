---
name: scrub-kept-quality
description: >-
  Audit and scrub junk company names from kept articles on /latest — headline
  fragments, lawsuit boilerplate, generic words on primary AND secondary entity
  links. Invoke after drain sessions, when /latest shows garbage entity names,
  or when the user asks to clean up published quality. Always dry-run first,
  then verify zero bad links remain.
---

# Scrub Kept Quality

**Goal:** `/v1/news/latest` must never show headline fragments as company names — on **primary or secondary** links.

The Trump/Anthropic failure happened because scrub only checked primaries. A correct primary (`Anthropic`) hid a garbage secondary (`Trump administration attempts to punish`) that still surfaced on `/latest`.

## Invoke when

- User reports garbage company names on `/latest`
- After any `@drain-waiting-room` session (mandatory post-drain step)
- After mock/harness runs with high `incomplete`
- User says "clean up", "scrub", "fix entity names", "quality pass"

## Mandatory behavior

1. **Audit before fix** — never scrub blind
2. **Dry-run first** — always `--dry-run`, review output, then live
3. **Scan ALL roles** — primary **and** secondary links on `noise_stage='kept'`
4. **Verify after** — audit query must return **0** bad links before saying done
5. **Spot-check `/latest`** — curl or browser; search for obvious fragments
6. **Do not** declare clean based on `bad kept primaries: 0` alone — secondaries count

## Workflow

```
audit → dry-run scrub → live scrub → audit again → /latest spot-check → report
```

### Step 1 — Audit (read-only)

```bash
.cursor/skills/scrub-kept-quality/scripts/audit.sh
```

Review every row. Pay special attention to:
- Names that are the **first clause of the headline** ("Trump administration attempts to punish")
- Lawsuit boilerplate ("Investors", "K Have Opportunity", "Securities Fraud Lawsuit")
- Prompt artifacts ("Title", "Adding", "How")
- Generic words ("Investors", "Please", "Talks")

### Step 2 — Dry-run scrub

```bash
pnpm quality:scrub-kept -- --dry-run
```

Optional window (recent drain only):

```bash
pnpm quality:scrub-kept -- --dry-run --hours=24
```

Read every `unlink` line. Confirm:
- Legitimate LLC names (`Melville Apartments Investors, LLC`) are **not** flagged
- Headline fragments **are** flagged on both primary and secondary
- **`generic_word` hits need judgment** — e.g. `Natural` may be a real company; `Investors` is always junk

### Step 3 — Live scrub

```bash
pnpm quality:scrub-kept
```

### Step 4 — Verify (ALL must pass)

Re-run audit:

```bash
.cursor/skills/scrub-kept-quality/scripts/audit.sh
```

**Done criteria:**

| Check | Target |
|-------|--------|
| Bad kept links (audit script) | **0** |
| `scrub-kept-quality.ts` final line | `bad kept links remaining: 0` |
| `/latest` spot-check | No headline fragments in `entity_name` or linked companies |
| Orphan kept articles | **0** (`noise_stage='kept'` with no entity links) |

Spot-check `/latest`:

```bash
curl -s "http://127.0.0.1:4600/v1/news/latest?limit=100" | python3 -c "
import sys, json, re
d = json.load(sys.stdin)
bad = re.compile(r'attempts to|administration|investors have|securities fraud|^how\\b|^title$|^investors$', re.I)
for a in d.get('data', []):
    name = a.get('entity_name','')
    if bad.search(name):
        print('BAD PRIMARY:', name, '|', a.get('title','')[:80])
    for c in a.get('companies', []) or []:
        n = c.get('name','')
        if bad.search(n):
            print('BAD LINK:', c.get('role'), n, '|', a.get('title','')[:80])
print('spot-check done')
"
```

### Step 5 — Completion report

```
Scrub kept quality — complete

Audit before: N bad links (list worst 3)
Dry-run unlinks: N
Live unlinks: N | orphans requeued: N | junk entities purged: N
Audit after: 0 bad links
/latest spot-check: clean | issues: (none or list)
Manual fixes applied: (if any — add to fix script or relink by hand)
```

## What the scrub does

`src/scripts/scrub-kept-quality.ts`:

1. Scans **every** entity link on kept articles
2. Unlinks names failing `entityNameRejectionReason()` or `isHeadlineFragmentEntity(name, title)`
3. Deletes orphan junk entities with no remaining links
4. Re-queues kept articles left without any entity link
5. Attempts title inference for articles that lost a bad **primary** (lawsuit lead-ins, `extractTitleSubject`)

Guard logic lives in `src/lib/quality.ts` — tighten there when new failure modes appear.

## Manual fixes (when inference fails)

If audit shows a kept article with wrong primary that scrub cannot infer:

1. Read the headline — identify the real company subject
2. Add a row to `src/scripts/fix-drain-session-quality.ts` FIXES array **or** relink via SQL
3. Re-run audit

Drop (not relink) when there is no company subject (NASA launch watch, gov policy, market commentary):

```sql
UPDATE articles SET noise_stage='llm_filter', discard_reason='scrub:no_company_subject', updated_at=now()
WHERE id = 'art_...';
```

## Related commands

| Command | When |
|---------|------|
| `pnpm quality:scrub-kept` | **Primary** — kept-article entity scrub |
| `pnpm quality:revalidate` | Demote slop titles + purge autocreate junk |
| `tsx ... scrub-harness-junk.ts --hours=4` | Recent harness mint cleanup |
| `pnpm harness:park-scrub` | Park scrub-requeued waiting articles |

## Pair with drain

After `@drain-waiting-room` completes (or pauses), **always** run this skill before telling the user the feed is clean.

## Reference

See [reference.md](reference.md) for SQL queries, anti-pattern table, and failure modes.
