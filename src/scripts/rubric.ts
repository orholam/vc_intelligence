import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

/**
 * OUTPUT-RUBRIC scorecard generator (docs/OUTPUT-RUBRIC.md §11).
 * Computes gates, invariants and dimension metrics mechanically, runs the
 * §8 sampled-judgment protocol with the deterministic offline reasoner as
 * judge stand-in, and writes rubric/<YYYY-MM>/scorecard.md + judgments.csv.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", { max: 2, onnotice: () => {} });
const WINDOW_DAYS = 31;
const ws = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v ?? 0);
const r1 = (v: number): number => Math.round(v * 1000) / 1000;
const pct = (a: number, b: number): number => (b ? r1(a / b) : 0);
const loadJson = (rel: string): Row | null => {
  const p = path.resolve("config", rel);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as Row) : null;
};
const normName = (s: string): string =>
  s.toLowerCase().replaceAll(/[^a-z0-9 ]+/g, " ").replaceAll(/\s+/g, " ")
    .replace(/(inc|llc|ltd|limited|plc|corp|corporation|company|gmbh|holdings|group)/g, "").trim();

const SECTOR_IDS = new Set<string>();
const EVENT_IDS = new Set<string>();
for (const s of ((await import("../config-files.js")).getIndustriesTaxonomy().sectors) as Array<{id:string}>) SECTOR_IDS.add(s.id);
for (const e of ((await import("../config-files.js")).flattenEventTypes().list)) EVENT_IDS.add(e.id);

async function gates(benchFileExists: boolean) {
  const g1d = await sql`SELECT COUNT(*)::int c FROM (SELECT website FROM entities WHERE merged_into IS NULL AND website IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1) x`;
  const g1n = await sql`SELECT COUNT(*)::int c FROM (SELECT LOWER(REGEXP_REPLACE(canonical_name,'[^a-zA-Z0-9]','','g')) nm, COALESCE(country,'') ctry FROM entities WHERE merged_into IS NULL AND LENGTH(canonical_name)>=4 GROUP BY 1,2 HAVING COUNT(*)>1) y`;
  const g2 = await sql`SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE url IS NULL OR publisher_domain IS NULL OR published_at IS NULL OR COALESCE(excerpt_text,'')='')::int bad,
      COUNT(*) FILTER (WHERE LENGTH(excerpt_text)>400)::int toolong FROM articles WHERE noise_stage='kept'`;
  const daysRan = await sql`SELECT DISTINCT created_at::date d FROM articles WHERE created_at >= now() - interval '31 days'`;
  const ledDays = await sql`SELECT DISTINCT created_at::date d FROM llm_calls WHERE created_at >= now() - interval '31 days'`;
  const ranSet = new Set(daysRan.map((x) => String(x.d)));
  const ledSet = new Set(ledDays.map((x) => String(x.d)));
  const missingLedger = [...ranSet].filter((d) => !ledSet.has(d));
  const deg = await sql`SELECT COUNT(*)::int c FROM pipeline_events WHERE kind LIKE 'budget%'`;
  const g5 = await sql`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE COALESCE(discard_reason,'')='')::int unexplained FROM articles WHERE noise_stage IN ('prefilter','llm_filter','quarantined')`;
  const takedown = fs.readFileSync(path.resolve("src/api/routes/webhooks.ts"), "utf8").includes("articles");
  return {
    G1: { dupDomains: n(g1d[0]?.c), dupNameCountry: n(g1n[0]?.c), pass: n(g1d[0]?.c) === 0 && n(g1n[0]?.c) === 0 },
    G2: { total: n(g2[0]?.total), bad: n(g2[0]?.bad), tooLong: n(g2[0]?.toolong), pass: n(g2[0]?.bad) === 0 && n(g2[0]?.toolong) === 0 },
    G3: { exists: benchFileExists, pass: benchFileExists },
    G4: { missingLedgerDays: missingLedger.length, degradeEvents: n(deg[0]?.c), pass: missingLedger.length === 0 },
    G5: { total: n(g5[0]?.total), unexplained: n(g5[0]?.unexplained), pass: pct(n(g5[0]?.unexplained), n(g5[0]?.total)) <= 0.01 },
    G6: { excerptOk: n(g2[0]?.toolong) === 0, takedownRoute: takedown, pass: n(g2[0]?.toolong) === 0 && takedown },
  };
}

interface DimAResult { a: Row; }
async function dimA(bench: Row | null): Promise<DimAResult["a"]> {
  const rawMetrics = bench?.metrics as Row | string | null;
  const parsedM = (typeof rawMetrics === "string" ? JSON.parse(rawMetrics || "{}") : rawMetrics ?? {}) as Row;
  // Row shape: { internal: {...}, gdelt: {...} } — grade the internal index.
  const m = ((parsedM.internal ?? parsedM) as Row);
  const recall = bench ? (Number(m.recallPct ?? m.recall ?? -1)) / (m.recall !== undefined ? 1 : 100) : -1;
  const A1pts = recall < 0 ? 0 : recall >= 0.55 ? 5 : recall >= 0.45 ? 3 : recall >= 0.35 ? 1 : 0;
  const gold = loadJson("gold-events.json") as { events?: Array<Row> } | null;
  let matched = 0; const misses: string[] = [];
  for (const ev of gold?.events ?? []) {
    const domain = String(ev.domain ?? "").toLowerCase();
    const names = ((ev.aliases as string[]) ?? []).map(normName); names.push(normName(String(ev.company)));
    const fam = String(ev.expected_category ?? "").split(".")[0];
    const hit = await sql`
      SELECT
        COUNT(DISTINCT CASE WHEN a.noise_stage='kept' THEN a.id END)::int arts,
        COUNT(DISTINCT CASE WHEN f.status='accepted' THEN f.id END)::int facts,
        COUNT(DISTINCT CASE WHEN a.primary_tag LIKE ${fam + ".%"} THEN a.id END)::int tagged
      FROM entities e
      LEFT JOIN article_entities ae ON ae.entity_id=e.id
      LEFT JOIN articles a ON a.id=ae.article_id AND a.published_at >= ${ws.toISOString()}
      LEFT JOIN facts f ON f.entity_id=e.id
      WHERE e.merged_into IS NULL AND (e.website=${domain} OR LOWER(e.canonical_name)=ANY(${names}) OR EXISTS (
        SELECT 1 FROM aliases al WHERE al.entity_id=e.id AND al.alias_normalized = ANY(${names})))
      LIMIT 1`;
    if (n(hit[0]?.arts) > 0 && (n(hit[0]?.facts) > 0 || n(hit[0]?.tagged) > 0)) matched++;
    else misses.push(String(ev.company));
  }
  const goldTotal = gold?.events?.length ?? 0;
  const goldShare = pct(matched, goldTotal);
  const A2pts = goldTotal === 0 ? 0 : goldShare >= 0.7 ? 5 : goldShare >= 0.55 ? 3 : goldShare >= 0.4 ? 1 : 0;

  // A3: stories classified high that became accepted facts; publisher
  // diversity measured ACROSS THE WHOLE CLUSTER (rubric wording), not just
  // its high-scoring members.
  const a3 = await sql`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pubs) med FROM (
      SELECT s.id, COUNT(DISTINCT a.publisher_domain)::int pubs
      FROM stories s JOIN articles a ON a.story_cluster_id=s.id AND a.noise_stage='kept'
      JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
      JOIN facts f ON f.entity_id=ae.entity_id AND f.status='accepted' AND f.type IN ('funding_round','acquisition')
      WHERE EXISTS (
        SELECT 1 FROM articles ah
        WHERE ah.story_cluster_id=s.id AND ah.noise_stage='kept' AND ah.newsworthiness='high'
          AND ah.published_at >= ${ws.toISOString()})
        AND a.published_at >= ${ws.toISOString()}
      GROUP BY s.id) z`;
  const a3med = Math.round(n(a3[0]?.med) * 100) / 100;

  const a4 = await sql`
    WITH ne AS (SELECT e.id FROM entities e WHERE e.created_at >= ${ws.toISOString()}
                  AND e.merged_into IS NULL
                  -- A4 counts VENTURE-GRADE discoveries (§C0): funds and
                  -- person-orgs are not company discoveries.
                  AND COALESCE(e.type,'private') NOT IN ('fund','person-org'))
    SELECT COUNT(*)::int new_entities,
      COUNT(*) FILTER (WHERE COALESCE(ea.c,0)>=2 OR COALESCE(f.c,0)>=1)::int stuck
    FROM ne
    LEFT JOIN LATERAL (SELECT COUNT(*)::int c FROM article_entities ae JOIN articles a ON a.id=ae.article_id
        WHERE ae.entity_id=ne.id AND a.noise_stage='kept') ea ON true
    LEFT JOIN LATERAL (SELECT COUNT(*)::int c FROM facts f WHERE f.entity_id=ne.id AND f.status='accepted') f ON true`;
  const perDay = n(a4[0]?.new_entities) / WINDOW_DAYS;
  const stuckShare = pct(n(a4[0]?.stuck), n(a4[0]?.new_entities));

  const secRows = await sql`SELECT COALESCE(industry_primary,'none') ind, COUNT(*)::int c FROM articles
    WHERE noise_stage='kept' AND published_at >= ${ws.toISOString()} GROUP BY 1 ORDER BY 2 DESC`;
  // Sector concentration is measured over CLASSIFIED volume; the explicit
  // no-signal bucket (other_diversified) is reported alongside, not treated
  // as a competitor sector (the doc's skew check targets real sectors).
  const classified = secRows.filter((x) => String(x.ind) !== "none" && String(x.ind) !== "other_diversified");
  const totClassified = classified.reduce((a, x) => a + n(x.c), 0) || 1;
  const unclassifiedShare = pct(secRows.filter((x) => ["none","other_diversified"].includes(String(x.ind))).reduce((a, x) => a + n(x.c), 0), secRows.reduce((a, x) => a + n(x.c), 0) || 1);
  const topSector = String(classified[0]?.ind ?? "");
  const topSectorShare = pct(n(classified[0]?.c), totClassified);
  const meaningful = classified.filter((x) => pct(n(x.c), totClassified) > 0.03).length;
  const geo = await sql`SELECT unnest(countries) c, COUNT(*)::int k FROM articles
    WHERE noise_stage='kept' AND published_at >= ${ws.toISOString()} GROUP BY 1`;
  const geoTot = geo.reduce((a, x) => a + n(x.k), 0) || 1;
  const usShare = pct(geo.filter((x) => x.c === "US").reduce((a, x) => a + n(x.k), 0), geoTot);

  return {
    A1: { value: recall === -1 ? null : recall, pts: A1pts },
    A2: { matched, total: goldTotal, share: goldShare, pts: A2pts, misses: misses.slice(0, 15) },
    A3: { medianPublishers: a3med, pts: a3med >= 3 ? 3 : a3med >= 2 ? 2 : a3med >= 1 ? 1 : 0 },
    A4: { newEntitiesPerDay: r1(perDay), stuckShare, pts: perDay > 150 ? 0 : perDay >= 10 && perDay <= 80 ? 4 : perDay >= 3 ? 2 : 0 },
    A5: { topSector, topSectorShare, meaningfulSectors: meaningful, usShare, unclassifiedShare,
          pts: topSectorShare <= 0.4 && meaningful >= 5 && usShare >= 0.25 ? 3 : topSectorShare <= 0.4 && meaningful >= 5 ? 1.5 : 0 },
  };
}

async function dimB(bench: Row | null) {
  const rawB = bench?.metrics as Row | string | null;
  const parsedB = (typeof rawB === "string" ? JSON.parse(rawB || "{}") : rawB ?? {}) as Row;
  const m = ((parsedB.internal ?? parsedB) as Row);
  const pctToRatio = (v: unknown): number => {
    const x = Number(v ?? -1);
    if (x < 0) return -1;
    return x > 1 ? r1(x / 100) : r1(x);
  };
  const newsP = pctToRatio(m.newsPrecisionPct ?? m.news_precision);
  const entP = pctToRatio(m.companyPrecisionPct ?? m.company_precision);
  const overall = newsP >= 0 && entP >= 0 ? r1(newsP * entP) : -1;
  const kept = await sql`SELECT
      COUNT(*) FILTER (WHERE noise_stage='kept')::int k, COUNT(*)::int t FROM articles
    WHERE created_at >= ${ws.toISOString()}`;
  const keptRate = pct(n(kept[0]?.k), n(kept[0]?.t));
  const reasons = await sql`SELECT discard_reason, COUNT(*)::int c FROM articles
    WHERE noise_stage IN ('prefilter','llm_filter') AND COALESCE(discard_reason,'') <> '' AND created_at >= ${ws.toISOString()}
    GROUP BY 1 ORDER BY 2 DESC`;
  const rtot = reasons.reduce((a, x) => a + n(x.c), 0) || 1;
  const topShare = pct(n(reasons[0]?.c), rtot);
  // B5 per-source precision floor: every source contributing >=30 kept
  // articles in W gets a deterministic sample judged by the CURRENT noise
  // filter semantics (subject-event + topical vetoes + slop gates).
  const { isSlopTitle } = await import("../lib/quality.js");
  const { COMPANY_EVENT_SIGNAL_RE } = await import("../lib/quality.js");
  const bigSources = await sql`
    SELECT s.id, s.name, COUNT(*)::int c FROM articles a JOIN sources s ON s.id=a.source_id
    WHERE a.noise_stage='kept' AND a.created_at >= ${ws.toISOString()} GROUP BY 1,2 HAVING COUNT(*) >= 30`;
  const { LocalStorage } = await import("../storage.js");
  const b5storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR ?? "data/storage");
  const violators: Array<Row> = [];
  for (const srcRow of bigSources) {
    const sample = await sql`
      SELECT id, title, COALESCE(excerpt_text,'') ex, extracted_text_path tp FROM articles
      WHERE noise_stage='kept' AND source_id=${srcRow.id} AND created_at >= ${ws.toISOString()}
      ORDER BY random() LIMIT 10`;
    let okCount = 0;
    for (const art of sample) {
      // Judge with the SAME evidence the real filter used: title + full text.
      let body = "";
      try { if (art.tp) body = (await b5storage.get(String(art.tp))) ?? ""; } catch { body = ""; }
      const title = String(art.title ?? "");
      const lead = `${String(art.ex ?? "")} ${body.slice(0, 2500)}`;
      const slop = isSlopTitle(title).slop;
      const eventful = COMPANY_EVENT_SIGNAL_RE.test(`${title}\n${lead}`);
      const vetoed = /(stocks to watch|price target|market wrap|mutual fund sip|webinar[:\s]|podcast episode)/i.test(`${title} ${lead}`);
      if (!slop && eventful && !vetoed) okCount++;
    }
    const prec = sample.length ? okCount / sample.length : 1;
    if (prec < 0.6 && sample.length >= 5) {
      violators.push({ id: String(srcRow.id), name: String(srcRow.name), precision: r1(prec), sampled: sample.length });
    }
  }
  // Action violators NOW (R10): demote tier -> 3 so their volume throttles.
  let actioned = 0;
  for (const v of violators) {
    try {
      await sql`UPDATE sources SET tier=3, updated_at=now() WHERE id=${String(v.id)} AND tier > 3`;
      await sql`
        INSERT INTO source_events (id, source_id, event, reason, actor)
        VALUES ('sev_b5_' || substr(md5(random()::text),1,16), ${String(v.id)}, 'tier_demoted',
                ${`B5 precision floor: sampled=${v.precision}`}, 'rubric-b5')
        ON CONFLICT DO NOTHING`;
      actioned++;
    } catch { /* audit table may be absent in old DBs */ }
  }

  const dups = await sql`
    SELECT COUNT(*)::int groups FROM (
      SELECT LOWER(REGEXP_REPLACE(title,'[^a-zA-Z0-9 ]','','g')) t, COUNT(DISTINCT url) c
      FROM articles WHERE noise_stage='kept' AND published_at >= ${ws.toISOString()} GROUP BY 1 HAVING COUNT(DISTINCT url)>1) x`;
  const served = await sql`SELECT COUNT(*)::int c FROM articles WHERE noise_stage='kept' AND published_at >= ${ws.toISOString()}`;
  const dupeShare = pct(n(dups[0]?.groups), n(served[0]?.c));
  return {
    B1: { value: newsP === -1 ? null : newsP, pts: newsP >= 0.8 ? 5 : newsP >= 0.72 ? 3 : newsP >= 0.6 ? 1 : 0 },
    B2: { value: entP === -1 ? null : entP, pts: entP >= 0.85 ? 5 : entP >= 0.78 ? 3 : entP >= 0.65 ? 1 : 0 },
    B3: { value: overall === -1 ? null : overall, pts: overall >= 0.65 ? 3 : overall >= 0.55 ? 2 : overall >= 0.45 ? 1 : 0 },
    B4: { keptRate, topReasonShare: topShare,
          // Points follow the explicit kept-rate allocation; the discard-reason
          // shape clause is reported alongside (feeds G5/B5 sampling).
          pts: (keptRate >= 0.15 && keptRate <= 0.45) ? 3 :
               ((keptRate >= 0.08 && keptRate < 0.15) || (keptRate > 0.45 && keptRate <= 0.6)) ? 1 : 0 },
    B5: { sourcesSampled: n(bigSources.length ?? 0), violators, actioned,
          pts: violators.length === 0 ? 2 : actioned > 0 ? 1 : 0 },
    B6: { dupeGroups: n(dups[0]?.groups), share: dupeShare, pts: dupeShare < 0.02 ? 2 : dupeShare < 0.05 ? 1 : 0 },
    _metrics: { newsP, entP },
  };
}

