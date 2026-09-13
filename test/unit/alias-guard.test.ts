import { describe, expect, it } from "vitest";
import {
  entityNameRejectionReason,
  isGenericCompanyAlias,
  isGenericFundingAlias,
} from "../../src/lib/quality.js";

/** Regression guard: funding vocabulary must never act as a company alias. */
describe("isGenericFundingAlias", () => {
  it("flags generic funding vocabulary", () => {
    for (const s of ["series", "series a", "series b", "series f", "series 3",
      "pre-series", "pre series a", "round", "rounds", "funding", "seed"]) {
      expect(isGenericFundingAlias(s), s).toBe(true);
    }
  });

  it("does not flag real company-ish names", () => {
    for (const s of ["acme robotics", "series.so", "seedrs", "roundtrip",
      "funding circle", "openai"]) {
      expect(isGenericFundingAlias(s), s).toBe(false);
    }
  });
});

describe("isGenericCompanyAlias", () => {
  it("flags common English / publisher words that swallow headlines", () => {
    for (const s of ["energy", "bank", "mark", "markets", "link", "owner", "alice",
      "natural", "slash", "pocket", "bot", "forbes", "nikkei"]) {
      expect(isGenericCompanyAlias(s), s).toBe(true);
    }
  });

  it("does not flag distinctive brand names", () => {
    for (const s of ["getenergy", "openai", "airtel", "tesla", "acme robotics"]) {
      expect(isGenericCompanyAlias(s), s).toBe(false);
    }
  });
});

describe("entityNameRejectionReason verb-glued headlines", () => {
  it("rejects names that swallowed a headline verb", () => {
    expect(entityNameRejectionReason("Neno Raises")).toBe("headline_verb_glued");
    expect(entityNameRejectionReason("Liquid AI Open-Sources Pipette")).toBe("headline_verb_glued");
  });

  it("rejects mock NER headline fragments", () => {
    expect(entityNameRejectionReason("Million")).toBe("headline_fragment");
    expect(entityNameRejectionReason("Includes")).toBe("headline_fragment");
    expect(entityNameRejectionReason("AI-related")).toBe("headline_fragment");
    expect(entityNameRejectionReason("Great Retro RPG List")).toBe("headline_artifact");
    expect(entityNameRejectionReason("Billion Space Telescope")).toBe("money_phrase_not_company");
    expect(entityNameRejectionReason("Title")).toBe("prompt_field_label");
    expect(entityNameRejectionReason("Adding")).toBe("prompt_field_label");
    expect(entityNameRejectionReason("M Series B")).toBe("funding_round_fragment");
    expect(entityNameRejectionReason("Slashdot")).toBe("media_or_aggregator");
    expect(entityNameRejectionReason("Funding")).toBe("generic_word");
  });

  it("allows real brands", () => {
    expect(entityNameRejectionReason("Liquid AI")).toBeNull();
    expect(entityNameRejectionReason("Hermetiq")).toBeNull();
  });
});
