import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/services/airtableNovosClientes.integration.test.ts"],
    // Tudo roda em sequência: as execuções compartilham a tabela de andamento e o índice de "uma por vez".
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
