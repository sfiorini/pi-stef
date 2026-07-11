#!/usr/bin/env node
/**
 * Generate a Postman Collection v2.1 from the finance-api OpenAPI spec.
 *
 * Usage:
 *   npx tsx packages/finance-api/scripts/gen-postman.mjs
 *
 * Output:
 *   packages/finance-api/postman/finance-api.postman_collection.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { openDb } from "../src/store/db.ts";
import { FINANCE_API_VERSION } from "../src/version.ts";
import ConverterV2 from "openapi-to-postmanv2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "postman", "finance-api.postman_collection.json");

// 1. Build an in-process app and get the OpenAPI spec directly
const db = openDb(":memory:");
const app = createApp({ db, token: "dummy" });
const spec = app.getOpenAPIDocument({
  openapi: "3.1.0",
  info: {
    title: "finance-api",
    version: FINANCE_API_VERSION,
    description: "Always-on local service for portfolio tracking, drift analysis, and investment suggestions.",
  },
  servers: [{ url: "http://127.0.0.1:7780", description: "Local" }],
});

// 2. Convert OpenAPI spec → Postman Collection v2.1
const result = await new Promise((resolve) => {
  ConverterV2.convert(
    { type: "json", data: spec },
    { folderStrategy: "Tags" },
    (err, res) => resolve({ err, res }),
  );
});

const { err, res } = result;
if (!res?.result) {
  console.error("Postman conversion failed:", err || res?.reason);
  process.exit(1);
}

const collection = res.output[0].data;

// 3. Set collection-level auth + variables
collection.auth = {
  type: "bearer",
  bearer: [{ key: "token", value: "{{token}}", type: "string" }],
};

collection.variable = [
  { key: "base_url", value: "http://127.0.0.1:7780", type: "string" },
  { key: "token", value: "your-token-here", type: "string" },
];

// 4. Post-process every request:
//    - Strip per-request auth (use collection-level auth instead)
//    - Rewrite URLs to use {{base_url}} instead of {{baseUrl}} or absolute URLs
function postProcess(items) {
  for (const item of items) {
    if (item.item) {
      postProcess(item.item);
    }
    if (item.request) {
      // Strip per-request auth — collection-level Bearer auth applies to all
      delete item.request.auth;

      // Rewrite URL: replace {{baseUrl}} host with {{base_url}}
      if (item.request.url) {
        const url = item.request.url;
        // Replace host variable from {{baseUrl}} to {{base_url}}
        if (Array.isArray(url.host)) {
          url.host = url.host.map((h) =>
            h === "{{baseUrl}}" ? "{{base_url}}" : h,
          );
        }
        // Build raw URL for Postman compatibility
        const host = (url.host || []).join(".");
        const pathStr = (url.path || []).join("/");
        const queryStr = (url.query || []).map((q) => `${q.key}=${q.value}`).join("&");
        url.raw = `${host}/${pathStr}${queryStr ? "?" + queryStr : ""}`;
      }
    }
  }
}
postProcess(collection.item || []);

// 5. Add a test script to the health endpoint
function addTestScripts(items) {
  for (const item of items) {
    if (item.item) {
      addTestScripts(item.item);
    }
    if (item.request?.url?.path?.includes("health")) {
      item.event = [{
        listen: "test",
        script: {
          type: "text/javascript",
          exec: [
            "pm.test('ok is true', () => {",
            "  pm.expect(pm.response.json().ok).to.be.true;",
            "});",
          ],
        },
      }];
    }
  }
}
addTestScripts(collection.item || []);

// 6. Write the collection
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(collection, null, 2) + "\n");
console.log(`Postman collection written to: ${outputPath}`);

function countRequests(items) {
  let count = 0;
  for (const item of items) {
    if (item.item) count += countRequests(item.item);
    else count++;
  }
  return count;
}

console.log(`Endpoints: ${countRequests(collection.item)} requests`);
