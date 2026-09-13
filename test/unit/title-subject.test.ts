import { describe, expect, it } from "vitest";
import { heuristicOrganizations } from "../../src/lib/ner-heuristics.js";
import { entityNameRejectionReason } from "../../src/lib/quality.js";
import {
  extractAcquisitionTarget,
  extractTitleSubject,
  isFundingRoundFragment,
  stripPublisherSuffix,
} from "../../src/lib/title-subject.js";

describe("title subject extraction", () => {
  it("extracts the raising company, not the round label", () => {
    expect(extractTitleSubject("OneDome Raises $25M Pre-Series C")).toBe("OneDome");
    expect(extractTitleSubject("Levanta Raises $22M Series B")).toBe("Levanta");
    expect(extractTitleSubject("Flash Raises $29M Series D")).toBe("Flash");
    expect(extractTitleSubject("Capital B raises $24.5M for its Bitcoin treasury")).toBe("Capital B");
  });

  it("rejects funding-round fragments and glue words", () => {
    for (const bad of ["M Pre-Series C", "M Series B", "M Series D", "Funding", "IPO OpenAI"]) {
      expect(isFundingRoundFragment(bad) || entityNameRejectionReason(bad)).toBeTruthy();
    }
  });

  it("strips syndicated publisher suffixes", () => {
    const t = "Nvidia Agrees to Acquire Hugging Face For $13 Billion - Slashdot";
    expect(stripPublisherSuffix(t)).not.toMatch(/slashdot/i);
    expect(extractTitleSubject(t)).toBe("Nvidia");
    expect(extractAcquisitionTarget(t)).toBe("Hugging Face");
  });

  it("NER does not mint M Series labels or Slashdot from funding headlines", () => {
    const orgs = heuristicOrganizations("OneDome Raises $25M Pre-Series C").map((o) => o.name);
    expect(orgs).toContain("OneDome");
    expect(orgs).not.toContain("M Pre-Series C");
    const slash = heuristicOrganizations(
      "Nvidia Agrees to Acquire Hugging Face For $13 Billion - Slashdot",
    ).map((o) => o.name);
    expect(slash.some((n) => /nvidia/i.test(n))).toBe(true);
    expect(slash).not.toContain("Slashdot");
  });
});