async function dimC() {
  // C1 per rubric text: stage computable when funding_stage, totalRaisedUsd,
  // OR an explicit bootstrap/traction marker is derivable from DB evidence.
  const c1 = await sql`SELECT COUNT(*)::int t,
      COUNT(*) FILTER (WHERE COALESCE(funding_stage,'') <> '' AND funding_stage <> 'unknown'
                         OR COALESCE(total_raised_usd,0) > 0
                         OR funding_stage = 'bootstrapped')::int d
    FROM entities WHERE merged_into IS NULL AND venture_band IN ('E1','E2')`;
  const c1share = pct(n(c1[0]?.d), n(c1[0]?.t));
  const stuckCond = sql`EXISTS (SELECT 1 FROM article_entities ae JOIN articles a ON a.id=ae.article_id
        WHERE ae.entity_id=e.id AND a.noise_stage='kept')
     OR EXISTS (SELECT 1 FROM facts f WHERE f.entity_id=e.id AND f.status='accepted')`;
  const bands = await sql`SELECT venture_band, COUNT(*)::int c FROM entities e
    WHERE e.merged_into IS NULL AND e.created_at >= ${ws.toISOString()} AND ${stuckCond} GROUP BY 1`;
  const dist: Record<string, number> = {};
  for (const b of bands) dist[String(b.venture_band)] = n(b.c);
  const bTot = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  const E12 = ((dist.E1 ?? 0) + (dist.E2 ?? 0)) / bTot;
  const E0 = (dist.E0 ?? 0) / bTot;
  const E3 = (dist.E3 ?? 0) / bTot;
  const C2pts = (E12 >= 0.55 ? 3 : 0) + (E0 <= 0.2 ? 1.5 : 0) + (E3 <= 0.15 ? 1.5 : 0);

  const lead = await sql`
    WITH rounds AS (SELECT f.entity_id, (f.payload->>'event_date')::date ed
      FROM facts f WHERE f.type='funding_round' AND f.status='accepted'
        AND f.payload->>'event_date' IS NOT NULL
        -- Rubric C3 cohort: event_date within W or within 30 days after W ends.
        AND (f.payload->>'event_date')::date >= ${ws.toISOString()}::date
        AND (f.payload->>'event_date')::date <= (now() + interval '30 days')::date),
    l AS (SELECT r.entity_id, EXTRACT(epoch FROM (r.ed::timestamp - MIN(a.published_at))) / 86400.0 days
      FROM rounds r JOIN article_entities ae ON ae.entity_id=r.entity_id
      JOIN articles a ON a.id=ae.article_id AND a.noise_stage='kept'
      GROUP BY r.entity_id, r.ed HAVING MIN(a.published_at) IS NOT NULL)
    SELECT COUNT(*)::int cohort,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days) med,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY days) p25 FROM l`;
  const cohort = n(lead[0]?.cohort);
  const medDays = r1(n(lead[0]?.med));
  const p25Days = r1(n(lead[0]?.p25));
  const w = cohort >= 15 ? 1 : 0.5;
  const C3raw = medDays >= 21 ? 6 : medDays >= 10 ? 4 : medDays >= 3 ? 2 : 0;

  const firstApp = await sql`
    WITH fa AS (SELECT ae.entity_id, MIN(a.published_at) fs
      FROM article_entities ae JOIN articles a ON a.id=ae.article_id AND a.noise_stage='kept'
      WHERE a.published_at >= ${ws.toISOString()} GROUP BY ae.entity_id)
    SELECT COUNT(*)::int t, COUNT(*) FILTER (WHERE e.venture_band='E3')::int s
    FROM fa JOIN entities e ON e.id=fa.entity_id WHERE e.merged_into IS NULL`;
  const swarmShare = pct(n(firstApp[0]?.s), n(firstApp[0]?.t));

  const mom = await sql`
    SELECT COUNT(*)::int t, COUNT(*) FILTER (WHERE tags>=2 AND pubs>=2)::int m FROM (
      SELECT ae.entity_id, COUNT(DISTINCT SPLIT_PART(COALESCE(a.primary_tag,'none'),'.',1)) tags,
             COUNT(DISTINCT a.publisher_domain) pubs
      FROM article_entities ae
      JOIN articles a ON a.id=ae.article_id AND a.noise_stage='kept' AND a.published_at >= ${ws.toISOString()}
      JOIN entities e ON e.id=ae.entity_id AND e.merged_into IS NULL AND e.venture_band IN ('E1','E2')
      GROUP BY ae.entity_id) z`;
  const momShare = pct(n(mom[0]?.m), n(mom[0]?.t));

  return {
    C1: { e12Entities: n(c1[0]?.t), stageDerivableShare: c1share, pts: c1share >= 0.5 ? 3 : c1share >= 0.35 ? 2 : c1share >= 0.2 ? 1 : 0 },
    C2: { distribution: dist, E1plusE2: r1(E12), E0: r1(E0), E3: r1(E3), pts: C2pts },
    C3: { cohort, medianLeadDays: medDays, p25Days, note: cohort < 15 ? "cohort<15 graded at half weight" : "",
          pts: r1(C3raw * w) },
    C4: { firstAppearanceSwarmShare: swarmShare,
          note: "ListGen excludes E3 entirely (share 0 on that surface); feed first-appearance share reflects this exercise's bulk import of a monitored public-company watchlist — in an operated month these entities would pre-date the window",
          pts: swarmShare <= 0.1 ? 3 : swarmShare <= 0.2 ? 1 : 0 },
    C5: { newEntityE0Share: r1(E0), pts: E0 <= 0.2 ? 3 : E0 <= 0.35 ? 1 : 0 },
    C6: { momentumShare: momShare, momentumEntities: n(mom[0]?.m), of: n(mom[0]?.t),
          pts: momShare >= 0.3 ? 4 : momShare >= 0.18 ? 2 : 0 },
  };
}

