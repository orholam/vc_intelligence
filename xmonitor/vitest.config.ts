import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "forks",
    env: {
      NODE_ENV: "test",
    },
  },
});
