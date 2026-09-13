# Copyr Intelligence — source of truth

> Living spec for **what this service is for**. Use this file when we clean the
> repo up: keep what serves these jobs, delete or shrink everything else, and
> do **not** flatten the product into "RSS in, JSON out."
>
> This is the desired product. `REQUIREMENTS.md` is the historical build spec
> (akta-parity, milestones, budget envelopes). Where they conflict, **this
> file wins**. Naming in the running system is often wrong; names below are
> the intended ones.

**Status:** draft, iterated 2026-09-12. Do not treat silence as a freeze.

---

## 1. One-sentence job

A **news-intelligence API for VCs**: continuously collect company-relevant
news, clean it, resolve it to real companies, and serve the resulting
signals — plus enough company context to act on them.

The website is a showcase and an admin console. The product is the API (and
any agent wrapper of that API).

### 1.1 Independent of Copyr

This intelligence service is **its own product**. It does not share a
codebase, database, or deploy with Copyr. We brand it similarly because
Copyr (the CRM) will call this API later. Until then, **ignore Copyr**:
do not design, name, or prioritize features for a CRM integration that
does not exist yet. Anyone with an API key is a client.

---

## 2. Two surfaces — do not collapse them

| Surface | Audience | Job | If we cut this… |
|---|---|---|---|
| **Product API** | Anyone with a key (apps, agents) | News + companies + facts + lists | The service has no point |
| **Admin / ops** | Us | Watch the machine, catch mistakes, operate the harness | We fly blind and the product rots |

Admin is **not** the product. It is allowed to be private, ugly, and renamed.
It is **not** allowed to disappear.

### 2.1 Non-goals that still hold

These were explicit in `REQUIREMENTS.md` and we are **keeping** them, so
cleanup does not accidentally grow a second product:

- **Not a people / founder graph.** A leadership *fact* may name a person
  and a role. We do not sell professional profiles (that is someone else's
  product).
- **Not a purchased company database.** No Crunchbase / Cap IQ / similar.
  Funding and status on the card come from **our facts** (and open
  filings/sites we fetch ourselves).
- **Not a full-text news wire.** We do not sell the publisher's article.
  Headline + source link is enough for the API. A short preview blurb is
  optional, not a reason to keep a copy of the body.
- **Not a 20M-company directory as the product.** We have a company KB
  because news, search, and ListGen need it. Depth is "useful card for
  companies we actually touch," not akta-shaped bulk data.

---

## 3. Product API (the point of the service)

Auth via API key. JSON. Publisher name + link on every news object.

A client can find a company by our id, a slug, a website, or a URL. If the
company later renames, **our id stays the same**.

### 3.1 Must exist

| Capability | What a VC / client actually gets | Today (do not delete the job) |
|---|---|---|
| **News by company** | Resolved, enriched articles for one company. `unique_article` = one row per story cluster. | `GET /v1/news/?company=` |
| **All-news feed** | Recent kept news across the index (not just one company) | `GET /v1/news/latest` — name collides with the UI tab |
| **Incremental feed** | Cursor / `since` sync so a client can poll for new items | `GET /v1/feed` |
| **Company card** | The company record + useful context (stage, tags, recent activity, profile) | `GET /v1/companies/:id` (+ `/enrichment`) |
| **Company search** | Find companies by name / sector / geo | `GET /v1/companies/search` |
| **ListGen** | Natural language → ranked company list. Always echo back what it thought you meant (`interpreted_filters`) so a bad parse can be corrected. | `POST /v1/list/generate/companies/` |
| **Structured facts** | Typed objects with the important fields. News of those types **points at** one. Also listable on its own (raises this month, not a pile of headlines). | DB `facts`; listed today as `GET /v1/events/` |

News queries should still support **date range**, **news type**, and
"one row per story" (`unique_article`). Easy to forget in a rewrite; still
part of the product.

**Required on every published news record:**