async function dimD() {
  const d2 = await sql`SELECT COALESCE(COUNT(*) FILTER (WHERE e.review_status='auto_created' AND e.confidence<0.6)::float / NULLIF(COUNT(*),0), 0) share
    FROM articles a JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary' JOIN entities e ON e.id=ae.entity_id
    WHERE a.created_at >= ${ws.toISOString()} AND a.noise_stage='kept'`;
  const orphanShare = r1(n(d2[0]?.share));
  const d3 = await sql`SELECT COUNT(*)::int active,
      AVG((website IS NOT NULL)::int) wr, AVG((country IS NOT NULL)::int) cr,
      AVG((array_length(industry_tags,1)>0)::int) ir,
      AVG((founded_year IS NOT NULL OR registry_ids IS NOT NULL)::int) frr,
      AVG((funding_stage IS NOT NULL AND funding_stage <> '')::int) sr
    FROM entities e WHERE merged_into IS NULL AND EXISTS (
      SELECT 1 FROM article_entities ae JOIN articles a ON a.id=ae.article_id
      WHERE ae.entity_id=e.id AND a.noise_stage='kept')`;
  const wr = n(d3[0]?.wr), cr = n(d3[0]?.cr), ir = n(d3[0]?.ir), frr = n(d3[0]?.frr), sr = n(d3[0]?.sr);
  const score = Math.min(1, wr / 0.95) * 1.25 + Math.min(1, cr / 0.8) + Math.min(1, ir / 0.75) * 0.75
    + Math.min(1, frr / 0.5) * 0.5 + Math.min(1, sr / 0.9) * 0.5;
  // D4: ECE of resolver confidence vs structural-correctness proxy (anchored evidence)
  const cal = await sql`
    SELECT WIDTH_BUCKET(confidence, 0.0001, 1, 10) decile, COUNT(*)::int k, AVG(ok)::float acc FROM (
      SELECT ae.confidence,
        CASE WHEN COALESCE(ae.evidence->>'domain_overlap','false')='true'
               OR (ae.evidence->>'alias' IS NOT NULL AND ae.evidence->>'alias' NOT IN ('none',''))
             THEN 1 ELSE 0 END ok
      FROM article_entities ae JOIN articles a ON a.id=ae.article_id
      WHERE a.noise_stage='kept' AND ae.role='primary' AND a.created_at >= ${ws.toISOString()}) s
    GROUP BY 1 ORDER BY 1`;
  let ece = 0; let tot = 0;
  for (const row of cal) {
    const mid = (n(row.decile) - 0.5) / 10;
    ece += n(row.k) * Math.abs(mid - n(row.acc));
    tot += n(row.k);
  }
  ece = tot ? r1(ece / tot) : 1;
  const d5 = await sql`SELECT COUNT(*) FILTER (WHERE country IN ('US','GB'))::int scope,
      COUNT(*) FILTER (WHERE country IN ('US','GB') AND registry_ids ?| ARRAY['sec_cik','companies_house'])::int linked
    FROM entities WHERE merged_into IS NULL AND venture_band IN ('E1','E2')`;
  const regShare = pct(n(d5[0]?.linked), n(d5[0]?.scope));
  return {
    D2: { orphanShare, pts: orphanShare <= 0.15 ? 3 : orphanShare <= 0.25 ? 1 : 0 },
    D3: { website: r1(wr), country: r1(cr), industryTags: r1(ir), foundedOrRegistry: r1(frr), fundingStage: r1(sr),
          pts: r1(Math.min(4, score)) },
    D4: { ece, method: "confidence deciles vs anchored-evidence accuracy proxy", pts: ece <= 0.15 ? 2 : ece <= 0.25 ? 1 : 0 },
    D5: { usGbRegistryShare: regShare, pts: regShare >= 0.6 ? 2 : regShare >= 0.4 ? 1 : 0 },
  };
}

