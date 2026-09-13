import eslint from "eslint/config";
import tseslint from "typescript-eslint";

export default eslint.defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "migrations/**", "coverage/**", ".tsbuildinfo/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
    },
  },
  {
    // CLI scripts and the MCP stdio server legitimately write to console.
    files: [
      "src/scripts/**/*.ts",
      "src/mcp/**/*.ts",
      "src/entities/imports/base.ts",
      "src/ops/**/*.ts",
    ],
    rules: { "no-console": "off" },
  },
]);