1. **Company references (most important)** — at least one company; primary +
   any material counterparties. News with no company is not published product.
2. **Dedup / related sources** — cluster the same story; expose related links
   to the underlying articles (often just one).
3. **News type** where it applies — funding raise, M&A, leadership, launch,
   legal, etc. Skip rather than invent. When the type **is** a material
   event, the news record must **reference a fact row** (§3.1.1).
4. **Where it came from** — url, publisher, published time. A VC has to
   be able to click through. Rows with no source link do not ship. A
   preview blurb is optional.

**Keep as cheap fields (not a product story):** short summary, industry/geo
tags, newsworthiness, sentiment (often wrong), a flag if this is the first
time *we* have seen this company.

### 3.1.1 Structured facts (decided)

The `facts` table is this. `/v1/events/` is the HTTP list of the same rows.
Keep **both** directions: news → fact, and "list facts of type X."

A **tag on the news** ("this is a funding story") is not enough. If the news
is a funding round, acquisition, leadership change, closure, or similar,
there must be a **separate row** that holds the fields a VC actually wants
from that type — amount, stage, lead investors, acquirer/target, person/role,
event date, whichever apply — and the news record **points at that row**.

| Rule | Why |
|---|---|
| Own table, not JSON jammed into the article | Same real-world event is covered by multiple articles; one fact, many news records |
| News → fact (when typed) | A client reading a raise should get the structured payload without a second guess |
| Facts are listable | "Series A this month" is a fact query, not a news-scan |
| Same event, one fact | Dedup on company + type + distinguishing fields. Extra coverage **attaches** |
| Accepted facts update the company | Card funding/status/stage come from facts |
| Not every news item gets one | Only mint a fact when the type has extractable important fields. Skip rather than invent |

News records now carry `fact_id` plus a small `fact` object (`articles.fact_id`,
backfilled from `facts.evidence_article_ids`). Extra coverage still attaches
on the fact side. `proposed` vs `accepted` and exact payload shape are
implementation.

### 3.1.2 Same company, one card (don't mix up two "Acmes")

Lots of companies share a short name. "Acme" in a headline might be Acme
Robotics in SF or Acme Dental in Ohio. Attaching a story to the **wrong**
one is bad — but **missing a real company entirely is worse**, especially
early in the funnel. Cleanup should not "solve" that by dropping anything
we're unsure about.

In practice that means:

- **Website is how we tell two mentions apart.** `acme.ai` vs `acme-dental.com`
  are different companies even if both headlines say "Acme."
- **Other names for the same company belong on one card** ("Acme AI",
  "Acme Robotics, Inc.", old name after a rebrand). That list of other
  names is all this file means by *aliases*.
- **Duplicate cards get combined.** If we accidentally created two rows
  for the same company, admin can merge them into one. The surviving row
  keeps the id.
- **Create a company when we don't have one yet**, using the name as
  trade press would print it — not a headline fragment, a person's name,
  a city, or lawsuit boilerplate. Fill in the card when we create it.
- **Private vs public is a field we keep.** Cleanup of the DB depends on
  it. Publics can show up as counterparties; they should not fill search /
  ListGen / "companies we track."
- **Our id does not change** if they rename.

**Recall vs noise:** at the **start** of the funnel (ingest → waiting
room), take the risk. Extra junk candidates are OK; a missed company is
not. The harness later discards what isn't real. Do not tighten
identification so hard that real startups never enter the room.

### 3.1.3 What "relevant to VCs" means

We care about **private companies with a real company event** (raise,
launch, hire, M&A, etc.).

- **Public companies are mostly irrelevant.** The DB is already full of
  them; cleanup includes cleaning that up, not just code. A public
  company can appear as context (acquirer, customer) without being a
  company we "track."
- **Track every funding series, not only up to C.** Seed, A, B, C, D,
  growth, etc. all belong when the company is still a VC-relevant
  private. Capping at Series C was a REQUIREMENTS leftover — drop it.
