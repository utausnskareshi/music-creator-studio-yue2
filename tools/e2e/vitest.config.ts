import { defineConfig } from "vitest/config";

// E2E TypeScript steps only (see ts_steps.test.ts): npx vitest run --config tools/e2e/vitest.config.ts
export default defineConfig({
  test: {
    root: "tools/e2e",
    include: ["*.test.ts"],
    environment: "node",
  },
});
