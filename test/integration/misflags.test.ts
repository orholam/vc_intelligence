import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, isolateConfig, normalizeExecuteShape, type TestDb } from "../helpers/db.js";
import type { Db } from "../../src/db/index.js";
import { LocalStorage } from "../../src/storage.js";
import { SourceRegistry } from "../../src/sources/registry.js";
import { EntityKb } from "../../src/entities/kb.js";
import { makeProvider, LlmRouter } from "../../src/llm/router.js";
import { buildApiApp } from "../../src/api/server.js";

describe("POST/GET/DELETE /v1/exoskeleton/flags", () => {
  let tdb: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    isolateConfig();
    tdb = await createTestDb();
    const db = normalizeExecuteShape(tdb.db) as unknown as Db;
    app = buildApiApp({
      db,
      registry: new SourceRegistry(db),
      kb: new EntityKb(db),
      router: new LlmRouter(db, makeProvider()),
      storage: new LocalStorage(process.env.LOCAL_STORAGE_DIR!),
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (tdb) await tdb.destroy();
  });

  it("rejects a flag without ref_id", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/exoskeleton/flags", payload: { note: "nope" } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("ref_id_required");
  });

  it("creates, lists, and deletes a miscategorization flag", async () => {
    const pkg = {
      ref_id: "rit_probe",
      kind: "raw",
      title: "Ghost Probe Labs raises $12 million Series A (probe)",
      terminal_node: "prefilter_discards",
      detail: "slop_title:acq_spam · example.com",
      steps: [
        { node: "raw", ts: "2026-09-01T10:00:00.000Z", label: "Ghost Probe Labs raises…", detail: "rss · example.com" },
        { node: "prefilter_discards", ts: "2026-09-01T10:01:00.000Z", label: "Ghost Probe Labs raises…", detail: "slop_title:acq_spam · example.com" },
      ],
      note: "genuine funding round — the slop regex is wrong here",
    };
    const created = await app.inject({ method: "POST", url: "/v1/exoskeleton/flags", payload: pkg });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { ok: boolean; flag: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.flag.id).toMatch(/^mfl_/);
    expect(body.flag.ref_id).toBe("rit_probe");
    expect(body.flag.title).toBe(pkg.title);
    expect(body.flag.terminal_node).toBe("prefilter_discards");
    expect(body.flag.note).toBe(pkg.note);
    expect((body.flag.steps as unknown[]).length).toBe(2);

    const listed = await app.inject({ method: "GET", url: "/v1/exoskeleton/flags" });
    expect(listed.statusCode).toBe(200);
    const list = listed.json() as { flags: Array<{ id: string; ref_id: string }> };
    expect(list.flags.some((f) => f.id === body.flag.id && f.ref_id === "rit_probe")).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/v1/exoskeleton/flags/${body.flag.id}` });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { ok: boolean }).ok).toBe(true);

    const after = await app.inject({ method: "GET", url: "/v1/exoskeleton/flags" });
    const list2 = after.json() as { flags: Array<{ id: string }> };
    expect(list2.flags.some((f) => f.id === body.flag.id)).toBe(false);

    const again = await app.inject({ method: "DELETE", url: `/v1/exoskeleton/flags/${body.flag.id}` });
    expect(again.statusCode).toBe(404);
  });

  it("keeps them durable and newest-first", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/exoskeleton/flags",
      payload: { ref_id: "art_a", title: "First", terminal_node: "harness_discards", note: "old" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/exoskeleton/flags",
      payload: { ref_id: "art_b", title: "Second", terminal_node: "winners", steps: [], note: "new" },
    });
    const listed = await app.inject({ method: "GET", url: "/v1/exoskeleton/flags" });
    const list = listed.json() as { flags: Array<{ ref_id: string; steps: unknown }> };
    expect(list.flags[0]?.ref_id).toBe("art_b");
    expect(list.flags[1]?.ref_id).toBe("art_a");
    expect(list.flags[0]?.steps).toEqual([]);
  });
});