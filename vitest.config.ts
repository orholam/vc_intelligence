import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    env: {
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: "/tmp/opencode/intel-test-storage",
      EMBEDDING_DIM: "256",
    },
  },
});
