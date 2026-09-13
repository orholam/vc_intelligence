import { z } from "zod";

const Env = z.object({
  LM_DB_PATH: z.string().default("./data/launchmonitor.sqlite"),
  LM_DATABASE_URL: z
    .string()
    .default("postgres://copyr_intel:intel@localhost:5434/intelligence"),
  LM_PAGE_GAP_MS: z.coerce.number().int().nonnegative().default(4000),
  LM_MAX_PAGES: z.coerce.number().int().positive().default(40),
  LM_LIBRARY_BASE_URL: z.string().default("https://okara.ai"),
  LOG_LEVEL: z.string().default("info"),
});

export type LaunchMonitorConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LaunchMonitorConfig {
  return Env.parse(env);
}
