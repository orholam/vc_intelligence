import { describe, expect, it } from "vitest";
import { extractExternalDomain, isNoiseText, looksLikeLaunchText, scoreLaunch } from "../src/classify.js";

describe("extractExternalDomain", () => {
  it("skips x.com and t.co links", () => {
    expect(extractExternalDomain(["https://t.co/abc", "https://x.com/foo/status/1"])).toBeNull();
  });

  it("returns the first product domain, stripping www", () => {
    expect(extractExternalDomain(["https://www.acme.io/pricing", "https://other.dev"])).toBe("acme.io");
    expect(extractExternalDomain(["not a url"])).toBeNull();
  });
});

describe("launch text detection", () => {
  it("recognizes announcement phrasing", () => {
    expect(looksLikeLaunchText("Introducing Acme 2.0 — the fastest way to ship")).toBe(true);
    expect(looksLikeLaunchText("we just launched our new dashboard")).toBe(true);
    expect(looksLikeLaunchText("having lunch")).toBe(false);
  });

  it("flags common non-launch noise", () => {
    expect(isNoiseText("We're hiring! Join our team")).toBe(true);
    expect(isNoiseText("Introducing our conference lineup for 2027")).toBe(true);
  });
});

describe("scoreLaunch", () => {
  const base = { views: 0, likes: 0, externalDomain: null as string | null };

  it("scores a leading-phrase video launch with own domain highest", () => {
    const strong = scoreLaunch({
      ...base,
      text: "Introducing Copyr — copyright intelligence for everyone",
      videoCount: 1,
      externalDomain: "copyr.dev",
    });
    const weak = scoreLaunch({
      ...base,
      text: "someone mentioned the word launch in passing today",
      videoCount: 0,
    });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.score).toBeGreaterThanOrEqual(0.8);
  });

  it("demotes noise posts hard", () => {
    const noisy = scoreLaunch({
      ...base,
      text: "Introducing our webinar series — register now!",
      videoCount: 1,
    });
    const clean = scoreLaunch({ ...base, text: "Introducing our new release — faster than ever", videoCount: 1 });
    expect(noisy.score).toBeLessThan(clean.score);
  });

  it("stays within [0,1] and includes reasons", () => {
    const s = scoreLaunch({
      views: 500_000,
      likes: 900,
      externalDomain: "example.com",
      text: "Introducing the thing",
      videoCount: 3,
    });
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.reasons).toContain("native-video");
    expect(s.domain).toBe("example.com");
  });
});
