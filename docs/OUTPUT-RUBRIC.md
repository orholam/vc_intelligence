# Output Rubric — Monthly Intelligence Corpus Quality

**What this is:** the acceptance bar for *what the database contains* after one month
of pipeline runs — not how it got there. Sources, fetchers, prompts, and models are
means; this document judges the ends. Every metric below is computed over a fixed
trailing window (**W = the past 31 days**) and is either directly measurable in SQL,
measurable via the existing FR-23 benchmark harness, or measurable via a small
hand-sampled judgment session defined in §8.

**Who the customer is and what they buy:** a VC analyst pays for four things, in order:

1. **Time advantage** — they hear about a company *before* the funding announcement,
   not after TechCrunch tells everyone. This is the single hardest property and the
   core of the "goldilocks zone" (§4).
2. **Trust** — every item is a real company, correctly identified, doing something
   real. One wrong company in ten destroys the habit of opening the feed.
3. **Density** — enough structured context per company (stage, sector, geography,
   momentum, money) to triage *without opening a browser tab*.
4. **Coverage where their thesis lives** — the sectors/stages/geos they care about,
   not a uniform scrape of the internet.

The rubric scores those four things plus the structural integrity underneath them.

---

## 0. Scoring model

| Section | Dimension | Weight |
|---|---|---|
| §2 | A. Coverage & Recall | 20 |
| §3 | B. Precision & Noise Floor | 20 |
| §4 | C. Goldilocks Zone (stage mix + lead time) | 25 |
| §5 | D. Entity Layer Integrity & Density | 15 |
| §6 | E. Enrichment Depth & Consistency | 10 |
| §7 | F. Timeliness & Freshness | 5 |
| §9 | G. Consumer Surface (what the VC actually receives) | 5 |
| | **Total** | **100** |

Before any points are awarded, the §1 gates must pass. Gates are binary; a failed
gate caps the whole score at 49 regardless of points earned ("demo-quality").
The §12 pipeline invariants (R01–R14) are an extension of the gates: they are the
code-level guarantees that make this month's output reproducible next month, and
any failed invariant triggers the same cap.

**Bands**

- **85–100 — VC-ready.** An analyst would keep a browser tab open on the feed.
- **70–84 — Promising.** Usable with manual verification; fix the named weak dims.
- **50–69 — Analyst trust broken.** The feed gets skimmed weekly, not relied on.
- **<50 — Demo.** Nobody would integrate this into a workflow.

Every scored metric has: definition → measurement → target with point allocation →
failure signature (what its absence looks like in the DB).

---

## 1. Gates (hard fails — cap score at 49)

Cheap to verify, non-negotiable, because they destroy trust silently.

- **G1 — Identity uniqueness.** Zero live (`merged_into IS NULL`) entity pairs share
  a registrable domain; zero live entity pairs share the same normalized canonical
  name AND country. Duplicate "Acme AI" cards are the #1 way to look amateur.
- **G2 — Provenance completeness.** 100% of articles returned by `/v1/news/` and
  `/v1/feed` have non-null `url`, `publisher_domain`, `published_at`,
  `excerpt_text`. Any consumer-facing claim must trace to a clickable source.
- **G3 — Benchmark artifact exists.** `benchmarks/YYYY-MM.md` produced for the
  window with overall precision, recall, F1, $/1K-correct (FR-23). No self-grading
  month is allowed to skip the exam.
- **G4 — Ledger continuity.** `llm_calls` has rows on every day the pipeline ran;
  no silent mid-month degradation. Soft-cap degrade-to-mini events must be recorded
  and disclosed in the dashboard, not hidden.
- **G5 — Discard auditability.** `v_discard_audit` explains ≥99% of discards with a
  stage + reason. "Vanished between fetch and serve" is a bug class, not a filter.
- **G6 — External text policy.** Spot-check API responses: full text never leaves
  the building; `excerpt_text ≤ 400 chars`; takedown endpoint removes served traces.

---

## 2. Dimension A — Coverage & Recall (20 pts)

*"Did we see the things that mattered?"*

### A1 — Benchmark recall vs. the akta methodology list (5)

- **Measure:** FR-23 harness, recall over validated stories for the window.
- **Target:** ≥0.55 = 5 · ≥0.45 = 3 · ≥0.35 = 1 · else 0.
- **Why this bar:** akta publishes its own precision methodology; matching their
  recall on their own 133-company list while paying less per correct story is the
  entire competitive thesis. Below 0.35 you are not a competitor, you are a sampler.

### A2 — Gold-event recall (5)

- **Setup (~1h/month):** maintain `config/gold-events.json` — ~50 known
  venture-relevant events in the window (rounds, launches, key hires at zone
  companies), collected *after* the month closes from public announcements.
- **Measure:** % of gold events with ≥1 matched article in W (entity match via
  domain or alias; event match via tag/category or fact).
- **Target:** ≥0.70 = 5 · ≥0.55 = 3 · ≥0.40 = 1 · else 0.
- **Failure signature:** misses cluster by sector or geography → your source mix is
  blind there (the "wildly out of shape" complaint, quantified).

