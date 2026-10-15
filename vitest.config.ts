import { defineConfig } from "vitest/config";

// Without an explicit exclude, vitest also picked up the COMPILED tests in
// dist/__tests__: every suite ran twice, and stale tests from an older build
// kept passing long after their source was deleted — which made the reported
// test count drift with whatever happened to be in dist/.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "dashboard/**"],
  },
});
