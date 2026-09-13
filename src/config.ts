import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// ------------------------------------------------------------------ env config
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  APP_PORT: z.coerce.number().int().default(4600),
  API_PUBLIC_ORIGINS: z.string().default(""),

  DATABASE_URL: z
    .string()
    .default("postgres://copyr_intel:intel@localhost:5434/intelligence"),

  LLM_PROVIDER: z.enum(["mock", "openai-compatible", "harness", "auto"]).default("mock"),
  LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default(""),
  MODEL_MINI: z.string().optional(),
  MODEL_BIG: z.string().optional(),
  MODEL_JUDGE: z.string().optional(),
  MODEL_EMBED: z.string().optional(),
  EMBEDDING_DIM: z.coerce.number().int().default(256),
  MONTHLY_BUDGET_USD: z.coerce.number().default(250),
  BUDGET_SOFT_LIMIT_PCT: z.coerce.number().min(1).max(100).default(90),

  // Harness mode (LLM_PROVIDER=harness): agent answers completions via the
  // internal claim/result API. Shared secret; empty = loopback-only access.
  HARNESS_KEY: z.string().default(""),
  /** Max seconds to wait for a harness answer before the call fails open. */
  LLM_HARNESS_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  /** auto mode: how long to wait for ANY harness to claim before falling back. */
  LLM_AUTO_CLAIM_WAIT_MS: z.coerce.number().int().min(250).default(5_000),
  /** Hosted embeddings even in harness mode (clustering needs real vectors). */
  LLM_HARNESS_HOSTED_EMBED: zCoerceBool(true),

  STORAGE_DRIVER: z.enum(["s3", "local"]).default("local"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("intelligence"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  LOCAL_STORAGE_DIR: z.string().default("./data/storage"),

  FETCH_USER_AGENT: z
    .string()
    .default("CopyrIntelligenceBot/0.1 (+https://copyr.example/intelligence-bot)"),
  FETCH_TIMEOUT_MS: z.coerce.number().int().default(10_000),
  FETCH_DOMAIN_MIN_INTERVAL_MS: z.coerce.number().int().default(2000),
  RSS_MAX_BACKOFF_HOURS: z.coerce.number().default(24),

  GDELT_ENABLED: zCoerceBool(true),
  GDELT_POLL_MINUTES: z.coerce.number().default(15),

  HOT_RETENTION_DAYS: z.coerce.number().int().default(180),
  TEXT_PASSTHROUGH: zCoerceBool(false),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().default(60),
  WEBHOOK_RETRIES: z.coerce.number().int().default(5),

  WIKIDATA_SPARQL_ENDPOINT: z
    .string()
    .default("https://query.wikidata.org/sparql"),
  EDGAR_USER_AGENT: z.string().default("Copyr Intelligence contact@copyr.example"),
  COMPANIES_HOUSE_API_KEY: z.string().default(""),
});

function zCoerceBool(def: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())))
    .default(def);
}

export type AppConfig = z.infer<typeof EnvSchema> & { configDir: string };

let cachedEnv: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cachedEnv) return cachedEnv;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  const configDir =
    process.env.INTELLIGENCE_CONFIG_DIR ??
    // resolve relative to repo layout: <root>/config — works from src/ and dist/
    path.resolve(new URL(import.meta.url, "file://").pathname, "../../config");
  cachedEnv = { ...parsed.data, configDir };
  if (!fs.existsSync(configDir)) {
    // fallback for bundled layouts
    cachedEnv.configDir = path.resolve(process.cwd(), "config");
  }
  return cachedEnv;
}

/** Test helper. */
export function resetConfigCache(): void {
  cachedEnv = undefined;
}

// ------------------------------------------------------- versioned config files
const fileCache = new Map<string, { mtimeMs: number; data: unknown }>();

/**
 * Load a JSON config file with mtime-based cache so operators can edit taxonomy,
 * prompts, models or thresholds without redeploying (NFR-9).
 */
export function loadConfigFile<T>(
  relPath: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
  const cfg = getConfig();
  const full = path.join(cfg.configDir, relPath);
  const stat = fs.statSync(full);
  const hit = fileCache.get(full);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data as T;
  const raw = JSON.parse(fs.readFileSync(full, "utf8")) as unknown;
  const parsed = schema.parse(raw);
  fileCache.set(full, { mtimeMs: stat.mtimeMs, data: parsed });
  return parsed;
}
