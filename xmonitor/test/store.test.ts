import { describe, expect, it } from "vitest";
import { LaunchStore, type NewLaunch } from "../src/store.js";

function makeLaunch(overrides: Partial<NewLaunch> = {}): NewLaunch {
  return {
    tweetId: `t${Math.random().toString(36).slice(2)}`,
    authorHandle: "acme",
    authorName: "Acme",
    text: "Introducing Acme",
    url: "https://x.com/acme/status/1",
    linkedDomain: "acme.io",
    videoCount: 1,
    views: 1000,
    likes: 10,
    retweets: 2,
    replies: 1,
    score: 0.9,
    queryId: "introducing",
    postedAtSec: Math.floor(Date.now() / 1000) - 600,
    ...overrides,
  };
}

describe("LaunchStore", () => {
  it("inserts once and dedupes by tweet id", () => {
    const store = new LaunchStore(":memory:");
    const l = makeLaunch();
    expect(store.insertLaunch(l)).toBe(true);
    expect(store.insertLaunch(l)).toBe(false);
    store.close();
  });

  it("filters recent launches by window, score and views", () => {
    const store = new LaunchStore(":memory:");
    store.insertLaunch(makeLaunch({ tweetId: "recent-strong" }));
    store.insertLaunch(
      makeLaunch({ tweetId: "old", postedAtSec: Math.floor(Date.now() / 1000) - 72 * 3600 }),
    );
    store.insertLaunch(makeLaunch({ tweetId: "low-score", score: 0.1 }));
    store.insertLaunch(makeLaunch({ tweetId: "low-views", views: 5 }));

    const rows = store.recentLaunches({ sinceHours: 24, limit: 10, minScore: 0.45, minViews: 200 });
    const ids = rows.map((r) => r.tweetId);
    expect(ids).toContain("recent-strong");
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("low-score");
    expect(ids).not.toContain("low-views");
    store.close();
  });

  it("records polls and reports stats", () => {
    const store = new LaunchStore(":memory:");
    store.recordPoll({ queryId: "introducing", fetched: 40, newLaunches: 3 });
    store.insertLaunch(makeLaunch());
    const s = store.stats();
    expect(s.totalLaunches).toBe(1);
    expect(s.last24h).toBe(1);
    expect(s.lastPollAt).not.toBeNull();
    store.close();
  });
});
