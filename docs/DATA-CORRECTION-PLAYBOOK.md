# Data correction playbook — existing intelligence KB rows

**Audience:** another model (or operator) whose job is to **correct rows already in live Postgres**. Do not use this document to change pipeline code. Pipeline contract fixes landed separately; this playbook is the data half.

**Database (as of 2026-08-26 audit):** `postgres://copyr_intel:intel@localhost:5434/intelligence`

**Snapshot at audit time:** 5,445 live entities, 41 merged, 19,020 articles (6,544 `kept`), 3,833 `article_entities`, 5,026 accepted facts (4,807 Form D), 8,343 aliases.

**Do not run another completeness / unclassified / amount-band backfill.** Those scripts manufactured the mess. Honest null / `unknown` / `proposed` / `pending` is the correct state until a **real** harness (not mock) re-enriches.

---

## 0. Operating constraints (read first)

1. Read `AGENT-COORDINATION.md`. Append a claim **before** any destructive SQL. Log every `DELETE` / `UPDATE` that drops links, aliases, facts, or entities in the Log section **before** executing it.
2. Take a backup first. Minimum:

   ```sql
   -- name the stamp with the UTC date you actually run
   CREATE TABLE _corr_bak_entities AS SELECT * FROM entities;
   CREATE TABLE _corr_bak_aliases AS SELECT * FROM aliases;
   CREATE TABLE _corr_bak_article_entities AS SELECT * FROM article_entities;
   CREATE TABLE _corr_bak_articles AS SELECT * FROM articles;
   CREATE TABLE _corr_bak_facts AS SELECT * FROM facts;
   CREATE TABLE _corr_bak_entity_profiles AS SELECT * FROM entity_profiles;
   ```

3. Work **idempotently**. Every `UPDATE`/`DELETE` must be safe to re-run. Prefer `WHERE` gates on current wrong values, not blind overwrites.
4. Use `EntityKb.merge(loserId, keeperId)` (`src/entities/kb.ts`) for duplicate cards. Do **not** hand-delete the loser after merge — `merged_into` is the surviving pointer. After merge, optionally copy missing website / tickers / registry_ids onto the keeper (merge does not copy card fields).
5. **Order of operations matters.** Do aliases and merges **before** re-queuing mock-kept articles, otherwise generic aliases will re-swallow headlines on the next harness run.
6. Do **not** set `industry_tags = '{unclassified}'`, `industry_primary = 'other_diversified'`, or `primary_tag = 'status.no_event'` as a “filled” state. Do **not** run `src/scripts/infer-stage-backlog.ts` on seed/reviewed cards. Do **not** stamp `needs_backfill = false` unless the card actually has a real sector (not `unclassified`) plus a non-null stage.
7. After structural pipeline fixes are deployed, re-queue is allowed. Until then, leaving mock-kept rows as `kept` is less harmful than re-running mock. Confirm `LLM_PROVIDER` is a real hosted/harness path (`LLM_API_KEY` is not `sk-xxx`) before any re-queue.
8. Famous public companies: `type = 'public'` and `funding_stage = 'public'`. Do not invent `series_b` / `bootstrapped` for them.

---

## 1. What went wrong (so you do not repeat it)

Cheap ingest parked items. A harness was supposed to tighten labels with a real model, keep/drop, deep-search new companies, and propose facts. In production, `LLM_PROVIDER=auto` with placeholder `LLM_API_KEY=sk-xxx` selected `MockProvider`. Mock labels were published. Completeness stamps (`unclassified`, `other_diversified`, `status.no_event`) satisfied the publish gate. Form D / launch ingest set `resolved_at`, so the harness skipped re-resolution. Baseline stamped `unclassified` and cleared `needs_backfill`, emptying the deep-search queue. Hollow mock profiles were marked `complete`. Form D facts with amount 0 were `accepted`. News facts required `newsworthiness = 'high'` (only ~443 kept rows), so almost no M&A/funding facts landed from press.

Your job is to repair **identity, aliases, types, stages, junk mints, and queue state**. You are **not** supposed to guess industries, summaries, or profile prose. Leave those null/pending for the real harness.

---

## 2. Merge duplicate companies (CIK / domain)

Use `EntityKb.merge(sourceId /*loser*/, targetId /*keeper*/)` then copy any missing keeper fields (website, tickers, `registry_ids`, better `canonical_name`).

**Keeper rule:** prefer the card with a real website, then the card with `type = 'public'` + tickers, then the seed/import card over autocreate/launchmonitor, then the one with more `article_entities`. Never keep a card whose website is a social domain (`x.com`, `github.com`) when a product domain exists.

### 2.1 Confirmed CIK duplicates (live 2026-08-26)

