import { eq, sql } from "drizzle-orm";
import { getFilters } from "../config-files.js";
import type { Db } from "../db/index.js";
import { articles, stories } from "../db/schema.js";
import { normalizeName } from "../lib/text.js";
import { opaqueId } from "../lib/ulid.js";
import type { LlmRouter } from "../llm/router.js";

/**
 * FR-17 near-duplicate detection & story clustering: embedding cosine
 * similarity + same-day window + same-primary-entity gate. Representative =
 * highest-tier source. Powers `unique_article=true` (one article per story
 * cluster per entity).
 */

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ClusterResult {
  storyId: string;
  created: boolean;
  similarity: number | null;
}

export async function clusterArticle(
  db: Db,
  router: LlmRouter,
  articleId: string,
): Promise<ClusterResult> {
  const cfg = getFilters().clustering;

  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!article) throw new Error(`article ${articleId} not found`);
  // Harness runs clustering on WAITING items just before publishing them;
  // already-published (kept) rows re-enter only via retry paths.
  if (article.noiseStage !== "waiting" && article.noiseStage !== "kept") {
    throw new Error("only waiting/kept articles are clustered");
  }

  // Embedding for this article (title + lead is enough signal for syndication).
  const primaryRows = await db.execute<{ entity_id: string }>(sql`
    SELECT entity_id FROM article_entities WHERE article_id = ${articleId} AND role = 'primary' LIMIT 1
  `);
  const primaryLink = primaryRows[0];
  const primaryEntityId = primaryLink?.entity_id ?? null;

  const windowStart0 = new Date(article.publishedAt.getTime() - cfg.window_hours * 3600_000);
  const windowEnd0 = new Date(article.publishedAt.getTime() + cfg.window_hours * 3600_000);
  void windowEnd0;

  // ---- Syndication shortcut (FR-17 hardening): identical normalized titles
  // within the window are the SAME story regardless of which entity the
  // (possibly wrong) resolver picked per copy — this is what let 40 wire
  // copies of one announcement become 40 separate "stories".
  const titleKey = normalizeName(article.title);
  if (titleKey.length >= 12) {
    const dupRows = await db.execute<{ story_cluster_id: string | null }>(sql`
      SELECT a.story_cluster_id
      FROM articles a
      WHERE a.noise_stage IN ('kept', 'waiting')
        AND a.id != ${articleId}
        AND a.story_cluster_id IS NOT NULL
        AND a.published_at BETWEEN ${windowStart0.toISOString()} AND ${windowEnd0.toISOString()}
        AND lower(regexp_replace(a.title, '[^a-zA-Z0-9]', '', 'g')) =
            ${titleKey.replace(/[^a-z0-9]/g, "")}
      ORDER BY a.published_at DESC LIMIT 1
    `);
    const existingStory = dupRows[0]?.story_cluster_id;
    if (existingStory) {
      const embRes0 = await router.embed([article.title], { stage: "cluster_embed", articleId });
      if (embRes0.ok) {
        await attachToStory(db, articleId, existingStory, false, embRes0.vectors[0]!);
        return { storyId: existingStory, created: false, similarity: 1 };
      }
    }
  }

  // Stable canonical signal: title + stored excerpt (NOT the mutable AI
  // summary) so syndicated copies embed nearly identically.
  const embRes = await router.embed([`${article.title}\n${article.excerptText ?? ""}`.trim()], {
    stage: "cluster_embed",
    articleId,
  });
  if (!embRes.ok) throw new Error(`embedding failed: ${embRes.error}`);
  const embedding = embRes.vectors[0]!;

  // Candidate neighbors: same time window, already embedded. When the
  // same-entity gate is on we still consider cross-entity pairs at a higher
  // similarity bar — syndicated wire copy often resolves to different (or no)
  // entities yet is the same story.
  const windowStart = new Date(article.publishedAt.getTime() - cfg.window_hours * 3600_000);
  const windowEnd = new Date(article.publishedAt.getTime() + cfg.window_hours * 3600_000);

  const rows = await db.execute<{
    id: string;
    story_cluster_id: string | null;
    embedding: string | number[] | null;
    entity_id: string | null;
  }>(sql`
    SELECT a.id, a.story_cluster_id, a.embedding::text AS embedding, ae.entity_id
    FROM articles a
    LEFT JOIN article_entities ae ON ae.article_id = a.id AND ae.role = 'primary'
    WHERE a.noise_stage IN ('kept', 'waiting')
      AND a.id != ${articleId}
      AND a.embedding IS NOT NULL
      AND a.published_at BETWEEN ${windowStart.toISOString()} AND ${windowEnd.toISOString()}
    ORDER BY a.embedding <=> ${`[${embedding.join(",")}]`}::vector
    LIMIT 120
  `);

  let bestSim = 0;
  let bestStoryId: string | null = null;
  for (const r of rows) {
    if (!r.embedding) continue;
    const vec = parseVector(r.embedding);
    if (!vec) continue;
    const sim = cosine(embedding, vec);
    // Only two resolved rows pointing at the SAME entity earn the lower
    // same-entity bar. Unresolved (null) pairs ride the cross-entity bar —
    // template junk (investor-alert mills, insider-buy roundups) embeds very
    // close together and must not merge just because both sides are null.
    const sameEntity =
      cfg.same_entity_gate && primaryEntityId != null && r.entity_id === primaryEntityId;
    const minSim = sameEntity ? cfg.cosine_threshold : Math.max(cfg.cosine_threshold, cfg.cross_entity_cosine);
    if (sim >= minSim && sim > bestSim) {
      bestSim = sim;
      bestStoryId = r.story_cluster_id ?? null;
    }
  }

  if (bestStoryId) {
    await attachToStory(db, articleId, bestStoryId, false, embedding);
    return { storyId: bestStoryId, created: false, similarity: Number(bestSim.toFixed(3)) };
  }

  // New story; representative starts as this article.
  const storyId = opaqueId("sto");
  await db.insert(stories).values({
    id: storyId,
    primaryEntityId,
    representativeArticleId: articleId,
    articleCount: 1,
  });
  await attachToStory(db, articleId, storyId, true, embedding);
  return { storyId, created: true, similarity: null };
}

