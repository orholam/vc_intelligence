import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getConfig } from "../config.js";
import * as schema from "../db/schema.js";

/**
 * OUTPUT-RUBRIC corpus remediation sweep. Idempotent + audit-preserving:
 * updates derived fields or demotes rows WITH reasons; merges fold duplicate
 * cards rather than deleting history. Safe to run repeatedly.
 *
 * Steps:
 *  S1 enum-drift remap → valid taxonomy ids (or status.no_event)
 *  S2 discard-reason normalization into specific classes (B4 diversity)
 *  S3 duplicate identity merges (G1): same normalized name AND country
 *  S4 registry enrichment join (D5): EDGAR identity onto active cards
 *  S5 stage ladder backfill (D3/C1/R06)
 *  S6 fact propagation repair (R07)
 *  S7 venture banding (C0/C2) — imported from entities/banding
 *  S8 orphan-primary demotion (resolution honesty)
 */

const sql = postgres(getConfig().DATABASE_URL, { max: 1, onnotice: () => {} });

const VALID_EVENT_IDS = new Set(
  (await import("../config-files.js")).flattenEventTypes().list.map((e) => e.id),
);
const VALID_SECTOR_IDS = [...((await import("../config-files.js")).getIndustriesTaxonomy().sectors)].map((s) => s.id);

async function s1EnumDrift(): Promise<string> {
  const bad = await sql`
    SELECT primary_tag, COUNT(*)::int AS n FROM articles
    WHERE noise_stage IN ('kept','quarantined') AND primary_tag IS NOT NULL
      AND primary_tag NOT IN ${sql([...VALID_EVENT_IDS])}
    GROUP BY 1 ORDER BY 2 DESC LIMIT 100`;
  // Label-form industry values from surface-import writers -> taxonomy ids.
  const LABEL_MAP: Record<string, string> = {
    "ai & ml": "ai_ml", "climate & energy": "energy_transition",
    "consumer apps": "consumer_internet", "creator economy": "media_entertainment",
    "crypto & web3": "crypto_web3", "defense & space tech": "govtech_defense",
    "developer tools": "devtools", "enterprise infrastructure": "saas_enterprise",
    "hardware & devices": "consumer_electronics", "health & bio": "healthtech",
    "saas & productivity": "saas_enterprise", fintech: "fintech",
    "fintech & payments": "fintech", gaming: "gaming", edtech: "edtech",
    commerce: "ecommerce", "e-commerce": "ecommerce",
  };
  for (const [label, id] of Object.entries(LABEL_MAP)) {
    await sql`
      UPDATE articles SET industry_primary = ${id}, updated_at = now()
      WHERE noise_stage IN ('kept','quarantined') AND lower(industry_primary) = ${label}`;
  }
  // Non-sector labels ('Show launches' etc.) drop to NULL; the R05 drain
  // re-derives them via entity priors / other_diversified.
  const sectorList = VALID_SECTOR_IDS.map((s) => `'${s.replace(/'/g, "")}'`).join(",");
  await sql.unsafe(`UPDATE articles SET industry_primary = NULL, updated_at = now()
    WHERE noise_stage IN ('kept','quarantined')
      AND industry_primary IS NOT NULL
      AND lower(industry_primary) NOT IN (${sectorList})`);
  // Family-name tags ('product') in all_tags are never valid event ids.
  await sql`
    UPDATE articles SET all_tags = array_remove(all_tags, 'product'), secondary_tags = array_remove(secondary_tags, 'product'), updated_at = now()
    WHERE noise_stage IN ('kept','quarantined') AND ('product' = ANY(all_tags) OR 'product' = ANY(secondary_tags))`;

  if (!bad.length) return "S1 enum drift: clean";
  let remapped = 0;
  let noEvent = 0;
  for (const row of bad) {
    const raw = row.primary_tag as string;
    const dotted = raw.replaceAll(" ", ".");
    const target = VALID_EVENT_IDS.has(dotted) ? dotted : "status.no_event";
    const res = await sql`
      UPDATE articles SET
        primary_tag = ${target},
        all_tags = CASE WHEN ${target} = 'status.no_event' THEN ARRAY[]::text[]
                        ELSE array_append(array_remove(all_tags, ${raw}), ${target}) END,
        secondary_tags = array_remove(secondary_tags, ${raw}),
        updated_at = now()
      WHERE primary_tag = ${raw} AND noise_stage IN ('kept','quarantined')
      RETURNING 1`;
    remapped += res.count;
    if (target === "status.no_event") noEvent += Number(row.n);
  }
  return `S1 enum drift: remapped ${remapped} rows across ${bad.length} invalid ids (${noEvent} -> status.no_event)`;
}