- **Goldilocks is still real, as the sweet spot, not a hard filter:**
  proved traction **and** still an early-ish funding stage. That is
  what we want the feed to *feel like*. It is not a reason to refuse a
  Series D private or a quiet seed if the event is real.
- Sports, stock-touting, product ads, and "the economy" with no company
  in it are still discards — that's later in the funnel, not a reason to
  skip identifying a company in the first place.

### 3.2 Product-adjacent (keep the job, implementation is fair game)

- **On-create enrichment** — a newly minted company must not ship as an
  empty nameplate. Fill the card from the article + site + open evidence we
  already have.
- **On-update via facts** — later articles that change funding / status /
  operating state update the company through the fact they reference, not
  by only appending a headline.
- **Company card depth** — a useful card is required; **16-section
  akta-parity is not**. Empty cards are a defect. Extra sections that do
  not help a VC act can shrink or drop.
- **Public MCP** wrapping the same core calls (news, search, ListGen,
  company card, facts) so agents consume the product without scraping REST.
- **OpenAPI**, hashed API keys, rate limits, takedown (`DELETE` by URL),
  optional webhooks for "new article on a watched company."

### 3.3 Not the product (do not promote these to "why we exist")

Corpus stats, funnel diagrams, source-health dashboards, waiting-room
counts, harness traces, akta benchmark scorecards, rubric probes. Those
belong in §5–6.

---

## 4. The machine behind the API

Cleanup may rewrite stages, queues, and file layout. It must **not** erase
this loop:

```
sources  →  ingest + ETL  →  waiting room  →  editorial harness  →  published index
                                      │
                                      ├── discard (not VC-relevant, junk, dupes)
                                      ├── create / update companies  (+ enrich)
                                      ├── mint / attach structured facts (when the type warrants it)
                                      └── publish news records  (companies + related links + types + fact ref)
```

### 4.1 Source aggregator

A registry of sources, not hard-coded scrapers in random folders.

- **RSS/Atom is the backbone** (and must stay addable without a code change).
  The **list of feeds** is part of the product, not just the registry code.
  Turning a bad source off without a deploy must stay possible.
- **Other collectors are in-scope** as modules behind the same funnel: page
  monitors, launch surfaces, filings, search/watchlist sweeps, etc.
  Individual modules can be deleted if they don't earn their keep; the
  *idea* of multiple source types must survive.
- Every accepted item is attributable to a source. Failures are isolated
  per source (one dead feed does not stall the rest).
- Ingest-time dedup (same GUID/URL) is ETL, not editorial.
- Conditional fetch / backoff so polling is cheap. Exact cadences are ops.

### 4.2 Cleaning / ETL (deterministic)

Standard hygiene before a human or LLM spends judgment:

- Fetch + extract title/body/published time/outbound links, **politely**
  (robots.txt, identifiable UA, per-domain rate limit)
- Cheap filter for obvious non-news (tag pages, empty stubs) — **do not**
  drop possible companies here just to keep the room tidy
- Normalize dates, publishers, URLs
- Record **why** something was dropped (stage + reason) — silent death is a bug
- Park fetch failures instead of pretending they were editorial discards
- Restarts must not ingest the same URL twice

Volume that never reaches the waiting room is something we need to **see**
(exoskeleton). Missing companies here is the expensive failure. Extra
noise in the room is cheaper than a false negative.

### 4.3 Waiting room

The holding pen **after** cheap ETL and **before** anything is product.

- Items sit here until the editorial harness (or an equivalent operator)
  keeps, drops, or parks them.
- Incomplete cards / "we still don't know which company" **do not publish**.
  They stay in the room or get parked with a reason. Half-filled rows must
  never appear on the public news API.
- The room is allowed to be noisy and to pile up. That is an ops problem.
  Tightening identification to shrink the room is the wrong fix (§3.1.2).

### 4.4 Editorial harness (LLM in the loop)

