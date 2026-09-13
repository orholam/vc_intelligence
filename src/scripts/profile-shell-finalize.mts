/**
 * Deterministic-only finalize for registry/Form-D shell entities: runs the
 * vetted engine derivation (deriveDeterministicSection from entities/profile.ts)
 * over entity card + accepted facts and persists the content-bearing subset of
 * {firmographic, location, company_hierarchy, funding_detail,
 *  mna_and_investment, management_profile} - no LLM, no invention.
 * Hand-authored (model='ox-alpha') rows are never overwritten.
 * Usage: tsx src/scripts/profile-shell-finalize.mts <ids.json>
 */
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { getConfig, resetConfigCache } from "../config.js";
import { createDb } from "../db/index.js";
import { entityProfiles, entities, facts } from "../db/schema.js";
import { opaqueId } from "../lib/ulid.js";
import {
  deriveDeterministicSection,
  DETERMINISTIC_FINALIZE,
  type ProfileSectionId,
} from "../entities/profile.js";

function hasContent(p: Record<string, unknown> | null | undefined): boolean {
  if (!p) return false;
  return Object.values(p).some((v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return hasContent(v as Record<string, unknown>);
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  });
}

async function main(): Promise<void> {
  resetConfigCache();
  const db = createDb(getConfig().DATABASE_URL, { max: 5 });
  const ids = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as string[];
  let written = 0;

  for (const id of ids) {
    const [e] = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
    if (!e || e.mergedInto || e.needsBackfill) continue;
    const factRows = await db
      .select()
      .from(facts)
      .where(and(eq(facts.entityId, id), eq(facts.status, "accepted")));
    for (const section of DETERMINISTIC_FINALIZE) {
      const base = deriveDeterministicSection(section as ProfileSectionId, e, factRows);
      if (!hasContent(base)) continue;
      const existing = (
        await db.select().from(entityProfiles)
          .where(and(eq(entityProfiles.entityId, id), eq(entityProfiles.section, section)))
          .limit(1))[0];
      if (existing?.model === "ox-alpha") continue; // hand-authored wins
      const values = {
        id: opaqueId("prf"), entityId: id, section,
        payload: base, status: "complete" as const,
        derivedFrom: factRows.length > 0 ? ("facts" as const) : ("registry" as const),
        generatedAt: new Date(),
        staleAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
        updatedAt: new Date(),
      };
      await db.insert(entityProfiles).values(values).onConflictDoUpdate({
        target: [entityProfiles.entityId, entityProfiles.section],
        set: { payload: values.payload, status: "complete", derivedFrom: values.derivedFrom,
               generatedAt: values.generatedAt, staleAt: values.staleAt, updatedAt: new Date() },
      });
      written += 1;
    }
  }
  console.log(JSON.stringify({ entities: ids.length, rowsWritten: written }));
  process.exit(0);
}
main().catch((e: Error) => { console.error("shell finalize failed:", e.message); process.exit(1); });
