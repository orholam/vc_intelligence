import { describe, expect, it } from "vitest";
import { canonicalizeUrl, hostToDomain, sha256Hex, urlHash } from "../../src/lib/hash.js";
import { excerpt, guessLanguage, normalizeName, parseLooseDate, splitSentences } from "../../src/lib/text.js";
import { ulid } from "../../src/lib/ulid.js";
import { extractCountries } from "../../src/lib/countries.js";
import { heuristicOrganizations, lexiconSentiment } from "../../src/lib/ner-heuristics.js";

describe("ulid", () => {
  it("generates sortable unique ids", () => {
    const a = ulid();
    const b = ulid();
    expect(a).toHaveLength(26);
    expect(b).toHaveLength(26);
    expect(a).not.toBe(b);
  });
});

describe("url hashing", () => {
  it("strips tracking params + fragments for dedup", () => {
    const a = "https://Example.com/article/1?utm_source=x&id=2#top";
    const b = "https://example.com/article/1?id=2";
    expect(urlHash(a)).toBe(urlHash(b));
    expect(canonicalizeUrl(a)).toBe("https://example.com/article/1?id=2");
  });

  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
  });

  it("reduces hosts to registrable domains", () => {
    expect(hostToDomain("https://www.news.example.co.uk/a")).toBe("example.co.uk");
    expect(hostToDomain("sub.techcrunch.com")).toBe("techcrunch.com");
  });
});

describe("text utils", () => {
  it("normalizes company names across legal suffixes", () => {
    expect(normalizeName("Acme Robotics, Inc.")).toBe(normalizeName("acme robotics"));
    expect(normalizeName("The Acme Ltd")).toBe(normalizeName("acme"));
  });

  it("excerpts on word boundaries <= maxChars", () => {
    const text = "word ".repeat(200);
    const ex = excerpt(text, 400);
    expect(ex.length).toBeLessThanOrEqual(401); // + ellipsis
    expect(ex.endsWith("\u2026")).toBe(true);
  });

  it("splits sentences and guesses language", () => {
    expect(splitSentences("One two. Three four! Five?")).toHaveLength(3);
    expect(guessLanguage("the quick brown fox jumps over the lazy dog and it is fine")).toBe("en");
  });

  it("parses GDELT seendates", () => {
    expect(parseLooseDate("20260821T091500Z")?.getUTCHours()).toBe(9);
    expect(parseLooseDate("2026-08-21T09:00:00Z")).not.toBeNull();
  });

  it("extracts countries from text", () => {
    expect(extractCountries("Acme raised in San Francisco, expanding to Germany")).toContain("US");
    expect(extractCountries("expanding to Germany")).toContain("DE");
  });

  it("heuristic NER finds capitalized org runs with suffix boost", () => {
    const orgs = heuristicOrganizations("Yesterday Acme Robotics announced Series B while visiting Paris.");
    const names = orgs.map((o) => o.name.toLowerCase());
    expect(names.some((n) => n.includes("acme"))).toBe(true);
  });

  it("lexicon sentiment scores direction", () => {
    expect(lexiconSentiment("profits surge, record growth").sentiment).toBe("positive");
    expect(lexiconSentiment("layoffs plunge amid lawsuit").sentiment).toBe("negative");
  });
});
