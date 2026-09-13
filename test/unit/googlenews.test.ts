import { describe, expect, it } from "vitest";
import {
  buildBatchExecuteBody,
  decodeLegacyArticleId,
  googleNewsArticleId,
  isGoogleNewsWrapper,
  parseBatchExecuteResponse,
  parseWrapperSignature,
} from "../../src/ingestion/googlenews.js";

describe("isGoogleNewsWrapper", () => {
  it("detects rss + bare article wrappers", () => {
    expect(isGoogleNewsWrapper("https://news.google.com/rss/articles/CBMiabc?oc=5")).toBe(true);
    expect(isGoogleNewsWrapper("https://news.google.com/articles/CBMiabc")).toBe(true);
  });

  it("rejects non-wrapper urls", () => {
    expect(isGoogleNewsWrapper("https://news.google.com/rss/search?q=x")).toBe(false);
    expect(isGoogleNewsWrapper("https://example.com/rss/articles/CBMiabc")).toBe(false);
    expect(isGoogleNewsWrapper("not a url")).toBe(false);
  });
});

describe("googleNewsArticleId", () => {
  it("extracts the id, stripping query params", () => {
    expect(googleNewsArticleId("https://news.google.com/rss/articles/CBMiabc?oc=5")).toBe(
      "CBMiabc",
    );
    expect(googleNewsArticleId("https://example.com/nope")).toBeNull();
  });
});

describe("decodeLegacyArticleId", () => {
  it("decodes legacy protobuf ids embedding the target url offline", () => {
    // protobuf: field1 varint (0x08 0x01), field2 len-delimited url string
    const id = Buffer.from([
      0x08, 0x01, 0x22, 0x15, ...Buffer.from("https://example.com/a", "utf8"),
    ])
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(decodeLegacyArticleId(id)).toBe("https://example.com/a");
  });

  it("returns null for opaque post-2024 tokens", () => {
    const id = Buffer.from([0x08, 0x01, 0x12, 0x08, ...Buffer.from("AU_yqLxx")]).toString(
      "base64url",
    );
    expect(decodeLegacyArticleId(id)).toBeNull();
  });

  it("returns null on garbage input", () => {
    expect(decodeLegacyArticleId("!!!not-base64!!!")).toBeNull();
    expect(decodeLegacyArticleId("")).toBeNull();
  });
});

describe("parseWrapperSignature", () => {
  it("reads data-n-a-sg / data-n-a-ts attributes", () => {
    const html = `<c-wiz data-n-a-sg="SIG-123" data-n-a-ts="1700000000000"></c-wiz>`;
    expect(parseWrapperSignature(html)).toEqual({ signature: "SIG-123", timestamp: 1700000000000 });
  });

  it("returns null when either attribute is missing or malformed", () => {
    expect(parseWrapperSignature(`<div data-n-a-sg="x"></div>`)).toBeNull();
    expect(parseWrapperSignature(`<div data-n-a-ts="abc"></div>`)).toBeNull();
  });
});

describe("buildBatchExecuteBody", () => {
  it("embeds article id, timestamp and signature in the f.req envelope", () => {
    const body = buildBatchExecuteBody("ARTID", { signature: "SG", timestamp: 42 });
    const outer = JSON.parse(decodeURIComponent(body.replace(/^f\.req=/, "")));
    expect(outer[0][0][0]).toBe("Fbv4je");
    const rpcInner = JSON.parse(outer[0][0][1]);
    expect(rpcInner[0]).toBe("garturlreq");
    expect(rpcInner[2]).toBe("ARTID");
    expect(rpcInner[3]).toBe(42);
    expect(rpcInner[4]).toBe("SG");
  });
});

describe("parseBatchExecuteResponse", () => {
  it("extracts garturlres target across envelope framing", () => {
    const payload = JSON.stringify(["garturlres", "https://publisher.com/story", null, null, []]);
    const body = `)]}'\n${payload.length}\n${JSON.stringify([["wrb.fr", "Fbv4je", payload, null, null, [], ""]])}\n[["di",26]]`;
    expect(parseBatchExecuteResponse(body)).toBe("https://publisher.com/story");
  });

  it("returns null when google refuses (null payload)", () => {
    const body = `)]}'\n[["wrb.fr","Fbv4je",null,null,null,[3],""]]`;
    expect(parseBatchExecuteResponse(body)).toBeNull();
  });
});
