import { describe, expect, it } from "vitest";
import { categoryOf, isSyncable, planLaunch } from "../src/mapping.js";
import type { OkaraLaunch } from "../src/store.js";

const base: OkaraLaunch = {
  slug: "wispr-flow",
  company_name: "Wispr Flow",
  tagline: "Don't type, just speak.",
  launched_at: "2026-08-05",
  launch_url: "https://x.com/tankots/status/2085033208882831615",
  company_website: "https://wisprflow.ai",
  category: "AI & ML",
  handle: "@tankots",
  views: 19_306_296,
  likes: 3144,
  reposts: 1210,
  comments: 532,
  saves: 1693,
  author_followers: 33_977,
  is_yc_launch: false,
};

describe("mapping", () => {
  it("extracts string and object categories", () => {
    expect(categoryOf(base)).toBe("AI & ML");
    expect(categoryOf({ ...base, category: { name: "Fintech" } })).toBe("Fintech");
    expect(categoryOf({ ...base, category: null })).toBeNull();
    expect(categoryOf({ ...base, category: undefined })).toBeNull();
  });

  it("requires a url and a name/slug to be syncable", () => {
    expect(isSyncable(base)).toBe(true);
    expect(isSyncable({ ...base, launch_url: null })).toBe(false);
    expect(isSyncable({ ...base, company_name: null, slug: "" })).toBe(false);
  });

  it("plans an entity with normalized domain + confidence", () => {
    const plan = planLaunch(base);
    expect(plan.entity.canonicalName).toBe("Wispr Flow");
    expect(plan.entity.website).toBe("wisprflow.ai");
    expect(plan.entity.industryTags).toEqual(["ai_ml"]);
    expect(plan.entity.confidence).toBe(0.7);
  });

  it("falls back to slug for the name when company_name is missing", () => {
    const plan = planLaunch({ ...base, company_name: null });
    expect(plan.entity.canonicalName).toBe("wispr-flow");
  });

  it("builds a titled article with platform meta", () => {
    const plan = planLaunch(base);
    expect(plan.article.title).toBe("Wispr Flow: Don't type, just speak.");
    expect(plan.article.publishedAt.toISOString()).toBe("2026-08-05T12:00:00.000Z");
    // E1 taxonomy validity: event tags are dotted ids, sectors are sector ids.
    expect(plan.article.primaryTag).toBe("product.launch");
    expect(plan.article.industryPrimary).toBe("ai_ml");
    expect(plan.article.allTags).toEqual(["product.launch"]);
    expect(plan.article.platformMeta).toMatchObject({
      surface: "okara-launch-library",
      views: 19_306_296,
      slug: "wispr-flow",
    });
  });

  it("handles missing dates and taglines without throwing", () => {
    const plan = planLaunch({
      ...base,
      tagline: null,
      launched_at: null,
      company_website: null,
      handle: null,
    });
    expect(Number.isNaN(plan.article.publishedAt.getTime())).toBe(false);
    expect(plan.entity.website).toBeNull();
    expect(plan.entity.confidence).toBe(0.55);
    expect(plan.article.excerptText.length).toBeGreaterThan(0);
  });
});
