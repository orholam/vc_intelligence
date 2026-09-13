import { describe, expect, it } from "vitest";
import { LaunchStore, type OkaraLaunch } from "../src/store.js";

const launch: OkaraLaunch = {
  slug: "lindy",
  company_name: "Lindy",
  tagline: "Your next hire is AI.",
  launched_at: "2026-08-10",
  launch_url: "https://x.com/Altimor/status/2086861887611019623",
  company_website: null,
  views: 7_700_000,
};

describe("LaunchStore", () => {
  it("inserts and dedups launches by slug", () => {
    const store = new LaunchStore(":memory:");
    expect(store.upsertLaunch(launch)).toBe("inserted");
    expect(store.upsertLaunch(launch)).toBe("updated");
    expect(store.count()).toBe(1);
    const all = store.allLaunches();
    expect(all).toHaveLength(1);
    expect(all[0]?.company_name).toBe("Lindy");
    store.close();
  });

  it("refreshes mutable fields on update", () => {
    const store = new LaunchStore(":memory:");
    store.upsertLaunch(launch);
    store.upsertLaunch({ ...launch, views: 9_000_000 });
    const [row] = store.allLaunches();
    expect(row?.views).toBe(9_000_000);
    store.close();
  });

  it("records sync audits", () => {
    const store = new LaunchStore(":memory:");
    store.recordSync({
      total: 10,
      entitiesCreated: 8,
      entitiesMatched: 2,
      articlesInserted: 10,
      articlesExisting: 0,
      linksCreated: 10,
    });
    const syncs = store.recentSyncs(5) as Array<Record<string, unknown>>;
    expect(syncs).toHaveLength(1);
    expect(syncs[0]?.entities_created).toBe(8);
    store.close();
  });
});
