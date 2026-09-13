import postgres from "postgres";
import type { OkaraLaunch } from "./store.js";
import { isSyncable, planLaunch } from "./mapping.js";
import { canonicalizeUrl, hostToDomain, normalizeName, opaqueId, sha256Hex, urlHash } from "./lib.js";

export interface SyncCounts {
  source: number;
  skipped: number;
  entitiesCreated: number;
  entitiesMatched: number;
  articlesInserted: number;
  articlesExisting: number;
  linksCreated: number;
}

export interface SyncOptions {
  databaseUrl: string;
  /** Log each row instead of writing. */
  dryRun?: boolean;
  onProgress?: (msg: string) => void;
}

interface EntityRow {
  id: string;
}

interface IdRow {
  id: string | null;
}

/**
 * Push launches into the parent intelligence Postgres:
 *   company  -> entities (+ aliases)
 *   launch   -> raw_items + articles (noise_stage='kept') + article_entities (primary)
 * Fully idempotent: entities by live-website key or exact name, rows by url_hash.
 */
export async function syncLaunches(
  launches: OkaraLaunch[],
  opts: SyncOptions,
): Promise<SyncCounts> {
  const sql = postgres(opts.databaseUrl, { max: 2, idle_timeout: 5 });
  const counts: SyncCounts = {
    source: launches.length,
    skipped: 0,
    entitiesCreated: 0,
    entitiesMatched: 0,
    articlesInserted: 0,
    articlesExisting: 0,
    linksCreated: 0,
  };

  try {
    await sql`SELECT 1`;

    for (const l of launches) {
      if (!isSyncable(l)) {
        counts.skipped++;
        continue;
      }
      const plan = planLaunch(l);
      const log = opts.onProgress;
      if (opts.dryRun) {
        log?.(`dry-run ${l.slug}: entity "${plan.entity.canonicalName}" (${plan.entity.website ?? "no domain"}) + article "${plan.article.title.slice(0, 60)}"`);
        continue;
      }

      // -- entity -----------------------------------------------------------
      let entityId: string | undefined;
      if (plan.entity.website) {
        const [row] = await sql<EntityRow[]>`
          SELECT id FROM entities
          WHERE website = ${plan.entity.website} AND merged_into IS NULL
          LIMIT 1`;
        entityId = row?.id;
      }
      if (!entityId) {
        const [row] = await sql<EntityRow[]>`
          SELECT id FROM entities
          WHERE LOWER(canonical_name) = LOWER(${plan.entity.canonicalName}) AND merged_into IS NULL
          LIMIT 1`;
        entityId = row?.id;
      }
      if (entityId) {
        counts.entitiesMatched++;
      } else {
        const id = opaqueId("ent");
        const inserted = await sql<EntityRow[]>`
          INSERT INTO entities
            (id, canonical_name, website, aliases, type, status, industry_tags,
             source_refs, confidence, review_status, created_by)
          VALUES (${id}, ${plan.entity.canonicalName}, ${plan.entity.website},
                  ${sql.array([plan.entity.canonicalName, ...plan.entity.aliases])},
                  'private', 'operating', ${sql.array(plan.entity.industryTags)},
                  ${sql.array(["okara:launch-library"])}, ${plan.entity.confidence},
                  'auto_created', 'launchmonitor')
          ON CONFLICT DO NOTHING
          RETURNING id`;
        if (inserted.length === 0) {
          // Lost a race on the partial unique website index — re-select.
          const [row] = await sql<EntityRow[]>`
            SELECT id FROM entities
            WHERE website = ${plan.entity.website} AND merged_into IS NULL
            LIMIT 1`;
          entityId = row?.id;
          if (entityId) counts.entitiesMatched++;
        } else {
          entityId = inserted[0]?.id;
          counts.entitiesCreated++;
        }
      }
      if (!entityId) throw new Error(`no entity id for launch ${l.slug}`);

      for (const alias of [plan.entity.canonicalName, ...plan.entity.aliases]) {
        const norm = normalizeName(alias);
        if (!norm) continue;
        await sql`
          INSERT INTO aliases (id, entity_id, alias, alias_normalized, kind, weight, source)
          VALUES (${opaqueId("als")}, ${entityId}, ${alias}, ${norm},
                  ${alias === plan.entity.website ? "domain" : "name"}, 1, 'launchmonitor')
          ON CONFLICT DO NOTHING`;
      }

      // -- raw item ---------------------------------------------------------
      const uHash = urlHash(plan.article.urlHashable);
      const gHash = sha256Hex(canonicalizeUrl(plan.article.urlHashable));
      let rawItemId = (
        await sql<IdRow[]>`
          INSERT INTO raw_items
            (id, discovered_via, url, url_hash, guid_hash, title, published_at,
             raw_payload, fetch_state)
          VALUES (${opaqueId("raw")}, 'manual', ${plan.article.url}, ${uHash}, ${gHash},
                  ${plan.article.title}, ${plan.article.publishedAt},
                  ${sql.json(l)}, 'fetched')
          ON CONFLICT (url_hash) DO NOTHING
          RETURNING id`
      )[0]?.id;
      if (!rawItemId) {
        rawItemId = (
          await sql<IdRow[]>`SELECT id FROM raw_items WHERE url_hash = ${uHash} LIMIT 1`
        )[0]?.id ?? null;
      }

      // -- article ----------------------------------------------------------
      const artInserted = await sql<IdRow[]>`
        INSERT INTO articles
          (id, raw_item_id, url, url_hash, publisher_domain, title, byline,
           published_at, language, excerpt_text, noise_stage, primary_tag,
           secondary_tags, all_tags, industry_primary, platform_meta,
           resolved_at, enriched_at)
        VALUES (${opaqueId("art")}, ${rawItemId}, ${plan.article.url}, ${uHash},
                ${hostToDomain(plan.article.url)}, ${plan.article.title}, ${plan.article.byline},
                ${plan.article.publishedAt}, 'en', ${plan.article.excerptText.slice(0, 400)},
                'kept', ${plan.article.primaryTag},
                ${sql.array(plan.article.secondaryTags)}, ${sql.array(plan.article.allTags)},
                ${plan.article.industryPrimary}, ${sql.json(plan.article.platformMeta)},
                now(), now())
        ON CONFLICT (url_hash) DO NOTHING
        RETURNING id`;
      if (artInserted.length > 0) counts.articlesInserted++;
      else counts.articlesExisting++;

      const articleId =
        (artInserted[0] as unknown as IdRow | undefined)?.id ??
        (
          await sql<IdRow[]>`SELECT id FROM articles WHERE url_hash = ${uHash} LIMIT 1`
        )[0]?.id;
      if (!articleId) throw new Error(`no article id for launch ${l.slug}`);

      // -- link -------------------------------------------------------------
      const link = await sql`
        INSERT INTO article_entities
          (article_id, entity_id, role, confidence, evidence)
        VALUES (${articleId}, ${entityId}, 'primary', ${plan.entity.confidence},
                ${sql.json({
                  domain_overlap: Boolean(plan.entity.website),
                  llm: "not_needed",
                  notes: [`launch-directory:${l.slug}`],
                })})
        ON CONFLICT (article_id, entity_id) DO NOTHING`;
      if (link.count > 0) counts.linksCreated++;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return counts;
}
