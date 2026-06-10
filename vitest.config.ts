import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts", "scripts/**/*.test.{ts,js,mjs}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