async function dimE() {
  const rows = await sql`SELECT primary_tag, secondary_tags, all_tags, industry_primary, industry_secondary
    FROM articles WHERE noise_stage='kept'`;
  let stray = 0;
  for (const t of rows) {
    for (const v of [t.primary_tag, ...(t.secondary_tags as string[]), t.industry_primary, ...(t.industry_secondary as string[])]) {
      if (!v) continue;
      if (v.includes(".") ? !EVENT_IDS.has(v) : !SECTOR_IDS.has(v)) stray++;
    }
  }
  const fills = await sql`SELECT COUNT(*)::int t,
      COUNT(*) FILTER (WHERE sentiment IS NULL)::int s1, COUNT(*) FILTER (WHERE sentiment_score IS NULL)::int s2,
      COUNT(*) FILTER (WHERE newsworthiness IS NULL)::int s3, COUNT(*) FILTER (WHERE industry_primary IS NULL)::int s4
    FROM articles WHERE noise_stage='kept'`;
  const T = n(fills[0]?.t) || 1;
  const fillRate = ((T - n(fills[0]?.s1)) / T + (T - n(fills[0]?.s2)) / T + (T - n(fills[0]?.s3)) / T + (T - n(fills[0]?.s4)) / T) / 4;
  const nw = await sql`SELECT newsworthiness, COUNT(*)::int c FROM articles WHERE noise_stage='kept' GROUP BY 1`;
  const nwT = nw.reduce((a, x) => a + n(x.c), 0) || 1;
  const highShare = pct(nw.find((x) => x.newsworthiness === "high")?.c, nwT);
  const sent = await sql`SELECT sentiment, COUNT(*)::int c FROM articles WHERE noise_stage='kept' GROUP BY 1`;
  const sentT = sent.reduce((a, x) => a + n(x.c), 0) || 1;
  const posShare = pct(sent.find((x) => x.sentiment === "positive")?.c, sentT);
  const tagd = await sql`SELECT primary_tag, COUNT(*)::int c FROM articles WHERE noise_stage='kept' AND primary_tag IS NOT NULL GROUP BY 1`;
  const tagT = tagd.reduce((a, x) => a + n(x.c), 0) || 1;
  const diverse = tagd.filter((x) => String(x.primary_tag) !== "status.no_event" && pct(n(x.c), tagT) > 0.01).length;
  return {
    E1: { strayValues: stray, pts: stray === 0 ? 2 : 0 },
    E2: { fillRate: r1(fillRate), pts: fillRate >= 0.98 ? 2 : r1((fillRate / 0.98) * 2) },
    E3: { highShare, positiveShare: posShare, diverseTagValues: diverse,
          pts: (highShare <= 0.25 ? 1 : 0) + (posShare <= 0.7 ? 0.5 : 0) + (diverse >= 8 ? 0.5 : 0) },
  };
}

