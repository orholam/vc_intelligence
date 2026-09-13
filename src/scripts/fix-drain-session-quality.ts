/**
 * Fix obvious entity/resolution junk from the 2026-08-29 drain session.
 *
 * Usage: tsx --env-file-if-exists=.env.local src/scripts/fix-drain-session-quality.ts [--dry-run]
 */
import { sql, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { getConfig } from "../config.js";
import { articles, aliases, articleEntities, entities } from "../db/schema.js";
import { entityNameRejectionReason, isHeadlineFragmentEntity, looksLikeLegalEntityName } from "../lib/quality.js";
import { extractTitleSubject } from "../lib/title-subject.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";

const dryRun = process.argv.includes("--dry-run");

const JUNK_NAMES = [
  "Title",
  "Adding",
  "Apple TV",
  "Talks",
  "How",
  "Investors",
  "Please",
  "Trusted Source",
  "Indian",
  "Meta's",
  "K Have Opportunity",
  "PETER PIPER PIZZA UNVEILS",
  "Inc. Securities Fraud Lawsuit",
  "Ltd. Securities Lawsuit PHH",
  "Oracle Helped Kneecap Section 230",
  "Meta Platforms, Inc. Securities Fraud Lawsuit",
  "Substantial Losses Have Opportunity",
  "NATIONAL SECURITIES LAW FIRM",
  "Singapore",
  "Pakistan",
  "Chinese",
  "Fortune",
  "Revenue",
  "Acquisitions",
  "Mac Studio",
  // 2026-09-02 misID scrub — unambiguous junk tokens only (not Flash/Series brands)
  "Ahead",
  "Over",
  "Watch",
  "Stock",
  "Sept.",
  "Ultra",
  "Canada",
  "European Union Skip",
  "Publishers After EU Pressure",
  "Exclusive: Femtech Ipremom",
];

const DROP_KEPT: Array<{ id: string; reason: string }> = [
  { id: "art_01M15JERK2JMN3ATD693BDH617", reason: "scrub:no_company_subject" },
  { id: "art_01M15JDF7K884HANN7QEGT1AES", reason: "scrub:govt_not_company" },
  { id: "art_01M0WNWJK8S2WBK1FGMF2HDTY7", reason: "scrub:govt_not_company" },
  // 2026-09-02 misID scrub — person/scandal, no company subject
  { id: "art_01M1F0QYQE9ZK80VEPZQC8WHSP", reason: "scrub:no_company_subject" },
  // deal roundup / EDGAR series label — no single company subject
  { id: "art_01M0M4K67TWA1EGG3W6ADA4QQN", reason: "scrub:no_company_subject" },
  { id: "art_01M0PWFQ97ZCDGK5DAXAKJP6K6", reason: "scrub:edgar_series_not_company" },
];

const FIXES: Array<{ articleId: string; primary: string; secondaries?: string[] }> = [
  { articleId: "art_01M15JY4M86XZR5EWH4DC7NMCS", primary: "Insulet" },
  { articleId: "art_01M15JXYK8990T0767D7H1EBMY", primary: "Microvast" },
  { articleId: "art_01M15JYADSFQTN667958Z8WEGR", primary: "Photronics" },
  { articleId: "art_01M14ZZBX0MMRWDR13TJ42PGGW", primary: "EquipmentShare" },
  { articleId: "art_01M14V8ND9320N5PV64VQ94A4K", primary: "GoDaddy" },
  { articleId: "art_01M15JXRQCGWV84V85DRWWC9T6", primary: "EyePoint" },
  { articleId: "art_01M15MEY5S2X9DVQ0T21K11GE6", primary: "Simply Good Foods" },
  { articleId: "art_01M14WTX7ZANJ3TZ7EJ0ZT7TAF", primary: "First Financial Bank" },
  { articleId: "art_01M0ZHWR9T974885FE4W3FKP27", primary: "Peter Piper Pizza" },
  { articleId: "art_01M15HXXWAEZ1M981SZS0C0JCC", primary: "Meta" },
  { articleId: "art_01M14WS2N436J19Y5P4VG4W2WA", primary: "Reservoir", secondaries: ["PopIndia"] },
  { articleId: "art_01M0VKM4H4NF9RKSF2W89857V7", primary: "Base Power" },
  { articleId: "art_01M0M4JYQZB5TZ0WZFF4P8S2TM", primary: "Ransom Busters" },
  { articleId: "art_01M0VF8HZ599DPRNHAFZ9J0QTH", primary: "PayPal", secondaries: ["Stripe"] },
  { articleId: "art_01M14WYXWRV69X2QAJQ7C1YPQ8", primary: "PROCEPT BioRobotics" },
  { articleId: "art_01M15337ZKHGHM9RA5GVV3CN2Y", primary: "Taboola" },
  { articleId: "art_01M14YBK1SH75H9T5MS2FD94E8", primary: "Wix" },
  { articleId: "art_01M0VRN07XQNXW7EVYFV98S4TX", primary: "Melville Apartments Investors, LLC" },
  { articleId: "art_01M0VRMZZJCJN4DVV3525XJ9QA", primary: "Cig Newtown Investors, LLC" },
  { articleId: "art_01M0VRMZYF892HAAM8VJQJD4MK", primary: "Bergen Park Global Opportunity Fund, Lp" },
  // 2026-08-31 kept-quality pass
  { articleId: "art_01M1AX6NJAHG0MYS436AQW1YNT", primary: "Huawei Cloud" },
  { articleId: "art_01M1AM8WC1X681VN3K17SJSKEZ", primary: "Shein" },
  { articleId: "art_01M1AMA5QBK8J675YZVSGAP6V5", primary: "Anthropic" },
  { articleId: "art_01M0VKZ64HKXZMP7J3HHH5JBTF", primary: "Xinte Energy" },
  { articleId: "art_01M0YHZTSWC2NRJVGBC6R8SBK2", primary: "Certain Energy" },
  { articleId: "art_01M174A2AKBA4W28HGSWEQ8H3C", primary: "Casey's" },
  { articleId: "art_01M173VBHH4YZ4VGKQ3BVYWYSN", primary: "CXMT" },
  { articleId: "art_01M1757FG38GADE35A5XVCJMK1", primary: "Gorman-Rupp" },
  { articleId: "art_01M19ZVB6MZ1BRP8YKYP351DPP", primary: "Google" },
  { articleId: "art_01M19ZVBQJWM1W7B6F0CAWR1RB", primary: "Apple" },
  { articleId: "art_01M1A04E1GGCQTXK0S1S39TCX5", primary: "Google" },
  { articleId: "art_01M0X5CK3S3ABEFX69GARR71H1", primary: "Alice" },
  { articleId: "art_01M0KNS8BYYE3C71YE5474DDB3", primary: "OpenRouter", secondaries: ["Stripe"] },
  // 2026-09-02 misID scrub (past ~5d) — preposition/product/geo/wrong-entity primaries
  { articleId: "art_01M1HJ3072QR8M9M0EXCM0TE88", primary: "OpenPayd" }, // was Ahead
  { articleId: "art_01M1HSNK713TDQH7CEWETSATWP", primary: "OpenAI" }, // was Publishers After EU Pressure
  { articleId: "art_01M1G5APKQH1W0NGBTZ9Y9RF6S", primary: "Ipremom" }, // was Exclusive: Femtech Ipremom
  { articleId: "art_01M1EXMF8TZ1QD01GNSN72G856", primary: "OpenAI" }, // was European Union Skip
  { articleId: "art_01M1HSYMJ3Y4AZ53BVZ9CPRWPH", primary: "EVB" }, // was Ultra (PL press)
  { articleId: "art_01M1HSYTCTCTQGAN53A7Q3421H", primary: "EVB" },
  { articleId: "art_01M1HSZ07REZJYGHZ9VQ2PEWQX", primary: "EVB" },
  { articleId: "art_01M1EZ1RCQ1D68QQ0R36HMWMJH", primary: "Sonos" }, // was Ultra (product)
  { articleId: "art_01M1HSX56GBWR5MS23PAR6Q23W", primary: "Huawei" }, // was Watch
  { articleId: "art_01M1HJR7GNEMBE3DBP43EMEBG7", primary: "Ford" }, // was Series
  { articleId: "art_01M1HK0VA205AHNW2WKW5063ZJ", primary: "Uber" }, // was Over (Overhiring)
  { articleId: "art_01M1HC9DH1HJETN34TXDPZGBHB", primary: "Google" }, // was Flash
  { articleId: "art_01M1FKPMBGAVNXYYGV599921G9", primary: "Sonos" }, // was Sept.
  { articleId: "art_01M1EVVSS13M5NFJA734F80NBT", primary: "McDonald's" }, // was Sept.
  { articleId: "art_01M1G8Q1712YEX1HVDH3YYS7EF", primary: "JioHotstar" }, // was Canada
  { articleId: "art_01M1FM8W1ZPY86HHGKXT5X7T1X", primary: "JioHotstar" },
  { articleId: "art_01M1FKY373JAJ3F8DGQVQ9EQGD", primary: "JioHotstar" },
  { articleId: "art_01M1HJPG6MEPS88W9FEVW421GV", primary: "Amazon" }, // was Pasqal on Prime YA
  { articleId: "art_01M1HSRYAARQTK25RW3S5Z3AWZ", primary: "BQP", secondaries: ["IBM"] }, // was Xanadu
  { articleId: "art_01M1HCQ9YMW0XW3YARCCF6HMXK", primary: "PsiQuantum" }, // was Xanadu
  { articleId: "art_01M1HMNA8F6K35AZW0NHKC77KB", primary: "Circular" }, // was Ring (product)
  { articleId: "art_01M1HSSZ4D6FD6XKBVQ5A99RWZ", primary: "Graeter's", secondaries: ["Toyota"] },
  { articleId: "art_01M1HJ2SV34WDAJWQFA8W9VVF4", primary: "X", secondaries: ["Stripe"] }, // was Stripe-only
  { articleId: "art_01M1HS4Y2FZXX453XJ1080A5J2", primary: "Coder", secondaries: ["Cursor", "SpaceXAI"] },
  { articleId: "art_01M1EZDSRPXXEBCKFVJHKMF97Y", primary: "Bamboo Insurance" }, // was LSEG
  { articleId: "art_01M1EZ4KMHD0C5R7XTKRZNC7QG", primary: "AMD" }, // was Stock
  { articleId: "art_01M1EX6M0S1J7NRDS2P0D1BYD3", primary: "LIV Golf" }, // was Malbon Golf
  { articleId: "art_01M1EZ9YT4CH6NPRG4DAZW0Z5M", primary: "Dream Racers", secondaries: ["Roblox"] },
  // collateral: same junk tokens on older kept articles
  { articleId: "art_01M0M37AFSDTBWS9RGGHXKZ1MG", primary: "Google" }, // Gemini 3.7 Flash
  { articleId: "art_01M0S183M35QRKYKP9RB9G8FR0", primary: "Google" }, // Gemini 3.6 Flash
  { articleId: "art_01M0X781NQ02VJ3KTKVVRNZA5J", primary: "Burger King" }, // was Sept.
  { articleId: "art_01M15KKJ9H275KXMJ3J2E8P69V", primary: "NuScale" }, // was Stock
  { articleId: "art_01M0R49X0A9T7VVM1R9QQV75HQ", primary: "Series" }, // AI social network product
  { articleId: "art_Y231EN0M108XFHEGBSGJ63S24E", primary: "Series" },
  { articleId: "art_01M1HCKX4HH45F7A6JHVAF3KV3", primary: "Alibaba" }, // was China
];

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] }).rows ?? []) as T[];
}

