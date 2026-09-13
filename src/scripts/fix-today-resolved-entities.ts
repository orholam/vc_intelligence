/**
 * Manual entity corrections for today's resolved kept articles.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/fix-today-resolved-entities.ts [--dry-run]
 */
import { sql, eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articleEntities, articles, aliases, entities } from "../db/schema.js";
import { EntityKb } from "../entities/kb.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const dryRun = process.argv.includes("--dry-run");

type Drop = { id: string; reason: string };
type Relink = {
  articleId: string;
  name: string;
  domain?: string;
  entityId?: string;
  note: string;
};

const DROPS: Drop[] = [
  {
    id: "art_01M1509DGXE0PQKJCV1XJJZ4KE",
    reason: "scrub:govt_program",
  },
  {
    id: "art_01M14ERPA7CAX58HPPF3RZDFRP",
    reason: "scrub:markets_commentary",
  },
  {
    id: "art_01M10DEMKD4KKC0NJ79JX934XT",
    reason: "scrub:markets_commentary",
  },
  {
    id: "art_01M0Z9XFD5KR78WKX0X1XKAYX3",
    reason: "scrub:industry_report",
  },
  {
    id: "art_01M104Q99HA7A08XH7F6Y899J2",
    reason: "scrub:govt_policy",
  },
  {
    id: "art_01M14DVM8FE6Q2F1KP7NREH5NR",
    reason: "scrub:university_project",
  },
];

