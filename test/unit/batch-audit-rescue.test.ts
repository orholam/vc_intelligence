import { describe, expect, it } from "vitest";
import { rescueBatchAuditVerdict, shouldRescueBatchAuditDrop } from "../../src/harness/batch-audit-rescue.js";
import type { BatchAuditVerdict } from "../../src/harness/batch-audit.js";
import { extractTitleSubject } from "../../src/lib/title-subject.js";

function dropVerdict(reason: string): BatchAuditVerdict {
  return {
    index: 0,
    keep: false,
    reason,
    primary_tag: "funding.seed",
    secondary_tags: [],
    sentiment: "neutral",
    sentiment_score: 0,
    newsworthiness: "low",
    industry_primary: "ai_ml",
    industry_secondary: [],
    countries: [],
    subject_name: null,
  };
}

describe("batch audit rescue", () => {
  it("rescues funding headlines dropped for re-pipeline / stock-tip reasons", () => {
    const title = "Egypt-Born Swvl Raises USD 13 M To Expand US Mobility Operations";
    const verdict = dropVerdict("Re-pipeline / earnings call / stock tip");
    expect(shouldRescueBatchAuditDrop(title, verdict)).toBe(true);
    const rescued = rescueBatchAuditVerdict(verdict, title);
    expect(rescued.keep).toBe(true);
    expect(rescued.subject_name).toMatch(/Swvl/);
    expect(rescued.reason).toMatch(/^rescue:company_event/);
  });

  it("rescues Quaise $180M and BitGo M&A soft drops", () => {
    for (const [title, reason] of [
      ["Quaise Energy raises $180m for Project Obsidian geothermal plant", "Soft / Form D / stock tip"],
      ["BitGo Acquires NYDIG Trading Business to Expand Institutional Crypto Platform", "Re-pipeline or soft noise; skip to curb incomplete"],
    ] as const) {
      const verdict = dropVerdict(reason);
      expect(shouldRescueBatchAuditDrop(title, verdict)).toBe(true);
      expect(rescueBatchAuditVerdict(verdict, title).keep).toBe(true);
    }
  });

  it("does not rescue bare market commentary", () => {
    const title = "Five stocks to watch before Monday's open";
    const verdict = dropVerdict("market commentary");
    expect(shouldRescueBatchAuditDrop(title, verdict)).toBe(false);
  });
});

describe("title subject extraction (false-negative patterns)", () => {
  it("extracts subjects from recovered headline shapes", () => {
    expect(extractTitleSubject("Raise Hires Abhishek Singh As CEO To Helm New Insurtech Arm")).toBe("Raise");
    expect(extractTitleSubject("Yotta Plans IPO ‘Very Soon’ to Keep Up With AI Demand, CEO Says")).toBe("Yotta");
    expect(extractTitleSubject("Reliance Jio IPO: 7 risk factors investors should know")).toBe("Reliance Jio");
    expect(
      extractTitleSubject("Tackling STI testing, Readily Diagnostics raises €811k for affordable alternative"),
    ).toBe("Readily Diagnostics");
    expect(
      extractTitleSubject("Montpellier-based dental robotics startup Lupin Dental closes €15 million Series A round"),
    ).toMatch(/Lupin Dental/);
  });
});