### A3 — Publisher independence on material stories (3)

- **Measure:** for stories classified `newsworthiness='high'` that became accepted
  facts, median count of distinct `publisher_domain`s across the cluster.
- **Target:** median ≥3 = 3 · ≥2 = 2 · else 0–1.
- **Why:** single-publisher "events" are press releases, not corroboration. The
  facts pipeline already encodes this instinct (`distinctPublishers`); hold the
  story layer to the same standard.

### A4 — Discovery yield (4)

- **Measure:** new venture-grade entities created in W per day (see §C0 for
  venture-grade). Count only entities that ended W with ≥2 articles or ≥1 accepted
  fact — discoveries that stuck, not autocreate spam.
- **Target band:** 10–80/day sustained = 4; 3–10 = 2; <3 = 0 (starving);
  >150/day = 0 (spraying).
- **Failure signature:** yield spikes the day a big round is announced and flatlines
  otherwise → you're echoing, not discovering.

### A5 — Shape fidelity to thesis (3)

- **Measure:** distribution of kept-article volume across `industry_primary` and
  `countries`, compared against declared thesis weights (put them in
  `config/thesis.json`; default: even spread with documented exceptions).
- **Target:** no unintended sector >40% of kept volume; ≥5 sectors with meaningful
  volume (>3% each); non-US share matches intent (if global, ≥25%).
- **Failure signature:** "everything is US dev-tools" — the classic seed-list bias.

---

## 3. Dimension B — Precision & Noise Floor (20 pts)

*"Can the analyst trust every line?"*

Use the FR-23 definitions verbatim: **news precision** (is the item real news about
its claimed subject), **company-entity precision** (is the right company attached),
**overall = product of the two**, judged by a neutral model family with
cross-provider corroboration.

### B1 — News precision (5)
≥0.80 = 5 · ≥0.72 = 3 · ≥0.60 = 1 · else 0

### B2 — Company-entity precision (5)
≥0.85 = 5 · ≥0.78 = 3 · ≥0.65 = 1 · else 0

### B3 — Overall precision (3)
≥0.65 = 3 · ≥0.55 = 2 · ≥0.45 = 1 · else 0

### B4 — Kept-rate sanity band (3)

- **Measure:** `kept / fetched-extracted` over W, plus discard-reason distribution.
- **Target:** kept-rate in **15–45%** = 3; 8–15% or 45–60% = 1; outside = 0.
- **Rationale:** below ~15% you're either paying LLM tax on garbage or filtering so
  hard that recall dies quietly (cross-check A2 before celebrating); above ~60%
  your sources are undifferentiated firehoses and the analyst sees noise.
- **Discard-reason shape:** no single heuristic reason >50% of discards;
  LLM-filter discard reasons read coherently when spot-sampled (§8).

### B5 — Per-source precision floor (2)

- **Measure:** stratified sample (§8) of kept articles grouped by contributing
  source.
- **Target:** every source whose kept volume is ≥30 items/W has sampled precision
  ≥0.6. Violators throttled/demoted in the registry *this month*, not eventually.
  Full compliance = 2; violators existed but were actioned = 1.

### B6 — Duplicate leakage (2)

- **Measure:** near-duplicate pairs (same entity, ≥0.92 embedding cosine, different
  URLs) present as separate served feed items.
- **Target:** <2% of served items = 2; <5% = 1; else 0.
- **Failure signature:** the analyst sees the same funding story three times from
  syndication networks → feed feels recycled.

---

## 4. Dimension C — Goldilocks Zone (25 pts) — the differentiator

*"Are we catching companies after they're serious but before the swarm?"*

### C0 — Operational definitions (read before arguing with the numbers)

Classify every entity active in W into a **venture band** using only DB evidence:

| Band | Name | Criteria (checked in order; first match wins) |
|---|---|---|
| **E3** | Swarm | ≥3 accepted `funding_round` facts lifetime; OR latest accepted round ≥$50M; OR a single story cluster in W with ≥12 distinct publishers; OR `funding_stage ∈ {series_c…}` |
| **E0** | Basement | No resolvable `website`; AND no registry id; AND single-source coverage only; AND no institutional-investor mention in any attached article text |
| **E2** | Validated | Accepted round with `funding_stage ∈ {seed, series_a, series_b}`; OR `totalRaisedUsd ≥ $1M`; OR named institutional investor in accepted-fact evidence |
| **E1** | Emerging | Real operating company (website resolves AND (≥2 independent articles in W OR ≥1 tier-1/2 article)) with traction signals — product launch, hiring surge, notable customer/partnership, angel round — but ≤2 rounds ever |

**Goldilocks = E1 ∪ E2.** E0 is pre-venture noise; E3 is where every VC's inbox
already lives.

### C1 — Stage computability (3)

- **Measure:** % of E1/E2 entities where `funding_stage`, `totalRaisedUsd`, or an
  explicit bootstrap/traction marker is derivable from facts + article evidence.
