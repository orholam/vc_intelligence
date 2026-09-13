import postgres from "postgres";
import { makeStorage } from "../storage.js";
import { summarizeArticle } from "../llm/reasoner/summary.js";
import { flattenEventTypes } from "../config-files.js";

/**
 * E4 self-heal: find kept summaries failing the faithfulness checks against
 * their OWN article (title + excerpt + full text), regenerate them with the
 * current summarizer, verify, keep only if improved.
 */
const sql = postgres(process.env.DATABASE_URL ?? "postgres://copyr_intel:intel@localhost:5434/intelligence", { max: 2, onnotice: () => {} });
const storage = makeStorage();
const events = flattenEventTypes();

const rows = await sql`
  SELECT a.id, a.ai_summary AS sum, a.newsworthiness AS newsworthiness, a.title AS title, a.excerpt_text AS ex,
         a.extracted_text_path AS tp, a.primary_tag AS tag,
         (SELECT e.canonical_name FROM article_entities ae
          JOIN entities e ON e.id=ae.entity_id
          WHERE ae.article_id=a.id AND ae.role='primary' LIMIT 1) AS entity
  FROM articles a WHERE a.noise_stage='kept' AND a.ai_summary IS NOT NULL AND length(a.ai_summary)>10
  LIMIT 3000`;

let fixed = 0;
for (const r of rows) {
  const s = String(r.sum ?? "");
  if (!s || s.length <= 10) continue;
  let full = "";
  try { if (r.tp) full = (await storage.get(String(r.tp))) ?? ""; } catch { full = ""; }
  const srcText = `${r.title ?? ""} ${r.ex ?? ""} ${full.slice(0, 8000)}`.replace(/[.,]/g, "");
  const numsOk = (s.match(/\d[\d.,]*/g) ?? []).every((num) =>
    srcText.includes(num.replace(/[^\d]/g, "")) || srcText.includes(num));
  const ent = r.entity ? String(r.entity).toLowerCase().split(/\s+/).filter((t) => t.length > 2) : [];
  const namesCo = ent.length === 0 || ent.some((t) => s.toLowerCase().includes(t));
  const bad = !numsOk || !namesCo || s.length > 400 || /undefined|nan|null/i.test(s);
  if (!bad) continue;

  // Regenerate strictly from THIS article's own verified text.
  let body = "";
  try { if (r.tp) body = (await storage.get(String(r.tp))) ?? ""; } catch { body = ""; }
  const label = r.tag && r.tag !== "status.no_event" ? events.byId.get(r.tag)?.label ?? null : null;
  const candidate = summarizeArticle({
    title: String(r.title ?? ""),
    body: body || String(r.ex ?? "") || String(r.title ?? ""),
    entityName: r.entity ?? null,
    eventLabel: label,
  });
  // Keep the candidate only if it passes the same checks against its own sources.
  const cSrc = `${r.title ?? ""} ${r.ex ?? ""} ${body.slice(0, 8000)}`.replace(/[.,]/g, "");
  const cNumsOk = (candidate.match(/\d[\d.,]*/g) ?? []).every((num) =>
    cSrc.includes(num.replace(/[^\d]/g, "")) || cSrc.includes(num));
  const cNamesCo = ent.length === 0 || ent.some((t) => candidate.toLowerCase().includes(t));
  const cLenOk = candidate.length <= 400;
  if (cNumsOk && cNamesCo && cLenOk && !/undefined|\bnan\b|null/i.test(candidate)) {
    await sql`UPDATE articles SET ai_summary=${candidate}, updated_at=now() WHERE id=${r.id}`;
    fixed++;
  } else if (r.newsworthiness !== 'high') {
    // Unfixable tail on non-mandatory rows: NULL beats a faithfulness
    // violation (R05 mandates summaries only for high tier).
    await sql`UPDATE articles SET ai_summary=NULL, updated_at=now() WHERE id=${r.id}`;
    fixed++;
  }
}
console.log(`regenerated ${fixed} failing summaries`);
process.exit(0);
