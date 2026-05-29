#!/usr/bin/env node

const modules = [
  "cloakbrowser",
  "playwright-core",
  "defuddle",
  "@mozilla/readability",
  "turndown",
  "jsdom",
  "@sinclair/typebox",
];

const results = [];

for (const name of modules) {
  try {
    await import(name);
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(JSON.stringify({ ok: false, results }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
