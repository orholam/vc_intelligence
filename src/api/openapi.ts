import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";

/**
 * OpenAPI 3.1 generation from the zod contracts in contracts.ts (FR-18 AC).
 * Routes register themselves here; /openapi.json serves the assembled spec.
 */
export interface RouteSpec {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  tags?: string[];
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
  /** admin routes still require an API key but are flagged in docs */
  admin?: boolean;
}

const registry: RouteSpec[] = [];

export function registerRoute(spec: RouteSpec): void {
  registry.push(spec);
}

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  return upgradeTo31(json);
}

/** Convert OpenAPI-3.0-style nullability to 3.1 JSON-Schema type unions. */
function upgradeTo31(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) {
    return node.map((n) => upgradeTo31(n)) as unknown as Record<string, unknown>;
  }
  if (!node || typeof node !== "object") {
    return node as Record<string, unknown>;
  }
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "$schema" || k === "nullable" || k === "id") continue;
    out[k] = upgradeTo31(v);
  }
  if (src.nullable === true) {
    const t = out["type"];
    if (typeof t === "string") {
      out["type"] = [t, "null"];
    } else {
      const inner: Record<string, unknown> = { ...out };
      return { anyOf: [inner, { type: "null" }] } as Record<string, unknown>;
    }
  }
  return out;
}

export function buildOpenApiDoc(info: { title: string; version: string; description?: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of registry) {
    const pathItem = (paths[route.path] ??= {});
    const parameters: unknown[] = [];
    if (route.query) {
      const qs = toJsonSchema(route.query) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
      for (const [name, schema] of Object.entries(qs.properties ?? {})) {
        parameters.push({
          name,
          in: "query",
          required: (qs.required ?? []).includes(name),
          schema,
        });
      }
    }
    const op: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags ?? ["v1"],
      parameters,
      responses: {
        "200": {
          description: "Success",
          content: route.response
            ? { "application/json": { schema: toJsonSchema(route.response) } }
            : undefined,
        },
        "401": { description: "Unauthorized", content: { "application/json": {} } },
        "422": { description: "Validation error", content: { "application/json": {} } },
        "429": { description: "Rate limited", content: { "application/json": {} } },
      },
      security: [{ ApiKeyAuth: [] }],
    };
    if (route.body) {
      op["requestBody"] = {
        required: true,
        content: { "application/json": { schema: toJsonSchema(route.body) } },
      };
    }
    pathItem[route.method] = op;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: info.version,
      description:
        info.description ??
        "News-intelligence API: entity-resolved company news signals + natural-language company lists.",
    },
    servers: [{ url: process.env.PUBLIC_BASE_URL ?? "http://localhost:4600" }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    paths,
  };
}