| CIK | Keeper (keep) | Loser (merge into keeper) | Notes |
|---|---|---|---|
| `0001318605` | `ent_01M0KJG7RCBG4WEP5YHT390SMN` Tesla tesla.com | `ent_01M0M2KW7260MHXJ6PA7S6WMM2` Tesla, Inc. (no website) | After merge: `type='public'`, `funding_stage='public'` |
| `0001327567` | `ent_01M0NZ0A80X9QXPR6GD6YAZ1JB` Palo Alto Networks paloaltonetworks.com | `ent_01M0M2WT0FB5F5CRSKJTCT0Y7E` Palo Alto Networks Inc | Same |
| `0001639920` | `ent_01M0KJG7VAYNEXF5YEFWQ08N4K` Spotify spotify.com | `ent_01M0M2X6DSW9XG41BQZ3QMXYTB` Spotify Technology S.A. | Same |
| `0001640147` | `ent_01M0KJG7S98375R6TFKZ74WV6V` Snowflake snowflake.com | `ent_01M0M2X6AKZJ63HZP6D7D1YHQ6` Snowflake Inc. | Same |
| `0001876042` | `ent_01M0NZ0A2DYYRHZD5CNW2B6HG8` Circle circle.com | `ent_01M0M2Z2ANHE8W55EBM9QWJZDZ` Circle Internet Group, Inc. | Same |
| `0002049036` | `ent_01M0NQ7TBDDJTAXD36Q3WEA7J9` Empirical Security empiricalsecurity.com | `ent_01M0NSQ196P2BC1GTWATHAHJSM` Empirical Security, INC. | Private; keep website |

Discovery query (re-run; merge any new pairs the same way):

```sql
SELECT registry_ids->>'sec_cik' AS cik, COUNT(*) AS n,
       json_agg(json_build_object('id', id, 'name', canonical_name, 'website', website, 'type', type, 'created_by', created_by))
FROM entities
WHERE merged_into IS NULL AND registry_ids->>'sec_cik' IS NOT NULL
GROUP BY 1 HAVING COUNT(*) > 1;
```

### 2.2 Domain / product duplicates (no shared CIK)

| Keeper | Loser | Why |
|---|---|---|
| `ent_01M0KJG7XBT2XJ6BNAPQDZ6D9Z` Vercel vercel.com | `ent_01M0NHDK7P9A0XNSBG5YD8MP4D` Vercel vercel.app | Same company; `.app` is a product host |
| `ent_01M0KJG7QTDZAVG4F3N6HSK17Z` Meta Platforms meta.com | `ent_S7HMDN0M108KDA4Y2EF25EQA5S` Meta meta.me | Same company; `.me` is not the product domain |
| `ent_01M0NZ0ACDQ8H14H905Y4EAW64` Arcads arcads.ai (`import:seed`) | `ent_VPJMDN0M10Y46WFN3YKE9D99X6` Arcads (no website, `launchmonitor`) | Seed has the domain |
| `ent_01M0NQ7TB66WFTT5VTD8ZYKM2N` Natural natural.io (`import:seed`) | `ent_9QJMDN0M10B75KZ1CJZ07MVSBM` Natural natural.com (`launchmonitor`) | **Verify** these are the same company before merge. If they are different products, do **not** merge; instead quarantine the generic alias `natural` on both (section 3) |

After each merge, copy onto the keeper if missing:

```sql
UPDATE entities k SET
  website = COALESCE(NULLIF(k.website, ''), l.website, k.website),
  tickers = CASE WHEN cardinality(k.tickers) = 0 THEN l.tickers ELSE k.tickers END,
  registry_ids = COALESCE(k.registry_ids, '{}'::jsonb) || COALESCE(l.registry_ids, '{}'::jsonb),
  type = CASE WHEN l.type = 'public' THEN 'public' ELSE k.type END,
  updated_at = now()
FROM entities l
WHERE k.id = :keeper AND l.id = :loser;
```

(`EntityKb.merge` already ran; `:loser` still exists with `merged_into = :keeper`.)

---

## 3. Quarantine generic aliases (do this before any re-resolve)

These aliases match common English words and attach unrelated headlines to the wrong card. **Delete the alias rows** (or demote by renaming `alias_normalized` to a unique token you will never query — deletion is cleaner). **Do not delete the entity** unless section 6 says to. GetEnergy / Alice.io / Owner.com may be real companies; they must not own the word `energy` / `alice` / `owner`.

### 3.1 Exact alias rows to delete

