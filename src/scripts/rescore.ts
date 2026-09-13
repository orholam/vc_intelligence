import { eq, sql } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { getFilters } from "../config-files.js";
import { createDb } from "../db/index.js";
import { articleEntities, articles, entities } from "../db/schema.js";
import { normalizeName } from "../lib/text.js";
import { entityNameRejectionReason } from "../lib/quality.js";

/**
 * FR-24 backlog rescore: applies the precision-overhaul rules to articles
 * already ingested under the old lenient funnel. Zero LLM spend — purely
 * deterministic re-gating of stored evidence:
 *
 *   1. Syndicated-title dedup over kept articles (identical normalized title
 *      inside the prefilter.dedup_window_hours window -> later copies are
 *      discarded as `title_duplicate_of:<id>`, earliest wins).
 *   2. Resolution re-gate: a primary entity link survives only when it has
 *      subject evidence — alias anchored in the TITLE, domain overlap, or an
 *      LLM adjudication at/above primary_min_confidence. Legacy links that
 *      passed on body mentions / ticker echoes alone are removed and the
 *      article's enrichment is cleared (it described the wrong company).
 *   3. Junk-entity deactivation: canonical names failing the KB name-quality
 *      guard are marked review_status='rejected' and unlinked everywhere.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 * Usage: pnpm exec tsx src/scripts/rescore.ts [--apply]
 */

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

interface DemoteStats {
  dedupDiscarded: number;
  linksChecked: number;
  linksDemoted: number;
  secondariesDropped: number;
  junkEntities: number;
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  resetConfigCache();
  const cfg = getConfig();
  const db = createDb(cfg.DATABASE_URL, { max: 4 });
  const filters = getFilters();
  const stats: DemoteStats = {
    dedupDiscarded: 0,
    linksChecked: 0,
    linksDemoted: 0,
    secondariesDropped: 0,
    junkEntities: 0,
  };
  const demotedSamples: string[] = [];

  // ---- pass 1: syndicated-title dedup over kept articles --------------------
  const dupes = await db.execute<{ keep_id: string; drop_id: string }>(sql`
    WITH ranked AS (
      SELECT id,
             lower(btrim(regexp_replace(title, '\\s+', ' ', 'g'))) AS norm_title,
             ROW_NUMBER() OVER (
               PARTITION BY lower(btrim(regexp_replace(title, '\\s+', ' ', 'g')))
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM articles
      WHERE noise_stage = 'kept'
        AND created_at > now() - (${filters.prefilter.dedup_window_hours} * interval '1 hour')
    )
    SELECT keep_id, drop_id
    FROM (
      SELECT a.id AS drop_id,
             (SELECT b.id FROM ranked b
              WHERE b.norm_title = a.norm_title AND b.rn = 1) AS keep_id
      FROM ranked a WHERE a.rn > 1
    ) d
    WHERE keep_id IS NOT NULL
  `);
  for (const row of dupes) {
    stats.dedupDiscarded++;
    if (apply) {
      await db.execute(sql`
        UPDATE articles SET noise_stage = 'prefilter',
          discard_reason = ${`title_duplicate_of:${row.keep_id}`},
          updated_at = now()
        WHERE id = ${row.drop_id}
      `);
      await db.execute(sql`DELETE FROM article_entities WHERE article_id = ${row.drop_id}`);
    }
  }

  // ---- pass 2: resolution re-gate on subject evidence -----------------------
  const links = await db
    .select({
      articleId: articleEntities.articleId,
      entityId: articleEntities.entityId,
      confidence: articleEntities.confidence,
      role: articleEntities.role,
      evidence: articleEntities.evidence,
      title: articles.title,
      outlinkDomains: articles.outlinkDomains,
    })
    .from(articleEntities)
    .innerJoin(articles, eq(articles.id, articleEntities.articleId));

  const entRows = await db.select().from(entities);
  const entsById = new Map(entRows.map((e) => [e.id, e]));
  // Alias lookups use the same union the runtime resolver sees: canonical
  // name + denormalized aliases array + alias-table rows. Ticker aliases are
  // EXCLUDED here: short tickers ("MAC", "UBER") substring-match unrelated
  // headlines and are not subject evidence (live resolver scores them
  // separately with word-bounded regexes).
  const aliasRows = await db.execute<{ entity_id: string; alias_normalized: string }>(sql`
    SELECT entity_id, alias_normalized FROM aliases WHERE kind <> 'ticker'
  `);
  const aliasesByEntity = new Map<string, Set<string>>();
  for (const r of aliasRows) {
    const set = aliasesByEntity.get(r.entity_id) ?? new Set<string>();
    set.add(r.alias_normalized);
    aliasesByEntity.set(r.entity_id, set);
  }