function extractLawsuitCompany(title: string): string | null {
  const lead = /\bLead\s+(.+?)\s+(?:Securities|Class Action)/i.exec(title);
  if (lead?.[1]) {
    const raw = lead[1]
      .replace(/,\s*Inc\.?$/i, "")
      .replace(/\s+Inc\.?$/i, "")
      .replace(/\s+Ltd\.?$/i, "")
      .replace(/\s+plc$/i, "")
      .trim();
    if (raw && !entityNameRejectionReason(raw)) return raw;
    if (/microvast/i.test(raw)) return "Microvast";
    if (/photronics/i.test(raw)) return "Photronics";
    if (/insulet/i.test(raw)) return "Insulet";
    if (/wix/i.test(raw)) return "Wix";
    if (/procept/i.test(raw)) return "PROCEPT BioRobotics";
  }

  const beforeShareholders = /^(.+?)\s+Shareholders\b/i.exec(title);
  if (beforeShareholders?.[1]) {
    const raw = beforeShareholders[1]
      .replace(/,\s*Inc\.?$/i, "")
      .replace(/\s+\([A-Z]{1,5}\)\s*$/i, "")
      .trim();
    if (raw && !entityNameRejectionReason(raw)) return raw;
  }

  const investigation = /Investigation Launched into\s+(.+?),/i.exec(title);
  if (investigation?.[1]) {
    const raw = investigation[1].replace(/,\s*Inc\.?$/i, "").trim();
    if (raw && !entityNameRejectionReason(raw)) return raw;
  }

  const classAction = /^(.+?)\s+Securities Fraud Class Action/i.exec(title);
  if (classAction?.[1]) {
    const raw = classAction[1].trim();
    if (raw && !entityNameRejectionReason(raw)) return raw;
  }

  return extractTitleSubject(title);
}

