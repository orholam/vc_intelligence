import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { articles, webhookDeliveries, webhookSubscriptions } from "../db/schema.js";
import { hmacSha256Hex } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";
import { getConfig } from "../config.js";

/**
 * FR-21 webhook fan-out: HMAC-SHA256-signed `article` events for every
 * subscription whose entity is related to the article (any role), retried up
 * to 5 times with exponential backoff (1m, 2m, 4m, 8m, 16m).
 */

export async function enqueueArticleDeliveries(db: Db, articleId: string): Promise<number> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT s.id
    FROM webhook_subscriptions s
    JOIN article_entities ae ON ae.entity_id = ANY(s.entity_ids)
    WHERE s.active = true AND ae.article_id = ${articleId}
  `);
  if (!rows.length) return 0;

  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!article) return 0;

  const payload = {
    event: "article" as const,
    article_id: article.id,
    title: article.title,
    url: article.url,
    publisher_domain: article.publisherDomain,
    published_at: article.publishedAt.toISOString(),
    primary_tag: article.primaryTag,
    newsworthiness: article.newsworthiness,
  };

  let enqueued = 0;
  for (const r of rows) {
    await db.insert(webhookDeliveries).values({
      id: opaqueId("whd"),
      subscriptionId: String(r.id),
      articleId,
      payload,
      maxAttempts: getConfig().WEBHOOK_RETRIES,
    });
    enqueued++;
  }
  return enqueued;
}

const BACKOFF_MINUTES = [1, 2, 4, 8, 16];

export async function processDueDeliveries(
  db: Db,
  opts: { limit?: number; now?: Date } = {},
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const now = opts.now ?? new Date();
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .limit(opts.limit ?? 50);

  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    const [sub] = await db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, d.subscriptionId))
      .limit(1);
    if (!sub || !sub.active) {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: "subscription inactive", attempts: d.attempts + 1 })
        .where(eq(webhookDeliveries.id, d.id));
      failed++;
      continue;
    }

    const body = JSON.stringify(d.payload);
    const signature = hmacSha256Hex(sub.secret, body);
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-copyr-signature": `sha256=${signature}`,
          "x-copyr-event": "article",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            attempts: d.attempts + 1,
            lastStatusCode: res.status,
            deliveredAt: new Date(),
          })
          .where(eq(webhookDeliveries.id, d.id));
        delivered++;
      } else {
        throw new Error(`http ${res.status}`);
      }
    } catch (e) {
      const attempts = d.attempts + 1;
      const isLast = attempts >= d.maxAttempts;
      const backoffMin = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 16;
      await db
        .update(webhookDeliveries)
        .set({
          attempts,
          status: isLast ? "failed" : "pending",
          nextAttemptAt: new Date(now.getTime() + backoffMin * 60_000),
          lastError: (e as Error).message.slice(0, 300),
        })
        .where(eq(webhookDeliveries.id, d.id));
      failed++;
      logger.warn(
        { deliveryId: d.id, attempt: attempts, err: (e as Error).message },
        isLast ? "webhook dead-lettered" : "webhook retry scheduled",
      );
    }
  }
  return { attempted: due.length, delivered, failed };
}