| alias_normalized | entity_id | canonical_name | website | kept headlines (audit) | Action |
|---|---|---|---|---|---|
| `energy` | `ent_CRHMDN0M10EWH1Q45WSD0C5RCA` | Energy | getenergy.com | 23 | Delete alias. Rename entity to **GetEnergy** if that is the brand. |
| `bank` | `ent_01M0QVM1JZZKHSX5813ZMSNSXB` | Bank | airtel.in | 14 | Delete alias. Inspect: this is almost certainly not a company named “Bank”. If `airtel.in` is wrong, treat as junk mint (section 6). |
| `alice` | `ent_01M0WQNN27WMX6J0T54B8PAGDX` | Alice | alice.io | 7 | Delete alias `alice`. Keep domain alias `alice.io`. |
| `mark` | `ent_Z5HMDN0M10DKA5147D702VWZW0` | Mark | thinkwithmark.com | 7 | Delete alias `mark`. |
| `markets` | `ent_18HMDN0M10HNBCJ8Z8YJ48H3D8` | Markets | markets.xyz | 7 | Delete alias `markets`. |
| `natural` | `ent_9QJMDN0M10B75KZ1CJZ07MVSBM` | Natural | natural.com | 6 | Delete alias. |
| `natural` | `ent_01M0NQ7TB66WFTT5VTD8ZYKM2N` | Natural | natural.io | 0 | Delete alias. |
| `slash` | `ent_EPHMDN0M100Q6A67NBE7R04AR3` | Slash | slash.com | 6 | Delete alias. |
| `forbes` | `ent_01M0NT4EVM5GT9PQG57R97A46M` | Forbes | forbes.com | 4 | Publisher, not a portco — see section 6 (delete entity). |
| `link` | `ent_HDHMDN0M10K4F19R4JTXRPSMN9` | Link | link.com | 4 | Delete alias. |
| `open bot` | `ent_9BJMDN0M10T1YY07BEZTAHZEWF` | Open Bot | github.com | 4 | Junk mint (section 6). |
| `owner` | `ent_5NHMDN0M101S0NJW69KNDGNSSK` | Owner | owner.com | 4 | Delete alias. Keep domain alias. |
| `pocket` | `ent_WVHMDN0M10RQAC4WZHN2XJPC4V` | Pocket | heypocket.com | 4 | Delete alias. |
| `bot` | `ent_01M0N3VJBDW2J0HDN69NR0N1GG` | xAI | x.ai | 3 | Delete alias `bot` off xAI. |
| `nikkei` | `ent_01M0Z2P9K1HS9RPYDHYRNXW9SY` | Nikkei | nikkei.com | 1 | Publisher — section 6. |

Idempotent delete:

```sql
DELETE FROM aliases
WHERE alias_normalized IN (
  'energy','bank','mark','markets','link','owner','alice','natural',
  'slash','pocket','open bot','bot','forbes','nikkei','news','media',
  'group','holdings','capital','partners','ventures','systems','solutions',
  'global','digital','cloud','data','tech','ai','app','inc','corp','llc','ltd'
)
AND kind <> 'ticker';
```

Also delete **any remaining single-token generic alias** (re-run until 0):

```sql
SELECT a.alias_normalized, e.id, e.canonical_name, e.website
FROM aliases a JOIN entities e ON e.id = a.entity_id
WHERE e.merged_into IS NULL
  AND a.kind <> 'ticker'
  AND a.alias_normalized ~ '^[a-z]+$'
  AND length(a.alias_normalized) <= 8
  AND a.alias_normalized IN (
    SELECT unnest FROM unnest(ARRAY[
      'energy','bank','mark','markets','link','owner','alice','natural','slash',
      'pocket','open','bot','news','media','group','the','inc','co','company'
    ])
  );
```

### 3.2 Unlink headlines that generic aliases wrongly attached

After deleting aliases, unlink **primary** `article_entities` whose article title does **not** contain the company’s distinctive brand (domain label or canonical name after rename). Example for GetEnergy:

```sql
DELETE FROM article_entities ae
USING articles a, entities e
WHERE ae.article_id = a.id AND ae.entity_id = e.id
  AND e.id = 'ent_CRHMDN0M10EWH1Q45WSD0C5RCA'
  AND ae.role = 'primary'
  AND a.title !~* 'getenergy|get energy'
  AND a.title ~* '\benergy\b';
```

Repeat the pattern for Bank/airtel (`title` should mention Airtel, not “West Bank” / “Bank of America”), Mark, Markets, etc. When unsure, unlink: a kept-unattributed article is better than a wrong company card.

xAI must not keep headlines that only matched `bot`.

---

## 4. Rename verb-glued autocreate names

These cards are probably real companies; the canonical name swallowed a headline verb. Rename to the brand implied by the website (strip `Raises`, `Raises US`, `Raises USD`, `Raises AED`, `IPO Raises`, `Open-Sources …`). Keep the entity id. Add the clean name as alias; do **not** keep the verb-glued string as an alias.

