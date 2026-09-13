import pino from "pino";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "warn" : "info");

/**
 * Structured JSON logging with request/job ids (NFR-4).
 * Redacts obvious secrets from any object logged via child bindings.
 */
export const logger = pino({
  level,
  base: { service: "intelligence" },
  redact: {
    paths: ["apiKey", "api_key", "authorization", "*.apiKey", "req.headers.authorization", "req.headers['x-api-key']"],
    censor: "[redacted]",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export function reqLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