function isJunkEntityName(name: string): boolean {
  const n = name.trim();
  if (JUNK_NAMES.includes(n)) return true;
  if (/have opportunity/i.test(n)) return true;
  if (/^inc\.?\s+securities fraud lawsuit$/i.test(n)) return true;
  if (/^ltd\.?\s+securities/i.test(n)) return true;
  if (/securities lawsuit phh$/i.test(n)) return true;
  if (/securities fraud lawsuit$/i.test(n) && n.length < 40) return true;
  if (/\bUNVEILS$/i.test(n)) return true;
  if (/^investors have opportunity$/i.test(n)) return true;
  if (/^meta's$/i.test(n)) return true;
  if (/^how$/i.test(n)) return true;
  if (/^investors$/i.test(n)) return true;
  if (/^please$/i.test(n)) return true;
  if (/^trusted source$/i.test(n)) return true;
  if (/^indian$/i.test(n)) return true;
  if (/^oracle helped/i.test(n)) return true;
  if (/^(exclusive|breaking|update|alert)\b/i.test(n)) return true;
  if (isHeadlineFragmentEntity(n)) return true;
  return false;
}

async function findEntityId(db: ReturnType<typeof createDb>, name: string): Promise<string | null> {
  const norm = normalizeName(name);
  const hit = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE merged_into IS NULL
        AND (canonical_name ILIKE ${name} OR ${norm} = ANY(aliases))
      ORDER BY CASE WHEN canonical_name ILIKE ${name} THEN 0 ELSE 1 END, confidence DESC
      LIMIT 1
    `),
  );
  return hit[0]?.id ?? null;
}

async function ensureEntity(db: ReturnType<typeof createDb>, name: string): Promise<string> {
  const existing = await findEntityId(db, name);
  if (existing) return existing;
  const id = opaqueId("ent");
  if (!dryRun) {
    await db.insert(entities).values({
      id,
      canonicalName: name,
      aliases: [normalizeName(name)],
      confidence: 0.55,
      createdBy: "scrub:fix-drain-session",
      sourceRefs: ["scrub:fix-drain-session"],
    });
    await db.insert(aliases).values({
      id: opaqueId("als"),
      entityId: id,
      alias: name,
      aliasNormalized: normalizeName(name),
      kind: "name",
      weight: 0.9,
      source: "scrub",
    });
  }
  console.log(`mint  ${name}`);
  return id;
}

async function relinkArticle(
  db: ReturnType<typeof createDb>,
  articleId: string,
  primary: string,
  secondaries: string[] = [],
): Promise<void> {
  if (dryRun) {
    console.log(`would fix  ${articleId}  ${primary}${secondaries.length ? ` + ${secondaries.join(", ")}` : ""}`);
    return;
  }
  await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
  const primaryId = await ensureEntity(db, primary);
  await db.insert(articleEntities).values({
    articleId,
    entityId: primaryId,
    role: "primary",
    confidence: 0.9,
  });
  for (const sec of secondaries) {
    const secId = await ensureEntity(db, sec);
    await db.insert(articleEntities).values({
      articleId,
      entityId: secId,
      role: "secondary",
      confidence: 0.75,
    });
  }
  await db
    .update(articles)
    .set({ noiseStage: "kept", discardReason: null, updatedAt: new Date() })
    .where(eq(articles.id, articleId));
  console.log(`fixed  ${articleId}  ${primary}${secondaries.length ? ` + ${secondaries.join(", ")}` : ""}`);
}

async function deleteEntityIfOrphan(db: ReturnType<typeof createDb>, entityId: string): Promise<void> {
  const left = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM article_entities WHERE entity_id = ${entityId}
    `),
  );
  if ((left[0]?.n ?? 0) === 0 && !dryRun) {
    await db.delete(aliases).where(eq(aliases.entityId, entityId));
    await db.delete(entities).where(eq(entities.id, entityId));
  }
}

