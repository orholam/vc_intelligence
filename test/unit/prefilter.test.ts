import { describe, expect, it } from "vitest";
import { prefilter } from "../../src/filtering/prefilter.js";

describe("FR-5a prefilter", () => {
  it("discards tag/category pages by URL pattern", () => {
    const r = prefilter({ url: "https://x.com/tag/funding/", title: "Funding tagged posts this week" });
    expect(r.kept).toBe(false);
    expect(r.reason).toContain("/tag/");
  });

  it("discards roundups and sponsored formats", () => {
    const r = prefilter({ url: "https://x.com/post/1", title: "Sponsored: The best tools of 2026" });
    expect(r.kept).toBe(false);
  });

  it("discards tiny bodies below min chars", () => {
    const r = prefilter({ url: "https://x.com/a/1", title: "Acme quietly updates pricing page today", body: "too short" });
    expect(r.kept).toBe(false);
    expect(r.reason).toBe("body_below_min_chars");
  });

  it("keeps genuine funding news even with short body (funding rescue)", () => {
    const r = prefilter({
      url: "https://x.com/a/2",
      title: "Acme raises $12M Series A",
      body: "short but real",
    });
    expect(r.kept).toBe(true);
  });

  it("keeps normal articles", () => {
    const body = "Acme Robotics announced a partnership with Globex. ".repeat(10);
    const r = prefilter({ url: "https://x.com/a/3", title: "Acme Robotics partners with Globex on robots", body });
    expect(r.kept).toBe(true);
    expect(r.score).toBeLessThan(0.5);
  });
});
