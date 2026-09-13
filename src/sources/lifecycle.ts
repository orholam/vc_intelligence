import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getFilters } from "../config-files.js";
import type { Db } from "../db/index.js";
import { sourceEvents, sources } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { opaqueId } from "../lib/ulid.js";

/**
 * R10 automated source lifecycle — onboard, demote/throttle, prune — with
 * every state transition audited in `source_events` (who/when/why). No manual
 * DB edits: the registry is the single front door (R01), these hooks keep it
 * healthy without code deploys.
 */

export type SourceEventKind =
  | "onboard_ok"
  | "onboard_unhealthy"
  | "throttled"
  | "tier_demoted"
  | "pruned"
  | "reactivated";

export async function recordSourceEvent(
  db: Db,
  sourceId: string,
  event: SourceEventKind,
  reason: string,
  actor = "lifecycle-tick",
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  await db.insert(sourceEvents).values({
    id: opaqueId("sev"),
    sourceId,
    event,
    reason: reason.slice(0, 300),
    actor,
    metadata,
  });
}

/** Latest lifecycle event of a kind for a source (dedup window checks). */
export async function latestEvent(
  db: Db,
  sourceId: string,
  event: SourceEventKind,
): Promise<{ createdAt: Date } | null> {
  const rows = await db
    .select({ createdAt: sourceEvents.createdAt })
    .from(sourceEvents)
    .where(and(eq(sourceEvents.sourceId, sourceId), eq(sourceEvents.event, event)))
    .orderBy(desc(sourceEvents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface LifecycleReport {
  pruned: string[];
  throttled: string[];
  onboardUnhealthy: string[];
}

/**
 * Hourly lifecycle pass:
 * - prune: failure_streak >= prune_failure_streak flips the source inactive.
 * - onboard: sources older than onboard_max_age_hours with zero successful
 *   fetches get one audited unhealthy marker (registry row is data, not code —
 *   a broken feed must be visible, not silent).
 * - throttle: sources with real volume but a discard rate above threshold lose
 *   tier until re-validated (the automated arm of the B5 precision floor).
 */
export async function runSourceLifecycleTick(db: Db): Promise<LifecycleReport> {
  const cfg = getFilters().source_lifecycle;
  const report: LifecycleReport = { pruned: [], throttled: [], onboardUnhealthy: [] };

  // ---- prune ------------------------------------------------------------
  if (cfg.prune_failure_streak > 0) {
    const dead = await db
      .select()
      .from(sources)
      .where(and(eq(sources.active, true), gte(sources.failureStreak, cfg.prune_failure_streak)));
    for (const s of dead) {
      await db
        .update(sources)
        .set({
          active: false,
          nextPollAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          updatedAt: new Date(),
        })
        .where(eq(sources.id, s.id));
      await recordSourceEvent(
        db,
        s.id,
        "pruned",
        `failure_streak=${s.failureStreak} >= ${cfg.prune_failure_streak}; flipped inactive`,
      );
      report.pruned.push(s.id);
    }
  }

  // ---- onboarding health check ------------------------------------------
  const stale = await db.execute<{ id: string; created_at: string }>(sql`
    SELECT s.id, s.created_at
    FROM sources s
    WHERE s.active = true
      AND s.last_fetched_at IS NULL
      AND s.created_at < now() - (${cfg.onboard_max_age_hours} * interval '1 hour')
      AND NOT EXISTS (
        SELECT 1 FROM source_events se
        WHERE se.source_id = s.id AND se.event = 'onboard_unhealthy'
          AND se.created_at > now() - interval '7 days'
      )
    LIMIT 200
  `);
  for (const r of stale) {
    await recordSourceEvent(
      db,
      r.id,
      "onboard_unhealthy",
      `no successful fetch ${(cfg.onboard_max_age_hours)}h after onboarding`,
    );
    report.onboardUnhealthy.push(r.id);
  }

  // ---- demote/throttle on discard-rate violations ------------------------
  if (cfg.throttle_min_kept_30d > 0) {
    const offenders = await db.execute<{
      id: string;
      tier: number;
      kept: number;
      discarded: number;
    }>(sql`
      SELECT s.id, s.tier,
             COUNT(a.id) FILTER (WHERE a.noise_stage = 'kept')::int AS kept,
             COUNT(a.id) FILTER (WHERE a.noise_stage IN ('prefilter','llm_filter'))::int AS discarded
      FROM sources s
      JOIN articles a ON a.source_id = s.id AND a.created_at >= now() - interval '30 days'
      WHERE s.active = true
      GROUP BY s.id, s.tier
      HAVING COUNT(a.id) FILTER (WHERE a.noise_stage = 'kept') >= ${cfg.throttle_min_kept_30d}
         AND COALESCE(
               COUNT(a.id) FILTER (WHERE a.noise_stage IN ('prefilter','llm_filter'))::float
               / NULLIF(COUNT(a.id), 0), 0)
             >= ${cfg.throttle_max_discard_rate_pct / 100}
         AND s.tier < 3
      LIMIT 50
    `);
    for (const o of offenders) {
      const recent = await latestEvent(db, o.id, "throttled");
      if (recent && Date.now() - recent.createdAt.getTime() < 30 * 24 * 3600 * 1000) continue;
      const newTier = Math.min(3, o.tier + 1) as 1 | 2 | 3;
      await db
        .update(sources)
        .set({ tier: newTier, updatedAt: new Date() })
        .where(eq(sources.id, o.id));
      await recordSourceEvent(db, o.id, "throttled",
        `discard_rate=${Math.round((o.discarded / Math.max(1, o.kept + o.discarded)) * 100)}% over ${o.kept} kept in 30d; tier ${o.tier}->${newTier}`,
        "lifecycle-tick",
        { kept_30d: o.kept, discarded_30d: o.discarded });
      report.throttled.push(o.id);
    }
  }

  if (report.pruned.length || report.throttled.length || report.onboardUnhealthy.length) {
    logger.info(report, "source lifecycle tick actions");
  }
  return report;
}
