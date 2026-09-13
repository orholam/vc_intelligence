/**
 * Batch 2: fragment misidentifications (What, There, Price, Base, etc.)
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/fix-today-resolved-entities-batch2.ts [--dry-run]
 */
import { sql, eq, inArray } from "drizzle-orm";
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
  { id: "art_01M150B998BVMV5KEJHHDHZ8VQ", reason: "scrub:defense_govt_deal" },
];

const RELINKS: Relink[] = [
  {
    articleId: "art_01M14WVRWSEP3XX8EC1P0T1ZTT",
    entityId: "ent_01M0M31XM6NNX6VH5MPGQ0SCFX",
    name: "Descartes Systems Group",
    note: "Headline '$100M Acquisition' parsed as company name",
  },
  {
    articleId: "art_01M14WV3C2HFPBVWFKK02ZFP86",
    name: "Bot Auto",
    domain: "bot.auto",
    note: "LA-based → false match to Base blockchain",
  },
  {
    articleId: "art_01M14WXM53EP8E7T0XAEVTR1XM",
    name: "Rockstar Games",
    domain: "rockstargames.com",
    note: "LA-based → false match to Base blockchain",
  },
  {
    articleId: "art_01M14ERMH89WCB0P9JJW36MYGE",
    entityId: "ent_01M14DAMSP84RKMXR0HN114ACA",
    name: "Ajaib",
    note: "Wrongly linked to DeepSeek (Indonesia fintech round)",
  },
  {
    articleId: "art_01M14YZRDHHHW7F9KKXS18YR23",
    name: "Evonik",
    domain: "evonik.com",
    note: "Truncated 'Evonik' → 'Evon'",
  },
  {
    articleId: "art_01M14T6FTYRH854FJ9KXKD3Z5S",
    entityId: "ent_01M14S4DJ4N74WQ8D021MFEYE3",
    name: "Fitbit",
    note: "[Gallery] tag parsed as company",
  },
  {
    articleId: "art_01M14S1QXA6TPNS3FA5JXJAH6S",
    entityId: "ent_01M0KJG7R03VAMHHATT9S2Z113",
    name: "Apple",
    note: "Here's → 'Here' instead of Apple Watch subject",
  },
  {
    articleId: "art_01M14FD2NWK7HC1EBF532P32M2",
    entityId: "ent_01M14FHA7TTCAFNJWR9HNDG5M9",
    name: "Astroburn",
    note: "Wrong entity Hi3D on Astroburn product story",
  },
  {
    articleId: "art_01M14WGNXHZPXJ5BEMMGQN79BD",
    entityId: "ent_01M1510QZ6TVKTTXS4X974BMZJ",
    name: "Xanadu",
    note: "Publisher HPCwire tagged instead of subject",
  },
  {
    articleId: "art_01M14V96YC7GKVQ2TXKA7V7SRT",
    name: "ATAI Life Sciences",
    domain: "atai.life",
    note: "Investor-alert 'Price and Process' → 'Price'",
  },
  {
    articleId: "art_01M14X1Z81S9YRXMSF099S4H8R",
    entityId: "ent_01M0M2WS64K0J0JKBZDZTM2292",
    name: "Alibaba Group",
    note: "Model family Qwen tagged instead of Alibaba",
  },
  {
    articleId: "art_01M14V8V7HNVZS28W3JMMCMCT8",
    entityId: "ent_01M1511SP5BVC32E1HJSP5PE38",
    name: "IDrive",
    note: "False match to Ring (encryption article)",
  },
  {
    articleId: "art_01M14WXJ90TAXEMH8AKAHVF5BB",
    name: "Cloud Imperium Games",
    domain: "cloudimperiumgames.com",
    note: "Quote fragment 'There is no way…' → 'There'",
  },
  {
    articleId: "art_01M14S27WYQ2JDWAVW3TWQ0BN4",
    entityId: "ent_01M0KJG7R03VAMHHATT9S2Z113",
    name: "Apple",
    note: "What to Know → 'What' instead of Apple TV subject",
  },
  {
    articleId: "art_01M14WS2N436J19Y5P4VG4W2WA",
    name: "PopIndia",
    note: "YouTube (platform) tagged instead of PopIndia acquirer",
  },
  {
    articleId: "art_01M14YSPWNFRHBK2V9SSCQ8GZH",
    name: "XRP Treasury Company",
    note: "Exchange NASDAQ tagged instead of listing company",
  },
  {
    articleId: "art_01M14W9JM8JAV2ACAGM7M1A3D7",
    entityId: "ent_01M1515Z6WTAMRSQ7RQEYM7T1J",
    name: "Reliance Group",
    note: "US steel RELIANCE, INC. false match on Indian media group",
  },
  {
    articleId: "art_01M14QW17YN8CFZR7J5RQVKSAY",
    entityId: "ent_01M0M2YTSFZ4S9HRYVZHE3BN34",
    name: "Affirm Holdings",
    note: "Thin 'Affirm' card; use public Affirm Holdings",
  },
];

