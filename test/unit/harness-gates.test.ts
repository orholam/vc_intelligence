import { describe, expect, it } from "vitest";
import { isAgentHarnessModel, isMockModelName, mockMustNotPublish, refuseHarnessWithoutModel } from "../../src/llm/router.js";

function cfg(partial: { LLM_PROVIDER: "mock" | "auto" | "harness" | "openai-compatible"; LLM_API_KEY: string }) {
  return partial as never;
}

describe("refuseHarnessWithoutModel", () => {
  it("blocks scheduled ticks when auto has no key or provider is harness", () => {
    expect(refuseHarnessWithoutModel(cfg({ LLM_PROVIDER: "auto", LLM_API_KEY: "sk-xxx" }))).toBe(true);
    expect(refuseHarnessWithoutModel(cfg({ LLM_PROVIDER: "auto", LLM_API_KEY: "" }))).toBe(true);
    expect(refuseHarnessWithoutModel(cfg({ LLM_PROVIDER: "harness", LLM_API_KEY: "" }))).toBe(true);
  });

  it("does not refuse explicit mock (offline tests) or auto with a real-looking key", () => {
    expect(refuseHarnessWithoutModel(cfg({ LLM_PROVIDER: "mock", LLM_API_KEY: "" }))).toBe(false);
    expect(refuseHarnessWithoutModel(cfg({ LLM_PROVIDER: "auto", LLM_API_KEY: "sk-live-not-a-placeholder" }))).toBe(
      false,
    );
  });
});

describe("mockMustNotPublish", () => {
  it("blocks mock fallback on auto/harness and allows the explicit mock provider", () => {
    expect(mockMustNotPublish(cfg({ LLM_PROVIDER: "auto", LLM_API_KEY: "sk-xxx" }))).toBe(true);
    expect(mockMustNotPublish(cfg({ LLM_PROVIDER: "harness", LLM_API_KEY: "" }))).toBe(true);
    expect(mockMustNotPublish(cfg({ LLM_PROVIDER: "mock", LLM_API_KEY: "" }))).toBe(false);
  });
});

describe("isMockModelName", () => {
  it("blocks programmatic mock brains and mock-prefixed models", () => {
    expect(isMockModelName("mock-offline")).toBe(true);
    expect(isMockModelName("editorial-brain")).toBe(true);
    expect(isMockModelName("harness:cursor-agent")).toBe(true);
    expect(isMockModelName("harness:mock-agent")).toBe(true);
  });

  it("allows the real agent model tag and hosted API models", () => {
    expect(isMockModelName("harness:agent")).toBe(false);
    expect(isMockModelName("gpt-4o-mini")).toBe(false);
    expect(isMockModelName(null)).toBe(false);
  });
});

describe("isAgentHarnessModel", () => {
  it("identifies the production agent model tag", () => {
    expect(isAgentHarnessModel("harness:agent")).toBe(true);
    expect(isAgentHarnessModel("harness:mock-agent")).toBe(false);
  });
});