const RELINKS: Relink[] = [
  {
    articleId: "art_01M14E9XDMZK7JZATBENATR303",
    name: "Pasqal",
    domain: "pasqal.com",
    note: "Parsed 'Cash' from '$360 Million in Cash'",
  },
  {
    articleId: "art_01M14DTKX7X1Z8JRR4XXBAJM0H",
    entityId: "ent_01M14DV88F5WK62YHPBM6FYJE5",
    name: "Atorie",
    note: "Parsed generic 'Fashion' instead of startup name",
  },
  {
    articleId: "art_01M14E0W834KCDZMGAGQAZ7F7C",
    entityId: "ent_01M14EDDDXF088KNWX4967JGCR",
    name: "Paramotor Digital Technology",
    note: "Fragment name included 'Fintech firm' prefix",
  },
  {
    articleId: "art_01M14DAK1GKPCA1M8E2YFX5Q5K",
    name: "DeFi Development Corp",
    domain: "defidevelopment.com",
    note: "Tagged blockchain Solana instead of treasury company",
  },
  {
    articleId: "art_01M14CSGKN5QM0KV7CBMGSC3HM",
    entityId: "ent_01M0VK3ZX6E4K04QJ6SB9YK4NN",
    name: "Google Research",
    note: "Parsed model-architecture fragment from headline",
  },
  {
    articleId: "art_01M0Z9ADDN9Z7E62X4D3KC80Y9",
    name: "SiFly",
    domain: "sifly.com",
    note: "Parsed 'Scale U.S. Production' from headline",
  },
  {
    articleId: "art_01M0ZHK5ND5S6G0PR0GBVDXNZH",
    name: "SiFly",
    domain: "sifly.com",
    note: "Parsed 'Scale Long-Endurance Drone Production' from headline",
  },
  {
    articleId: "art_01M14EYHMHFNX1ABT2TSFAXV94",
    entityId: "ent_01M14RSSZ9RCFGRTVAJR06948A",
    name: "Hollister",
    note: "Tagged retailer Target (distribution partner) not subject",
  },
  {
    articleId: "art_01M14NRMM81RGNZSM1DQPP1BFR",
    entityId: "ent_01M0KJG7R03VAMHHATT9S2Z113",
    name: "Apple",
    note: "Tagged product Apple TV instead of company",
  },
  {
    articleId: "art_01M14NAHC4TWRKA74M1257BQK1",
    name: "Jio Platforms",
    domain: "jio.com",
    note: "Parsed 'Jio IPO' phrase instead of company",
  },
  {
    articleId: "art_01M14N8P13J7YXWQ9FDGCFZD7W",
    entityId: "ent_01M14S286NTAWADRFQVSXW4S9K",
    name: "Futuri",
    note: "Parsed 'Leaders' from sales-leader headline",
  },
  {
    articleId: "art_01M14QJDVT272V706PN3166332",
    name: "USD.AI",
    domain: "usd.ai",
    note: "Parsed 'Power AI Buildout' from headline tail",
  },
  {
    articleId: "art_01M0ZXPVDA3MXHBN2RPFG31RMW",
    entityId: "ent_01M0M2WW03KQAV209RTHZC0W1F",
    name: "IBM",
    note: "Tagged product line IBM Z instead of company",
  },
  {
    articleId: "art_01M0Z8ZT2PV7YBKVQ33MSFJE8E",
    name: "Blend",
    domain: "blend.com",
    note: "Parsed headline clause as company name",
  },
  {
    articleId: "art_01M14C6KM913TWD5EXKKHVYM5F",
    name: "Zuri",
    domain: "zuri.com",
    note: "Parsed 'Civil' from civil/defense operations phrase",
  },
  {
    articleId: "art_01M14ERJJCVXHN2KQ774HX4Q26",
    entityId: "ent_01M14CPN9DZ8PKR3ZQ6CS7GJR7",
    name: "Levanta",
    note: "Tagged city Seattle instead of startup (same $22M round)",
  },
  {
    articleId: "art_01M14FD92Z5K1QZBJ66E2B29KA",
    entityId: "ent_01M0KJG7QC3097N4PFQZH43HHV",
    name: "Microsoft",
    note: "Tagged product Visual Studio Code instead of company",
  },
  {
    articleId: "art_01M103EPTBPKG03C2H6CAKJWFJ",
    entityId: "ent_01M14S27F7ACBG06R6289DZW15",
    name: "Deep Cogito",
    note: "Inconsistent casing on existing entity",
  },
  {
    articleId: "art_01M14ERMH89WCB0P9JJW36MYGE",
    entityId: "ent_01M14EBC19B4NDWN6DNTP2PHP8",
    name: "DeepSeek",
    note: "Truncated subject 'DeepSeek Looks to'",
  },
  {
    articleId: "art_01M14BKXSRS2W5YPN5S0MKS8T7",
    name: "ÄIO",
    note: "Wrong casing on biotech company ÄIO",
  },
  {
    articleId: "art_01M0Z8YH0MAPZ9X7YVF28S8X3Y",
    name: "Ring",
    domain: "ring.com",
    note: "Generic Ring entity missing Amazon-owned domain",
  },
  {
    articleId: "art_01M14CM8F5GPHJ5WT2JXFVJVJR",
    name: "Handshake",
    domain: "joinhandshake.com",
    note: "Recruiting platform — add canonical domain",
  },
];

