import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "src/routes/commercial-opportunities.integration.test.ts",
      "src/routes/crm-atendimento.integration.test.ts",
      "src/routes/anexos-atendimento.integration.test.ts",
      "src/services/primeiroContatoFormulario.integration.test.ts",
      "src/services/airtableNovosClientes.integration.test.ts",
      "src/routes/education.event-summary.integration.test.ts",
      "src/routes/event-flow.integration.test.ts",
    ],
  },
});
