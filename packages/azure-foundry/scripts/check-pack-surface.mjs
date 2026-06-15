import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const files = new Set(pkg.files || []);

const required = ["extensions/", "src/", "scripts/", "config.schema.json", "README.md"];
const forbidden = ["tests", "node_modules", "tsconfig.json", "pnpm-lock.yaml", "package-lock.json"];

for (const entry of required) {
  if (!files.has(entry)) throw new Error(`package.json#files must include ${entry}`);
}
for (const entry of forbidden) {
  if (files.has(entry)) throw new Error(`package.json#files must not include ${entry}`);
}
if (!existsSync(new URL("../config.schema.json", import.meta.url))) {
  throw new Error("config.schema.json must exist in the package root");
}

console.log("Pack surface OK");