- **Target:** ≥50% = 3 · ≥35% = 2 · ≥20% = 1 · else 0.
- **Failure signature:** great companies in the DB but the VC can't tell seed stage
  from Series C without leaving the app → density promise broken.

### C2 — Band distribution of new entities (6)

- **Measure:** over entities created in W that survived to ≥2 articles or ≥1
  accepted fact (the "stuck" set from A4).
- **Target:** E1+E2 ≥55% = 3 pts · E0 ≤20% = 1.5 pts · E3 ≤15% = 1.5 pts
  (half credit one band worse).
- **This is the headline number of the whole rubric.** If you print one metric on
  the wall, print this triple.

### C3 — Lead time (6) — the time-advantage metric

- **Definition:** for every entity with an accepted `funding_round` fact whose
  `event_date` falls in W or within 30 days after W ends:
  `lead_days = event_date − min(published_at of any article linked to the entity)`.
- **Measure:** median and P25 over the cohort (cohort ≥15 required for a stable
  grade; smaller cohorts grade at half weight).
- **Target:** median ≥21 days = 6 · ≥10 days = 4 · ≥3 days = 2 · else 0;
  P25 ≥7 days adds nothing here but is reported alongside.
- **Interpretation guide:**
  - negative/zero median → echo chamber; the swarm beat you;
  - 3–10 days → catching the wave as it breaks — useful only to fast movers;
  - 21+ days → surfacing companies on hiring/launch/customer signals *before* the
    round — that is the product VCs pay for.
- **Honesty requirement:** report cohort size and exclusion rules next to the
  number, every time.

### C4 — Swarm contamination of discovery surfaces (3)

- **Measure:** on ListGen outputs and `/v1/feed` first-appearance items, % of
  entities classified E3.
- **Target:** ≤10% = 3 · ≤20% = 1 · else 0.
- **Failure signature:** `generate_company_list('pre-seed fintech')` returns Ramp
  and Stripe because they were in the news this week.

### C5 — Basement contamination (3)

- **Measure:** % of newly created entities still E0 at window close.
- **Target:** ≤20% = 3 · ≤35% = 1 · else 0. Cross-check against the autocreate
  confidence threshold: if raising it 0.05 cuts E0 share by a third without denting
  A4 yield, the threshold was wrong.

### C6 — Momentum coherence (4)

- **Definition:** a momentum entity has ≥2 *distinct* event categories attached in
  W (e.g., product_launch + hiring_signal, partnership + funding_rumor) from ≥2
  independent publishers.
- **Measure:** % of E1/E2 entities qualifying as momentum entities; plus sampled
  precision of whatever internal "heating" flag is exposed.
- **Target:** ≥30% = 4 · ≥18% = 2 · else 0.
- **Why:** single-article entities are flukes; convergent multi-signal evidence is
  what separates "serious venture" from "someone's basement project" *before*
  money confirms it. This metric IS the qualification the feed's user doesn't
  have time to do themselves.


---

## 5. Dimension D — Entity Layer Integrity & Density (15 pts)

*"Is one company always one card, and does the card say anything?"*

### D1 — Merge correctness (4)

- **Measure:** gold pair set (~100 positive pairs, ~100 hard-negative confusables:
  "Acme AI" vs "Acme Labs", subsidiary vs parent, same-name different-country).
- **Target:** merge precision ≥0.95 AND recall ≥0.85 = 4; −1 per axis below.
- **Probe:** `merged_into` graph must be acyclic; no domain re-registered to a
  second live entity post-merge (G1 covers the static case).

### D2 — Orphan share (3)

- **Measure:** % of kept articles whose primary entity has
  `review_status='auto_created'` AND `confidence < 0.6`.
- **Target:** ≤15% = 3 · ≤25% = 1 · else 0.
- **Failure signature:** thousands of one-article ghost entities dilute search and
  ListGen; every ghost is a future false merge waiting to happen.

### D3 — Field density composite (4)

Fill rates over entities active in W (≥1 kept article):

| Field | Target | Weight |
|---|---|---|
| `website` (registrable domain) | ≥95% | 1.25 |
| `country` (+`hq_city` for top geos) | ≥80% | 1 |
| ≥1 `industry_tags` | ≥75% | 0.75 |
| `founded_year` OR `registry_ids` | ≥50% | 0.5 |
| `funding_stage` non-null — real value or explicit `unknown` / `bootstrapped` marker; **null is a defect** | ≥90% (stretch: 100%) | 0.5 |

Pro-rated linearly. **A card with a name and nothing else is a search result,
not intelligence.** Stage policy: null is not a state. Every entity carries
either an evidenced stage (`pre_seed`, `seed`, `series_a`, …), `bootstrapped`
where traction-without-capital is evidenced, or literal `unknown` with the backfill
flag set — so stage filters in ListGen are always deterministic and "how many
seed-stage companies did we see" never silently drops 99% of the DB (the current
state: exactly one entity has this field set).

