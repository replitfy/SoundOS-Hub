
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/routes/event-flow.integration.test.ts", "src/routes/interesse-geral.integration.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