/** Junk autocreate entities to merge into keepers after relink. */
const MERGE_JUNK: Array<{ loserId: string; keeperId: string; note: string }> = [
  { loserId: "ent_01M14EB5HHGXPKJBYZR4TCP1J7", keeperId: "ent_PLACEHOLDER_PASQAL", note: "Cash" },
  { loserId: "ent_01M14DV88X7KRN33E0SK0RQ8CN", keeperId: "ent_01M14DV88F5WK62YHPBM6FYJE5", note: "Fashion" },
  { loserId: "ent_01M14EDDDKHWSZFNRFVFF6T310", keeperId: "ent_01M14EDDDXF088KNWX4967JGCR", note: "Fintech firm Paramotor..." },
  { loserId: "ent_01M14D0SF1ZHYKGC2MK21K70WB", keeperId: "ent_PLACEHOLDER_DEFI", note: "Solana" },
  { loserId: "ent_01M14CV8GDQF46P6RFJCRME6P6", keeperId: "ent_01M0VK3ZX6E4K04QJ6SB9YK4NN", note: "M-Parameter model" },
  { loserId: "ent_01M14CTGA82ZDQG4X5ZT2MJ3CP", keeperId: "ent_PLACEHOLDER_SIFLY", note: "Scale U.S. Production" },
  { loserId: "ent_01M14CVQ1VJ40RCRXYTNRH064J", keeperId: "ent_PLACEHOLDER_SIFLY", note: "Scale Long-Endurance..." },
  { loserId: "ent_01M14RSPM7SDX46ZSGQCZ8WMS7", keeperId: "ent_01M14RSSZ9RCFGRTVAJR06948A", note: "Target" },
  { loserId: "ent_01M14E9JG0DARXCFM4R9EC4TA7", keeperId: "ent_01M0KJG7R03VAMHHATT9S2Z113", note: "Apple TV" },
  { loserId: "ent_01M14NAYPRNFJXXF3RCQ9B0BS1", keeperId: "ent_PLACEHOLDER_JIO", note: "Jio IPO" },
  { loserId: "ent_01M14EAJTH81A3G4M5M4D1HG9T", keeperId: "ent_01M14S286NTAWADRFQVSXW4S9K", note: "Leaders" },
  { loserId: "ent_01M14QJKG90WJF31WZV9FEJXQD", keeperId: "ent_PLACEHOLDER_USDAI", note: "Power AI Buildout" },
  { loserId: "ent_01M14EQDX1GHNAP6YR1PFB0N0K", keeperId: "ent_01M0M2WW03KQAV209RTHZC0W1F", note: "IBM Z" },
  { loserId: "ent_01M14CMD64AV2P2CNS7HK9QFQN", keeperId: "ent_PLACEHOLDER_BLEND", note: "Accelerating Enterprise AI..." },
  { loserId: "ent_01M14C7D170C1D1D2VKKDMYNXT", keeperId: "ent_PLACEHOLDER_ZURI", note: "Civil" },
  { loserId: "ent_01M14ERKJS8K8K2NDH9WYPDRED", keeperId: "ent_01M14EBC19B4NDWN6DNTP2PHP8", note: "DeepSeek Looks to" },
  { loserId: "ent_01M14EJXQRGEDRS7FSKTQGJ7W0", keeperId: "ent_01M14S27F7ACBG06R6289DZW15", note: "Deepcogito" },
  { loserId: "ent_01M14EDJARR65BMYW6RS32B5QM", keeperId: "ent_01M14EDJARR65BMYW6RS32B5QM", note: "Ireland — orphan after drop" },
  { loserId: "ent_01M0M30663CFPPCDTAVK9F2VHT", keeperId: "ent_01M0M30663CFPPCDTAVK9F2VHT", note: "Five Below on Army — orphan after drop" },
  { loserId: "ent_01M14NB5NDJP798GZGYG96HBY0", keeperId: "ent_01M14NB5NDJP798GZGYG96HBY0", note: "IPOs commentary" },
  { loserId: "ent_01M14G7S2TNPQ2ZWNDV4J92AZQ", keeperId: "ent_01M14G7S2TNPQ2ZWNDV4J92AZQ", note: "Retail commentary" },
  { loserId: "ent_01M14CM6B6YVRJC24VBVYYDCWB", keeperId: "ent_01M14CM6B6YVRJC24VBVYYDCWB", note: "Risk report" },
  { loserId: "ent_01M14C9KWJZ16N8G3DED8MWTHD", keeperId: "ent_01M14C9KWJZ16N8G3DED8MWTHD", note: "Tempe city" },
];

async function findEntityId(db: ReturnType<typeof createDb>, name: string, domain?: string): Promise<string | null> {
  if (domain) {
    const byWeb = await db.execute<{ id: string }>(sql`
      SELECT id FROM entities WHERE merged_into IS NULL AND website ILIKE ${"%" + domain + "%"} LIMIT 1
    `);
    if (byWeb[0]?.id) return String(byWeb[0].id);
  }
  const norm = normalizeName(name);
  const hit = await db.execute<{ id: string }>(sql`
    SELECT e.id FROM entities e
    LEFT JOIN aliases a ON a.entity_id = e.id
    WHERE e.merged_into IS NULL
      AND (e.canonical_name ILIKE ${name} OR a.alias_normalized = ${norm})
    LIMIT 1
  `);
  return hit[0]?.id ? String(hit[0].id) : null;
}