### D4 — Confidence calibration (2)

- **Measure:** bucket `confidence` into deciles; compare against empirical accuracy
  on the §8 entity sample; report expected calibration error (ECE).
- **Target:** ECE ≤0.15 = 2 · ≤0.25 = 1 · else 0.
- **Why:** downstream consumers (agents!) gate actions on this number; an
  uncalibrated 0.8 is a lie with decimals.

### D5 — Registry cross-linking (2)

- **Measure:** among E1/E2 entities plausibly in scope (US-incorporated or
  UK-registered), % carrying `registry_ids.sec_cik` or `companies_house` where such
  a filing exists (verified on the §8 sample, not exhaustively).
- **Target:** ≥60% = 2 · ≥40% = 1 · else 0.
- **Why:** registry ids are the strongest disambiguator for left-edge entities —
  exactly the goldilocks population that lacks press volume.

---

## 6. Dimension E — Enrichment Depth & Consistency (10 pts)

*"Does every served item carry honest, valid structure?"*

### E1 — Taxonomy validity (2)
100% of `primary_tag`, `secondary_tags`, `all_tags`, `industry_primary`,
`industry_secondary` values drawn from the 86-type config taxonomy. Any stray value
= automatic 0 for E1 — silent enum drift poisons every downstream filter.

### E2 — Fill rates (2)
On kept articles: `sentiment`, `sentiment_score`, `newsworthiness`,
`industry_primary` populated ≥98%. Linear pro-rate.

### E3 — Distribution sanity (2)

- `newsworthiness='high'` ≤25% of kept (grade inflation makes "high" meaningless);
- sentiment not >70% positive (press-release capture detector);
- ≥8 distinct `primary_tag` values with >1% share each in W — a taxonomy that has
  collapsed to `funding` + `other` is broken.

### E4 — Summary faithfulness (2)

- **Sample:** 40 `ai_summary` items (§8). Judge: (a) every factual claim supported
  by the excerpt/full text, (b) no invented numbers/names, (c) names the company
  and the event, (d) ≤400 chars.
- **Target:** ≥95% fully faithful = 2 · ≥85% = 1 · else 0.
- One hallucinated funding amount that reaches a partner memo costs more than this
  entire dimension.

### E5 — Clustering quality (2)

- **Sample:** 20 story clusters. Judge purity (all members genuinely same story),
  split rate (obvious same-story clusters left separate), representative selection
  (best-tier publisher wins ties).
- **Target:** purity ≥0.9 AND splits ≤10% = 2; one axis failing = 1.

---

## 7. Dimension F — Timeliness & Freshness (5 pts)

### F1 — Ingestion latency (2)

- **Measure:** `created_at − published_at` on kept articles, per source tier.
- **Target:** tier-1 median ≤6h AND P90 ≤24h; tier-2 median ≤24h. Both met = 2;
  one = 1.
- Note: feeds sometimes backdate `published_at`; dispute with GDELT `seendate`
  cross-checks on a sample, not vibes.

### F2 — Feed liveness (2)

- **Measure:** % of active sources with `last_fetched_at` within 2× their tier
  cadence and `failure_streak < 5`; plus raw_items backlog age P95 <48h.
- **Target:** both clean = 2; one = 1.

### F3 — No stale ghosts (1)

- **Measure:** % of entities active in W whose latest article is >180 days old yet
  still surface in default search/ListGen ordering.
- **Target:** ≤5% = 1. Recency must be a first-class sort input.

---

## 8. Judgment protocol (how the sampled numbers get made)

Small, fixed, repeatable — ~90 minutes once a month:

1. **Articles (60):** stratified by source tier × `newsworthiness`. Judge binary
   "real news about a real company," entity correctness, category correctness.
   Feeds B1/B2/B5.
2. **Entities (40):** stratified by `created_by` × confidence decile. Assign venture
   band per C0 rules, verify field-density claims, verify resolution with ~2 minutes
   of manual search each. Feeds C2/D3/D4/D5.
3. **Facts (30):** type correct; amount within ±20% or marked estimate; investors
   real and correctly attributed; date within ±14d; `rejected_reason` populated and
   coherent on rejects. Feeds C-dimension fact inputs.
4. **Summaries (40)** → E4. **Clusters (20)** → E5.
5. **ListGen (10 canned thesis queries)** kept in
   `config/rubric.listgen.queries.json`: grade precision@limit and whether
   `interpreted_filters` match intent. Feeds G2.
6. Log judgments to `rubric/YYYY-MM/judgments.csv` (fixed column contract) so scores
   stay auditable and drift-comparable month over month. Re-judge 10% twice;
   disagreements get adjudicated, not averaged away.


---

## 9. Dimension G — Consumer Surface (5 pts)

Judge what leaves the API — that is all a VC will ever see.

### G1 — Company card triage test (2)
For the 25 most-queried entities of the month: can an analyst decide
relevant / not relevant / need-more from `GET /v1/companies/:id` plus its news
list **without opening a browser**? ≥85% yes = 2 · ≥70% = 1.

