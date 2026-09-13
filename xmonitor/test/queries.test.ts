import { describe, expect, it } from "vitest";
import { buildLaunchQueries, buildLaunchQuery, mergeQueries, parseCustomQueries } from "../src/queries.js";

describe("buildLaunchQuery", () => {
  it("includes video filter and excludes replies/retweets", () => {
    const q = buildLaunchQuery("introducing");
    expect(q).toContain("introducing");
    expect(q).toContain("filter:native_video");
    expect(q).toContain("-filter:replies");
    expect(q).toContain("-filter:retweets");
    expect(q).toContain("lang:en");
  });
});

describe("buildLaunchQueries", () => {
  it("creates stable ids for each phrase", () => {
    const qs = buildLaunchQueries(["introducing", "we're launching"]);
    expect(qs).toHaveLength(2);
    expect(qs[0]?.id).toBe("introducing");
    expect(qs[1]?.id).toBe("were-launching");
    expect(new Set(qs.map((q) => q.id)).size).toBe(2);
  });
});

describe("parseCustomQueries", () => {
  it("parses comma-separated queries", () => {
    const qs = parseCustomQueries("launching today filter:native_video lang:de, unveiling filter:native_video");
    expect(qs).toHaveLength(2);
    expect(qs[0]?.text).toBe("launching today filter:native_video lang:de");
    expect(qs[0]?.id.startsWith("custom-")).toBe(true);
  });

  it("parses a JSON array", () => {
    const qs = parseCustomQueries('["a filter:native_video","b filter:native_video"]');
    expect(qs).toHaveLength(2);
    expect(qs[1]?.text).toBe("b filter:native_video");
  });

  it("returns empty for empty input", () => {
    expect(parseCustomQueries(undefined)).toEqual([]);
    expect(parseCustomQueries("")).toEqual([]);
  });
});

describe("mergeQueries", () => {
  it("puts custom first and dedupes against defaults", () => {
    const merged = mergeQueries('introducing filter:native_video -filter:replies -filter:retweets lang:en');
    const texts = merged.map((q) => q.text);
    expect(new Set(texts).size).toBe(texts.length);
    // custom variant comes first
    expect(merged[0]?.id.startsWith("custom-")).toBe(true);
    // all six default phrases still present exactly once
    expect(texts.filter((t) => t === "introducing filter:native_video -filter:replies -filter:retweets lang:en")).toHaveLength(1);
  });
});
