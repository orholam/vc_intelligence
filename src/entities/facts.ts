import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { flattenEventTypes, getFilters, renderPrompt, getTemplate } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articles, entities, facts, sources } from "../db/schema.js";
import { excerpt, normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";
import type { LlmRouter } from "../llm/router.js";

/**
 * FR-9: high-confidence funding/M&A events on highly newsworthy kept articles
 * become structured fact PROPOSALS in the KB. A fact promotes proposed ->
 * accepted only with two independent publisher domains or one tier-1 source;
 * accepted facts update entity.funding_stage / total_raised_usd /
 * last_funding_date. Funding fields are never bought data (NG1/NG4).
 */

const ExtractedFact = z.object({
  has_event: z.boolean(),
  type: z
    .enum(["funding_round", "acquisition", "leadership_change", "closure"])
    .nullable()
    .default(null),
  payload: z
    .object({
      funding_stage: z.string().nullable().default(null),
      amount_usd_est: z.number().nullable().default(null),
      lead_investors: z.array(z.string()).default([]),
      acquirer: z.string().nullable().default(null),
      target: z.string().nullable().default(null),
      person: z.string().nullable().default(null),
      role: z.string().nullable().default(null),
      event_date: z.string().nullable().default(null),
    })
    .default({}),
});

export interface FactProposalResult {
  proposed: boolean;
  accepted: boolean;
  factId?: string;
  reason?: string;
}

function amountBucket(amount: number | null): string {
  if (!amount || amount <= 0) return "na";
  return `~1e${Math.floor(Math.log10(amount))}`; // magnitude bucket
}

export async function proposeFactFromArticle(
  db: Db,
  router: LlmRouter,
  args: {
    articleId: string;
    entityId: string;
    resolverConfidence: number;
  },
): Promise<FactProposalResult> {
  const filters = getFilters();

  const [article] = await db.select().from(articles).where(eq(articles.id, args.articleId)).limit(1);
  const [entity] = await db.select().from(entities).where(eq(entities.id, args.entityId)).limit(1);
  if (!article || !entity) return { proposed: false, accepted: false, reason: "missing article/entity" };
  if (!article.primaryTag || !article.newsworthiness) {
    return { proposed: false, accepted: false, reason: "not enriched" };
  }
  const factWorthyTag =
    article.primaryTag.startsWith("funding.") || article.primaryTag.startsWith("mna.");
  if (article.newsworthiness !== "high" && !factWorthyTag) {
    return { proposed: false, accepted: false, reason: "not high-tier" };
  }

  const evDef = flattenEventTypes().byId.get(article.primaryTag);
  if (!evDef?.fact_type) return { proposed: false, accepted: false, reason: "no fact_type" };
  if (args.resolverConfidence < filters.facts.min_event_confidence) {
    return { proposed: false, accepted: false, reason: "resolver confidence below floor" };
  }

  // Full text lives in storage; fall back to title when missing.
  let body = article.title;
  if (article.extractedTextPath) {
    const { makeStorage } = await import("../storage.js");
    const text = await makeStorage().get(article.extractedTextPath);
    if (text) body = `${article.title}\n${text}`;
  }

  const tpl = getTemplate("fact_extract");
  const { system, user, templateVersion } = renderPrompt(tpl, {
    entity_name: entity.canonicalName,
    entity_domain: entity.website ?? "unknown",
    today: new Date().toISOString().slice(0, 10),
    title: article.title,
    body: excerpt(body, 3000),
  });
  const res = await router.chatJson(ExtractedFact, system, user, {
    stage: "fact_extract",
    tier: "mini",
    promptTemplate: "fact_extract",
    promptTemplateVersion: templateVersion,
    articleId: article.id,
  });
  if (!res.ok || !res.data.has_event || !res.data.type) {
    return { proposed: false, accepted: false, reason: res.ok ? "no event extracted" : res.error.slice(0, 100) };
  }

  const p = (res.data.payload ?? {}) as NonNullable<typeof res.data.payload>;
  const month = p.event_date ? String(p.event_date).slice(0, 7) : article.publishedAt.toISOString().slice(0, 7);
  const dedupKey = [
    args.entityId,
    res.data.type,
    normalizeName(String(p.funding_stage ?? p.acquirer ?? "")) || "na",
    amountBucket(p.amount_usd_est ?? null),
    month,
  ].join("|");

  // Canonical fact per dedup key; extra evidence merges into it.
  await db
    .insert(facts)
    .values({
      id: opaqueId("fct"),
      entityId: args.entityId,
      type: res.data.type,
      payload: {
        funding_stage: p.funding_stage ?? undefined,
        amount_usd_est: p.amount_usd_est ?? undefined,
        lead_investors: p.lead_investors.slice(0, 5),
        event_date: p.event_date ?? undefined,
        ...(p.acquirer ? { acquirer: p.acquirer } : {}),
        ...(p.target ? { target: p.target } : {}),
        ...(p.person ? { person: p.person } : {}),
        ...(p.role ? { role: p.role } : {}),
      },
      status: "proposed",
      evidenceArticleIds: [article.id],
      dedupKey,
    })
    .onConflictDoNothing({ target: facts.dedupKey });

  const [fact] = await db.select().from(facts).where(eq(facts.dedupKey, dedupKey)).limit(1);
  if (!fact) return { proposed: false, accepted: false, reason: "insert failed" };

  if (!fact.evidenceArticleIds.includes(article.id)) {
    const merged = [...fact.evidenceArticleIds, article.id];
    // Corroborating evidence must also refresh the corroboration count:
    // distinct publisher domains across ALL evidence articles.
    const evRows = await db
      .select({ d: articles.publisherDomain })
      .from(articles)
      .where(inArray(articles.id, merged));
    const domains = new Set(evRows.map((r) => r.d));
    await db
      .update(facts)
      .set({
        evidenceArticleIds: merged,
        distinctPublishers: domains.size,
        updatedAt: new Date(),
      })
      .where(eq(facts.id, fact.id));
  }

  const accepted = await tryPromoteFact(db, fact.id);
  return { proposed: true, accepted, factId: fact.id };
}

/** Promotion rule (FR-9): >=2 distinct publisher domains OR any tier-1 source. */
export async function tryPromoteFact(db: Db, factId: string): Promise<boolean> {
  const filters = getFilters();
  const [fact] = await db.select().from(facts).where(eq(facts.id, factId)).limit(1);
  if (!fact || fact.status !== "proposed") return false;

  const rows = fact.evidenceArticleIds.length
    ? await db
        .select({
          domain: articles.publisherDomain,
          tier: sources.tier,
        })
        .from(articles)
        .leftJoin(sources, eq(sources.id, articles.sourceId))
        .where(inArray(articles.id, fact.evidenceArticleIds))
    : [];

  const distinctDomains = new Set(rows.map((r) => r.domain)).size;
  const hasTierOne = rows.some((r) => r.tier === 1);

  const qualifies = filters.facts.require_two_publishers_or_tier1
    ? distinctDomains >= 2 || hasTierOne
    : true;
  if (!qualifies) {
    await db
      .update(facts)
      .set({ distinctPublishers: distinctDomains, bestSourceTier: bestTier(rows), updatedAt: new Date() })
      .where(eq(facts.id, factId));
    return false;
  }

  await db
    .update(facts)
    .set({
      status: "accepted",
      promotedAt: new Date(),
      distinctPublishers: distinctDomains,
      bestSourceTier: bestTier(rows),
      updatedAt: new Date(),
    })
    .where(eq(facts.id, factId));

  await applyFactToEntity(db, factId);
  return true;
}

function bestTier(rows: Array<{ tier: number | null }>): number | null {
  const tiers = rows.map((r) => r.tier).filter((t): t is number => t != null);
  return tiers.length ? Math.min(...tiers) : null;
}

/**
 * Accepted funding facts update the entity KB fields (§6.2 policy note).
 * R07: propagation happens immediately on acceptance and includes
 * `source_refs` pointing at the evidence article ids, so every derived stage/
 * raise on the card traces to clickable provenance.
 */
async function applyFactToEntity(db: Db, factId: string): Promise<void> {
  const [fact] = await db.select().from(facts).where(eq(facts.id, factId)).limit(1);
  if (!fact || fact.type !== "funding_round") return;

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const stage = (fact.payload as { funding_stage?: string | null }).funding_stage;
  const amount = (fact.payload as { amount_usd_est?: number | null }).amount_usd_est;
  const dateRaw = (fact.payload as { event_date?: string | null }).event_date;

  if (stage) set.fundingStage = stage.toLowerCase();
  const [cur] = await db.select().from(entities).where(eq(entities.id, fact.entityId)).limit(1);
  if (amount && cur) {
    set.totalRaisedUsd = Math.max(cur.totalRaisedUsd ?? 0, 0) + amount;
  }
  if (dateRaw) {
    const d = new Date(dateRaw);
    if (!Number.isNaN(d.getTime())) set.lastFundingDate = d;
  } else if (cur) {
    set.lastFundingDate = new Date();
  }
  // R07: evidence article ids land on the card alongside the derived values.
  if (cur) {
    set.sourceRefs = [
      ...new Set([...(cur.sourceRefs ?? []), ...fact.evidenceArticleIds]),
    ].slice(0, 50);
  }
  await db.update(entities).set(set).where(eq(entities.id, fact.entityId));
}

/**
 * R07 verify/repair: re-applies accepted funding facts whose entity card is
 * missing the derived values (e.g. a crash between fact promotion and KB
 * update). The rubric probe "accepted facts older than 24h lacking derived
 * fields" must always come back empty; this closes that gap self-healingly.
 */
export async function repairFactPropagation(db: Db): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT f.id
    FROM facts f
    JOIN entities e ON e.id = f.entity_id
    WHERE f.type = 'funding_round' AND f.status = 'accepted'
      AND f.promoted_at < now() - interval '5 minutes'
      AND (
        (f.payload->>'funding_stage' IS NOT NULL AND COALESCE(e.funding_stage, '') <> lower(f.payload->>'funding_stage'))
        OR (e.last_funding_date IS NULL)
      )
    LIMIT 200
  `);
  for (const r of rows) await applyFactToEntity(db, r.id);
  return rows.length;
}

/** Manual rejection from review tooling. */
export async function rejectFact(db: Db, factId: string, reason: string): Promise<void> {
  await db
    .update(facts)
    .set({ status: "rejected", rejectedReason: reason, updatedAt: new Date() })
    .where(and(eq(facts.id, factId)));
}