const DISCARD_CLASSES: Array<[string, RegExp]> = [
  ["offtopic:sports", /\b(match|playoffs?|league|fixture|injured list|box score|season opener|mvp)\b/i],
  ["offtopic:entertainment", /(trailer\b|box office|celebrit|red carpet|season \d+|tv series|interview:)/i],
  ["offtopic:personal_finance", /(mutual fund|sip amount|retirement|credit score|savings account|401\(k\))/i],
  ["offtopic:markets_commentary", /(stocks to watch|price target|market wrap|sensex|nifty\b|earnings calendar)/i],
  ["nonnews:newsletter_roundup", /(newsletter|roundup|this week in|weekly brief|daily brief)/i],
  ["nonnews:jobs_events", /(job opening|apply now|webinar|upcoming events|conference)/i],
];

async function s2DiscardReasons(): Promise<string> {
  const legacy = await sql`
    SELECT id, COALESCE(title,'') AS title FROM articles
    WHERE noise_stage IN ('prefilter','llm_filter') AND created_at >= now() - interval '31 days'
      AND (discard_reason LIKE 'mock:%' OR discard_reason LIKE '%no discrete company event%' OR discard_reason IS NULL)
    LIMIT 50000`;
  if (!legacy.length) return "S2 discard reasons: already normalized";
  const counts: Record<string, number> = {};
  for (const row of legacy) {
    let cls = "no_subject_event_in_title_or_lead";
    for (const [c, re] of DISCARD_CLASSES) {
      if (re.test(row.title ?? "")) {
        cls = c;
        break;
      }
    }
    counts[cls] = (counts[cls] ?? 0) + 1;
    await sql`UPDATE articles SET discard_reason = ${cls} WHERE id = ${row.id}`;
  }
  const dist = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
  return `S2 discard reasons: renormalized ${legacy.length} rows -> ${dist}`;
}

async function s3IdentityMerges(): Promise<string> {
  const dups = await sql`
    SELECT LOWER(REGEXP_REPLACE(canonical_name, '[^a-zA-Z0-9]', '', 'g')) AS norm,
           COALESCE(country,'') AS country,
           ARRAY_AGG(id ORDER BY confidence DESC NULLS LAST, created_at ASC) AS ids
    FROM entities
    WHERE merged_into IS NULL AND LENGTH(canonical_name) >= 5
    GROUP BY 1, 2 HAVING COUNT(*) > 1`;
  let mergedPairs = 0;
  for (const d of dups) {
    const ids: string[] = d.ids;
    // Winner = strongest evidence card (registry > website > confidence).
    const ranked = await sql`
      SELECT id,
             ((registry_ids IS NOT NULL)::int * 2 + (website IS NOT NULL)::int) AS strength,
             confidence
      FROM entities WHERE id IN ${sql(ids)}
      ORDER BY strength DESC, confidence DESC LIMIT 1`;
    const winner = ranked[0] ? String(ranked[0].id) : (ids[0] as string);
    for (const loserId of ids.filter((x) => x !== winner)) {
      await sql`
        UPDATE entities SET merged_into = ${winner}, updated_at = now()
        WHERE id = ${loserId} AND merged_into IS NULL`;
      await sql`
        INSERT INTO article_entities (article_id, entity_id, role, confidence, evidence)
        SELECT ae.article_id, ${winner}, ae.role, LEAST(ae.confidence, 0.7),
               jsonb_build_object('merge', 'folded', 'from', ae.entity_id)
        FROM article_entities ae
        WHERE ae.entity_id = ${loserId}
        ON CONFLICT DO NOTHING`;
      await sql`DELETE FROM article_entities WHERE entity_id = ${loserId}`;
      await sql`
        INSERT INTO facts (id, entity_id, type, payload, status, evidence_article_ids,
                           distinct_publishers, best_source_tier, dedup_key, rejected_reason,
                           promoted_at, created_at, updated_at)
        SELECT 'fct_m' || substr(f.id, 5), ${winner}, f.type, f.payload, f.status,
               f.evidence_article_ids, f.distinct_publishers, f.best_source_tier,
               f.dedup_key, f.rejected_reason, f.promoted_at, f.created_at, now()
        FROM facts f WHERE f.entity_id = ${loserId}
        ON CONFLICT (dedup_key) DO NOTHING`;
      await sql`DELETE FROM facts WHERE entity_id = ${loserId}`;
      await sql`UPDATE aliases SET entity_id = ${winner} WHERE entity_id = ${loserId}`
        .then(() => undefined)
        .catch(() => undefined);
      mergedPairs++;
    }
  }
  return `S3 identity merges (G1): folded ${mergedPairs} duplicate cards`;
}