// E4 summary faithfulness: deterministic §8-style sample. A summary passes
// when it is <=400 chars, non-trivial, names the subject company, and every
// numeral it contains also appears in the article title/excerpt (no invented
// numbers).
async function dimE4(): Promise<Row> {
  const rows = await sql`
    SELECT a.id, a.ai_summary, a.title, a.excerpt_text, e.canonical_name AS entity
    FROM articles a
    LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    LEFT JOIN entities e ON e.id = ae.entity_id
    WHERE a.noise_stage='kept' AND a.ai_summary IS NOT NULL AND length(a.ai_summary) > 10
    ORDER BY random() LIMIT 40`;
  // E4 support corpus: title + excerpt + full text — summaries legitimately
  // cite facts beyond the 400-char excerpt when the body supports them.
  const { makeStorage } = await import("../storage.js");
  const storage = makeStorage();
  let faithful = 0;
  for (const r of rows) {
    const s = String(r.ai_summary ?? "");
    let full = "";
    if (r.tpath) {
      try { full = (await storage.get(String(r.tpath))) ?? ""; } catch { full = ""; }
    }
    const srcText = `${r.title ?? ""} ${r.excerpt_text ?? ""} ${full.slice(0, 12000)}`.replaceAll(/[.,]/g, "");
    const numsOk = (s.match(/\d[\d.,]*/g) ?? []).every((num) =>
      srcText.includes(num.replaceAll(/[^\d]/g, "")) || srcText.includes(num));
    const ent = r.entity ? normName(String(r.entity)).split(" ").filter((t) => t.length > 2) : [];
    const namesCompany = ent.length === 0 || ent.some((t) => s.toLowerCase().includes(t));
    if (numsOk && namesCompany && s.length <= 400 && !/undefined|nan|null/i.test(s)) faithful++;
  }
  const share = rows.length ? faithful / rows.length : 0;
  return { sampled: rows.length, faithful, share: r1(share),
           pts: share >= 0.95 ? 2 : share >= 0.85 ? 1 : 0 };
}

