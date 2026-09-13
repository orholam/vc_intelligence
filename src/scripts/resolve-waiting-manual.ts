/**
 * Manual resolution for remaining waiting-room rows (operator/agent curated).
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/resolve-waiting-manual.ts [--dry-run]
 */
import { sql, eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const dryRun = process.argv.includes("--dry-run");

type Drop = { id: string; reason: string };
type Publish = {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  primaryTag?: string;
};

const DROPS: Drop[] = [
  { id: "art_01M0ZT1TBMAV7YEWRTKJ5C6EE0", reason: "scrub:healthcare_commentary" },
  { id: "art_01M0ZV740ZS77W7J38GWS243ZK", reason: "scrub:govt_program" },
  { id: "art_01M1077TX6CZ33Q1PD1AC6BKPX", reason: "scrub:markets_commentary" },
  { id: "art_01M10HBT8S6A0RQKNHRFW1D5HM", reason: "scrub:vague_commentary" },
  { id: "art_01M14D6JTK7A6H4RJ9P2Q9NBQZ", reason: "scrub:govt_policy" },
  { id: "art_01M14GB21AYN9PKW0XCKWT9XN3", reason: "scrub:govt_policy" },
  { id: "art_01M14JQKC99XC5W0136691J2TF", reason: "scrub:politics" },
  { id: "art_01M14CYPA96JTBE1KZBYP6YC00", reason: "scrub:entertainment" },
  { id: "art_01M14RREJKCZH0DE2NG6GZ6CY0", reason: "scrub:markets_commentary" },
  { id: "art_01M14RSFV56JZ095PTDYCM8T4V", reason: "scrub:markets_commentary" },
  { id: "art_01M0ZPAK0JTMDXFZN7PJJ6S5FB", reason: "scrub:industry_event" },
  { id: "art_01M0ZT0A8KF5CNP191AETSHHMM", reason: "scrub:sports_labor" },
  { id: "art_01M0Z8Q3WPS9KWBJ2Q1TWZYD7W", reason: "scrub:service_shutdown" },
  { id: "art_01M14S1QXA6TPNS3FA5JXJAH6S", reason: "scrub:product_rumor" },
  { id: "art_01M14S222X0ZH67JJMZTPC6RDJ", reason: "scrub:product_rumor" },
  { id: "art_01M14S23R5WMEH5EFQPKHADW5G", reason: "scrub:politics" },
  { id: "art_01M14S25VH8YNFQ29W9YCYR8QT", reason: "scrub:product_commentary" },
  { id: "art_01M14S27WYQ2JDWAVW3TWQ0BN4", reason: "scrub:product_commentary" },
  { id: "art_01M14S29PAG423GTBZ4TDMHMSZ", reason: "scrub:product_commentary" },
  { id: "art_01M14S2BRV2PZKP2E2YYWQKR1H", reason: "scrub:politics" },
  { id: "art_01M14S2DNDWVDGTRNM299DDH7T", reason: "scrub:product_rumor" },
  { id: "art_01M14S2FGRC5T7YA89K61T9RV4", reason: "scrub:product_rumor" },
  { id: "art_01M14S2HJ2FEH7N8DXN8R0TGQS", reason: "scrub:entertainment" },
  { id: "art_01M14S2KKXHS0PP8NRBHYTK9BV", reason: "scrub:policy_update" },
  { id: "art_01M14S2NAAKJV6WSVVTJSVMFGR", reason: "scrub:industry_report" },
  { id: "art_01M14S2QKZNEFPZ5621PS5C4QQ", reason: "scrub:consumer_commentary" },
  { id: "art_01M14S2SFJS091412V2C49KN8W", reason: "scrub:science_govt" },
  { id: "art_01M14S2VDAWKRDNF8RMMH3PQVT", reason: "scrub:commentary" },
  { id: "art_01M14S2Z6ZTVFC8MSW0EJWADGF", reason: "scrub:ai_commentary" },
  { id: "art_01M14S375868DVQZ4R7067BXFP", reason: "scrub:commentary" },
  { id: "art_01M14S3EYBCEJ59B34F96GXN10", reason: "scrub:consumer_review" },
];

const PUBLISH: Publish[] = [
  {
    id: "art_01M0ZHWR9T974885FE4W3FKP27",
    name: "Peter Piper Pizza",
    industry: "restaurants_delivery",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M0ZM6V05EJDJ75W3QHYM12H8",
    name: "Deep Cogito",
    industry: "ai_ml",
    primaryTag: "funding.series_a",
  },
  {
    id: "art_01M104WNBF1684F6GYHXV2QNRY",
    name: "Ring",
    domain: "ring.com",
    industry: "consumer_electronics",
    primaryTag: "product.launch",
  },
  { id: "art_01M104WQC16XFJMPXNVQNZ18BB", name: "ASUS", domain: "asus.com", industry: "gaming" },
  { id: "art_01M1051GB43WKXH13450X5PQWV", name: "Joget", industry: "saas_enterprise" },
  {
    id: "art_01M10DEYTG8WVPBMYCRYWFW1KR",
    name: "Lego",
    domain: "lego.com",
    industry: "retail",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M0ZXE62QH479PT2XVAC2K704",
    name: "thatgamecompany",
    industry: "gaming",
    primaryTag: "corporate.expansion",
  },
  { id: "art_01M14BKXSRS2W5YPN5S0MKS8T7", name: "Äio", industry: "biotech_pharma" },
  { id: "art_01M14BM1MH6MSG1PX4CN10VMA0", name: "ICEYE", industry: "automotive_aerospace" },
  { id: "art_01M14C0VWQWEHHZQ0R3MXKR9RS", name: "AusperBio", industry: "biotech_pharma" },
  { id: "art_01M14C15Q8FWNEJNRMPN8RZPYW", name: "Adaptyv", domain: "adaptyvbio.com", industry: "biotech_pharma" },
  { id: "art_01M14C17MX3C2621FGS7JM0N6K", name: "Deep Cogito", industry: "ai_ml" },
  { id: "art_01M14C6NCBKCM61F8FT0Q5FGVW", name: "Corvus Robotics", domain: "corvus-robotics.com", industry: "robotics_hardware" },
  { id: "art_01M14C9Z7KWY8R6MP1PRW8BYG7", name: "Postquant Labs", industry: "crypto_web3" },
  { id: "art_01M14CMAEB52VV0Z2DEKXBHQSK", name: "Adaptyv", domain: "adaptyvbio.com", industry: "biotech_pharma" },
  { id: "art_01M14CMCBRHCCR3E7KVFKSAQ9R", name: "Lokal", domain: "somoslokal.cl", industry: "saas_enterprise" },
  { id: "art_01M14CMZWPH7CPAYYY96A6XD1J", name: "Cloverleaf AI", domain: "cloverleaf.ai", industry: "ai_ml" },
  { id: "art_01M14CPVSKFC65EEVZEG6NSHK6", name: "Blaze Pizza", industry: "restaurants_delivery" },
  { id: "art_01M14D3V706D2MGK5VW1R2WZGX", name: "Ripple", industry: "crypto_web3" },
  { id: "art_01M14D73WNA9D8P463642AQRT6", name: "Shanghai Ravioli", industry: "agtech_food" },
  {
    id: "art_01M14D7QB2T477550TX6P1E2VJ",
    name: "Ulta Beauty",
    industry: "retail",
    primaryTag: "financial.earnings_beat",
  },
  { id: "art_01M14D9B98JAAJ13MG84CA5Z1R", name: "Astro", domain: "astro.build", industry: "saas_enterprise" },
  { id: "art_01M14E5MB82CS16Y1ZXV5W50DE", name: "BitGo", industry: "crypto_web3" },
  { id: "art_01M14EANCWGRX5WKSGN6VZQYF6", name: "1X", domain: "1x.tech", industry: "robotics_hardware" },
  {
    id: "art_01M14FEFB42DGK58A1A1DHT7BW",
    name: "Boston Scientific",
    industry: "medtech_devices",
    primaryTag: "risk.data_breach",
  },
  { id: "art_01M14JNCPKZH6W0QVNXQFMW70R", name: "Futuri", industry: "saas_enterprise" },
  { id: "art_01M14JP63T71WKVNBM8CNY8DC2", name: "AT&T", industry: "telecom_networking" },
  {
    id: "art_01M14S2XAJ77YJK1AYE5QDRVS0",
    name: "Adobe",
    domain: "adobe.com",
    industry: "saas_enterprise",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S3168RJMD80BM920943V6",
    name: "Nokia",
    domain: "nokia.com",
    industry: "consumer_electronics",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S333ZARHD7Q32M7350Z11",
    name: "Sony",
    domain: "sony.com",
    industry: "consumer_electronics",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S351P38S9KVWS5NKYXJ64",
    name: "Hugging Face",
    domain: "huggingface.co",
    industry: "ai_ml",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S391VQWTEWD0X9ZY595TS",
    name: "T-Mobile",
    domain: "t-mobile.com",
    industry: "telecom_networking",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S3AZC6CZPRN8PW2S0P1SW",
    name: "Plaud",
    domain: "plaud.ai",
    industry: "consumer_electronics",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S3CWW1P30RXC0F418EG3G",
    name: "Fitbit",
    domain: "fitbit.com",
    industry: "consumer_electronics",
    primaryTag: "product.launch",
  },
  {
    id: "art_01M14S3FHFN1WYHQGZVCXB73V8",
    name: "Amazon Web Services",
    domain: "aws.amazon.com",
    industry: "cloud_infra",
    primaryTag: "mna.acquisition_announced",
  },
];

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

async function findEntityId(db: ReturnType<typeof createDb>, name: string, domain?: string): Promise<string | null> {
  if (domain) {
    const byWeb = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT id FROM entities WHERE merged_into IS NULL AND website ILIKE ${"%" + domain + "%"} LIMIT 1
      `),
    );
    if (byWeb[0]?.id) return String(byWeb[0].id);
  }
  const norm = normalizeName(name);
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND (canonical_name ILIKE ${name} OR ${norm} = ANY(aliases))
      LIMIT 1
    `),
  );
  return hit[0]?.id ? String(hit[0].id) : null;
}

