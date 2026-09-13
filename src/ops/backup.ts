#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { logger } from "../lib/logger.js";

const run = promisify(execFile);

/**
 * NFR-3 daily backup: plain pg_dump to the backup dir with 14-day rotation.
 * Run from cron/systemd timer inside the VPS:
 *   pnpm db:backup   (script: tsx src/scripts/backup.ts)
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  const url = new URL(cfg.DATABASE_URL);
  const dir = path.resolve(process.cwd(), "data", "backups");
  await fs.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `intelligence-${stamp}.sql.gz`);
  await run("sh", [
    "-c",
    `pg_dump --no-owner --dbname=${JSON.stringify(url.toString())} | gzip > ${JSON.stringify(file)}`,
  ]);
  logger.info({ file }, "backup written");

  // rotate: keep last 14
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql.gz")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 14))) {
    await fs.rm(path.join(dir, old));
    logger.info({ removed: old }, "backup rotated");
  }
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, "backup failed");
  process.exit(1);
});
