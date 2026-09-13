import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { normalizeWebsite } from "../kb.js";
import type { CreateEntityInput } from "../kb.js";
import { importOne, type ImportContext, type ImportOutcome, ProgressLogger } from "./base.js";

/**
 * FR-7 seed lists: curated accelerator/startup/community exports consumed as
 * JSON or CSV files from config/seeds/ (YC directory export, Product Hunt
 * lists, GitHub org inventories). Files are operator-supplied so licensing of
 * each upstream source stays explicit; the importer is idempotent like all
 * FR-7 imports.
 *
 * Expected JSON schema per record (CSV columns use the same snake_case keys):
 *   { name, website?, description?, country?, founded_year?, industry_tags?,
 *     aliases?, github_org? }
 */

const SeedRecord = z.object({
  name: z.string().min(2).max(160),
  website: z.string().nullish(),
  description: z.string().max(500).nullish(),
  country: z.string().length(2).nullish(),
  founded_year: z.coerce.number().int().min(1600).max(2100).nullish(),
  industry_tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  github_org: z.string().nullish(),
});

export interface SeedImportOptions {
  dir?: string;
}

export async function importSeeds(
  ctx: ImportContext,
  opts: SeedImportOptions = {},
): Promise<{ files: number; processed: number; outcomes: Record<ImportOutcome, number> }> {
  const dir = opts.dir ?? path.resolve(process.cwd(), "config", "seeds");
  if (!fs.existsSync(dir)) return { files: 0, processed: 0, outcomes: { created: 0, updated: 0, unchanged: 0, skipped: 0 } };

  const progress = new ProgressLogger();
  let processed = 0;
  const files = fs.readdirSync(dir).filter((f) => /\.(json|csv)$/i.test(f));

  for (const file of files) {
    const full = path.join(dir, file);
    const records = /\.json$/i.test(file)
      ? parseJsonSeed(full)
      : parseCsvSeed(full);
    for (const raw of records) {
      const parsed = SeedRecord.safeParse(raw);
      if (!parsed.success) {
        progress.add("skipped");
        continue;
      }
      const rec = parsed.data;
      const externalKey = `seed:${path.basename(file)}:${rec.name.toLowerCase().replace(/\s+/g, "-")}`;
      const outcome = await importOne(ctx, "seed", externalKey, (): CreateEntityInput | null => ({
        canonicalName: rec.name,
        legalName: null,
        website: rec.website ? normalizeWebsite(rec.website) : null,
        aliases: [...rec.aliases, ...(rec.github_org ? [rec.github_org] : [])],
        type: "private",
        status: "operating",
        country: rec.country ? rec.country.toUpperCase() : null,
        hqCity: null,
        foundedYear: rec.founded_year ?? null,
        industryTags: rec.industry_tags.slice(0, 4),
        tickers: [],
        sourceRefs: [`seed:${path.basename(file)}`],
        confidence: 0.5,
        createdBy: "import:seed",
      }));
      progress.add(outcome);
      processed++;
    }
  }
  return { files: files.length, processed, outcomes: progress.snapshot() };
}

function parseJsonSeed(file: string): unknown[] {
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray((json as { records?: unknown }).records)) {
    return (json as { records: unknown[] }).records;
  }
  return [];
}

function parseCsvSeed(file: string): unknown[] {
  // Minimal CSV parser with header row; avoids pulling csv-parse into this path twice.
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase().replaceAll(" ", "_"));
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = cells[i];
      if (v !== undefined && v !== "") obj[h] = v;
    });
    return obj;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
