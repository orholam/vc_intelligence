import { describe, expect, it } from "vitest";
import Parser from "rss-parser";
import { sanitizeBareAmpersands, parseFeedTolerant } from "../../src/ingestion/rss.js";

const parser = new Parser({ headers: {} });

const FEED_WITH_BARE_AMP = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>T</title>
<item>
  <title>Watch this</title>
  <link>https://example.com/a?_r=1&_t=ZT-999</link>
  <pubDate>Mon, 24 Aug 2026 12:00:00 GMT</pubDate>
</item>
</channel></rss>`;

describe("tolerant RSS parsing", () => {
  it("sanitizes bare ampersands but leaves valid entities alone", () => {
    const out = sanitizeBareAmpersands("<a href='x?a=1&amp;b=2'>&lt;tag&gt; &#038; &#x26; raw & raw</a>");
    expect(out).toBe("<a href='x?a=1&amp;b=2'>&lt;tag&gt; &#038; &#x26; raw &amp; raw</a>");
  });

  it("recovers a feed that strict XML rejects due to a bare '&'", async () => {
    await expect(parser.parseString(FEED_WITH_BARE_AMP)).rejects.toThrow(/entity name/i);
    const feed = await parseFeedTolerant(FEED_WITH_BARE_AMP);
    expect(feed.items?.[0]?.link).toContain("example.com");
  });
});
