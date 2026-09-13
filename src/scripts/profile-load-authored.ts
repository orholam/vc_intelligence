import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { entityProfiles } from "../db/schema.js";
import { opaqueId } from "../lib/ulid.js";
import { getCompanyProfileConfig, type ProfileSectionId } from "../config-files.js";
import { SECTION_SCHEMAS } from "../api/contracts-enrichment.js";

/**
 * Loads .dbg/profile-authored.json (hand-authored batch-1 profiles) into
 * entity_profiles. Every payload is validated through the serving zod
 * schemas first; citation URLs are collected into row-level evidence.
 * Skips sections already complete-and-fresh unless --force.
 */

function collectSources(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const x of node) collectSources(x, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o["source"])) {
    for (const u of o["source"]) if (typeof u === "string" && u.startsWith("http")) out.add(u);
  }
  for (const v of Object.values(o)) collectSources(v, out);
}

async function main(): Promise<void> {
  resetConfigCache();
  const db = createDb(getConfig().DATABASE_URL, { max: 5 });
  const cfg = getCompanyProfileConfig();
  const force = process.argv.includes("--force");
  const filePath = process.argv[2] ?? ".dbg/profile-authored.json";
  const isAuto = filePath.includes("auto");
  const modelName = isAuto ? "ox-alpha-auto" : "ox-alpha";
  const tplVersion = isAuto ? "auto-authored#v1" : "hand-authored#batch-1";
  const authored = JSON.parse(
    fs.readFileSync(filePath, "utf8"),
  ) as Record<string, Partial<Record<ProfileSectionId, Record<string, unknown>>>>;

  let written = 0;
  let skippedFresh = 0;
  const invalid: string[] = [];

  for (const [entityId, sections] of Object.entries(authored)) {
    for (const [section, raw] of Object.entries(sections)) {
      const sid = section as ProfileSectionId;
      const schema = SECTION_SCHEMAS[sid];
      if (!schema) { invalid.push(`${entityId}:${section}:unknown-section`); continue; }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        invalid.push(`${entityId}:${section}:${parsed.error.issues[0]?.path.join(".")}`);
        continue;
      }
      const existing = (
        await db
          .select()
          .from(entityProfiles)
          .where(and(eq(entityProfiles.entityId, entityId), eq(entityProfiles.section, sid)))
          .limit(1)
      )[0];
      // Hand-authored (ox-alpha) rows always win: only skip when a prior
      // hand-authored payload is already complete-and-fresh.
      if (existing && existing.model === modelName && existing.status === "complete" &&
          existing.staleAt && existing.staleAt.getTime() > Date.now() && !force) {
        skippedFresh += 1;
        continue;
      }
      const payload = parsed.data as Record<string, unknown>;
      const sources = new Set<string>();
      collectSources(payload, sources);
      const site = cfg.sections.includes(sid) ? null : null; // placeholder no-op
      void site;
      const values = {
        id: opaqueId("prf"),
        entityId,
        section: sid,
        payload,
        status: "complete" as const,
        derivedFrom: "llm" as const,
        attempts: 0,
        lastError: null,
        model: modelName,
        promptTemplateVersion: tplVersion,
        generatedAt: new Date(),
        staleAt: new Date(Date.now() + cfg.refresh_days * 24 * 3600 * 1000),
        evidence: { sources: [...sources].slice(0, 50) },
        updatedAt: new Date(),
      };
      await db
        .insert(entityProfiles)
        .values(values)
        .onConflictDoUpdate({
          target: [entityProfiles.entityId, entityProfiles.section],
          set: {
            payload: values.payload,
            status: values.status,
            derivedFrom: values.derivedFrom,
            attempts: 0,
            lastError: null,
            model: values.model,
            promptTemplateVersion: values.promptTemplateVersion,
            generatedAt: values.generatedAt,
            staleAt: values.staleAt,
            evidence: values.evidence,
            updatedAt: new Date(),
          },
        });
      written += 1;
    }
  }

  console.log(JSON.stringify({ written, skippedFresh, invalid }, null, 1));
  process.exit(0);
}

main().catch((e: Error) => {
  console.error("load failed:", e.message);
  process.exit(1);
});
