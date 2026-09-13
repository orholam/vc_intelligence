import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { getConfig, resetConfigCache } from "../config.js";
import { articles, entities } from "../db/schema.js";
import { makeStorage } from "../storage.js";
import { summarizeArticle } from "../llm/reasoner/summary.js";
import { flattenEventTypes } from "../config-files.js";

/**
 * R11 backfill: regenerate ai_summary for every kept article under the
 * CURRENT summarizer (template v3 + leak guard). Deterministic; no LLM.
 * Clears the FR-16 reuse guard by rewriting in place.
 */
resetConfigCache();
const cfg = getConfig();
const client = postgres(cfg.DATABASE_URL, { max: 2, onnotice: () => {} });
const db = drizzle(client, { schema, logger: false });
const storage = makeStorage();
const events = flattenEventTypes();

const rows = await db
  .select({
    id: articles.id,
    title: articles.title,
    tag: articles.primaryTag,
    path: articles.extractedTextPath,
    entity: entities.canonicalName,
  })
  .from(articles)
  .leftJoin(entities, sql`entities.id = (SELECT ae.entity_id FROM article_entities ae WHERE ae.article_id = ${articles.id} AND ae.role='primary' LIMIT 1)`)
  .where(eq(articles.noiseStage, "kept"))
  .orderBy(sql`published_at ASC`)
  .limit(4000);

let regen = 0;
for (const [i, r] of rows.entries()) {
  let body = "";
  try {
    body = (await storage.get(r.path ?? "")) ?? "";
  } catch { /* absent */ }
  if (!body && r.path?.startsWith("local://")) {
    try { body = (await storage.get(r.path)) ?? ""; } catch { /* ignore */ }
  }
  const label = r.tag && r.tag !== "status.no_event" ? events.byId.get(r.tag)?.label ?? null : null;
  const summary = summarizeArticle({
    title: r.title,
    body: body || r.title,
    entityName: r.entity ?? null,
    eventLabel: label,
  });
  await db.execute(sql`
    UPDATE articles SET ai_summary = ${summary}, updated_at = now()
    WHERE id = ${r.id}`);
  regen++;
  if ((i + 1) % 300 === 0) console.log(`${i + 1}/${rows.length}`);
}
console.log(`regenerated ${regen} summaries`);
process.exit(0);