| id | current name | website | rename to |
|---|---|---|---|
| `ent_01M0Z2KXGMGJ42C07JZ682Y42K` | Emerald AI Raises | emeraldai.co | Emerald AI |
| `ent_01M0Z2QEFP5D0ZRWRBM4RSP6S0` | Gestala Raises US | gestala.com | Gestala |
| `ent_01M0W53RFHPGSS2E59VMQE8FAZ` | Gravis Robotics Raises | gravisrobotics.com | Gravis Robotics |
| `ent_01M0WR4FZMA5N37CY8EAKYRNMR` | Hermetiq Raises | hermetiq.com | Hermetiq |
| `ent_01M0WR5C7ZPQREGEJ697YD7H3K` | HERP Raises | herp.co.jp | HERP |
| `ent_01M0XVJXPYNQWYPVFV7PE0T55V` | Liquid AI Open-Sources Pipette | liquid.ai | Liquid AI |
| `ent_01M0Z2KWNFGB0CHW8BVDZYWE5S` | Mundo AI Raises | mundoai.world | Mundo AI |
| `ent_01M0WR5ET4KN5RFVQQ3CFRKG9E` | Neno Raises | neno.co | Neno |
| `ent_01M0W51YXHCBWCF1P3NTCAJ5V7` | Pixelgen Technologies Raises | pixelgen.com | Pixelgen Technologies |
| `ent_01M0W4GTHHKK3MF399SB8XPKMZ` | Resilire Raises | resilire.jp | Resilire |
| `ent_01M0Z2VTF2GE0ZJG4P77DH69NE` | Stellaria Raises AED | stellaria.ai | Stellaria |
| `ent_01M0WQW5CD2DRD1JCC22JT7DP2` | Verascient Raises USD | verascient.com | Verascient |
| `ent_01M0TC7P6P7AY34GQNT4YR2BFF` | Vogenx IPO Raises | vogenx.com | Vogenx |
| `ent_01M0Z2VVVM96AF20QCTJD2YMKF` | Wrtn Technologies Raises | wrtn.io | Wrtn Technologies |

Discovery query for leftovers:

```sql
SELECT id, canonical_name, website FROM entities
WHERE merged_into IS NULL
  AND canonical_name ~* '(Raises|Launches|Acquires|Open-Sources|IPO Raises)\b';
```

After rename, `DELETE FROM aliases WHERE entity_id = :id AND alias ~* '(Raises|Launches|Acquires|Open-Sources)'`.

---

## 5. Famous / seed card field corrections

Do **not** invent a private-company stage. Public issuers: `type='public'`, `funding_stage='public'`. Private companies whose stage was guessed from amount bands or mock: set `funding_stage='unknown'` unless an **accepted** fact with a real `funding_stage` in payload exists.

| id | name | website | Fix |
|---|---|---|---|
| `ent_01M0KJG7R03VAMHHATT9S2Z113` | Apple | apple.com | `type='public'`, `funding_stage='public'` (already public stage at audit; type is wrongly `private`) |
| `ent_01M0KJG7R6G8HQ58WHZRSQ5YGN` | Amazon | amazon.com | `type='public'` |
| `ent_01M0KJG7QC3097N4PFQZH43HHV` | Microsoft | microsoft.com | `type='public'` |
| `ent_01M0KJG7NXNSEWCSNX56EP9BH5` | Nvidia | nvidia.com | `type='public'` |
| `ent_01M0N3VJ9T8KAKM4C6K0KDTV8Q` | Google | google.com | `type='public'`, `funding_stage='public'` (was `series_c`) |
| `ent_01M0N3VJABY92HT6BE9GXBEE7N` | SpaceX | spacex.com | Leave `type='private'`. Stage `series_b` is **not evidenced** — set `unknown` unless a real accepted round fact exists. Do **not** invent `late_stage`. |
| `ent_01M0N3VJB4BS9JG0PF4N7YY6Q2` | ByteDance | bytedance.com | `bootstrapped` is wrong. Set `unknown` (or evidenced late_stage only from a real fact). |
| `ent_01M0NZ4FDF4GW0M4M14DB4VV15` | Bloomberg | bloomberg.com | `series_b` is wrong. Private + `unknown` (or `public` only if you confirm a listing — Bloomberg LP is private). |
| `ent_01M0NZ0A4ZQTXWQ2FJ7B7REAB0` | Harvey | harvey.ai | Remove `unclassified` tag; leave `industry_tags='{}'` and `needs_backfill=true` until harness. Stage `late_stage` only if an accepted fact says so; else `unknown`. |
| `ent_01M0NZ0A67BE18GK5H9D8N7MZS` | Lemonade | lemonade.com | `type='public'`, `funding_stage='public'`; drop `unclassified`. |
| `ent_4NJMDN0M107SC7MZJ5T9V42CD8` | Slack | slack.com | Already `subsidiary` (Salesforce). Remap industry `AI & ML` → `ai_ml` (section 7). Stage can stay `late_stage` only as historical; `unknown` is safer. |
| `ent_KBHMDN0M103S94YS2PWWW3KFAV` | Rippling | **x.com (WRONG)** | Set `website='rippling.com'`. Remap `SaaS & productivity` → `saas_enterprise`. Stage `pre_seed` is wrong for Rippling — set `unknown` (or evidenced late_stage from a real fact, not amount-band inference). There is **no** second Rippling card; do not invent one. |

