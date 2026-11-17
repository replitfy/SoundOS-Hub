import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/routes/commercial-opportunities.integration.test.ts",
      "src/routes/crm-atendimento.integration.test.ts",
      "src/routes/anexos-atendimento.integration.test.ts",
      "src/services/primeiroContatoFormulario.integration.test.ts",
      "src/services/cartaoDaConversa.integration.test.ts",
    ],
  },
});