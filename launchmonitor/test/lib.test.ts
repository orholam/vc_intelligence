import { describe, expect, it } from "vitest";
import { canonicalizeUrl, hostToDomain, normalizeName, opaqueId, urlHash } from "../src/lib.js";

describe("lib", () => {
  it("hashes urls consistently with tracking params stripped", () => {
    const a = urlHash("https://x.com/foo/status/123");
    const b = urlHash("https://x.com/foo/status/123?utm_source=x");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalizes fragments away but keeps paths distinct", () => {
    expect(canonicalizeUrl("https://x.com/a#top")).toBe("https://x.com/a");
    expect(urlHash("https://x.com/a")).not.toBe(urlHash("https://x.com/b"));
  });

  it("reduces hosts to registrable domains", () => {
    expect(hostToDomain("https://www.wisprflow.ai/pricing")).toBe("wisprflow.ai");
    expect(hostToDomain("stitch.withgoogle.com")).toBe("withgoogle.com");
    expect(hostToDomain("bbc.co.uk")).toBe("bbc.co.uk");
  });

  it("normalizes names like the parent KB", () => {
    expect(normalizeName("Acme Corp.")).toBe("acme");
    expect(normalizeName("Wispr Flow")).toBe("wispr flow");
  });

  it("mints prefixed ids", () => {
    expect(opaqueId("ent")).toMatch(/^ent_[0-9A-Z]{26}$/);
  });
});
