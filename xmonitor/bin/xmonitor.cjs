#!/usr/bin/env node
// Shim so `xmonitor <cmd>` works after `pnpm link`; the real entry is TS run by tsx.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const tsx = require.resolve("tsx/cli", { paths: [path.join(__dirname, "..")] });
const res = spawnSync(process.execPath, [tsx, path.join(__dirname, "..", "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