Batch type fix for any remaining seed public issuers that have tickers and a well-known listing:

```sql
UPDATE entities SET type = 'public',
  funding_stage = CASE WHEN funding_stage IN ('series_a','series_b','series_c','seed','pre_seed','bootstrapped')
                       THEN 'public' ELSE funding_stage END,
  updated_at = now()
WHERE merged_into IS NULL
  AND type = 'private'
  AND cardinality(tickers) > 0
  AND created_by IN ('import:seed','import:edgar')
  AND website IN (
    'apple.com','amazon.com','microsoft.com','nvidia.com','google.com',
    'meta.com','tesla.com','netflix.com','spotify.com','snowflake.com'
  );
```

Re-check with:

```sql
SELECT id, canonical_name, type, funding_stage, website
FROM entities
WHERE merged_into IS NULL AND website IN
  ('apple.com','amazon.com','microsoft.com','nvidia.com','google.com','meta.com','tesla.com');
```

---

## 6. Delete junk mints (not companies)

These are people, publishers, headline fragments, or product pages minted as `type='private'`. Procedure:

1. `DELETE FROM article_entities WHERE entity_id = :id` (or re-point if a real company is obvious — usually not).
2. `DELETE FROM aliases WHERE entity_id = :id`.
3. `DELETE FROM facts WHERE entity_id = :id`.
4. `DELETE FROM entity_profiles WHERE entity_id = :id`.
5. `UPDATE articles SET …` is not required; kept articles become unattributed, which is correct.
6. `DELETE FROM entities WHERE id = :id`.

If `article_entities` ON DELETE CASCADE is present, deleting the entity is enough — **check the FK** before relying on cascade. Log the ids in AGENT-COORDINATION first.

| id | name | website | Why |
|---|---|---|---|
| `ent_01M0WV803MJRS5YJHSWY34JK2R` | Purvanshi Mehta | (none) | Person |
| `ent_01M0WV8034TMVKMSGF6SE1QRYT` | Priyaa Kalyanaraman | (none) | Person |
| `ent_01M0VK853SVTCGNBJ7WB1ZYX3J` | Joy Taylor | joytaylorfoundation.com | Person |
| `ent_01M0NEMQXEYDYF4JDDGXPCTR9X` | The Gross Clinic | inquirer.com | Painting / publisher page |
| `ent_01M0WXAAKQDASBNBZNX49QZW7H` | Nature Communications | nature.com | Journal |
| `ent_01M0NEMTR3RAE29D59AEDZAWCB` | Celebrity News | eonline.com | Headline / publisher |
| `ent_01M0NFCSG1M3TFSDNREVF6QPCN` | Anniversary Sale | 9to5toys.com | Retail headline |
| `ent_01M0X8ME8PQEYYDK5B1C7WAYK1` | Claude Code | claude.com | Product, not a company (Anthropic already should exist — do not merge this into Anthropic unless you verify; deleting is safer) |
| `ent_01M0NT4EVM5GT9PQG57R97A46M` | Forbes | forbes.com | Publisher |
| `ent_01M0Z2P9K1HS9RPYDHYRNXW9SY` | Nikkei | nikkei.com | Publisher |
| `ent_9BJMDN0M10T1YY07BEZTAHZEWF` | Open Bot | github.com | Repo / generic |

Sweep for more people-shaped autocreates (review before delete):

```sql
SELECT id, canonical_name, website, created_by
FROM entities
WHERE merged_into IS NULL
  AND created_by = 'autocreate'
  AND canonical_name ~ '^[A-Z][a-z]+ [A-Z][a-z]+$'
  AND type = 'private'
  AND cardinality(tickers) = 0
  AND registry_ids IS NULL
LIMIT 200;
```

Sweep for publisher domains minted as companies:

```sql
SELECT id, canonical_name, website FROM entities
WHERE merged_into IS NULL AND website IN
  ('forbes.com','nikkei.com','nature.com','eonline.com','inquirer.com','reuters.com','bloomberg.com')
  AND created_by = 'autocreate';
```

(Do **not** delete the seed Bloomberg card `ent_01M0NZ4FDF4GW0M4M14DB4VV15` — that is the company, not an autocreate publisher mint. The query above is autocreate-only.)

Also inspect `ent_01M0QVM1JZZKHSX5813ZMSNSXB` (Bank / airtel.in). If it is not Airtel, delete it. If it is Airtel, rename to Airtel and set `website='airtel.in'` only after you are sure; still never keep alias `bank`.

