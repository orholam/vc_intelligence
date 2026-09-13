import { describe, expect, it } from "vitest";
import { buildGithubSearchUrl } from "../../src/ingestion/launches.js";

describe("github_trending launch surface", () => {
  it("builds a search query scoped to the recency window with a star floor", () => {
    const url = buildGithubSearchUrl(150, 7);
    expect(url).toContain("https://api.github.com/search/repositories?");
    expect(url).toContain("sort=stars");
    expect(url).toContain("order=desc");
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    expect(q).toMatch(/^created:>\d{4}-\d{2}-\d{2} stars:150\.\.\*$/);
  });

  it("widens the window as days change", () => {
    const q30 = decodeURIComponent(
      new URL(buildGithubSearchUrl(100, 30)).searchParams.get("q") ?? "",
    );
    expect(q30).toContain("stars:100..*");
  });
});