async function scrubHeadlineFragmentLinks(db: ReturnType<typeof createDb>): Promise<void> {
  const links = rowsOf<{
    article_id: string;
    entity_id: string;
    role: string;
    canonical_name: string;
    title: string;
  }>(
    await db.execute(sql`
      SELECT ae.article_id, ae.entity_id, ae.role, e.canonical_name, a.title
      FROM article_entities ae
      JOIN entities e ON e.id = ae.entity_id
      JOIN articles a ON a.id = ae.article_id
      WHERE a.noise_stage = 'kept'
    `),
  );

  for (const link of links) {
    const name = String(link.canonical_name);
    const title = String(link.title);
    if (!isHeadlineFragmentEntity(name, title)) continue;

    console.log(`unlink headline-fragment  ${link.role}  ${name}  ${link.article_id}`);
    if (!dryRun) {
      await db.execute(sql`
        DELETE FROM article_entities
        WHERE article_id = ${link.article_id} AND entity_id = ${link.entity_id}
      `);
      await deleteEntityIfOrphan(db, String(link.entity_id));
    }

    if (link.role !== "primary") continue;

    const inferred = extractLawsuitCompany(title) ?? extractTitleSubject(title);
    if (inferred && !isHeadlineFragmentEntity(inferred, title)) {
      await relinkArticle(db, String(link.article_id), inferred);
    } else {
      console.log(`requeue (bad primary fragment)  ${link.article_id}`);
      if (!dryRun) {
        await db
          .update(articles)
          .set({
            noiseStage: "waiting",
            resolvedAt: null,
            discardReason: "scrub:headline_fragment_entity",
            updatedAt: new Date(),
          })
          .where(eq(articles.id, String(link.article_id)));
      }
    }
  }
}

