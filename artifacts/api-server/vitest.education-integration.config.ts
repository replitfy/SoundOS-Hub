import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/routes/education.event-summary.integration.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});