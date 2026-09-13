---
name: drain-waiting-room
description: >-
  Drain the Copyr intelligence waiting room: review batched RSS articles,
  drop irrelevant posts, fix company name and category misidentifications,
  publish keepers to the database, and enrich new companies. Invoke when the
  user asks to drain, process, review, or clear the waiting room. YOU are the
  LLM — stay in the claim loop in this session until done criteria are met.
  Success = correct publishes and entity names, not claims answered or waiting
  count alone.
---

# Drain Waiting Room

**You are the LLM.** With `LLM_PROVIDER=harness`, nothing publishes until **you** claim and answer completions in **this chat session**. Background scripts start infra only — they do not do editorial work.

**Subagents do not count.** Do not delegate the claim loop to a Task/subagent. If the user says "keep going," that means **you** keep claiming — not spawn a background worker.

## What success actually means

Three different numbers — do not conflate them:

| Metric | What it measures | User-visible? |
|--------|------------------|-----------------|
| `waiting` down | Backlog cleared from the waiting room | No |
| `last_run.published` / `published_24h` up | Articles passed all gates → `noise_stage='kept'` | Partially |
| `/v1/news/latest` | Kept articles **with a company attached**, sorted by RSS **`published_at`** | **Yes — this is what the user sees** |

**Critical:** `/latest` sorts by the article's original RSS publication date, **not** when you marked it kept. Draining old backlog makes `published_24h` rise but `/latest` may still show "2d ago" timestamps. Fresh RSS from the last hour only appears if those articles survive audit **and** entity resolution **and** enrichment.

A run that answers 200 claims but `last_run.published: 0` and `incomplete` climbing is **failing**, not progress.

## Invoke this skill when the user wants to

1. Clean up irrelevant posts in the waiting room
2. Fix misidentifications (wrong company name, wrong category/tags)
3. Publish good articles to the database
4. Enrich new companies discovered during the batch

## Mandatory behavior — do NOT skip

