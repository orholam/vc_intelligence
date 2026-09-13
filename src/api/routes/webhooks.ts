import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { webhookSubscriptions } from "../../db/schema.js";
import { Errors } from "../../lib/errors.js";
import { opaqueId } from "../../lib/ulid.js";
import type { AppDeps } from "../deps.js";
import { registerRoute } from "../openapi.js";
import {
  TakedownResponse,
  WebhookSubscriptionCreate,
  WebhookSubscriptionDto,
} from "../contracts.js";

/**
 * FR-21 webhook subscriptions + NFR-7 takedown endpoint.
 */
export function registerWebhookAndTakedownRoutes(app: FastifyInstance, deps: AppDeps) {
  // ------------------------------------------------------------ webhooks
  registerRoute({
    method: "post",
    path: "/v1/webhooks/subscriptions",
    operationId: "createWebhookSubscription",
    summary: "Subscribe an HTTPS endpoint to article events per entity (HMAC-signed).",
    tags: ["webhooks"],
    body: WebhookSubscriptionCreate,
    response: WebhookSubscriptionDto,
  });
  app.post("/v1/webhooks/subscriptions", async (request, reply) => {
    const body = WebhookSubscriptionCreate.parse(request.body ?? {});
    const keyId = request.auth!.keyId;
    const [row] = await deps.db
      .insert(webhookSubscriptions)
      .values({
        id: opaqueId("whs"),
        apiKeyId: keyId,
        url: body.url,
        secret: opaqueId("whsecret").slice(0, 40),
        entityIds: body.entity_ids,
      })
      .returning();
    return reply.status(201).send({ ...toSubDto(row!), secret: row!.secret });
  });

  registerRoute({
    method: "get",
    path: "/v1/webhooks/subscriptions",
    operationId: "listWebhookSubscriptions",
    summary: "List this key's webhook subscriptions.",
    tags: ["webhooks"],
    response: z.object({ data: z.array(WebhookSubscriptionDto) }),
  });
  app.get("/v1/webhooks/subscriptions", async (request, reply) => {
    const rows = await deps.db
      .select()
      .from(webhookSubscriptions)
      .where(sql`api_key_id = ${request.auth!.keyId}`);
    return reply.send({ data: rows.map(toSubDto) });
  });

  app.delete("/v1/webhooks/subscriptions/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    const deleted = await deps.db
      .delete(webhookSubscriptions)
      .where(sql`id = ${id} AND api_key_id = ${request.auth!.keyId}`)
      .returning();
    if (!deleted.length) throw Errors.notFound("subscription not found");
    return reply.send({ deleted: true });
  });

  function toSubDto(row: typeof webhookSubscriptions.$inferSelect) {
    return {
      id: row.id,
      url: row.url,
      entity_ids: row.entityIds,
      active: row.active,
      created_at: row.createdAt.toISOString(),
    };
  }

  // ------------------------------------------------------ takedown (NFR-7)
  registerRoute({
    method: "delete",
    path: "/v1/articles/{url}",
    operationId: "takedownArticle",
    summary:
      "DMCA-style takedown: remove an article URL from all indexes (audit log retained).",
    tags: ["compliance"],
    response: TakedownResponse,
  });
  app.delete("/v1/articles/:url", async (request, reply) => {
    const rawUrl = decodeURIComponent(String((request.params as { url?: string }).url ?? ""));
    if (!/^https?:\/\//i.test(rawUrl)) throw Errors.badRequest("pass the full article URL");
    const { sha256Hex, canonicalizeUrl } = await import("../../lib/hash.js");
    const hash = sha256Hex(canonicalizeUrl(rawUrl));

    const updated = await deps.db.execute<{ n: number }>(sql`
      WITH removed AS (
        UPDATE articles SET noise_stage = 'prefilter', discard_reason = 'takedown', updated_at = now()
        WHERE url_hash = ${hash}
        RETURNING id
      ), del_ae AS (
        DELETE FROM article_entities ae USING removed r WHERE ae.article_id = r.id RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM removed
    `);

    await deps.db.execute(sql`
      INSERT INTO kv_state (key, value)
      VALUES ('takedown_log', jsonb_build_object('url', ${rawUrl}::text, 'at', now()))
      ON CONFLICT (key) DO UPDATE SET value = kv_state.value || jsonb_build_array(jsonb_build_object('url', ${rawUrl}::text, 'at', now())), updated_at = now()
    `    );

    if (!Number(updated[0]?.n ?? 0)) {
      throw Errors.notFound("no indexed article for that URL");
    }
    return reply.send({
      removed: true,
      url_hash: hash.slice(0, 16),
      note: "Removed from all indexes; retention log kept for compliance.",
    });
  });
}