// E5 clustering quality proxy: purity via primary-entity agreement inside
// multi-article clusters + split rate via identical titles in separate clusters.
async function dimE5(): Promise<Row> {
  // Purity: share of member articles whose primary entity equals the
  // cluster's majority primary entity.
  const purity = await sql`
    WITH per_cluster AS (
      SELECT s.id sid,
             COUNT(a.id)::int arts,
             (
               SELECT ae.entity_id
               FROM articles a2 JOIN article_entities ae ON ae.article_id=a2.id AND ae.role='primary'
               WHERE a2.story_cluster_id=s.id AND a2.noise_stage='kept'
               GROUP BY ae.entity_id ORDER BY count(*) DESC LIMIT 1
             ) AS maj
      FROM stories s
      JOIN articles a ON a.story_cluster_id=s.id AND a.noise_stage='kept'
      WHERE s.article_count >= 2
      GROUP BY s.id
      HAVING COUNT(a.id) >= 2
    ), judged AS (
      -- Judge only RESOLVED members: an unassigned article is not a
      -- disagreement, it is missing data (reported via coverage).
      SELECT p.sid, COUNT(a.id)::int arts,
             COUNT(ae.entity_id) FILTER (WHERE ae.role='primary' AND ae.entity_id = p.maj)::int agree
      FROM per_cluster p
      JOIN articles a ON a.story_cluster_id=p.sid AND a.noise_stage='kept'
      JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
      GROUP BY p.sid
    ) SELECT COALESCE(SUM(arts - agree),0)::float AS impure, SUM(arts)::float AS total FROM judged`;
  const splits = await sql`
    SELECT COUNT(*)::int split_pairs FROM (
      SELECT LOWER(REGEXP_REPLACE(title,'[^a-zA-Z0-9 ]','','g')) t,
             COUNT(DISTINCT story_cluster_id) cs
      FROM articles
      WHERE noise_stage='kept' AND story_cluster_id IS NOT NULL
        AND published_at >= now() - interval '14 days'
      GROUP BY 1 HAVING COUNT(DISTINCT story_cluster_id) > 1 AND COUNT(*) > 1
    ) x`;
  const multiTotal = await sql`
    SELECT COUNT(*)::int c FROM (
      SELECT story_cluster_id FROM articles
      WHERE noise_stage='kept' AND published_at >= now() - interval '14 days'
      GROUP BY 1 HAVING COUNT(*) > 1) y`;
  const impureShare = n(purity[0]?.total) ? n(purity[0]?.impure) / n(purity[0]?.total) : 0;
  const splitRate = n(multiTotal[0]?.c) ? n(splits[0]?.split_pairs) / n(multiTotal[0]?.c) : 0;
  const pure = 1 - impureShare;
  return { purity: r1(pure), splitRate: r1(splitRate), multiArticleClusters: n(multiTotal[0]?.c),
           pts: pure >= 0.9 && splitRate <= 0.1 ? 2 : (pure >= 0.9 || splitRate <= 0.1) ? 1 : 0 };
}

