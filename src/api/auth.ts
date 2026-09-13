import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { sha256Hex } from "../lib/hash.js";
import { Errors } from "../lib/errors.js";
import { opaqueId } from "../lib/ulid.js";

export interface AuthContext {
  keyId: string;
  keyName: string;
  rateLimitPerMin: number;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Mint a new API key; raw value returned ONCE, only the hash is stored (NFR-6). */
export function generateApiKey(): { id: string; raw: string; hash: string; prefix: string } {
  const id = opaqueId("key");
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const raw = `cit_${Buffer.from(bytes).toString("base64url")}`;
  return { id, raw, hash: sha256Hex(raw), prefix: raw.slice(0, 12) };
}

export function makeAuthHook(db: Db) {
  return async function authenticate(request: FastifyRequest): Promise<AuthContext> {
    const header = request.headers["x-api-key"];
    const raw =
      (Array.isArray(header) ? header[0] : header) ||
      // Same-origin web has no header; Vite proxy / Vercel injects PLAYGROUND_KEY.
      process.env.PLAYGROUND_KEY ||
      "";
    if (!raw) throw Errors.unauthorized("Missing x-api-key header");

    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, sha256Hex(raw)))
      .limit(1);
    if (!row || !row.active) throw Errors.unauthorized();

    // fire-and-forget last_used update
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));

    request.auth = {
      keyId: row.id,
      keyName: row.name,
      rateLimitPerMin: row.rateLimitPerMin,
    };
    return request.auth;
  };
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw Errors.unauthorized();
  return request.auth;
}

export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof Error && "statusCode" in err && "code" in err) {
    const e = err as Error & { statusCode: number; code: string };
    void reply.status(e.statusCode).send({ error: { code: e.code, message: e.message } });
    return;
  }
  void reply.status(500).send({ error: { code: "internal", message: "Internal error" } });
}
