import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

const requiredFiles = [
  "extensions/cursor.ts",
  "src/index.ts",
  "src/proxy.ts",
  "src/auth.ts",
  "src/h2-bridge.mjs",
  "README.md",
];

const missing = requiredFiles.filter((relativePath) => !existsSync(join(packageRoot, relativePath)));
if (missing.length > 0) {
  throw new Error(`cursor-provider package surface is missing: ${missing.join(", ")}`);
}

const files = new Set(pkg.files ?? []);
for (const entry of ["extensions/", "src/", "scripts/", "docs/"]) {
  if (!files.has(entry)) throw new Error(`package.json files must include ${entry}`);
}