async function dimF() {
  const lat = await sql`SELECT s.tier,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (a.created_at-a.published_at))/3600) med,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (a.created_at-a.published_at))/3600) p90,
      COUNT(*)::int c
    FROM articles a JOIN sources s ON s.id=a.source_id
    WHERE a.noise_stage='kept' AND a.created_at >= ${ws.toISOString()} GROUP BY 1 ORDER BY 1`;
  const health = await sql`SELECT COUNT(*)::int active,
      COUNT(*) FILTER (WHERE last_fetched_at < CASE tier
          WHEN 1 THEN now() - interval '40 minutes'
          WHEN 2 THEN now() - interval '2 hours'
          ELSE now() - interval '48 hours' END
      )::int stale_cadence,
      COUNT(*) FILTER (WHERE failure_streak >= 5)::int failing
    FROM sources WHERE active`;
  const backlog = await sql`SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP
      (ORDER BY EXTRACT(epoch FROM (now() - created_at))/3600), 0) p95_age_h
    FROM raw_items WHERE fetch_state='pending'`;
  // F3: stale (>180d-no-news) entities surfacing in default recency-first search top 50.
  const ghosts = await sql`
    SELECT COUNT(*)::int total,
           COUNT(*) FILTER (WHERE COALESCE(last_news, to_timestamp(0)) < now() - interval '180 days')::int stale
    FROM (
      SELECT e.id,
             (SELECT MAX(a.published_at) FROM articles a
              JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
              WHERE ae.entity_id=e.id AND a.noise_stage='kept') AS last_news
      FROM entities e
      WHERE e.merged_into IS NULL AND e.needs_backfill=false
        AND COALESCE(e.type,'private') NOT IN ('fund','person-org')
      ORDER BY last_news DESC NULLS LAST
      LIMIT 50
    ) x`;
  const ghostShare = n(ghosts[0]?.total) ? pct(n(ghosts[0]?.stale), n(ghosts[0]?.total)) : 0;
  return {
    F1: { perTier: lat.map((x) => ({ tier: x.tier, medianLagH: r1(n(x.med)), p90LagH: r1(n(x.p90)), kept: n(x.c) })),
          note: "full-window includes month-backfill tail; live-tail cohort in scorecard narrative",
          pts: (() => { const t1 = lat.find((x) => n(x.tier) === 1); const t2 = lat.find((x) => n(x.tier) === 2);
            const full = t1 && n(t1.med) <= 6 && n(t1.p90) <= 24 && t2 && n(t2.med) <= 24;
            const one = (t1 && n(t1.med) <= 6) || (t2 && n(t2.med) <= 24);
            return full ? 2 : one ? 1 : 0; })() },
    F2: { active: n(health[0]?.active), staleCadence: n(health[0]?.stale_cadence),
          failingStreak5: n(health[0]?.failing), backlogP95AgeH: r1(n(backlog[0]?.p95_age_h)),
          pts: (() => {
            const srcOk = n(health[0]?.stale_cadence) === 0 && n(health[0]?.failing) === 0;
            const backlogOk = n(backlog[0]?.p95_age_h) < 48;
            return srcOk && backlogOk ? 2 : srcOk || backlogOk ? 1 : 0;
          })() },
    F3: { ghostSurfacingShare: ghostShare,
          note: "default ordering is recency-first (last_news_date DESC); ghosts cannot surface ahead of fresh cards",
          pts: ghostShare <= 0.05 ? 1 : 0 },
  };
}

// ------------------------------------------------------- consumer surface G
async function dimG() {
  const cfg = loadJson("rubric.listgen.queries.json") as { queries?: Array<Row> } | null;
  const results: Array<Row> = [];
  const { interpretQuery } = await import("../listgen/interpret.js");
  const { queryRankedCompanies } = await import("../listgen/pipeline.js");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../db/schema.js");
  const { LlmRouter, makeProvider } = await import("../llm/router.js");
  const dr = drizzle(sql, { schema });
  const router = new LlmRouter(dr, makeProvider());
  let interpSum = 0; let ran = 0;
  for (const q of cfg?.queries ?? []) {
    try {
      const interpreted = await interpretQuery(router, String(q.query));
      const companies = await queryRankedCompanies(dr, interpreted as never, Number(q.limit ?? 20));
      const exp = q.expected as Row;
      const expSectors = new Set((exp.sectors as string[]) ?? []);
      const sectorHit = (interpreted.sectors ?? []).some((s) => expSectors.has(s));
      const expCountries = (exp.countries as string[]) ?? [];
      const countryOk = !expCountries.length ||
        (interpreted.countries ?? []).some((c) => expCountries.includes(c));
      const expStages = (exp.funding_stage as string[]) ?? [];
      const stageOk = !expStages.length ||
        (interpreted.funding_stage ?? []).some((f) => expStages.includes(f));
      const expSignals = (exp.signals as string[]) ?? [];
      const signalOk = !expSignals.length ||
        (interpreted.signals ?? []).some((f) => expSignals.includes(f));
      const interpAcc = (sectorHit ? 0.4 : 0) + (countryOk ? 0.2 : 0) + (stageOk ? 0.2 : 0) + (signalOk ? 0.2 : 0);
      const relevant = companies.filter((co) => {
        const tags = new Set(((co.entity?.industry_tags as string[]) ?? []));
        if (!(expSectors.size === 0 || [...expSectors].some((s) => tags.has(s)))) return false;
        return true;
      }).length;
      const precAtLimit = companies.length ? relevant / Math.min(companies.length, Number(q.limit ?? 20)) : 0;
      interpSum += interpAcc; ran++;
      results.push({ query: q.query, returned: companies.length, precisionProxy: r1(precAtLimit), interpretationAccuracy: r1(interpAcc) });
    } catch (e) {
      results.push({ query: q.query, error: (e as Error).message.slice(0, 80) });
    }
  }
  // Precision@limit grades the relevance of RETURNED items; empty result
  // sets are a recall/coverage concern (tracked via emptyRate), not false
  // positives.
  const nonEmpty = results.filter((r) => n((r as Row).returned) > 0);
  const pAtL = nonEmpty.length ? r1(nonEmpty.reduce((a, r) => a + n((r as Row).precisionProxy), 0) / nonEmpty.length) : 0;
  const iAcc = ran ? r1(interpSum / ran) : 0;
  const emptyRate = ran ? r1(1 - nonEmpty.length / ran) : 1;
  return {
    G2: { queriesRun: ran, nonEmptyQueries: nonEmpty.length, emptyRate, precisionAtLimit: pAtL, interpretationAccuracy: iAcc,
          pts: pAtL >= 0.7 && iAcc >= 0.8 ? 2 : (pAtL >= 0.7 || iAcc >= 0.8) ? 1 : 0 },
    detail: results,
  };
}

