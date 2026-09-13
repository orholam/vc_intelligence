import postgres from "postgres";


/**
 * Event-story consolidation (A3/E5): articles sharing a primary entity whose
 * coverage reports the SAME discrete event (funding/M&A family tags, within
 * ±14 days) belong to ONE story per FR-17 — cross-publisher paraphrases
 * routinely miss the 0.9 cosine gate, leaving corroboration scattered.
 *
 * Deterministic merge: earliest-created story wins; member articles re-point,
 * representatives recomputed, counts fixed. Idempotent.
 */

const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", {
  max: 1,
  onnotice: () => {},
});

async function main(): Promise<void> {
  // Candidate entities: >=2 kept funding/mna-tagged articles within a 14-day slide
  const entities = await sql`
    SELECT ae.entity_id, count(*)::int arts
    FROM article_entities ae
    JOIN articles a ON a.id=ae.article_id AND a.noise_stage='kept'
    WHERE ae.role='primary'
      AND a.primary_tag LIKE ANY (ARRAY['funding.%','mna.%'])
      AND a.story_cluster_id IS NOT NULL
    GROUP BY ae.entity_id HAVING count(*) >= 2 LIMIT 400`;

  let merged = 0;
  let touched = 0;
  for (const ent of entities) {
    const rows = await sql`
      SELECT a.id art_id, a.primary_tag tag, a.published_at pub, a.story_cluster_id sid,
             s.first_seen_at s_created
      FROM article_entities ae
      JOIN articles a ON a.id=ae.article_id AND a.noise_stage='kept'
      LEFT JOIN stories s ON s.id=a.story_cluster_id
      WHERE ae.entity_id=${ent.entity_id} AND ae.role='primary'
        AND a.primary_tag LIKE ANY (ARRAY['funding.%','mna.%'])
        AND a.story_cluster_id IS NOT NULL
      ORDER BY a.published_at ASC`;
    if (rows.length < 2) continue;

    // Group into event buckets: consecutive items within 14 days of bucket start,
    // and family-compatible (funding vs mna never merge).
    const family = (tag: string | null) => String(tag ?? "").split(".")[0];
    type RowT = typeof rows[number];
    const buckets: RowT[][] = [];
    for (const r of rows) {
      const b = buckets[buckets.length - 1];
      const first = b?.[0];
      if (
        b && first &&
        new Date(r.pub).getTime() - new Date(first.pub).getTime() <= 14 * 86_400_000 &&
        family(r.tag) === family(first.tag)
      ) {
        b.push(r);
      } else {
        buckets.push([r]);
      }
    }

    for (const b of buckets) {
      if (b.length < 2 || new Set(b.map((x) => x.sid)).size < 2) continue;
      const sids = [...new Set(b.map((x) => x.sid))];
      const canonical = b.reduce((m, x) =>
        new Date(x.s_created ?? 0).getTime() < new Date(m.s_created ?? 0).getTime() ? x : m,
      );
      for (const sid of sids) {
        if (sid === canonical.sid) continue;
        await sql`
          UPDATE articles SET story_cluster_id = ${canonical.sid}, updated_at = now()
          WHERE story_cluster_id = ${sid} AND noise_stage='kept'`;
        await sql`DELETE FROM stories WHERE id = ${sid}`;
        merged++;
      }
      touched++;
    }
  }

  // Recompute counts + representatives for touched stories
  await sql`
    UPDATE stories s SET article_count = c.n,
      representative_article_id = c.best
    FROM (
      SELECT story_cluster_id sid, count(*)::int n,
             (ARRAY_AGG(id ORDER BY is_cluster_representative DESC, published_at DESC))[1] AS best
      FROM articles WHERE noise_stage='kept' AND story_cluster_id IS NOT NULL
      GROUP BY 1
    ) c WHERE s.id = c.sid`;

  console.log(`[consolidate] merged ${merged} duplicate stories across ${touched} event groups`);
  process.exit(0);
}

void main();