async function ensureEntity(db: ReturnType<typeof createDb>, name: string, domain?: string): Promise<string> {
  const existing = await findEntityId(db, name, domain);
  if (existing) {
    if (domain && !dryRun) {
      await db.execute(sql`
        UPDATE entities SET website = COALESCE(NULLIF(website, ''), ${domain}), updated_at = now()
        WHERE id = ${existing} AND (website IS NULL OR website = '')
      `);
    }
    if (name === "ÄIO" && !dryRun) {
      await db.update(entities).set({ canonicalName: "ÄIO", updatedAt: new Date() }).where(eq(entities.id, existing));
    }
    return existing;
  }
  const id = opaqueId("ent");
  if (!dryRun) {
    await db.insert(entities).values({
      id,
      canonicalName: name,
      website: domain ?? null,
      aliases: [normalizeName(name)],
      confidence: 0.72,
      createdBy: "manual:fix-today",
      sourceRefs: ["manual:fix-today"],
      needsBackfill: true,
    });
    await db.insert(aliases).values({
      id: opaqueId("als"),
      entityId: id,
      alias: name,
      aliasNormalized: normalizeName(name),
      kind: "name",
      weight: 0.9,
      source: "manual",
    });
  }
  console.log(`mint  ${id}  ${name}${domain ? ` (${domain})` : ""}`);
  return id;
}

