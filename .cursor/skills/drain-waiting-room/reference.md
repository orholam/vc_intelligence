# Waiting Room Harness — Reference

## API endpoints (loopback or `HARNESS_KEY`)

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/exoskeleton/snapshot` | waiting count, harness `running_now`, `last_run` metrics |
| `POST /v1/exoskeleton/harness/run` | queue one harness batch (120 items default) |
| `GET /internal/llm/stats` | pending/claimed queue depth |
| `GET /internal/llm/claim?wait=25` | claim one completion (long-poll) |
| `POST /internal/llm/:id/result` | submit JSON `{ok:true,data,raw,model:"harness:agent"}` or `{ok:false,error,model}` |

## LLM stages the agent answers

| Stage | Role |
|-------|------|
| `batch_audit` | Part 1 pile audit (items with index, keep, tags, subject_name) |
| `adjudicate` | Match article subject to KB candidates |
| `discover_subject` | Mint new company from headline when no match |
| `counterparty_extract` | Other companies mentioned |
| `summary` | Neutral ≤400 char summary |
| `site_describe` | Short site/card blurb |
| `company_profile` | Deep LLM profile sections — **`@enrich-new-companies` skill** (not hourly cron in harness mode) |

## Model tags

| Model | Who | Publishes in harness mode? |
|-------|-----|---------------------------|
| `harness:agent` | Cursor agent (production) | **Yes** |
| `editorial-brain` | `harness-brain-loop.ts` (mock) | No |
| `harness:mock-agent` | `harness-agent-session.ts` (mock) | No |
| `mock-*` | MockProvider tests | No (except `LLM_PROVIDER=mock`) |

## Common failure modes

| Symptom | Fix |
|---------|-----|
| Harness "running" but nothing moves | **No agent claiming** — invoke `@drain-waiting-room` claim loop |
| Agent only started background scripts | Wrong — agent must claim/answer in session |
| `llm_queue.claimed: 1`, claim returns null | **Stuck claim** — POST result for claimed row; never spin a claim loop |
| Agent used shell loop / subagent for claims | Wrong — editorial work in this session only; see SKILL.md "Do not" |
| `harness_running=true` but no LLM pending | `pnpm harness:recover` — stale lock |
| Brain idle, harness stuck | wait for 180s timeout or `harness-answer-stuck.ts` |
| `published: 0`, `mock_fallback_refused` | Mock/programmatic brain tried to publish — use agent with `harness:agent` |
| `published: 0`, high `incomplete_skipped` | Bad `discover_subject` / missing enrichment — audit entity names, not throughput |
| Waiting down but `/latest` looks stale | `/latest` sorts by RSS `published_at`; backlog keepers show old timestamps |
| Garbage entity names on `/latest` | Title-fragment `discover_subject` — see SKILL.md anti-patterns; run **`@scrub-kept-quality`** (checks secondaries too) |
| Waiting never hits 0 | RSS still ingesting; net drain ≠ empty room — report honestly, don't rush |

## npm commands

| Command | Purpose |
|---------|---------|
| `pnpm harness:prepare` | recover + supervisor + fire harness |
| `pnpm harness:status` | waiting count + queue depth |
| `pnpm harness:stop` | stop background workers |
| `pnpm harness:recover` | clear stale harness lock |
| `pnpm harness:drain-mock` | **tests only** — MockProvider brain |

## Config knobs (`config/filters.json`)

- `harness.max_batch` — items per run (default 120)
- `harness.audit_chunk_size` — headlines per `batch_audit` call (default 40)
- `harness.deep_search_entities` — Part 2 entity cap (default 8)
