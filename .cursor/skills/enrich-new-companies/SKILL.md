---
name: enrich-new-companies
description: >-
  Fill missing company-card information for recently published companies.
  Invoke after draining the waiting room, when the user asks to enrich or
  profile companies, or when a card still says "No profile yet." Success is
  recent_empty: 0 on enrich:status and the newest /latest company showing a
  Profile — never "queue started."
---

# Enrich New Companies

Running this skill means **cards that were empty now have a Profile**. The hourly tick is **off** in harness mode. `pnpm enrich:queue` exiting 0 is **not** done.

## One path — do this in order, in this session

```bash
pnpm harness:stop                                 # drain steals claims; stop it
pnpm enrich:status                                # note newest_empty names
pnpm enrich:run -- --days=2 --limit=200           # queue + answer, foreground
pnpm enrich:status                                # must show recent_empty: 0
```

`pnpm enrich:run` starts the runner **and** answers `company_profile` claims (evidence pack → `harness:agent`) until the queue goes idle. **Wait for it.** Do not background it and tell the user companies are populated.

## Done (all must pass)

| Check | Target |
|-------|--------|
| `pnpm enrich:status` `recent_empty` | **0** |
| `recent_needs_backfill` | **0** |
| `newest_empty` | `[]` |
| `llm_queue` | `{pending: 0, claimed: 0}` |
| `/tmp/enrich-new-companies.log` | contains `"phase":"done"` |
| Spot-check | Newest name from the **before** `newest_empty` list has Profile sections |

Corpus `sections_pending` is old debt. Ignore it.

If `recent_empty > 0` after `enrich:run`, do the [leftover pass](#leftover-pass) — do not report complete.

## Leftover pass

Usually Form D / scrub mints still on `needs_backfill`, or a card that already had one placeholder section so it sorted behind true empties.

```bash
# For each id still in newest_empty (and any company the user named):
pnpm enrich:answer -- --max=200 &
pnpm profile:run -- --entity=ent_XXXXX
wait
pnpm enrich:status
```

Repeat until `recent_empty: 0`.

## Completion report

```
Enrich — complete for last N days

Before: recent_empty X (newest: Name, Name, …)
After:  recent_empty 0 | recent_with_profile Y / recent_with_coverage Z
Spot-check: (name) has Profile sections
Leftovers: (none or ids + what you did)
```

## Do not

- Say complete because queue.sh printed a PID
- Background `enrich:run` / `enrich:answer` and walk away
- Use limit **50** (newest mints fall off the batch)
- Leave the waiting-room harness running (it eats profile claims)
- Wait for corpus `sections_pending: 0`
- Expect the hourly profiler to fill gaps
- Answer drain stages (`batch_audit`, `discover_subject`) with the profile answerer — it refuses those

## Commands

| Action | Command |
|--------|---------|
| Status | `pnpm enrich:status` |
| **Full run** (queue + answer) | `pnpm enrich:run -- --days=2 --limit=200` |
| Answer claims only | `pnpm enrich:answer -- --max=800` |
| One entity | `pnpm profile:run -- --entity=ent_…` |
| Stop runner | `pkill -f enrich-new-companies` |

## Related

- `@drain-waiting-room` → `@scrub-kept-quality` → this skill
- [reference.md](reference.md)