async function linkPrimary(db: ReturnType<typeof createDb>, articleId: string, entityId: string): Promise<void> {
  if (!dryRun) {
    await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
    await db.insert(articleEntities).values({
      articleId,
      entityId,
      role: "primary",
      confidence: 0.92,
    });
    await db
      .update(articles)
      .set({ resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(articles.id, articleId));
  }
  console.log(`link  ${articleId}  →  ${entityId}`);
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  const kb = new EntityKb(db);
  console.log(dryRun ? "DRY RUN" : "LIVE");

  const keeperByArticle = new Map<string, string>();

  for (const drop of DROPS) {
    console.log(`drop  ${drop.id}  ${drop.reason}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({
          noiseStage: "llm_filter",
          discardReason: drop.reason,
          updatedAt: new Date(),
        })
        .where(eq(articles.id, drop.id));
      await db.delete(articleEntities).where(eq(articleEntities.articleId, drop.id));
    }
  }

  for (const rel of RELINKS) {
    const eid = rel.entityId ?? (await ensureEntity(db, rel.name, rel.domain));
    keeperByArticle.set(rel.articleId, eid);
    await linkPrimary(db, rel.articleId, eid);
    console.log(`fix   ${rel.note}`);
  }

  // Resolve placeholder keeper ids for merges
  const pasqal = keeperByArticle.get("art_01M14E9XDMZK7JZATBENATR303")!;
  const defi = keeperByArticle.get("art_01M14DAK1GKPCA1M8E2YFX5Q5K")!;
  const sifly = keeperByArticle.get("art_01M0Z9ADDN9Z7E62X4D3KC80Y9")!;
  const jio = keeperByArticle.get("art_01M14NAHC4TWRKA74M1257BQK1")!;
  const usdai = keeperByArticle.get("art_01M14QJDVT272V706PN3166332")!;
  const blend = keeperByArticle.get("art_01M0Z8ZT2PV7YBKVQ33MSFJE8E")!;
  const zuri = keeperByArticle.get("art_01M14C6KM913TWD5EXKKHVYM5F")!;

  const merges: Array<{ loserId: string; keeperId: string; note: string }> = [
    { loserId: "ent_01M14EB5HHGXPKJBYZR4TCP1J7", keeperId: pasqal, note: "Cash → Pasqal" },
    { loserId: "ent_01M14DV88X7KRN33E0SK0RQ8CN", keeperId: "ent_01M14DV88F5WK62YHPBM6FYJE5", note: "Fashion → Atorie" },
    { loserId: "ent_01M14EDDDKHWSZFNRFVFF6T310", keeperId: "ent_01M14EDDDXF088KNWX4967JGCR", note: "Fragment → Paramotor" },
    { loserId: "ent_01M14D0SF1ZHYKGC2MK21K70WB", keeperId: defi, note: "Solana → DeFi Development Corp" },
    { loserId: "ent_01M14CV8GDQF46P6RFJCRME6P6", keeperId: "ent_01M0VK3ZX6E4K04QJ6SB9YK4NN", note: "Model fragment → Google Research" },
    { loserId: "ent_01M14CTGA82ZDQG4X5ZT2MJ3CP", keeperId: sifly, note: "Scale U.S. → SiFly" },
    { loserId: "ent_01M14CVQ1VJ40RCRXYTNRH064J", keeperId: sifly, note: "Scale Long-Endurance → SiFly" },
    { loserId: "ent_01M14RSPM7SDX46ZSGQCZ8WMS7", keeperId: "ent_01M14RSSZ9RCFGRTVAJR06948A", note: "Target → Hollister" },
    { loserId: "ent_01M14E9JG0DARXCFM4R9EC4TA7", keeperId: "ent_01M0KJG7R03VAMHHATT9S2Z113", note: "Apple TV → Apple" },
    { loserId: "ent_01M14NAYPRNFJXXF3RCQ9B0BS1", keeperId: jio, note: "Jio IPO → Jio Platforms" },
    { loserId: "ent_01M14EAJTH81A3G4M5M4D1HG9T", keeperId: "ent_01M14S286NTAWADRFQVSXW4S9K", note: "Leaders → Futuri" },
    { loserId: "ent_01M14QJKG90WJF31WZV9FEJXQD", keeperId: usdai, note: "Power AI Buildout → USD.AI" },
    { loserId: "ent_01M14EQDX1GHNAP6YR1PFB0N0K", keeperId: "ent_01M0M2WW03KQAV209RTHZC0W1F", note: "IBM Z → IBM" },
    { loserId: "ent_01M14CMD64AV2P2CNS7HK9QFQN", keeperId: blend, note: "Headline clause → Blend" },
    { loserId: "ent_01M14C7D170C1D1D2VKKDMYNXT", keeperId: zuri, note: "Civil → Zuri" },
    { loserId: "ent_01M14ERKJS8K8K2NDH9WYPDRED", keeperId: "ent_01M14EBC19B4NDWN6DNTP2PHP8", note: "DeepSeek Looks to → DeepSeek" },
    { loserId: "ent_01M14EJXQRGEDRS7FSKTQGJ7W0", keeperId: "ent_01M14S27F7ACBG06R6289DZW15", note: "Deepcogito → Deep Cogito" },
    { loserId: "ent_01M14CMD6P831BT3JMK6WQQDDZ", keeperId: blend, note: "Latin America Blend Expands → Blend" },
    { loserId: "ent_01M14EBRWQEJJATNVM45YNYWK3", keeperId: "ent_01M14DV88F5WK62YHPBM6FYJE5", note: "Fashion startup Atorie → Atorie" },
    { loserId: "ent_01M14C9KWJZ16N8G3DED8MWTHD", keeperId: "ent_01M14C9KWJZ16N8G3DED8MWTHD", note: "skip self" },
  ].filter((m) => m.loserId !== m.keeperId && m.note !== "skip self");

  for (const m of merges) {
    if (!m.loserId || !m.keeperId) continue;
    console.log(`merge ${m.loserId} → ${m.keeperId}  (${m.note})`);
    if (!dryRun) {
      try {
        await kb.merge(m.loserId, m.keeperId);
      } catch (e) {
        console.warn(`  merge skipped: ${(e as Error).message}`);
      }
    }
  }

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