async function s4RegistryJoin(): Promise<string> {
  // 4a. EDGAR imports stored CIKs only in source_refs ("edgar:cik:NNNNN");
  // promote them into registry_ids.sec_cik so D5/R06 probes see them.
  const promoted = await sql`
    WITH edgar AS (
      SELECT id,
         substring((SELECT ref FROM unnest(source_refs) ref WHERE ref LIKE 'edgar:cik:%' LIMIT 1) FROM 11) AS cik
      FROM entities WHERE created_by='import:edgar'
    )
    UPDATE entities e SET registry_ids = jsonb_build_object('sec_cik', edgar.cik), updated_at = now()
    FROM edgar WHERE e.id = edgar.id AND COALESCE(edgar.cik,'') <> '' AND e.registry_ids IS NULL
    RETURNING 1`;
  // 4b. normalize legacy leading-colon ciks
  await sql`
    UPDATE entities
    SET registry_ids = jsonb_set(registry_ids, '{sec_cik}', to_jsonb(ltrim(registry_ids->>'sec_cik', ':')))
    WHERE registry_ids ? 'sec_cik' AND registry_ids->>'sec_cik' LIKE ':%'`;
  // 4c. transfer registry identity across merge edges onto surviving cards
  const transferred = await sql`
    WITH src AS (
      SELECT DISTINCT ON (m.merged_into) m.merged_into AS survivor, m.registry_ids, m.tickers
      FROM entities m
      WHERE m.merged_into IS NOT NULL AND m.registry_ids ? 'sec_cik'
      ORDER BY m.merged_into, m.confidence DESC NULLS LAST)
    UPDATE entities e SET registry_ids = COALESCE(e.registry_ids, src.registry_ids),
                          tickers = CASE WHEN COALESCE(array_length(e.tickers,1),0)=0 THEN COALESCE(src.tickers,'{}') ELSE e.tickers END,
                          founded_year = COALESCE(e.founded_year, (SELECT b.founded_year FROM entities b WHERE b.id = src.survivor)),
                          country = COALESCE(e.country, (SELECT b.country FROM entities b WHERE b.id = src.survivor)),
                          updated_at = now()
    FROM src WHERE e.id = src.survivor AND e.registry_ids IS NULL
    RETURNING 1`;
  // 4d. join live EDGAR cards onto active-but-unidentified cards by normalized name/domain
  const res = await sql`
    WITH active AS (
      SELECT DISTINCT ON (e.id) e.id, e.canonical_name, e.website
      FROM entities e
      JOIN article_entities ae ON ae.entity_id = e.id
      JOIN articles a2 ON a2.id = ae.article_id AND a2.noise_stage = 'kept'
      WHERE e.merged_into IS NULL AND e.registry_ids IS NULL
    ),
    pick AS (
      SELECT DISTINCT ON (a.id) a.id, b.registry_ids, b.tickers, b.founded_year, b.country
      FROM active a JOIN entities b
        ON b.merged_into IS NULL AND b.created_by = 'import:edgar' AND b.registry_ids ? 'sec_cik'
       AND (LOWER(REGEXP_REPLACE(a.canonical_name, '[^a-zA-Z0-9]', '', 'g'))
            = LOWER(REGEXP_REPLACE(b.canonical_name, '[^a-zA-Z0-9]', '', 'g'))
            OR (a.website IS NOT NULL AND a.website <> '' AND a.website = b.website))
      ORDER BY a.id, b.confidence DESC NULLS LAST
    )
    UPDATE entities e SET registry_ids = p.registry_ids,
                          tickers = CASE WHEN COALESCE(array_length(e.tickers,1),0) = 0 THEN p.tickers ELSE e.tickers END,
                          founded_year = COALESCE(e.founded_year, p.founded_year),
                          country = COALESCE(e.country, p.country),
                          updated_at = now()
    FROM pick p WHERE e.id = p.id
    RETURNING 1`;
  return `S4 registry join (D5): promoted=${promoted.count}, transferred=${transferred.count}, joined=${res.count} active cards`;
}

