import postgres from "postgres";
import { sicToTag } from "./enrich-edgar-submissions.js";

const SEC_UA = "Copyr intelligence classify-unclassified (research; contact: data@copyr.example)";

/**
 * Classify the residual `unclassified` companies in the canonical set.
 *
 * These entities were imported with an `edgar:cik` source ref but were never
 * run through the SEC-submissions SIC pass (they are missing `edgar:subscan`),
 * so their industry stayed `unclassified`. This reuses the same SIC -> sector
 * mapping as enrich-edgar-submissions and fills identity fields (country /
 * hq_city / founded_year) from the EDGAR profile where they are still empty.
 *
 * Entities without an EDGAR CIK (and no Wikidata QID — they only carry the
 * bare `wikidata` marker) cannot be classified from existing evidence and are
 * left `unclassified`, per the "if you can't find it, let it be" rule.
 *
 * Idempotent: only entities still carrying `unclassified` and lacking
 * `edgar:subscan` are touched; each gets `edgar:subscan` appended.
 * Dry-run by default — pass `--apply` to write to the database.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR",
  "PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR","GU","VI",
]);

interface Submissions {
  name?: string;
  tickers?: string[];
  sic?: string;
  addresses?: {
    business?: { city?: string; stateOrCountryDescription?: string };
    mailing?: { city?: string; stateOrCountryDescription?: string };
  };
  formerNames?: Array<{ from?: string }>;
}

function cikFromRefs(refs: string[]): string | null {
  for (const r of refs) {
    const m = /^edgar:cik:(\d+)$/.exec(r);
    if (m && m[1]) return m[1].padStart(10, "0");
  }
  return null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);
  const sleepMs = Number(process.argv.find((a) => a.startsWith("--sleep="))?.split("=")[1] ?? 300);

  const allTargets = await sql<{ id: string; canonical_name: string; source_refs: string[] }[]>`
    SELECT id, canonical_name, source_refs
    FROM entities
    WHERE merged_into IS NULL AND needs_backfill = false
      AND type NOT IN ('fund', 'person-org')
      AND 'unclassified' = ANY(industry_tags)
      AND source_refs::text ~ 'edgar:cik'
      AND NOT ('edgar:subscan' = ANY(source_refs))
    ORDER BY id ASC`;
  const targets = limitArg ? allTargets.slice(0, limitArg) : allTargets;

  console.log(`[classify-unclassified] targets: ${targets.length} (${apply ? "APPLY" : "dry-run"})`);

  let classified = 0;
  let identityFilled = 0;
  let noSic = 0;
  let failures = 0;

  for (const t of targets) {
    const cik = cikFromRefs(t.source_refs ?? []);
    if (!cik) {
      failures++;
      continue;
    }
    let sub: Submissions | null = null;
    try {
      const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        headers: { "user-agent": SEC_UA, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 200) sub = (await res.json()) as Submissions;
    } catch {
      /* leave for a later run */
    }

    const sicTag = sub ? sicToTag(sub.sic) : null;
    const addr = sub?.addresses?.business ?? sub?.addresses?.mailing ?? {};
    const st = (addr.stateOrCountryDescription ?? "").toUpperCase().trim();
    const isUs = US_STATES.has(st);
    const city = (addr.city ?? "").trim();
    let founded: number | null = null;
    for (const fn of sub?.formerNames ?? []) {
      if (fn.from && /^\d{4}/.test(fn.from)) {
        const y = Number(fn.from.slice(0, 4));
        if (y >= 1600 && y <= new Date().getFullYear() && (founded === null || y < founded)) founded = y;
      }
    }

    if (!apply) {
      if (sicTag) classified++;
      else noSic++;
      if (isUs || city || founded !== null) identityFilled++;
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }

    try {
      if (!sub) {
        noSic++;
        continue;
      }
      if (sicTag) {
        await sql`
          UPDATE entities SET
            industry_tags = array_remove(industry_tags, 'unclassified')
              || ARRAY[${sicTag}]::text[],
            updated_at = now()
          WHERE id = ${t.id}`;
        classified++;
      } else {
        noSic++;
      }
      if (isUs || city || founded !== null) {
        const meta = await sql`
          UPDATE entities SET
            country = COALESCE(country, ${isUs ? "US" : null}::text),
            hq_city = COALESCE(hq_city, NULLIF(${city}, '')),
            founded_year = COALESCE(founded_year, ${founded}),
            updated_at = now()
          WHERE id = ${t.id}
          RETURNING 1`;
        if (meta.count) identityFilled++;
      }
      await sql`
        UPDATE entities SET source_refs = source_refs || ARRAY['edgar:subscan']::text[], updated_at = now()
        WHERE id = ${t.id} AND NOT ('edgar:subscan' = ANY(source_refs))`;
    } catch {
      failures++;
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  console.log(
    `[classify-unclassified] done — classified: ${classified}, identity-filled: ${identityFilled}, ` +
      `no-sic (left unclassified): ${noSic}, failures: ${failures}`,
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