---

## 7. Okara / launchmonitor industry label remap

~213 cards still have human labels instead of taxonomy ids. Mapping (from `launchmonitor/src/mapping.ts`):

| stored tag | taxonomy id |
|---|---|
| `AI & ML` | `ai_ml` |
| `Developer tools` | `devtools` |
| `Climate & energy` | `energy_transition` |
| `Consumer apps` | `consumer_internet` |
| `Creator economy` | `media_entertainment` |
| `Crypto & web3` | `crypto_web3` |
| `Defense & space tech` | `govtech_defense` |
| `Enterprise infrastructure` | `saas_enterprise` |
| `Hardware & devices` | `consumer_electronics` |
| `Health & bio` | `healthtech` |
| `SaaS & productivity` | `saas_enterprise` |
| `Fintech` / `Fintech & payments` | `fintech` |
| `Education` | `edtech` |
| `Gaming` | `gaming` |

Idempotent remap (array replace):

```sql
UPDATE entities SET
  industry_tags = ARRAY(
    SELECT DISTINCT CASE lower(t)
      WHEN 'ai & ml' THEN 'ai_ml'
      WHEN 'developer tools' THEN 'devtools'
      WHEN 'climate & energy' THEN 'energy_transition'
      WHEN 'consumer apps' THEN 'consumer_internet'
      WHEN 'creator economy' THEN 'media_entertainment'
      WHEN 'crypto & web3' THEN 'crypto_web3'
      WHEN 'defense & space tech' THEN 'govtech_defense'
      WHEN 'enterprise infrastructure' THEN 'saas_enterprise'
      WHEN 'hardware & devices' THEN 'consumer_electronics'
      WHEN 'health & bio' THEN 'healthtech'
      WHEN 'saas & productivity' THEN 'saas_enterprise'
      WHEN 'fintech' THEN 'fintech'
      WHEN 'fintech & payments' THEN 'fintech'
      WHEN 'education' THEN 'edtech'
      WHEN 'gaming' THEN 'gaming'
      ELSE t
    END
    FROM unnest(industry_tags) AS t
  ),
  updated_at = now()
WHERE merged_into IS NULL
  AND industry_tags && ARRAY[
    'AI & ML','Developer tools','Climate & energy','Consumer apps','Creator economy',
    'Crypto & web3','Defense & space tech','Enterprise infrastructure','Hardware & devices',
    'Health & bio','SaaS & productivity','Fintech','Fintech & payments','Education','Gaming'
  ];
```

`unclassified` is **not** a real sector. Strip it and reflag:

```sql
UPDATE entities SET
  industry_tags = array_remove(industry_tags, 'unclassified'),
  needs_backfill = true,
  updated_at = now()
WHERE merged_into IS NULL
  AND 'unclassified' = ANY(industry_tags);
```

If that leaves `industry_tags = '{}'`, leave it empty. Do not invent a replacement tag.

---

## 8. Facts: Form D amount-0 and news-fact drought

### 8.1 Demote hollow Form D facts to `proposed`

~2,256 accepted Form D facts have `amount_usd_est` 0 or missing, and ~4,844 have no `funding_stage` in payload. They must not drive `entities.funding_stage`.

```sql
UPDATE facts SET
  status = 'proposed',
  promoted_at = NULL
WHERE status = 'accepted'
  AND type = 'funding_round'
  AND dedup_key LIKE 'formd:%'
  AND (
    COALESCE((payload->>'amount_usd_est')::numeric, 0) <= 0
    AND COALESCE(payload->>'funding_stage','') = ''
  );
```

Then clear entity stages that only existed because of those facts:

```sql
UPDATE entities e SET
  funding_stage = 'unknown',
  updated_at = now()
WHERE e.merged_into IS NULL
  AND e.funding_stage IN ('pre_seed','seed')
  AND e.created_by IN ('formd')
  AND NOT EXISTS (
    SELECT 1 FROM facts f
    WHERE f.entity_id = e.id AND f.status = 'accepted' AND f.type = 'funding_round'
      AND COALESCE((f.payload->>'amount_usd_est')::numeric, 0) > 0
  );
```

Do **not** run `infer-stage-backlog.ts` to refill those.

### 8.2 Do not accept news facts from mock

Leave existing accepted news facts unless they are obviously wrong (acquirer/target swapped, amount 0). After the pipeline fix, funding/M&A facts no longer require `newsworthiness='high'`. You do **not** need to backfill facts by hand; the next real harness pass will propose them.

---

## 9. Hollow profiles → pending

~15k mock-complete profile rows with empty arrays. Mark narrative sections pending when the payload has no non-empty field. Keep deterministic sections (`location`, `company_hierarchy`, `funding_detail`, `mna_and_investment`, `management_profile`) complete **only if** they actually contain facts/registry values.