### G2 — ListGen quality (2)
From the §8 canned queries: precision@limit ≥0.7 AND interpretation accuracy ≥0.8
= 2; one axis = 1.

### G3 — Push usefulness (1)
Webhook/feed payloads pass the same no-browser test ≥80% of the time (sample 20
deliveries): entity resolved, event typed, excerpt sufficient, links work.

---

## 10. Red-flag catalog (symptom → diagnosis → which metric catches it)

| Symptom (your words) | Likely root cause | Caught by |
|---|---|---|
| "Everything is thin" | Entities autocreated from single articles; no registry/backfill join | D2, D3, A4 stuck-rate |
| "Wildly out of shape" | Seed-list/source skew toward one sector or geo | A5, E3 taxonomy diversity |
| "So much noise" | Low-tier sources dominating kept volume; kept-rate too high | B4, B5, C5 |
| "Always late to rounds" | Echoing announcement coverage; no pre-round signal classes | C3 lead time, C6 |
| "Basement projects everywhere" | Autocreate threshold too loose; no seriousness bar | C5, C2 E0-share |
| "Same story 3× in the feed" | Syndication leakage past clustering | B6, E5 |
| "Can't tell stage apart" | Facts pipeline under-fired; stage never propagates to entity KB | C1, fact precision |
| "Lists return famous companies" | Recency weighting drowning stage filters | C4, F3 |
| "Scores good but feels bad" | Calibration drift; sampling not blind | D4, §8 discipline |

---

## 11. Monthly scorecard template

```
Month: YYYY-MM   Window: YYYY-MM-DD .. YYYY-MM-DD
Gates G1..G6:                        [ ] [ ] [ ] [ ] [ ] [ ]
Pipeline invariants R01..R14:        __/14 pass (§12; any fail = gate fail)
A Coverage & Recall     __/20   (A1 _ A2 _ A3 _ A4 _ A5 _)
B Precision & Noise     __/20   (B1 _ B2 _ B3 _ B4 _ B5 _ B6 _)
C Goldilocks            __/25   (C1 _ C2 _/6 C3 _/6 C4 _ C5 _ C6 _)
D Entity Layer          __/15   (D1 _ D2 _ D3 _ D4 _ D5 _)
E Enrichment            __/10   (E1 _ E2 _ E3 _ E4 _ E5 _)
F Timeliness            __/5    (F1 _ F2 _ F3 _)
G Consumer Surface      __/5    (G1 _ G2 _ G3 _)
TOTAL                   __/100  Band: ________
Headline triple (C2):  E1+E2 ____%   E0 ____%   E3 ____%
Lead time (C3):        median ____d   P25 ____d   n=____
$/1K correct (FR-23):  $____   delta vs last month: ____
Top 3 fixes this month: 1.___________ 2.___________ 3.___________
```

---

---

## 12. Pipeline & Code Requirements (invariants R01–R14)

The dimensions above judge *output*; these invariants judge the machine that
produces it. Every failure mode in §10 traces back to an engineering gap, not a
data gap: thin entities mean nothing enforced a baseline card; noise means
nothing bounded what may serve; lateness means nothing could be replayed. Each
invariant below is pass/fail and must be verifiable by a named test, script, or
SQL probe — not by vibes in code review. Any fail triggers the §1-gate cap.

### R01 — Single front door: registry-driven ingestion only

- **Requirement:** every feed, GDELT query, launch-surface watch, and seed list
  enters through the `sources` registry (tier, topics, country, cadence). No
  fetcher, worker, or script may fetch from hardcoded URLs or private lists.
  Onboarding a source is *data, not code*: one registry row via the admin API or
  OPML/CSV import path — zero deploy.
- **Rationale:** the month you let a "quick one-off scraper" live outside the
  pipeline is the month its output skips filtering, enrichment, and audit.
- **Verify:** no production `fetch(` of remote articles outside `src/ingestion`;
  every high-volume publisher domain in `raw_items` has a corresponding
  `sources` row (or is GDELT-derived behind the domain allow/block gate).

### R02 — Uniform stage contract

- **Requirement:** every item traverses the same deterministic chain —
  `fetch-feed → fetch-article → filter → resolve → enrich → cluster → facts` —
  regardless of origin (RSS tiers 1/2/3, GDELT sweep, launch surface, manual).
  No stage may be skipped by any path; per-item stage state is queryable.
- **Rationale:** special-cased paths are where enrichment silently stops
  happening. "Everything gets enriched" must be structural, not aspirational.
- **Verify:** an offline integration test (PGlite + mock LLM) drives one fixture
  per ingestion origin through all stages and asserts identical final shape;
  a `pipeline:replay --article=<id>` CLI re-drives any article from any stage.

### R03 — Idempotent everywhere

- **Requirement:** re-running anything twice changes nothing. Content-hash dedup
  at raw boundaries (`url_hash` / `guid_hash`), `payload_hash` on imports,
  `dedup_key` on facts, idempotent pg-boss job handlers.
