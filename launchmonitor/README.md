# launchmonitor

Okara Launch Library monitor — part of the intelligence service, sibling of
`xmonitor`. Ingests product-launch posts curated by [okara.ai/launch-library](https://okara.ai/launch-library)
(450+ X launch videos with view/like counts), caches them in local SQLite, and
syncs them into the parent intelligence Postgres so that:

- every company becomes an **entity** (`entities`, `created_by='launchmonitor'`)
- every launch becomes a **news article** (`raw_items` + `articles`,
  `noise_stage='kept'`, `platform_meta.surface='okara-launch-library'`) linked
  to its company via `article_entities` (role `primary`)

After a sync the launches are visible through the standard API surface:
`GET /v1/news/latest`, `GET /v1/companies/:id`, `GET /v1/companies/search`.

## Why not live-fetch?

okara.ai bot-protects its `/api/launch-library` endpoint (TLS-fingerprint +
headless-browser detection; returns `403 {"error":"Automated access denied."}`).
`lm fetch` exists for completeness but stops immediately on a block instead of
retrying — repeated attempts risk IP blacklisting. The supported path is:

1. Open https://okara.ai/launch-library in a real browser.
2. Click "Show N more" until everything is loaded (or drive a stealth/headful
   automation session yourself).
3. Capture the JSON each click produces: DevTools → Network →
   `api/launch-library?...&offset=…` → Copy response. Concatenate the
   `launches` arrays into one file.
4. `pnpm import <file.json>`

The store is idempotent per launch slug, so re-importing overlapping exports is safe.

## Setup

```sh
cp .env.example .env          # adjust LM_DB_PATH / LM_DATABASE_URL if needed
pnpm install                  # from intelligence/ root
```

Requires Node >= 22 (uses built-in `node:sqlite`). Postgres access uses
`postgres` (postgres-js) with plain SQL — no drizzle dependency here.

## Commands

| Command | What it does |
|---|---|
| `pnpm import <file.json>` | Load an Okara export (array or `{launches:[...]}`) into the local store |
| `pnpm fetch [--pages N]` | Try live paging of okara.ai (usually bot-blocked; see above) |
| `pnpm sync [--dry-run]` | Push stored launches into intelligence Postgres |
| `pnpm digest [--limit N]` | Markdown digest of stored launches ranked by views |
| `pnpm stats` | Store count + recent sync audits |

Sync behavior:

- entity match: registrable domain first (`entities_live_website_key`), then
  exact canonical name; creates `auto_created` entities otherwise and adds
  name/domain aliases
- article dedup on canonicalized `url_hash` at both raw-item and article layer
  (re-running never duplicates)
- `platformMeta` carries views/likes/reposts/replies/saves/followers/YC flag

Quality gates: `pnpm typecheck && pnpm lint && pnpm test`.

## Layout

```
src/config.ts    LM_* env parsing (zod)
src/lib.ts       ulid/sha256/url-canonicalization/host-to-domain/text helpers
                 (behavioral mirrors of intelligence/src/lib/*)
src/store.ts     SQLite cache + sync audit log
src/mapping.ts   PURE launch -> {entity plan, article plan}
src/syncdb.ts    Postgres writer (idempotent)
src/okara.ts     paged API client (stops on block/rate-limit)
src/cli.ts       import | fetch | sync | digest | stats
test/            unit tests (mapping, store, lib)
```

## Legal

Launch metadata originates from public X posts aggregated by okara.ai. Internal
research/monitoring use only.