```sql
UPDATE entity_profiles SET
  status = 'pending',
  last_error = 'emptied_mock_complete',
  stale_at = NULL
WHERE status = 'complete'
  AND section NOT IN ('location','company_hierarchy','funding_detail','mna_and_investment','management_profile')
  AND (
    payload IS NULL
    OR payload::text IN ('{}','null')
    OR (
      -- heuristic: no string value longer than 2 chars besides keys
      COALESCE(payload::text, '') NOT LIKE '%": "%'
      AND COALESCE(payload::text, '') NOT LIKE '%": "%'
    )
  );
```

Safer operational approach: for each mandated narrative section (`firmographic` may stay if `name` is present), set `status='pending'` where `model LIKE 'mock%'` OR `derived_from = 'llm'` AND payload arrays are all empty. Inspect a few rows in `psql` before a wide update.

Do **not** delete profile rows.

---

## 10. Articles: re-queue mock-kept rows (last, and only with a real LLM)

**How the harness will look at them:** part 1 is a **batch audit**, not one LLM job per article. The model sees up to `max_batch` waiting items together (chunked; `harness.audit_chunk_size`, default 40) and keep/drop/retags the pile as a set — the reasonable way to correct misclassification and throw away irrelevant items. After that it **hones in**: summaries only for high/medium keepers, then per-company deep search and card updates on survivors. Do not write a correction pass that classifies each re-queued URL in isolation.

**Preconditions:** sections 2–7 done; structural pipeline deployed; `LLM_PROVIDER` is `openai-compatible` or `harness` with a real key/agent (not `auto` + `sk-xxx`).

Identify mock-kept:

```sql
SELECT COUNT(*) FROM articles a
WHERE a.noise_stage = 'kept'
  AND EXISTS (
    SELECT 1 FROM llm_calls c
    WHERE c.article_id = a.id AND c.stage = 'classify_enrich' AND c.model LIKE 'mock%'
  );
```

Audit count was ~6,470. Re-queue in bounded batches (e.g. 120 — harness `max_batch`):

```sql
UPDATE articles SET
  noise_stage = 'waiting',
  enriched_at = NULL,
  resolved_at = NULL,
  discard_reason = 'requeue:mock_kept',
  enrich_attempts = 0,
  updated_at = now()
WHERE id IN (
  SELECT a.id FROM articles a
  WHERE a.noise_stage = 'kept'
    AND EXISTS (
      SELECT 1 FROM llm_calls c
      WHERE c.article_id = a.id AND c.stage = 'classify_enrich' AND c.model LIKE 'mock%'
    )
  ORDER BY a.published_at DESC
  LIMIT 120
);
```

Also re-queue kept rows whose `primary_tag = 'status.no_event'` or `industry_primary = 'other_diversified'` even if the llm_calls join misses (legacy rows). Same `LIMIT 120` drain.

**Do not** flip `llm_filter` discards back to waiting in bulk — mock noise_filter had ≥10% false drops (`no_subject_event_in_title_or_lead`), but recovering them is a separate, titled-event-only pass:

```sql
-- OPTIONAL, titled company-event discards only, after real LLM is confirmed
UPDATE articles SET
  noise_stage = 'waiting',
  discard_reason = 'requeue:mock_noise_fp',
  resolved_at = NULL,
  enriched_at = NULL,
  enrich_attempts = 0,
  updated_at = now()
WHERE noise_stage = 'llm_filter'
  AND discard_reason = 'no_subject_event_in_title_or_lead'
  AND title ~* '(rais(e[sd]?|ing)|acquir(e[sd]?|ing)|launch(es|ed)?|merger|ipo|series [a-c]|files form d)'
  AND id IN (SELECT id FROM articles WHERE noise_stage = 'llm_filter' LIMIT 120);
```

Form D / launch rows that already have registry/domain `article_entities` should **keep those links**; clearing `resolved_at` is still correct so the harness re-checks. Do not delete those links yourself.

Summaries that start with `unknown:` or equal the title: leave them; re-enrich will replace. Do not hand-write summaries.

---

## 11. Location HQ `USA`

2,759 cards have HQ country `USA` (EDGAR default via `iso3ish`). Entity `country` should be ISO-3166 alpha-2 `US`, not `USA`. Profile location payloads may say `USA` as a label — that is a display mapping, not a card field.

```sql
UPDATE entities SET country = 'US', updated_at = now()
WHERE merged_into IS NULL AND country IN ('USA','united states','United States');
```

Do not invent `hq_city`. Do not set country on Form D funds just because EDGAR is US — `US` is acceptable for SEC filers; leave it.