- **Verify:** CI double-run test over fixtures asserts zero row-count deltas
  across `raw_items`, `articles`, `facts`, `entity_imports`.

### R04 — Nothing dies silently

- **Requirement:** every raw item terminates in exactly one auditable state:
  served article, discard with stage + reason (`v_discard_audit`), or parked
  failure with `fetch_error`. Retries are bounded exponential backoff ending in
  a parked state — never an infinite loop, never a vanishing act. Parked /
  dead-letter counts appear on the admin dashboard daily.
- **Verify:** monthly reconciliation probe accounts for ≥99.9% of items:
  raw_items = kept_articles + audited_discards + parked_failures.

### R05 — Enrichment completeness invariant (enforced, not hoped for)

- **Requirement:** an article may become servable only when every tier-mandated
  field is populated: `primary_tag`, `secondary_tags`, `sentiment`,
  `sentiment_score`, `newsworthiness`, `industry_primary`, `countries`, plus
  `ai_summary` where tier policy requires it. A post-enrich validator flips
  incomplete rows into a quarantined state excluded from all serving queries;
  quarantine drains via retry — it is never served half-enriched.
- **Rationale:** "enriched-or-quarantined, never half." One null
  `industry_primary` leaking into ListGen is how filters return garbage while
  tests stay green.
- **Verify:** nightly zero-row assertion that kept+enriched articles have no
  null mandated fields; contract test fails CI if a stage change lets partial
  rows serve.

### R06 — Minimum viable company card (no company left without basics)

- **Requirement:** an entity becomes servable/searchable/listable only after a
  backfill pass guarantees its baseline card: registrable-domain resolution
  attempted, country inferred (or explicitly unknown-flagged), ≥1 industry tag,
  `funding_stage` set — an evidenced stage where facts allow, otherwise
  `bootstrapped` or literal `unknown` (null is a defect; see D3 stage policy) —
  aliases seeded, `confidence` set. Entities missing baseline carry a
  `needs_backfill` flag and are excluded from default ListGen and search
  surfaces until drained. A nightly backfill worker works the queue; drain rate
  and outstanding count are dashboard metrics.
- **Rationale:** this is the structural answer to "everything is thin." Cards
  enter the world complete or they do not enter at all; thinness can only
  regress from a complete baseline, never start there. Stage is in the baseline
  because it is the first filter every VC applies — a card without stage cannot
  answer "is this even in my lane?"
- **Verify:** SQL: ≥95% of live entities active in W satisfy the baseline
  predicate **including non-null `funding_stage`**; needs_backfill count trends
  to ~0 weekly; surface queries filter flagged entities (contract-tested).

### R07 — Facts propagate to the entity KB within SLA

- **Requirement:** an accepted fact updates the entity's derived fields
  (`funding_stage`, `totalRaisedUsd`, `lastFundingDate`, `sourceRefs`) within
  24h of acceptance, with `source_refs` pointing at evidence article ids.
  Rejections record `rejected_reason`.
- **Rationale:** stage computability (C1) dies if facts are accepted but never
  land on the card. The KB is the product; facts are just its write path.
- **Verify:** SQL: accepted funding facts older than 24h whose entity lacks the
  corresponding derived field = 0 rows.

### R08 — Judgment lives in config, versioned

- **Requirement:** taxonomy, thresholds, prompts, model routing, and rubric
  targets live in `config/*.json` (mtime-cached, no deploy). Every LLM call
  records `prompt_template` + version in the ledger; every derived row can be
  traced to the config version that produced it (or to a documented default).
- **Verify:** spot-check: pick 5 kept articles, follow `llm_calls` back to
  prompt template + version; confirm current config values match what the
  pipeline would apply today.

### R09 — Budget degradation is disclosed, never silent

- **Requirement:** soft-cap degrade-to-mini and hard-cap stops are recorded as
  events, visible on the dashboard, and noted in that month's benchmark report.
  A month where quality degraded mid-window cannot be graded against a full-price
  month without disclosure (extends G4).
- **Verify:** dashboard shows degrade events; benchmark artifact references them.

### R10 — Source lifecycle is automated: onboard, demote, prune

- **Requirement:** three scripted lifecycle hooks, no manual DB edits:
  - **onboard:** new source gets a health check within 24h — first successful
    fetch, extraction rate ≥ threshold, tier proposal reviewed or auto-applied;
  - **demote/throttle:** sources violating the B5 precision floor lose volume
    automatically until re-validated;
  - **prune:** sources with `failure_streak ≥ N` flip inactive and appear on a
    monthly pruning report rather than rotting silently.
- **Verify:** run all three against fixtures in CI; registry state transitions
  are audited (who/when/why).

### R11 — Replayable history under budget

- **Requirement:** any change that alters derived outputs (prompt edit, model
  swap, resolver scoring change, taxonomy change) ships with a backfill plan:
  which row populations change, how they get recomputed within the monthly
  budget cap, and a before/after FR-23 benchmark comparison attached to the PR.