const JUNK_ENTITY_IDS = [
  "ent_01M14DDFP7YJPMCSVNXM2HBFGD", // Acquisition
  "ent_01M14DFQPJDPEXVCQ46VF8T1N9", // Price
  "ent_01M14ED8SY0P59CSKE3QTDS0QC", // What
  "ent_01M0ZZ0FJT2Y6FB0ZGM6JYNC98", // There
  "ent_01M14C1HRJDRKNCD39ZZ5Y1HNJ", // Qwen
  "ent_01M14DB46H6SY2NXTXDZ69H5MH", // YouTube
  "ent_01M14C6SJC398TP11WW1V8SK79", // Here
  "ent_01M14EFDQTRYK9PYX1Y2MWY7DA", // Evon
  "ent_01M14DQ9W13A1TN2YRPH6N51Z0", // Gallery
  "ent_01M14C782EVQNGZ4TR4XBBJA3Q", // HPCwire
  "ent_01M0WQG6DANMKRPPJ8S5ZHMFJ3", // Hi3D
  "ent_01M14CYPSS23ZP1H6WGBKJV19D", // Javelin
  "ent_01M14NWTJNM11E0TECYFHM01JF", // Recalls
  "ent_01M14QW9GFESJ6D6E1P2T1JZNY", // Affirm Q4
  "ent_01M0X2VB87BA4KKH2V0ZP3BK74", // Canada (country)
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
  if (existing) return existing;
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
  console.log(dryRun ? "DRY RUN batch 2" : "LIVE batch 2");

  const keeperByArticle = new Map<string, string>();

  for (const drop of DROPS) {
    console.log(`drop  ${drop.id}  ${drop.reason}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({ noiseStage: "llm_filter", discardReason: drop.reason, updatedAt: new Date() })
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

  // Remove junk secondary links (Recalls, Affirm Q4, Canada on Xanadu, etc.)
  if (!dryRun) {
    const removed = await db
      .delete(articleEntities)
      .where(inArray(articleEntities.entityId, JUNK_ENTITY_IDS))
      .returning({ articleId: articleEntities.articleId, entityId: articleEntities.entityId });
    for (const r of removed) {
      console.log(`del secondary/junk link  ${r.articleId}  ${r.entityId}`);
    }
  } else {
    console.log(`would delete article_entities where entity in ${JUNK_ENTITY_IDS.length} junk ids`);
  }

  const popindia = keeperByArticle.get("art_01M14WS2N436J19Y5P4VG4W2WA");
  const atai = keeperByArticle.get("art_01M14V96YC7GKVQ2TXKA7V7SRT");
  const evonik = keeperByArticle.get("art_01M14YZRDHHHW7F9KKXS18YR23");
  const cloudImperium = keeperByArticle.get("art_01M14WXJ90TAXEMH8AKAHVF5BB");
  const xrpTreasury = keeperByArticle.get("art_01M14YSPWNFRHBK2V9SSCQ8GZH");

  const merges = [
    { loserId: "ent_01M14DDFP7YJPMCSVNXM2HBFGD", keeperId: "ent_01M0M31XM6NNX6VH5MPGQ0SCFX", note: "Acquisition → Descartes" },
    { loserId: "ent_01M14DFQPJDPEXVCQ46VF8T1N9", keeperId: atai, note: "Price → ATAI" },
    { loserId: "ent_01M14ED8SY0P59CSKE3QTDS0QC", keeperId: "ent_01M0KJG7R03VAMHHATT9S2Z113", note: "What → Apple" },
    { loserId: "ent_01M0ZZ0FJT2Y6FB0ZGM6JYNC98", keeperId: cloudImperium, note: "There → Cloud Imperium" },
    { loserId: "ent_01M14C1HRJDRKNCD39ZZ5Y1HNJ", keeperId: "ent_01M0M2WS64K0J0JKBZDZTM2292", note: "Qwen → Alibaba" },
    { loserId: "ent_01M14DB46H6SY2NXTXDZ69H5MH", keeperId: popindia, note: "YouTube → PopIndia" },
    { loserId: "ent_01M14C6SJC398TP11WW1V8SK79", keeperId: "ent_01M0KJG7R03VAMHHATT9S2Z113", note: "Here → Apple" },
    { loserId: "ent_01M14EFDQTRYK9PYX1Y2MWY7DA", keeperId: evonik, note: "Evon → Evonik" },
    { loserId: "ent_01M14DQ9W13A1TN2YRPH6N51Z0", keeperId: "ent_01M14S4DJ4N74WQ8D021MFEYE3", note: "Gallery → Fitbit" },
    { loserId: "ent_01M14C782EVQNGZ4TR4XBBJA3Q", keeperId: "ent_01M1510QZ6TVKTTXS4X974BMZJ", note: "HPCwire → Xanadu" },
    { loserId: "ent_01M0WQG6DANMKRPPJ8S5ZHMFJ3", keeperId: "ent_01M14FHA7TTCAFNJWR9HNDG5M9", note: "Hi3D → Astroburn" },
    { loserId: "ent_01M14CYPSS23ZP1H6WGBKJV19D", keeperId: "ent_01M14CYPSS23ZP1H6WGBKJV19D", note: "skip" },
    { loserId: "ent_01M14NWTJNM11E0TECYFHM01JF", keeperId: "ent_01M0KJG7RCBG4WEP5YHT390SMN", note: "Recalls → Tesla" },
    { loserId: "ent_01M14QW9GFESJ6D6E1P2T1JZNY", keeperId: "ent_01M0M2YTSFZ4S9HRYVZHE3BN34", note: "Affirm Q4 → Affirm Holdings" },
  ].filter((m) => m.note !== "skip" && m.loserId !== m.keeperId && m.keeperId);

  for (const m of merges) {
    console.log(`merge ${m.loserId} → ${m.keeperId}  (${m.note})`);
    if (!dryRun) {
      try {
        await kb.merge(m.loserId, m.keeperId!);
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
