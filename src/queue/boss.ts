import PgBoss from "pg-boss";
import { getConfig } from "../config.js";
import { logger } from "../lib/logger.js";

export type Boss = PgBoss;

export async function createBoss(connectionString?: string): Promise<Boss> {
  const boss = new PgBoss({
    connectionString: connectionString ?? getConfig().DATABASE_URL,
    max: 5,
  });
  boss.on("error", (err) => logger.error({ err: err.message }, "pg-boss error"));
  return boss;
}

/** pg-boss v10 requires queues to exist before send/schedule. */
export async function ensureQueues(boss: Boss, names: string[]): Promise<void> {
  for (const name of names) {
    await boss.createQueue(name).catch((e: Error) => {
      if (!/already exists/i.test(e.message)) throw e;
    });
  }
}
