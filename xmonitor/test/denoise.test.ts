import { describe, expect, it } from "vitest";
import { evaluateLaunch } from "../src/denoise.js";

// Real examples captured on 2026-08-22.
describe("evaluateLaunch — rejects today's noise", () => {
  it("rejects breaking-news politics", () => {
    const v = evaluateLaunch({
      text: "🚨BREAKING: Iran’s Supreme Leader Mojtaba Khamenei has reportedly…",
      linkedDomain: null,
      views: 2_025_045,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("news-style");
  });

  it("rejects 'IT'S OFFICIAL' news style", () => {
    const v = evaluateLaunch({
      text: "🚨 IT'S OFFICIAL: President Trump confirms the strike is complete.",
      linkedDomain: null,
      views: 43_758,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("news-style");
  });

  it("rejects sports home-run milestones", () => {
    const v = evaluateLaunch({
      text: "Pete Alonso just launched his 30th HR of the season, extending the Mets' lead.",
      linkedDomain: null,
      views: 83_394,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("sports-milestone");
  });

  it("rejects personal introductions", () => {
    const v = evaluateLaunch({
      text: "Introducing myself be like 🫵🏾🤭 https://t.co/xyz",
      linkedDomain: null,
      views: 671,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("personal-introduction");
  });

  it("fails low-signal celebrity/idol posts without hard-reject", () => {
    const v = evaluateLaunch({
      text: "introducing ALPHA DRIVE ONE c-representative ZHOU ANXIN https://t.co/WHVYhjc2I7",
      linkedDomain: null,
      views: 930,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("low-signal");
  });

  it("rejects viral movie-poster hype despite huge traction (no product evidence)", () => {
    const v = evaluateLaunch({
      text: "Introducing\nADDRESS: Supervisor Satyam, C/O Ammaji Aqua Industries… Welcome to the world of #KAAKA 🔥🔥 Wishing our dearest Annayya a very Happy Birthday.",
      linkedDomain: "youtu.be",
      views: 583_706,
    });
    expect(v.ok).toBe(false);
  });

  it("rejects self re-introductions despite traction", () => {
    const v = evaluateLaunch({
      text: "RE INTRODUCING YUSUF!!! 🥹❤️ see you on screen soon",
      linkedDomain: null,
      views: 31_984,
    });
    expect(v.ok).toBe(false);
  });

  it("rejects group introductions", () => {
    const v = evaluateLaunch({
      text: "kongddo introducing each other for their last day as trainees 🥹",
      linkedDomain: null,
      views: 1237,
    });
    expect(v.ok).toBe(false);
  });
});

describe("evaluateLaunch — keeps real launches", () => {
  it("keeps hardware launch with own domain", () => {
    const v = evaluateLaunch({
      text: "Introducing the RetroTINK-6X CE: ‣Native 2560x1440p ‣True HDR10 CRT Simulation $230 USD",
      linkedDomain: "retrotink.com",
      views: 51_800,
    });
    expect(v.ok).toBe(true);
  });

  it("keeps indie app with own domain", () => {
    const v = evaluateLaunch({
      text: "Introducing Phonon! Fast, local, open-source voice typing with parakeet and gemma 4.",
      linkedDomain: "phonon.sh",
      views: 1_439,
    });
    expect(v.ok).toBe(true);
  });

  it("keeps high-traction feature launch even without own domain", () => {
    const v = evaluateLaunch({
      text: "Introducing Graphs on Backpack 🎒 Compare stocks across hundreds of financial and market metrics in one view.",
      linkedDomain: null,
      views: 41_100,
    });
    expect(v.ok).toBe(true);
  });

  it("keeps dev-tool launch via product vocab", () => {
    const v = evaluateLaunch({
      text: "Introducing the GPUI based block editor, the missing component for your expensive AI SaaS! Try it",
      linkedDomain: "bezel.gallery",
      views: 4_854,
    });
    expect(v.ok).toBe(true);
  });

  it("keeps marketplace launch without captured domain", () => {
    const v = evaluateLaunch({
      text: "Introducing GemEx - an aggregated marketplace for tokenized graded slabs. No more wasted time searching every marketplace.",
      linkedDomain: null,
      views: 50,
    });
    expect(v.ok).toBe(true);
  });
});