- **Rationale:** otherwise the corpus becomes stratified sediment — different
  months enriched by different invisible rules — and every trend line lies.
- **Verify:** PR template checkbox + benchmark diff artifact; backfill runs
  respect the NFR-1 cap (chunked, resumable).

### R12 — Contract and golden tests guard the invariants

- **Requirement:** zod contracts drive request validation, response shape, and
  OpenAPI (already FR-18). Golden offline tests assert the full pipeline on
  fixtures produces: fully-enriched article (R05), baseline-complete entity
  (R06), dedup-perfect double-run (R03). CI red = invariant broken; no override
  flags, no skipped-in-production paths.
- **Verify:** `pnpm typecheck && pnpm lint && pnpm test` green on main; golden
  snapshots reviewed like API changes.

### R13 — Funnel observability with deviation alerts

- **Requirement:** daily per-stage counters (fetched, extracted, kept, resolved,
  enriched, clustered, fact-proposed/accepted) land in one queryable place with
  week-over-week deltas on the admin dashboard. Alert when any stage deviates
  >30% WoW or any queue age exceeds its SLA.
- **Rationale:** every §10 red flag was visible days earlier in the funnel; the
  point is to see it before the month closes, not during grading.
- **Verify:** dashboard screenshot in scorecard; alert rules fire on a staged
  fixture anomaly in CI.

### R14 — Determinism where it matters

- **Requirement:** same input + same config + same model version ⇒ same output,
  wherever technically possible (temperature 0 / seeds for classification and
  extraction stages). Creative stages (summaries) may vary but must stay within
  contract shape. This is what makes replays, diffs, and benchmark comparisons
  meaningful instead of noise.
- **Verify:** replay test runs the same fixture batch twice and asserts stable
  filter/resolve/fact decisions; summary variance bounded by contract checks.

---

### Definition of Done — new source

```
[ ] Registry row created via admin API/import (tier, topics, country)
[ ] Onboard health check passed within 24h (fetch OK, extraction >= threshold)
[ ] Items visible in funnel counters under the source id
[ ] First-month precision sampled vs B5 floor; actioned if below
[ ] No code deployed (if code was needed, R01 was violated)
```

### Definition of Done — pipeline change

```
[ ] Contracts/golden tests updated + green (R12)
[ ] Double-run idempotence proven for touched stages (R03)
[ ] Backfill plan for affected historical rows, budget-capped (R11)
[ ] Before/after benchmark numbers attached (FR-23)
[ ] Config values externalized, versions bumped (R08)
[ ] Funnel counters still reconcile end-to-end (R04)
```

---

## Appendix — SQL probe pack

All probes assume `:ws` / `:we` = window start/end timestamps.