This is the quality gate. Today it is Cursor (or any agent) claiming work
from an internal LLM queue (`LLM_PROVIDER=harness` / auto). The transport
can be HTTP, MCP, or both — **the actions matter more than the socket**.

The harness must be able to:

| Action | Why it is load-bearing |
|---|---|
| **Discard** | Irrelevant to VCs (§3.1.3), not a company event, sports/macro/promo/commentary, irreparable junk |
| **Create company** | Unknown subject → mint a real company (trade-press name). Enrich on create. |
| **Update company** | Via the fact: funding, status, stage, or other card-material fields |
| **Mint / attach fact** | If the news is a material typed event, extract the important fields into `facts` (or attach to the existing same-event row) and point the news at it |
| **Publish news record** | Attach 1+ companies, related source links (dedup), categorize when applicable, **fact ref when typed**, source url/publisher/date filled |
| **Correct** | Fix bad company names, bad types, bad primary vs secondary, bad/missing fact payloads before publish |

Anti-goals for the harness:

- It is not a background script that "claims until the number goes down."
- Waiting-room count is not success. Correct publishes and real company
  names are success. Shrinking the room by skipping unsure companies is
  failure.
- Do not invent a company name by chopping the headline.

A dedicated **admin/editorial MCP** (waiting-room tools: list, discard,
publish, mint/update company, mint/attach fact) is a reasonable cleanup
shape. The existing **public MCP** is a client of §3, not a substitute for
this harness.

### 4.5 Constraints the machine must keep

- **No paid datasets** (§2.1).
- **Takedown** removes a URL from what we serve and keeps an audit log.
- **Taxonomy / prompts / thresholds in config**, not hardcoded, so we can
  retune without a rewrite. We do **not** owe anyone an 80-type taxonomy;
  we owe types that are useful when present.
- **Cost and volume visible** to admin (ledger of LLM calls, funnel
  counts). Hard dollar caps from `REQUIREMENTS.md` are historical; do not
  delete *visibility*. Whether a $250/mo cap still binds is §9.

### 4.6 How it actually runs

Only the jobs. The current files/scripts are fair game.

- **Read the article when we extract** (facts, summary, keep/drop). That
  can be a live fetch. **Keeping a stored copy of the body is not
  required.** Same for an API excerpt — nice if cheap, not a product
  pillar.
- **Waiting-room items and unpublished rows live in the database**, so a
  reboot does not empty the room. How we schedule polls (a job table,
  cron, whatever) is implementation.
- **Harness claim loop** (you or an agent answering waiting-room work)
  stays until replaced. A fake LLM for tests and a hosted key are
  conveniences, not the product.
- **How we operate today** lives in the Cursor skills
  (`drain-waiting-room`, `enrich-new-companies`, `scrub-kept-quality`).
  Rewrite them; keep the jobs: drain the room, fill new cards, clean junk
  names that already published.
- **Production data should be recoverable** via whatever hosts Postgres
  (e.g. Supabase backups). A homemade `pg_dump` script is leftover, not a
  feature.

---

## 5. Frontend

Keep the current visual language (paper, serif mark, grain hero, restrained
type). Cleanup the information architecture; do not "simplify" by shipping a
generic dashboard theme.

| Page | Intent | Notes for cleanup |
|---|---|---|
| **Landing** | Marketing / explanation of the API | **Keep. Loved.** `#signals` / `#pipeline` are sections, not pages — stop putting them in the top nav as if they were. |
| **Playground** | Try the **product** API in-browser | Keep. Cover §3.1 (including all-news, company card, facts), not admin funnel endpoints. |
| **Updates** (admin) | What actually made it into the index — the published stream, with enough context to spot bad names / bad types / empty cards / missing facts | **Keep.** Today jammed into `/latest` with analytics. Make the job obvious. Rename. |
| **Analytics** (admin) | Corpus health for us: volume, coverage, sources, mix, growth | **Keep.** This is the poorly named **"Latest"** tab today. Not a VC-facing product page. |
| **Exoskeleton** (admin) | Pipeline visibility + harness outcomes | Keep the job, **cut the cram**. See §5.1. |
| **Docs** | OpenAPI | Fine as a link; does not need to pretend to be a page. |