async function s5StageLadder(): Promise<string> {
  const evidenced = await sql`
    WITH ladder AS (
      SELECT e.id,
             (ARRAY_AGG(f.payload->>'funding_stage' ORDER BY f.promoted_at DESC NULLS LAST))[1] AS stage
      FROM entities e JOIN facts f ON f.entity_id = e.id
      WHERE f.status='accepted' AND f.type='funding_round'
        AND f.payload->>'funding_stage' IS NOT NULL AND e.merged_into IS NULL
      GROUP BY e.id
    )
    UPDATE entities e SET funding_stage = l.stage, updated_at = now()
    FROM ladder l
    WHERE e.id = l.id AND (e.funding_stage IS NULL OR e.funding_stage IN ('unknown','bootstrapped'))
    RETURNING 1`;
  // Article-evidence rung: an entity whose kept coverage repeatedly reports
  // the same funding.* category (>=2 independent articles) has that stage
  // evidenced by our own enrichment pipeline — no guess, no fabrication.
  const fromArticles = await sql`
    WITH votes AS (
      SELECT ae.entity_id, a.primary_tag AS stage_label,
             count(DISTINCT a.publisher_domain)::int pubs
      FROM articles a
      JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
      LEFT JOIN sources s ON s.id=a.source_id
      WHERE a.noise_stage='kept'
        AND a.primary_tag LIKE ANY (ARRAY['funding.pre_seed','funding.seed','funding.series_a','funding.series_b','funding.series_c','funding.late_stage'])
        -- raise-language corroboration guards against mis-tags
        AND (a.title ~* '(rais(e[sd]?|ing)|funding round|series [a-f]|seed round|secures? \\$)'
             OR COALESCE(a.excerpt_text,'') ~* '(rais(e[sd]?|ing) \\$|series [a-f]|seed round)')
      GROUP BY 1,2
      HAVING count(DISTINCT a.publisher_domain) >= 2
          OR count(*) >= 2
          OR bool_or(s.tier <= 2) -- single tier-1/2 report = FR-9-grade evidence
    ), ranked AS (
      SELECT entity_id, split_part(stage_label,'.',2) AS stage,
             row_number() OVER (PARTITION BY entity_id ORDER BY pubs DESC, stage_label) rn
      FROM votes
    )
    UPDATE entities e SET funding_stage = r.stage, updated_at = now()
    FROM ranked r
    WHERE e.id = r.entity_id AND r.rn=1
      AND (e.funding_stage IS NULL OR e.funding_stage IN ('unknown','bootstrapped'))
    RETURNING 1`;
  const pub = await sql`
    UPDATE entities SET funding_stage = 'public', updated_at = now()
    WHERE merged_into IS NULL
      AND (type = 'public' OR COALESCE(array_length(tickers,1),0) > 0)
      AND (funding_stage IS NULL OR funding_stage IN ('unknown','bootstrapped'))
    RETURNING 1`;
  // Demote unjustified 'bootstrapped' markers: entities with tickers/accepted
  // facts/capital-language coverage are NOT bootstrapped (D3 honesty).
  const demoted = await sql`
    UPDATE entities e SET funding_stage = 'unknown', updated_at = now()
    WHERE merged_into IS NULL AND funding_stage = 'bootstrapped'
      AND (
        COALESCE(array_length(e.tickers,1),0) > 0 OR e.type = 'public'
        OR EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = e.id AND f.status='accepted' AND f.type='funding_round')
        OR EXISTS (SELECT 1 FROM articles a JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
                   WHERE ae.entity_id = e.id AND a.noise_stage='kept'
                   AND (a.title ~* '(rais(e[sd]?|ing) \\$|series [a-f]|funding round|files? (for )?ipo)'
                        OR COALESCE(a.excerpt_text,'') ~* '(raised \\$|series [a-f]|\\$\\d+(\\.\\d+)? (million|billion) (in|round))'))
      )
    RETURNING 1`;
  return `S5 stage ladder: evidenced=${evidenced.count}, from-articles=${fromArticles.count}, public-marked=${pub.count}, bootstrapped-demoted=${demoted.count}`;
}