async function ensureEntity(
  db: ReturnType<typeof createDb>,
  name: string,
  domain?: string,
): Promise<string> {
  const existing = await findEntityId(db, name, domain);
  if (existing) return existing;
  const id = opaqueId("ent");
  if (!dryRun) {
    await db.insert(entities).values({
      id,
      canonicalName: name,
      website: domain ?? null,
      aliases: [normalizeName(name)],
      confidence: 0.68,
      createdBy: "manual:resolve-waiting",
      sourceRefs: ["manual:resolve-waiting"],
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
      confidence: 0.9,
    });
  }
  console.log(`link  ${articleId}  ${entityId}`);
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  console.log(dryRun ? "DRY RUN" : "LIVE");

  for (const drop of DROPS) {
    console.log(`drop  ${drop.id}  ${drop.reason}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({ noiseStage: "llm_filter", discardReason: drop.reason, updatedAt: new Date() })
        .where(eq(articles.id, drop.id));
    }
  }

  for (const pub of PUBLISH) {
    const eid = await ensureEntity(db, pub.name, pub.domain);
    await linkPrimary(db, pub.id, eid);
    const patch: Record<string, unknown> = {
      noiseStage: "kept",
      discardReason: null,
      resolvedAt: new Date(),
      updatedAt: new Date(),
      enrichedAt: new Date(),
    };
    if (pub.industry) patch.industryPrimary = pub.industry;
    if (pub.primaryTag) patch.primaryTag = pub.primaryTag;
    if (!dryRun) {
      await db.update(articles).set(patch).where(eq(articles.id, pub.id));
      // Backfill ai_summary from title when missing but newsworthiness warrants it
      await db.execute(sql`
        UPDATE articles SET ai_summary = left(title, 400)
        WHERE id = ${pub.id}
          AND (ai_summary IS NULL OR trim(ai_summary) = '')
          AND newsworthiness IN ('high', 'medium')
      `);
      // Replace status.no_event placeholder when we have a real tag
      if (pub.primaryTag) {
        await db.execute(sql`
          UPDATE articles SET primary_tag = ${pub.primaryTag}
          WHERE id = ${pub.id} AND primary_tag IN ('status.no_event', '')
        `);
      }
    }
    console.log(`kept  ${pub.id}  ${pub.name}`);
  }

  const waiting = rowsOf<{ c: number }>(
    await db.execute(sql`SELECT count(*)::int AS c FROM articles WHERE noise_stage = 'waiting'`),
  );
  const kept = rowsOf<{ c: number }>(
    await db.execute(sql`SELECT count(*)::int AS c FROM articles WHERE noise_stage = 'kept'`),
  );
  console.log(`waiting: ${waiting[0]?.c ?? 0}  kept: ${kept[0]?.c ?? 0}`);

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