Top-level nav after cleanup should be real destinations, e.g. Landing,
Playground, then clearly-marked admin (Updates, Analytics, Exoskeleton) —
not hash fragments mixed in with product pages.

**Decided:** `/latest` today is a mash-up of Updates + Analytics. **Both jobs
stay.** Splitting into two routes vs. one admin page with two clear sections
is an implementation choice for cleanup, not a product question.

### 5.1 Exoskeleton — minimum viable (the rest is optional)

The live-pipeline page tried to be a full plant schematic, journey animator,
misflag log, ghosting tool, and harness trigger. It is buggy and overloaded.

At minimum it must answer:

1. **How much is piling up in the waiting room?**
2. **How much is *not* making it to the waiting room?** (dropped in fetch,
   prefilter, ingest dedup, source failure — with reasons, not a single
   mystery counter)
3. **How is the harness resolving the room?** Creates, updates, publishes,
   discards, facts minted/attached — counts and a way to inspect examples.
4. **Is it making mistakes?** Spot-check: garbage company names, story
   attached to the wrong company, a real company that never made the room,
   published-but-should-have-dropped, dropped-but-was-a-real round, typed
   news with no fact. A durable "I disagree" trail is useful; a physics
   simulation of packets is not.

If a widget does not serve one of those four questions, it is a candidate
to delete during cleanup.

---

## 6. Admin / private API (not the point, still required)

Private or keyed-admin endpoints that exist so *we* can operate the service.
Clients should not need them. Cleanup may regroup and rename; do not delete
the jobs.

- Source registry CRUD / import
- Company create / patch / other-names / combine-duplicates
- API key minting
- Dashboard / funnel / cost / volume (`/v1/admin/dashboard`, news stats,
  overview, sources, company mix/growth)
- Exoskeleton snapshot / stream / stage inspect / harness run
- Internal LLM claim/result/stats (harness protocol)
- Discard audit / parked failures

---

## 7. Naming debt (fix in cleanup, do not lose the referent)

| Current | Intended |
|---|---|
| DB / code `entities` | **Companies** |
| UI tab `/latest` | **Updates + Analytics** (both jobs; rename; split optional — §5) |
| `GET /v1/news/latest` | **All-news feed** (keep the capability; rename if it collides with the UI) |
| DB `facts` / `GET /v1/events/` | **Structured facts** — same object; news of material types must point at a row; also listable (§3.1.1) |
| "Publish an article" | Publish a **news record** (company refs + related links + types + fact ref), not the publisher's prose |
| Exoskeleton | Pipeline / waiting-room console (name is optional; job is not) |

---

## 8. Cleanup guardrails

When we later delete code, every removal should fail at least one of these
tests or it is probably a mistake:

1. Does a VC client still get news-by-company, all-news, incremental feed,
   company card, search, ListGen, and structured facts (on the news record
   **and** listable)?
2. Can we still ingest from a source registry (RSS + other modules)?
3. Does every item still pass ETL → waiting room → explicit keep/drop
   before it can appear on the product API?
4. Can an LLM harness still create/update companies (without missing real
   ones early, without attaching the wrong Acme when we *do* publish) and
   publish news records with company refs, related links, types, source
   links, and a fact pointer when the type is a material event?
5. Can an admin still see waiting-room depth, pre-room loss, harness
   outcomes, and enough examples to catch mistakes — including combining
   duplicate company cards?
6. Does the landing page still look like *this* product?
7. Can we still turn a source off, keep the waiting room across a reboot,
   and drain / enrich / scrub (even if the current scripts change)?

