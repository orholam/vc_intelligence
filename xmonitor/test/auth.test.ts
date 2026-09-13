import { describe, expect, it } from "vitest";
import { cookieStringsFromContent } from "../src/auth.js";
import { parseCookieHeader } from "../src/session.js";

describe("cookieStringsFromContent", () => {
  it("parses a raw cookie header", () => {
    const out = cookieStringsFromContent("auth_token=abc123; ct0=deadbeef; lang=en");
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("auth_token=abc123");
  });

  it("parses a Cookie-Editor JSON export into scraper-ready strings", () => {
    const out = cookieStringsFromContent(
      JSON.stringify([
        { name: "auth_token", value: "abc", domain: ".x.com", path: "/" },
        { name: "ct0", value: "def", domain: ".x.com", path: "/" },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("auth_token=abc");
    expect(out[0]).toContain("Domain=.x.com");
    expect(out[0]).toContain("Secure");
  });

  it("keeps string entries as-is", () => {
    const out = cookieStringsFromContent(JSON.stringify(["ct0=zzz; Path=/; Domain=.x.com"]));
    expect(out).toEqual(["ct0=zzz; Path=/; Domain=.x.com"]);
  });
});

describe("parseCookieHeader edge cases", () => {
  it("drops empty and malformed parts", () => {
    expect(parseCookieHeader("a=1;; b=; c; d=2")).toEqual(["a=1", "d=2"]);
  });
});