Form D **funds** (`type='fund'`, ~2,047, all unclassified, no website): leave as funds. Do not website-scrape them. Do not stamp a sector.

---

## 12. What you must not do

- Do not run `pnpm classify:unclassified`, `infer-stage-backlog`, `enrich-formd` amount-band inference, or any script that writes `unclassified` / `pre_seed` from absence of data.
- Do not mark profile sections `complete` with empty arrays.
- Do not `needs_backfill=false` on cards with empty or `unclassified` industry.
- Do not merge Meta / Natural / Arcads pairs without the keeper rules in section 2.
- Do not delete GetEnergy / Alice / Owner solely because their **alias** was generic.
- Do not publish from mock. If a harness run finishes in a few seconds and `new_companies_deep_searched = 0` while thousands are still `needs_backfill`, you are still on mock — stop.

---

## 13. Verification queries (must be green before you stop)

```sql
-- 0 remaining CIK dupes
SELECT registry_ids->>'sec_cik', COUNT(*)
FROM entities WHERE merged_into IS NULL AND registry_ids->>'sec_cik' IS NOT NULL
GROUP BY 1 HAVING COUNT(*) > 1;

-- 0 generic aliases
SELECT COUNT(*) FROM aliases
WHERE kind <> 'ticker' AND alias_normalized IN
  ('energy','bank','mark','markets','link','owner','alice','natural','slash','pocket','bot','forbes','nikkei');

-- 0 verb-glued names
SELECT COUNT(*) FROM entities
WHERE merged_into IS NULL AND canonical_name ~* '(Raises|Open-Sources|IPO Raises)\b';

-- famous types
SELECT canonical_name, type, funding_stage FROM entities
WHERE id IN (
  'ent_01M0KJG7R03VAMHHATT9S2Z113','ent_01M0KJG7R6G8HQ58WHZRSQ5YGN',
  'ent_01M0KJG7QC3097N4PFQZH43HHV','ent_01M0KJG7NXNSEWCSNX56EP9BH5',
  'ent_01M0N3VJ9T8KAKM4C6K0KDTV8Q'
);

-- Rippling website
SELECT website, industry_tags, funding_stage FROM entities
WHERE id = 'ent_KBHMDN0M103S94YS2PWWW3KFAV';

-- 0 Okara human labels
SELECT COUNT(*) FROM entities
WHERE merged_into IS NULL AND industry_tags && ARRAY['AI & ML','SaaS & productivity','Developer tools'];

-- 0 unclassified tags
SELECT COUNT(*) FROM entities WHERE merged_into IS NULL AND 'unclassified' = ANY(industry_tags);

-- junk mints gone
SELECT COUNT(*) FROM entities WHERE id IN (
  'ent_01M0WV803MJRS5YJHSWY34JK2R','ent_01M0WV8034TMVKMSGF6SE1QRYT',
  'ent_01M0VK853SVTCGNBJ7WB1ZYX3J','ent_01M0NEMQXEYDYF4JDDGXPCTR9X',
  'ent_01M0WXAAKQDASBNBZNX49QZW7H','ent_01M0NEMTR3RAE29D59AEDZAWCB',
  'ent_01M0NFCSG1M3TFSDNREVF6QPCN','ent_01M0X8ME8PQEYYDK5B1C7WAYK1',
  'ent_01M0NT4EVM5GT9PQG57R97A46M','ent_01M0Z2P9K1HS9RPYDHYRNXW9SY',
  'ent_9BJMDN0M10T1YY07BEZTAHZEWF'
);

-- Form D hollow facts no longer accepted
SELECT COUNT(*) FROM facts
WHERE status='accepted' AND type='funding_round' AND dedup_key LIKE 'formd:%'
  AND COALESCE((payload->>'amount_usd_est')::numeric, 0) <= 0
  AND COALESCE(payload->>'funding_stage','') = '';
```

Log actual before/after counts in `AGENT-COORDINATION.md` when you execute.

---

## 14. Suggested execution order

1. Backup tables (section 0).
2. Claim + log in `AGENT-COORDINATION.md`.
3. Generic alias deletes (section 3.1) + unlink wrong primaries (3.2).
4. CIK / domain merges (section 2), then copy missing keeper fields.
5. Verb-glued renames (section 4).
6. Famous card type/stage + Rippling website (section 5).
7. Junk mint deletes (section 6).
8. Okara remap + strip `unclassified` (section 7).
9. Demote hollow Form D facts (section 8).
10. Hollow profiles → pending (section 9).
11. Country `USA` → `US` (section 11).
12. Run verification (section 13).
13. **Stop.** Re-queue mock-kept (section 10) only after a human confirms a real LLM path and the structural harness fixes are live.

If anything conflicts with a later `AGENT-COORDINATION` log entry, follow the log — this playbook is a snapshot of 2026-08-26 ids.