  const demoteArticle = async (articleId: string) => {
    if (!apply) return;
    await db.execute(sql`DELETE FROM article_entities WHERE article_id = ${articleId}`);
    await db.execute(sql`
      UPDATE articles SET
        resolved_at = NULL, enriched_at = NULL,
        primary_tag = NULL, secondary_tags = '{}', all_tags = '{}',
        sentiment = NULL, sentiment_score = NULL, newsworthiness = NULL,
        industry_primary = NULL, industry_secondary = '{}', countries = '{}',
        ai_summary = NULL, story_cluster_id = NULL,
        is_cluster_representative = false, embedding = NULL,
        updated_at = now()
      WHERE id = ${articleId}
    `);
  };

  const demotedArticles = new Set<string>();
  for (const l of links) {
    if (l.role !== "primary") continue;
    stats.linksChecked++;
    const e = entsById.get(l.entityId);
    if (!e || e.mergedInto != null) {
      stats.linksDemoted++;
      demotedArticles.add(l.articleId);
      continue;
    }
    const ev = (l.evidence ?? {}) as Record<string, unknown>;
    const scores = (ev.scores ?? {}) as Record<string, unknown>;

    const aliasesNorm = new Set([
      ...[e.canonicalName, ...e.aliases]
        .filter((a): a is string => Boolean(a))
        .map(normalizeName)
        .filter((a) => a.length >= 3),
      ...(aliasesByEntity.get(e.id) ?? []),
    ].filter((a) => a.length >= 3));
    const titleNorm = normalizeName(l.title);
    const titleHit = [...aliasesNorm].some((a) => titleNorm.includes(a));
    const domainOverlap = Boolean(
      e.website && (l.outlinkDomains ?? []).includes(e.website),
    );
    // Legacy `llm:"adjudicated"` rows came from the pre-overhaul prompt and
    // demonstrably blessed body-mention matches (Apple on mutual-fund columns,
    // Uber on stock-pick commentary), so only NEW numeric adjudications count.
    const llmConf =
      typeof scores.llm_adjudication === "number" ? scores.llm_adjudication : 0;

    const subjectEvidence =
      titleHit || domainOverlap || llmConf >= filters.resolver.primary_min_confidence;
    if (!subjectEvidence) {
      stats.linksDemoted++;
      demotedArticles.add(l.articleId);
      if (process.env.RESCORE_VERBOSE || demotedSamples.length < 15) {
        demotedSamples.push(
          `${e.canonicalName}  <-  "${l.title.slice(0, 70)}" [titleHit=${titleHit} domainOverlap=${domainOverlap} llmConf=${llmConf}]`,
        );
      }
      continue;
    }
  }

  // Stale weak secondaries (pre-overhaul threshold was 0.45).
  const weakSecondaries = await db.execute<{ article_id: string; entity_id: string }>(sql`
    SELECT article_id, entity_id FROM article_entities
    WHERE role = 'secondary' AND confidence < ${filters.resolver.secondary_min_confidence}
  `);
  stats.secondariesDropped += weakSecondaries.length;
  if (apply) {
    for (const row of weakSecondaries) {
      await db.execute(sql`
        DELETE FROM article_entities
        WHERE article_id = ${row.article_id} AND entity_id = ${row.entity_id} AND role = 'secondary'
      `);
    }
  }

  // ---- pass 3: junk-entity deactivation -------------------------------------
  // Schema has no 'rejected' review status; deactivation = merged_into
  // sentinel, which every entity-indexed query filters out.
  const JUNK_SENTINEL = "__junk__";
  for (const e of entRows) {
    if (e.mergedInto != null) continue;
    const reason = entityNameRejectionReason(e.canonicalName);
    if (!reason) continue;
    // SEC-style all-caps legal names ("QUALYS, INC.") are legitimate; the
    // quality guard already allows them. Anything else flagged gets parked.
    stats.junkEntities++;
    if (apply) {
      await db.execute(sql`
        UPDATE entities SET merged_into = ${JUNK_SENTINEL}, updated_at = now()
        WHERE id = ${e.id}
      `);
      await db.execute(sql`DELETE FROM article_entities WHERE entity_id = ${e.id}`);
    }
  }

  if (apply) {
    for (const articleId of demotedArticles) await demoteArticle(articleId);
  }

  console.log(
    `[rescore] mode=${apply ? "APPLY" : "DRY-RUN"}\n` +
      `  syndicated duplicates discarded: ${stats.dedupDiscarded}\n` +
      `  primary links checked:           ${stats.linksChecked}\n` +
      `  primary links demoted:           ${stats.linksDemoted} (${demotedArticles.size} articles)\n` +
      `  weak secondaries dropped:        ${stats.secondariesDropped}\n` +
      `  junk entities deactivated:       ${stats.junkEntities}`,
  );
  if (demotedSamples.length) {
    console.log("  sample demotions:\n    " + demotedSamples.join("\n    "));
  }
  if (!apply) console.log("[rescore] dry-run only — re-run with --apply to write changes.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