**Fair game to shrink or drop** if they do not earn their keep: akta
benchmark theater, 16-section profile parity for its own sake, unused
source modules (GDELT, Form D, launch monitors — *as implementations*, not
the aggregator idea), hash-link nav items, the animated exoskeleton vis,
duplicate docs (`REQUIREMENTS.md` addenda, one-off playbooks), a giant
Wikidata dump if mint-from-news + a smaller seed is enough, sentiment as a
*product story* (keep the field).

**Not fair game:** treating the waiting room as optional; auto-publishing
without a company; empty company cards; dropping the `facts` table or
leaving typed news as a tag with no structured row; deleting admin
visibility because "the API is the product"; missing real companies at
the start of the funnel in the name of cleanliness; attaching a story to
the wrong company on purpose. Database cleanup of public companies we
should not be tracking is **in scope** for the later cleanup, not "leave
the DB alone."

---

## 9. Open questions (do not invent answers in cleanup)

Already decided (do not re-litigate): `/latest` = Updates + Analytics, both
stay; company card = useful, not 16-section parity; `REQUIREMENTS.md` is
historical and loses to this file; **structured facts stay**; one real
company = one card (website + other names + merge); **missed companies
early in the funnel are worse than extra waiting-room noise**; relevance
= private companies, all funding series, goldilocks is the sweet spot not
a Series C cap; public companies are mostly out (including DB cleanup);
§2.1 non-goals stay.

Still open:

- **Budget.** Keep visibility. Is the old dollar cap still a constraint?

Decided in cleanup:

- Keep `GET /v1/news/latest` as the all-news path (UI `/latest` already redirects to Updates).
- Other collectors (GDELT, Form D, launches) exist behind the same funnel, **off by default**; RSS is enough for v1.
- Editorial harness: keep the HTTP claim loop; MCP can list the room and fire a run.
- Company list: mint-from-news + small seeds. Do not re-run giant public dumps. Website-duplicate finder + admin merge.
- Webhooks: **commit** (HMAC delivery stays; secret returned on create).

---

## 10. From `REQUIREMENTS.md` — what we did with it

| Historical item | Verdict |
|---|---|
| This API is its own product; Copyr is a possible future client, ignore for now | **Keep** — §1.1 |
| News, company card, search, ListGen, feed | **Keep** — §3.1 |
| Signal-derived facts updating the company | **Keep, strengthened** — news must point at the fact |
| One company, one card; website + other names; merge dupes | **Keep** — §3.1.2. Early funnel: miss fewer companies, accept noise |
| Excerpt + source link; no full-text product | **Keep the rule we don't republish articles.** Excerpt is optional. Stored body is optional. — §2.1 / §4.6 |
| No people directory; no paid datasets | **Keep** — §2.1 |
| Waiting-room editorial gate | **Keep** — §4.3–4.4 |
| Private companies, goldilocks sweet spot | **Keep, corrected** — all series, not a Series C cap; publics out — §3.1.3 |
| Useful company card / enrichment on mint | **Keep**; 16-section parity **drop as a goal** |
| Source registry, polite fetch, discard reasons | **Keep** — §4 |
| Public MCP, OpenAPI, optional webhooks | **Keep jobs** — §3.2 |
| ~80 event types, akta response-shape mirror | **Drop as a goal.** Types when useful; our shapes |
| Akta benchmark harness as the success bar | **Drop as a goal.** Admin may still run evals |
| GDELT as required recall backbone | **Module, not sacred.** Aggregator idea stays |
| 300K entity imports as an exit criterion | **Open** — §9 |
| $40 VPS / $250 LLM cap as identity | **Visibility stays; cap is §9** |
| Milestones M0–M4, FR numbering | Historical. Do not block cleanup |

---

## 11. How to use this file

1. Read §3 and §4 before deleting a pipeline stage.
2. Read §5 before deleting a route or nav item.
3. If a feature is not mentioned here, it is **guilty until proven** —
   either add it to this file (with a job) or it can go.
4. When we decide something in chat, patch this file in the same change.
