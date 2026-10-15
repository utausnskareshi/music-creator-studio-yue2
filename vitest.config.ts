import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tools: unit tests of tool helpers; tools/e2e: only the unit tests of the driver helpers (the E2E steps need MCS_E2E_DIR, see tools/e2e/vitest.config.ts)
    include: ["src/**/__tests__/**/*.test.ts", "tools/e2e/*.unit.test.ts", "tools/*.unit.test.ts"],
    environment: "node",
  },
});
