import { describe, expect, it } from "vitest";
import type { Scraper, Tweet } from "@the-convocation/twitter-scraper";
import { loadConfig } from "../src/config.js";
import { formatDigest } from "../src/digest.js";
import { makeLogger } from "../src/log.js";
import { LaunchStore } from "../src/store.js";
import { pollOnce } from "../src/watcher.js";

/** Deterministic fake of the parts of Scraper that pollOnce touches. */
class FakeScraper {
  constructor(private readonly feed: Map<string, Tweet[]>) {}
  *searchTweets(query: string, _max: number, _mode: unknown): Generator<Tweet> {
    const tweets = this.feed.get(query.split(" ")[0] ?? "") ?? [];
    yield* tweets;
  }
}

const NOW = Math.floor(Date.now() / 1000);

function tweet(overrides: Partial<Tweet>): Tweet {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    text: "",
    username: "someone",
    name: "Someone",
    timestamp: NOW - 300,
    urls: [],
    photos: [],
    videos: [],
    hashtags: [],
    mentions: [],
    thread: [],
    ...overrides,
  };
}

describe("pipeline: pollOnce -> store -> digest (simulated)", () => {
  it("captures launches, filters junk, dedupes, ranks and renders", async () => {
    const strong = tweet({
      id: "strong-1",
      text: "Introducing Copyr Lens — realtime copyright intelligence. Here's the 40s tour:",
      username: "copyrdev",
      name: "Copyr",
      videos: [{ id: "v1", preview: "https://pbs.twimg.com/x.jpg", url: "https://video.twimg.com/x.mp4" }],
      urls: ["https://copyr.dev"],
      views: 4200,
      likes: 87,
    });
    const feed = new Map<string, Tweet[]>([
      [
        "introducing",
        [
          strong,
          tweet({
            id: "noise-1",
            text: "Introducing our webinar series starting next week!",
            username: "boringco",
            videos: [{ id: "v2", preview: "p" }],
            views: 90,
            likes: 1,
          }),
          tweet({ id: "reply-1", text: "Introducing myself here!", isReply: true, username: "newbie" }),
          tweet({ id: "rt-1", text: "Introducing something great", isRetweet: true, username: "reposter" }),
          tweet({
            id: "weak-1",
            text: "introducing some changes to our pricing page today",
            username: "somesaas",
            urls: ["https://somesaas.io/pricing"],
            views: 40,
          }),
        ],
      ],
      // second query re-surfaces the same strong tweet -> cross-query dedupe
      ["were-launching", [tweet({ ...strong })]],
    ]);

    const scraper = new FakeScraper(feed) as unknown as Scraper;
    const store = new LaunchStore(":memory:");
    const cfg = { ...loadConfig({} as NodeJS.ProcessEnv), maxSearchesPerHour: 100, queryGapSeconds: 0 };

    const run1 = await pollOnce(scraper, store, cfg, makeLogger("error"));
    expect(run1.length).toBeGreaterThan(0);
    // Store keeps every non-junk post (replies/retweets dropped): strong,
    // webinar-noise and weak-pricing all land here — scoring is advisory.
    expect(run1.reduce((n, r) => n + r.newLaunches, 0)).toBe(3);

    // second poll over identical tweets -> everything deduped
    const run2 = await pollOnce(scraper, store, cfg, makeLogger("error"));
    expect(run2.reduce((n, r) => n + r.newLaunches, 0)).toBe(0);

    // Digest thresholds are what gate quality: only the strong launch survives.
    const rows = store.recentLaunches({ sinceHours: 24, limit: 10, minScore: 0.45, minViews: 200 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorHandle).toBe("copyrdev");
    expect(rows[0]?.linkedDomain).toBe("copyr.dev");
    expect(rows[0]?.videoCount).toBe(1);

    const md = formatDigest(rows, { minViews: 200, format: "md" });
    expect(md).toContain("@copyrdev");
    expect(md).toContain("`copyr.dev`");
    expect(md).toContain("Introducing Copyr Lens");
    expect(md).toContain("https://x.com/copyrdev/status/strong-1");
    store.close();
  });

  it("skips queries once the persisted hourly budget is spent", async () => {
    const scraper = new FakeScraper(new Map()) as unknown as Scraper;
    const store = new LaunchStore(":memory:");
    const cfg = {
      ...loadConfig({} as NodeJS.ProcessEnv),
      maxSearchesPerHour: 2,
      queryGapSeconds: 0,
    };
    const results = await pollOnce(scraper, store, cfg, makeLogger("error"));
    const executed = results.filter((r) => !r.error?.startsWith("skipped"));
    const skipped = results.filter((r) => r.error?.startsWith("skipped") === true);
    expect(executed).toHaveLength(2); // hour cap reached
    expect(skipped).toHaveLength(results.length - 2);
    expect(store.searchCountSince(3600)).toBe(2);
    store.close();
  });
});