async function main(): Promise<void> {
  const db = createDb(getConfig().DATABASE_URL);
  console.log(dryRun ? "DRY RUN" : "LIVE");

  for (const drop of DROP_KEPT) {
    console.log(`drop kept  ${drop.id}  ${drop.reason}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({ noiseStage: "llm_filter", discardReason: drop.reason, updatedAt: new Date() })
        .where(eq(articles.id, drop.id));
    }
  }

  for (const fix of FIXES) {
    await relinkArticle(db, fix.articleId, fix.primary, fix.secondaries ?? []);
  }

  await scrubHeadlineFragmentLinks(db);

  const junkEntities = rowsOf<{ id: string; canonical_name: string }>(
    await db.execute(sql`
      SELECT id, canonical_name FROM entities
      WHERE merged_into IS NULL
    `),
  ).filter((e) => isJunkEntityName(String(e.canonical_name)));

  const junkIds = junkEntities.map((e) => String(e.id));
  if (junkIds.length) {
    console.log(`junk entities: ${junkEntities.map((e) => e.canonical_name).join(", ")}`);
    const affected = rowsOf<{ article_id: string; title: string; noise_stage: string }>(
      await db.execute(sql`
        SELECT DISTINCT a.id AS article_id, a.title, a.noise_stage
        FROM article_entities ae
        JOIN articles a ON a.id = ae.article_id
        WHERE ae.entity_id IN (${sql.join(junkIds.map((id) => sql`${id}`), sql`, `)})
      `),
    );

    if (!dryRun) {
      await db.delete(articleEntities).where(inArray(articleEntities.entityId, junkIds));
      await db.delete(aliases).where(inArray(aliases.entityId, junkIds));
      await db.delete(entities).where(inArray(entities.id, junkIds));
    }

    for (const row of affected) {
      if (row.noise_stage !== "kept") continue;
      // Skip articles we already explicitly fixed in FIXES this run.
      if (FIXES.some((f) => f.articleId === String(row.article_id))) continue;

      const remaining = rowsOf<{ n: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM article_entities
          WHERE article_id = ${String(row.article_id)}
            AND entity_id NOT IN (${sql.join(junkIds.map((id) => sql`${id}`), sql`, `)})
        `),
      );
      // Still has a good link (e.g. UPDATE: DP World junk + DP World primary) — leave it.
      if ((remaining[0]?.n ?? 0) > 0) {
        console.log(`kept ok after junk unlink  ${row.article_id}`);
        continue;
      }

      const inferred =
        extractLawsuitCompany(String(row.title)) ?? extractTitleSubject(String(row.title));
      if (
        inferred &&
        !isJunkEntityName(inferred) &&
        !entityNameRejectionReason(inferred) &&
        !isHeadlineFragmentEntity(inferred, String(row.title))
      ) {
        await relinkArticle(db, String(row.article_id), inferred);
      } else {
        console.log(`requeue  ${row.article_id}  (was junk-linked kept)`);
        if (!dryRun) {
          await db
            .update(articles)
            .set({
              noiseStage: "waiting",
              resolvedAt: null,
              discardReason: "scrub:bad_resolution",
              updatedAt: new Date(),
            })
            .where(eq(articles.id, String(row.article_id)));
        }
      }
    }
  }

  const orphanKept = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT a.id FROM articles a
      WHERE a.noise_stage = 'kept'
        AND NOT EXISTS (SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id)
    `),
  );
  for (const row of orphanKept) {
    console.log(`requeue (no entities)  ${row.id}`);
    if (!dryRun) {
      await db
        .update(articles)
        .set({
          noiseStage: "waiting",
          resolvedAt: null,
          discardReason: "scrub:no_entities",
          updatedAt: new Date(),
        })
        .where(eq(articles.id, row.id));
    }
  }

  const badKept = rowsOf<{ id: string; title: string; canonical_name: string }>(
    await db.execute(sql`
      SELECT a.id, a.title, e.canonical_name
      FROM articles a
      JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
      JOIN entities e ON e.id = ae.entity_id
      WHERE a.noise_stage = 'kept'
    `),
  ).filter((r) => isJunkEntityName(String(r.canonical_name)) || isHeadlineFragmentEntity(String(r.canonical_name), String(r.title)));

  console.log(`bad kept primaries remaining: ${badKept.length}`);
  for (const row of badKept) {
    console.log(`  ${row.id}  ${row.canonical_name}  ${row.title.slice(0, 80)}`);
  }

  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