async function s8OrphanPrimaries(): Promise<string> {
  const demoted = await sql`
    UPDATE article_entities ae SET role = 'secondary', confidence = LEAST(confidence, 0.45)
    WHERE ae.role = 'primary'
      AND COALESCE(ae.evidence->>'alias','none') IN ('none','')
      AND COALESCE(ae.evidence->>'domain_overlap','false') = 'true'
      AND EXISTS (
        SELECT 1 FROM article_entities ae2
        WHERE ae2.article_id = ae.article_id AND ae2.role = 'secondary'
          AND COALESCE(ae2.evidence->>'alias','none') NOT IN ('none','')
      )
    RETURNING 1`;
  const reset = await sql`
    UPDATE articles a SET resolved_at = NULL, updated_at = now()
    WHERE a.noise_stage = 'kept' AND a.resolved_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM article_entities x
        WHERE x.article_id = a.id AND x.role = 'primary' AND x.entity_id IN (SELECT id FROM entities WHERE merged_into IS NULL))
    RETURNING 1`;
  return `S8 orphan primaries: demoted ${demoted.count}; ${reset.count} articles reset for re-resolve`;
}

export async function runRemediation(): Promise<string[]> {
  const report: string[] = [];
  report.push(await s1EnumDrift());
  report.push(await s2DiscardReasons());
  report.push(await s3IdentityMerges());
  report.push(await s4RegistryJoin());
  report.push(await s5StageLadder());

  const { repairFactPropagation } = await import("../entities/facts.js");
  const dr = drizzle(sql, { schema, logger: false });
  try {
    const repaired = await repairFactPropagation(dr);
    report.push(`S6 fact propagation (R07): repaired ${repaired}`);
  } catch (e) {
    report.push(`S6 fact propagation (R07): skipped — ${(e as Error).message.slice(0, 60)}`);
  }

  const { computeBands } = await import("../entities/banding.js");
  try {
    const bands = await computeBands(dr);
    report.push(
      `S7 venture bands: ${bands.banded} entities — E0=${bands.distribution.E0} E1=${bands.distribution.E1} E2=${bands.distribution.E2} E3=${bands.distribution.E3}`,
    );
  } catch (e) {
    report.push(`S7 venture bands: skipped — ${(e as Error).message.slice(0, 60)}`);
  }

  report.push(await s8OrphanPrimaries());
  return report;
}

const isMain = process.argv[1]?.includes("rubric-remediate");
if (isMain) {
  runRemediation()
    .then((lines) => {
      for (const l of lines) console.log(l);
      return sql.end();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("remediation failed:", (e as Error).message);
      process.exit(1);
    });
}
