import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, type TestDb } from "../helpers/db.js";
import type { Db } from "../../src/db/index.js";
import { sources } from "../../src/db/schema.js";
import { SourceRegistry, POLL_CADENCE_MINUTES, nextPollAt } from "../../src/sources/registry.js";
import { syncSourceTiers } from "../../src/scripts/sync-source-tiers.js";

async function seedSource(db: TestDb["db"], url: string, opts: { tier?: 1 | 2 | 3; active?: boolean } = {}) {
  const registry = new SourceRegistry(db as unknown as Db);
  return registry.create({
    name: `src-${url.slice(-12)}`,
    publisher: "Pub",
    feedUrl: url,
    tier: opts.tier ?? 2,
    country: null,
    defaultLanguage: "en",
    topics: [],
    active: opts.active ?? true,
  });
}

function writeSeedFile(feeds: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const file = path.join(dir, "feeds.seed.json");
  fs.writeFileSync(file, JSON.stringify({ feeds }));
  return file;
}

describe("POLL_CADENCE_MINUTES", () => {
  it("uses the raised inflow cadence (15m / 30m / 2h)", () => {
    expect(POLL_CADENCE_MINUTES).toEqual({ 1: 15, 2: 30, 3: 120 });
    expect(nextPollAt(3).getTime() - Date.now()).toBeLessThan(121 * 60_000);
  });
});

describe("syncSourceTiers", () => {
  it("deactivates when the seed says active:false", async () => {
    const t = await createTestDb();
    try {
      const row = await seedSource(t.db, "https://example.com/feed-a");
      const seed = writeSeedFile([
        { name: "feed-a", publisher: "Pub", feed_url: row.feedUrl, tier: 2, active: false },
      ]);
      const res = await syncSourceTiers(t.db as unknown as Db, seed);
      expect(res.deactivated).toBe(1);
      const [after] = await t.db.select().from(sources).where(eq(sources.id, row.id));
      expect(after?.active).toBe(false);
    } finally {
      await t.destroy();
    }
  });

  it("never re-activates an operator-pruned source from the seed default", async () => {
    const t = await createTestDb();
    try {
      const row = await seedSource(t.db, "https://example.com/feed-b", { active: false });
      // No explicit `active` in seed — must NOT resurrect (purge→re-import loop).
      const seed = writeSeedFile([
        { name: "feed-b", publisher: "Pub", feed_url: row.feedUrl, tier: 3 },
      ]);
      const res = await syncSourceTiers(t.db as unknown as Db, seed);
      expect(res.reactivationsSkipped).toBe(1);
      const [after] = await t.db.select().from(sources).where(eq(sources.id, row.id));
      expect(after?.active).toBe(false);
      expect(after?.tier).toBe(3); // re-tiering still applies
    } finally {
      await t.destroy();
    }
  });

  it("applies tier changes and counts missing rows", async () => {
    const t = await createTestDb();
    try {
      const row = await seedSource(t.db, "https://example.com/feed-c", { tier: 3 });
      const seed = writeSeedFile([
        { name: "feed-c", publisher: "Pub", feed_url: row.feedUrl, tier: 2 },
        { name: "absent", publisher: "Pub", feed_url: "https://example.com/feed-d", tier: 1 },
      ]);
      const res = await syncSourceTiers(t.db as unknown as Db, seed);
      expect(res.updatedTier).toBe(1);
      expect(res.missingInDb).toBe(1);
      expect(res.deactivated).toBe(0);
      const [after] = await t.db.select().from(sources).where(eq(sources.id, row.id));
      expect(after?.tier).toBe(2);
    } finally {
      await t.destroy();
    }
  });
});