```sql
-- P0. Corpus overview
SELECT noise_stage, count(*) FROM articles
WHERE created_at BETWEEN :ws AND :we GROUP BY 1;

-- P1. Kept rate + discard reasons (B4, G5)
SELECT count(*) FILTER (WHERE noise_stage = 'kept')::float / count(*) AS kept_rate,
       count(*) AS total
FROM articles WHERE created_at BETWEEN :ws AND :we;

SELECT discard_reason, count(*) FROM articles
WHERE created_at BETWEEN :ws AND :we AND discard_reason IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;

-- P2. New-entity survival ("stuck" set) — denominator for C2/A4/C5
WITH new_entities AS (
  SELECT e.id, e.created_by, e.confidence, e.funding_stage, e.website,
         e.registry_ids, e.review_status
  FROM entities e
  WHERE e.created_at BETWEEN :ws AND :we AND e.merged_into IS NULL
)
SELECT count(*) AS new_entities,
       count(*) FILTER (WHERE ea.article_count >= 2 OR f.accepted_facts >= 1) AS stuck,
       count(*) FILTER (WHERE f.accepted_facts >= 1) AS with_accepted_fact
FROM new_entities e
LEFT JOIN LATERAL (
  SELECT count(*) AS article_count FROM article_entities ae
  JOIN articles a ON a.id = ae.article_id
  WHERE ae.entity_id = e.id AND ae.role = 'primary'
) ea ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS accepted_facts FROM facts f
  WHERE f.entity_id = e.id AND f.status = 'accepted'
) f ON true;

-- P3. Field density composite (D3)
SELECT count(*) AS active_entities,
       avg((website IS NOT NULL)::int)                        AS website_rate,
       avg((country IS NOT NULL)::int)                        AS country_rate,
       avg((array_length(industry_tags, 1) > 0)::int)         AS industry_rate,
       avg((founded_year IS NOT NULL OR registry_ids IS NOT NULL)::int) AS founded_or_registry_rate
FROM entities e
WHERE merged_into IS NULL
  AND EXISTS (SELECT 1 FROM article_entities ae JOIN articles a ON a.id = ae.article_id
              WHERE ae.entity_id = e.id AND a.noise_stage = 'kept');

-- P4. Orphan share (D2)
SELECT count(*) FILTER (WHERE e.review_status = 'auto_created' AND e.confidence < 0.6)::float
       / count(*) AS orphan_share
FROM articles a
JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
JOIN entities e ON e.id = ae.entity_id
WHERE a.created_at BETWEEN :ws AND :we AND a.noise_stage = 'kept';

-- P5. Fact funnel (C-dimension inputs)
SELECT type, status, count(*),
       avg(distinct_publishers) AS avg_publishers,
       avg(best_source_tier)    AS avg_best_tier
FROM facts WHERE created_at BETWEEN :ws AND :we
GROUP BY 1, 2 ORDER BY 1, 2;

-- P6. Lead-time proxy (C3) — accepted rounds vs earliest linked article
WITH rounds AS (
  SELECT f.entity_id,
         (f.payload->>'event_date')::date AS event_date
  FROM facts f
  WHERE f.type = 'funding_round' AND f.status = 'accepted'
    AND f.payload->>'event_date' IS NOT NULL
)
SELECT r.entity_id, r.event_date,
       extract(epoch FROM (r.event_date::timestamp - min(a.published_at))) / 86400 AS lead_days
FROM rounds r
JOIN article_entities ae ON ae.entity_id = r.entity_id
JOIN articles a ON a.id = ae.article_id
GROUP BY r.entity_id, r.event_date
HAVING min(a.published_at) IS NOT NULL
ORDER BY lead_days;

-- P7. Momentum coherence proxy (C6): distinct primary tags per active entity
SELECT count(*) FILTER (WHERE distinct_tags >= 2)::float / count(*) AS momentum_share
FROM (
  SELECT ae.entity_id, count(DISTINCT a.primary_tag) AS distinct_tags,
         count(DISTINCT a.publisher_domain) AS publishers
  FROM article_entities ae
  JOIN articles a ON a.id = ae.article_id
  WHERE a.noise_stage = 'kept' AND a.published_at BETWEEN :ws AND :we
  GROUP BY ae.entity_id
  HAVING count(DISTINCT a.publisher_domain) >= 2
) t;

-- P8. Latency percentiles per tier (F1)
SELECT s.tier,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (a.created_at - a.published_at))/3600) AS median_lag_h,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (a.created_at - a.published_at))/3600) AS p90_lag_h
FROM articles a JOIN sources s ON s.id = a.source_id
WHERE a.noise_stage = 'kept' AND a.created_at BETWEEN :ws AND :we
GROUP BY s.tier ORDER BY s.tier;

-- P9. Source health (F2, B5 input)
SELECT s.id, s.tier, s.failure_streak, s.last_fetched_at,
       count(a.id) FILTER (WHERE a.noise_stage = 'kept') AS kept_articles
FROM sources s
LEFT JOIN articles a ON a.source_id = s.id AND a.created_at BETWEEN :ws AND :we
WHERE s.active
GROUP BY s.id, s.tier, s.failure_streak, s.last_fetched_at
ORDER BY kept_articles DESC;

-- P10. Sector + geo mix of kept volume (A5)
SELECT coalesce(industry_primary, '(none)') AS industry, count(*)
FROM articles WHERE noise_stage = 'kept' AND published_at BETWEEN :ws AND :we
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

SELECT unnest(countries) AS country, count(*)
FROM articles WHERE noise_stage = 'kept' AND published_at BETWEEN :ws AND :we
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;

-- P11. Confidence deciles for calibration check (D4)
SELECT width_bucket(confidence, 0, 1, 10) AS decile, review_status, count(*)
FROM entities WHERE created_at BETWEEN :ws AND :we AND merged_into IS NULL
GROUP BY 1, 2 ORDER BY 1;

-- P12. Cost per unit (ties to FR-23 $/1K correct)
SELECT sum(cost_usd) AS month_llm_spend
FROM llm_calls WHERE created_at BETWEEN :ws AND :we;

-- P13. Stage coverage + distribution (D3 stage policy, C2 banding input)
SELECT coalesce(funding_stage, '(NULL — DEFECT)') AS stage, count(*),
       count(*)::float * 100 / sum(count(*)) OVER () AS pct
FROM entities
WHERE merged_into IS NULL
  AND EXISTS (SELECT 1 FROM article_entities ae JOIN articles a ON a.id = ae.article_id
              WHERE ae.entity_id = entities.id AND a.noise_stage = 'kept')
GROUP BY 1 ORDER BY 2 DESC;
```

## Appendix B — Truth-set files to stand up once

| File | Purpose | Feeds |
|---|---|---|
| `config/gold-events.json` (~50/mo) | Known venture-relevant events in window | A2 |
| `config/gold-merge-pairs.json` (~200 pairs) | Merge correctness ground truth | D1 |
| `config/rubric.listgen.queries.json` (10 queries) | Canned thesis queries w/ expected filters | G2 |
| `config/benchmark.companies.json` (exists) | akta 133-company list | A1 |

The rubric is deliberately source-agnostic: it never says where data comes from.
It only says what must be true about the database when the month closes — which is
exactly the contract akta-style consumers buy against.
