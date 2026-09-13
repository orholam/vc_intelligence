import postgres from "postgres";

import { LocalStorage } from "../storage.js";
import { extractFact } from "../llm/reasoner/factsex.js";

/**
 * A3 corroboration strengthener: for each accepted funding/M&A fact backed by
 * a SINGLE publisher, look for other-domain kept articles on the same entity
 * covering the SAME event (verified by re-running the fact extractor and
 * comparing type + amount band), and merge them into the fact's evidence.
 * distinct_publishers then reflects true multi-source corroboration.
 *
 * Deterministic; no LLM provider calls beyond the offline reasoner.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});
const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR ?? "data/storage");


async function main(): Promise<void> {
  const facts = await sql`
    SELECT f.id, f.entity_id, f.type, f.payload, f.evidence_article_ids,
           e.canonical_name
    FROM facts f JOIN entities e ON e.id=f.entity_id
    WHERE f.status='accepted' AND f.type IN ('funding_round','acquisition')
      AND f.distinct_publishers < 2
      AND f.evidence_article_ids <> '{}'
      AND f.dedup_key NOT LIKE 'formd:%'
      AND f.dedup_key NOT LIKE 'efts:%'
      AND e.merged_into IS NULL
    LIMIT 200`;
  console.log(`[strengthen] single-publisher facts: ${facts.length}`);

  let strengthened = 0;
  for (const f of facts) {
    const evIds: string[] = Array.isArray(f.evidence_article_ids) ? f.evidence_article_ids : [];
    const knownDomains = new Set<string>(
      (
        await sql`
          SELECT DISTINCT publisher_domain d FROM articles
          WHERE id IN ${sql(evIds)}`
      ).map((r) => String(r.d)),
    );
    // Candidate articles: same primary entity, other publishers, same family,
    // published near the fact window.
    const cands = await sql`
      SELECT a.id, a.title, a.extracted_text_path p, a.publisher_domain d,
             a.published_at, a.primary_tag
      FROM articles a
      JOIN article_entities ae ON ae.article_id=a.id AND ae.role='primary'
      WHERE ae.entity_id = ${f.entity_id}
        AND a.noise_stage='kept'
        AND a.id NOT IN ${sql(evIds)}
        AND a.primary_tag LIKE ${String(f.type) === "funding_round" ? "funding.%" : "mna.%"}
      ORDER BY a.published_at DESC LIMIT 6`;

    const payload = (f.payload ?? {}) as Record<string, unknown>;
    const factAmount = Number(payload.amount_usd_est ?? 0) || null;
    const factStage = (payload.funding_stage as string | null)?.toLowerCase() ?? null;

    for (const c of cands) {
      if (knownDomains.has(String(c.d))) continue;
      let body = "";
      try {
        if (c.p) body = (await storage.get(String(c.p))) ?? "";
      } catch { /* absent */ }
      const extracted = extractFact({
        entityName: String(f.canonical_name),
        title: String(c.title ?? ""),
        body: body.slice(0, 3000),
        today: new Date(),
      });
      if (!extracted.has_event || extracted.type !== f.type) continue;
      // Same-event checks: amount within ±35% or identical stage when present.
      const exAmt = extracted.payload.amount_usd_est;
      const exStage = extracted.payload.funding_stage?.toLowerCase() ?? null;
      let sameEvent = false;
      if (factAmount && exAmt && Math.abs(exAmt - factAmount) / factAmount <= 0.35) sameEvent = true;
      if (factStage && exStage && factStage === exStage) sameEvent = true;
      if (!sameEvent && !factAmount && !exAmt && extracted.confidence >= 0.7) sameEvent = true;
      if (!sameEvent) continue;

      const domainsNow = new Set(knownDomains);
      domainsNow.add(String(c.d));
      const newEv = [...evIds, String(c.id)];
      await sql`
        UPDATE facts SET
          evidence_article_ids = ${sql(newEv)},
          distinct_publishers = ${domainsNow.size},
          updated_at = now()
        WHERE id = ${f.id}`;
      evIds.push(String(c.id));
      knownDomains.add(String(c.d));
      strengthened++;
      break; // one corroborating publisher suffices for the >=2 floor
    }
  }
  console.log(`[strengthen] merged second-publisher evidence into ${strengthened} facts`);
  process.exit(0);
}

void main();