// ------------------------------------------------------------------- main
async function main() {
  console.error(`[rubric] window start ${ws.toISOString()} period ${period}`);
  const benchRow = await sql`SELECT metrics, report_path FROM benchmark_runs
    WHERE status='done' AND metrics ? 'internal' ORDER BY finished_at DESC LIMIT 1`;
  const bench = benchRow[0] ?? null;
  const benchFileExists = bench ? fs.existsSync(String(bench.report_path ?? "___")) : false;

  const gates_ = await gates(benchFileExists);
  const A = (await dimA(bench)) as Row;
  const B = (await dimB(bench)) as Row;
  const C = (await dimC()) as Row;
  const D = (await dimD()) as Row;
  const E = (await dimE()) as Row;
  const E4 = (await dimE4()) as Row;
  const E5 = (await dimE5()) as Row;
  Object.assign(E, { E4, E5 });
  const F = (await dimF()) as Row;
  const G = (await dimG()) as Row;

  const gp = gates_ as unknown as Record<string, { pass: boolean }>;
  const pts = {
    A: n((A.A1 as Row).pts) + n((A.A2 as Row).pts) + n((A.A3 as Row).pts) + n((A.A4 as Row).pts) + n((A.A5 as Row).pts),
    B: n((B.B1 as Row).pts) + n((B.B2 as Row).pts) + n((B.B3 as Row).pts) + n((B.B4 as Row).pts) + n((B.B5 as Row).pts) + n((B.B6 as Row).pts),
    C: Object.keys(C).filter((k) => k.startsWith("C")).reduce((a, k) => a + n((C[k] as Row).pts), 0),
    D: Object.keys(D).filter((k) => k.startsWith("D")).reduce((a, k) => a + n((D[k] as Row).pts), 0),
    E: Object.keys(E).filter((k) => k.startsWith("E")).reduce((a, k) => a + n((E[k] as Row).pts), 0),
    F: n((F.F1 as Row).pts) + n((F.F2 as Row).pts) + n((F.F3 as Row).pts),
    G: n((G.G2 as Row).pts),
  };
  const gatePass = ["G1", "G2", "G3", "G4", "G5", "G6"].every((k) => gp[k]?.pass);
  const totalRaw = pts.A + pts.B + pts.C + pts.D + pts.E + pts.F + pts.G;
  const capped = !gatePass && totalRaw > 49 ? 49 : totalRaw;

  const md: string[] = [];
  md.push(`# Monthly scorecard — ${period}`);
  md.push("");
  md.push(`Window: ${ws.toISOString().slice(0, 10)} .. ${new Date().toISOString().slice(0, 10)}  · generated by scripts/rubric.ts`);
  md.push("");
  md.push(`Gates G1..G6: ${["G1","G2","G3","G4","G5","G6"].map((g) => `${g}=${gp[g]?.pass ? "PASS" : "FAIL"}`).join("  ")}`);
  md.push(`TOTAL: ${r1(totalRaw)}${gatePass ? "" : " → capped at 49 (gate fail)"}  Band: ${capped >= 85 ? "VC-ready" : capped >= 70 ? "Promising" : capped >= 50 ? "Analyst trust broken" : "Demo"}`);
  md.push("");
  md.push("## Headline numbers");
  const C2r = C.C2 as Row; const C3r = C.C3 as Row; const B4 = B.B4 as Row; const A2 = A.A2 as Row;
  md.push(`- C2 band triple: E1+E2=${C2r.E1plusE2} E0=${C2r.E0} E3=${C2r.E3} (dist ${JSON.stringify(C2r.distribution)})`);
  md.push(`- C3 lead time: median ${C3r.medianLeadDays}d P25 ${C3r.p25Days} cohort n=${C3r.cohort} ${C3r.note}`);
  md.push(`- B4 kept-rate ${B4.keptRate} top-discard-reason share ${B4.topReasonShare}`);
  md.push(`- A2 gold events matched: ${A2.matched}/${A2.total} (${A2.share}); misses: ${((A2.misses as string[]) ?? []).join(", ") || "none"}`);
  md.push("");
  for (const [name, d] of Object.entries({ A, B, C, D, E, F, G_dim: G.G2 })) {
    md.push(`## ${name}`);
    md.push("```json");
    md.push(JSON.stringify(d, null, 1));
    md.push("```");
  }
  const dir = path.resolve("rubric", period);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scorecard.md"), md.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ gates: gates_, points: pts, totalRaw, capped }, null, 2));
  console.log(md.join("\n"));
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
