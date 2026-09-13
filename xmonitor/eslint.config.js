import eslint from "eslint/config";
import tseslint from "typescript-eslint";

export default eslint.defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "data/**"],
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
    // The CLI and interactive auth legitimately write to stdout/stderr.
    files: ["src/cli.ts", "src/auth.ts", "bin/**"],
    rules: { "no-console": "off" },
  },
]);