async function attachToStory(
  db: Db,
  articleId: string,
  storyId: string,
  isRepresentative: boolean,
  embedding: number[],
): Promise<void> {
  await db
    .update(articles)
    .set({
      storyClusterId: storyId,
      isClusterRepresentative: isRepresentative,
      clusteredAt: new Date(),
      embedding,
      updatedAt: new Date(),
    })
    .where(eq(articles.id, articleId));

  if (!isRepresentative) {
    await db
      .update(stories)
      .set({
        lastSeenAt: new Date(),
        articleCount: sql`${stories.articleCount} + 1`,
      })
      .where(eq(stories.id, storyId));

    // Representative = highest-tier source (FR-17).
    await db.execute(sql`
      WITH rep AS (
        SELECT a.id AS article_id
        FROM articles a
        LEFT JOIN sources s ON s.id = a.source_id
        WHERE a.story_cluster_id = ${storyId}
        ORDER BY COALESCE(s.tier, 4) ASC, a.published_at DESC
        LIMIT 1
      )
      UPDATE articles a
      SET is_cluster_representative = (a.id = (SELECT article_id FROM rep))
      WHERE a.story_cluster_id = ${storyId}
    `);
  }
}

function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((x) => typeof x === "number")) {
    return value as number[];
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\[[\d.,eE\-+\s]*\]$/.test(text)) {
      const nums = text.slice(1, -1).split(",").map((s) => Number(s.trim()));
      if (nums.length && nums.every((n) => Number.isFinite(n))) return nums;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) return parsed as number[];
    } catch {
      /* not JSON */
    }
  }
  return null;
}
