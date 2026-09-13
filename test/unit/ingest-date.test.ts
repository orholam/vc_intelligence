import { describe, expect, it } from "vitest";
import { resolveIngestPublishedAt } from "../../src/queue/jobs.js";

/** Ingest publish-date hygiene: future clamps + staleness gate. */
describe("resolveIngestPublishedAt", () => {
  const now = Date.parse("2026-08-24T12:00:00Z");
  const d = (iso: string) => new Date(iso);

  it("keeps fresh dates untouched", () => {
    const r = resolveIngestPublishedAt(d("2026-08-24T09:00:00Z"), now);
    expect(r).toEqual({ ok: true, publishedAt: d("2026-08-24T09:00:00Z") });
  });

  it("falls back to ingest time when no date is parseable", () => {
    expect(resolveIngestPublishedAt(null, now)).toEqual({
      ok: true,
      publishedAt: d("2026-08-24T12:00:00Z"),
    });
  });

  it("clamps future-dated pages to ingest time (bad <time> metadata)", () => {
    const r = resolveIngestPublishedAt(d("2027-01-01T00:00:00Z"), now);
    expect(r).toEqual({ ok: true, publishedAt: d("2026-08-24T12:00:00Z") });
  });

  it("tolerates trivial clock skew within the future window", () => {
    const r = resolveIngestPublishedAt(d("2026-08-24T12:01:30Z"), now);
    expect(r).toEqual({ ok: true, publishedAt: d("2026-08-24T12:01:30Z") });
  });

  it("flags stale resurfaces older than max_article_age_days", () => {
    const r = resolveIngestPublishedAt(d("2026-03-16T20:32:54Z"), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.publishedAt.toISOString()).toBe("2026-03-16T20:32:54.000Z");
  });

  it("accepts dates just inside the age window", () => {
    const r = resolveIngestPublishedAt(d("2026-07-15T00:00:00Z"), now); // ~40 days
    expect(r.ok).toBe(true);
  });

  it("applies the tighter discovered-origin window (gdelt/search resurfaces)", () => {
    // 7-day-old page date: fine for RSS (45d), a resurface for GDELT (3d).
    const pageDate = d("2026-08-17T12:00:00Z");
    expect(resolveIngestPublishedAt(pageDate, now, 45).ok).toBe(true);
    expect(resolveIngestPublishedAt(pageDate, now, 3).ok).toBe(false);
  });
});