1. **Do not** start background mock scripts and exit (`harness:mock-agent`, `harness:drain-mock`) for production work
2. **Do not** say "complete" or "mostly done" until **all** done criteria below are met — no "close enough"
3. **Do** enter the claim loop yourself in **this chat session** and stay until done
4. **Do** report progress every 10–25 claims using the [progress template](#progress-report-every-1025-claims) below
5. **Do** treat **every stage** as editorial — a bad `discover_subject` blocks publish and poisons `/latest` with the same severity as a bad keep in `batch_audit`
6. **Do** slow down when `incomplete` rises or `published` stalls — more claims is not the fix; better entity/tag answers are

## Do not (production) — violations that caused real failures

- Run `pnpm harness:mock-agent` or `pnpm harness:drain-mock` — MockProvider, blocked from publishing
- **Shell loops, scripts, or batch curl** that claim or answer LLM requests for you — even if labeled "pipeline only"
- **Subagents / Task tool** to answer claims — editorial work stays in this session
- **Claim twice without posting** the first result — leaves `claimed: 1` and freezes the queue
- **Heuristic / title-parse answers** for `discover_subject` (e.g. first capitalized span, lawsuit boilerplate, ticker fragments)
- Fire harness and walk away without claiming
- Stall past 180s on a claim
- Use any model tag other than `harness:agent` for your POSTs
- Optimize for `waiting` count alone while ignoring `incomplete` and entity quality

## Step 0 — Prepare infra

```bash
# Start API + workers if not running
pnpm dev

# Recover stale lock, start supervisor, fire first harness batch
pnpm harness:prepare
```

If API is already up and supervisor running, you can skip to Step 1.

**Supervisor** (background, optional — `pnpm harness:prepare` starts it): re-fires `harness/run` when waiting > 0 and harness idle. It does **zero** LLM work.

## Step 1 — Claim loop (YOU do this — repeat until done)

### One claim at a time (non-negotiable)

```
claim → read full prompt → apply editorial judgment → POST result → claim again
```

Never call `claim` a second time before POSTing the first. If a for-loop or script "claims until batch_audit," it **will** double-claim and stick the queue.

### Claim

```bash
curl -s "http://127.0.0.1:4600/internal/llm/claim?wait=25"
```

**If `request` is null:** check queue and waiting count:

```bash
pnpm harness:status
```

- If `llm_queue.claimed > 0` but claim returns null → **stuck claim**. Query DB for `status='claimed'`, read the prompt, POST the result — do not idle in a loop
- If `waiting > 0` OR `llm_queue` has pending → wait 5s, claim again
- If both idle → proceed to Step 2 (done check)

**If `request` is present:**

1. Read `stage`, `system`, `user` from the claim response — **full text**, not a preview
2. Apply editorial judgment (see [Stage rules](#stage-rules) — every stage)
3. POST result within **180 seconds** — always use model **`harness:agent`**:

```bash
curl -s -X POST "http://127.0.0.1:4600/internal/llm/{id}/result" \
  -H 'Content-Type: application/json' \
  -d '{"ok":true,"data":{...},"raw":"...","model":"harness:agent"}'
```

On unrecoverable failure:

```bash
curl -s -X POST "http://127.0.0.1:4600/internal/llm/{id}/result" \
  -H 'Content-Type: application/json' \
  -d '{"ok":false,"error":"brief reason","model":"harness:agent"}'
```

Then **immediately** claim again. Do not exit the loop early.

## Step 2 — Done criteria (ALL must pass before saying complete)

Run `pnpm harness:status` and verify **every row**:

| Check | Target |
|-------|--------|
| `waiting` | User target (default: **under 50**) OR **0** if user asked to drain fully |
| `llm_queue` | `{pending: 0, claimed: 0}` |
| Harness | Not stuck (`harness_running: false` OR last_run shows progress) |
| **`last_run.published`** | **> 0** on the most recent completed run **or** explain in the completion report why zero (e.g. all discards) |
| **`last_run.incomplete`** | Not climbing run-over-run — if high, entity/enrichment answers are wrong |
| **Entity quality** | Spot-check: no title fragments, lawsuit boilerplate, or generic words as company names (see [discover_subject anti-patterns](#discover_subject--mint-company)) |

If RSS is refilling faster than you drain and `waiting` cannot reach the target in one session: **keep quality, report honestly**, do not rush pipeline stages to "get close." Say: waiting at X, published Y this session, incomplete Z, net drain blocked by RSS — not "mostly complete."

**Completion report must include:** waiting count, `published` / `discards` / `incomplete` from last_run, `published_24h` delta, claims answered this session, worst entity name you saw (if any), anything parked for manual review, whether `/latest` would show fresh rows (remember: RSS date, not harness time).

## Step 3 — Stop background workers (when done)

```bash
pnpm harness:stop
```

## Step 4 — Scrub kept quality (mandatory before saying feed is clean)

After draining, run **`@scrub-kept-quality`** — scans primary **and** secondary links on kept articles. A correct primary does not excuse garbage secondaries on `/latest`.

## Step 5 — Enrich new companies (if cards are empty)

```bash
pnpm enrich:run -- --days=2 --limit=200
```

Done only when `pnpm enrich:status` shows `recent_empty: 0` and the newest `/latest` company has Profile sections. See **`@enrich-new-companies`**.

## Progress report (every 10–25 claims)

Copy this template — fill every line:

```
Claims this session: N
waiting: X | published_24h: Y | last_run: published P discards D incomplete I
llm_queue: pending / claimed
Session publish yield: (published_24h delta since start)
Entity spot-check: (best and worst company_name you set this block)
Blockers: (stuck claim / incomplete rising / API down / none)
```

If `incomplete` > 10 or `last_run.published: 0` after a full harness batch, **stop speeding up** and audit your last 5 `discover_subject` / `batch_audit` answers before continuing.

## What the harness does (for context)

Each `harness/run` batch (~120 articles):

1. **Part 1 — batch audit:** You review a pile of headlines (`batch_audit`), keep/drop/retag each
2. **Per-keeper pipeline:** summary, entity resolution (`adjudicate`, `discover_subject`), clustering → publish (`noise_stage=kept`) — **only if enrichment completeness passes**
3. **Part 2 — baseline backfill:** deterministic (no LLM) for new entities
4. **Part 3 — card/fact updates:** mostly deterministic from signals

Keepers that fail enrichment (`enrich_missing:…`) go back to `waiting` — they do **not** appear on `/latest`. Bad entity names cause this.

For **deep company profiles**, use **`@enrich-new-companies`** (`pnpm enrich:run`). Success is populated cards, not a started queue.

## Stage rules

**Every stage is editorial.** There are no "fast" stages.

| Stage | Your job |
|-------|----------|
| `batch_audit` | Read **every** ITEM index. Drop noise (GitHub repos, sports, stock commentary, product promos, macro without company subject, commentary dupes). KEEP discrete company events. Set `subject_name` = primary company as styled in coverage. Valid EVENT_TYPES + SECTORS from prompt. |
| `adjudicate` | Match subject to KB; empty `matches` if no confident hit. Never force-match a garbage KB candidate. |
| `discover_subject` | Mint new company — see [anti-patterns](#discover_subject--mint-company) below |
| `counterparty_extract` | Other companies mentioned + roles — not the primary subject |
| `summary` | Neutral summary, ≤400 chars, facts from text only, name the company explicitly |
| `site_describe` | Short factual blurb from homepage content; use known company facts if page errored |
| `company_profile` | Follow system schema — use `@enrich-new-companies` skill |

Use valid taxonomy ids from the prompt. When unsure on adjudicate, prefer no match over a bad match.

### `discover_subject` — mint company

Return `{company_name, website_domain, confidence}`.

- `company_name`: how the company is styled in trade press — **not** a headline fragment, person, city, lawsuit boilerplate, or generic word
- `website_domain`: **only** if an outbound link domain plainly belongs to that company; else `null` — never invent
- If no specific company is the subject → `company_name: null, website_domain: null`

**Anti-patterns (reject these — use null or the correct name instead):**

| Headline | ❌ Wrong | ✅ Right |
|----------|----------|----------|
| `…Investors with Losses…Lead Microvast…Lawsuit` | `K Have Opportunity`, `Investors` | `Microvast` |
| `PETER PIPER PIZZA UNVEILS $1 MILLION…` | `PETER PIPER PIZZA UNVEILS` | `Peter Piper Pizza` |
| `NASA's Nancy Grace Roman Telescope launch: How to watch live` | `How`, `NASA's` | `null` (no operating company subject) |
| `PLAB Investors…Lead Photronics…` | `PLAB Investors` | `Photronics` |

**Self-check before POST:** Would a human editor put this string on a company card? If not, fix it.

## Thresholds

- Default batch target: drain until **waiting < 50**
- Full drain: **waiting = 0** and queue idle
- User can override: "drain 200 articles", "process one batch", etc.
- RSS keeps ingesting — **net drain ≠ empty room**. Quality beats speed when the target is unreachable.

## Quick ops commands

| Action | Command |
|--------|---------|
| Status | `pnpm harness:status` |
| Prepare (recover + supervisor + fire) | `pnpm harness:prepare` |
| Stop background workers | `pnpm harness:stop` |
| Recover stale lock | `pnpm harness:recover` |
| **Tests only** — mock brain | `pnpm harness:drain-mock` |

## API reference

See [reference.md](reference.md).
