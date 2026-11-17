import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pessoaCamposConfirmados: {},
  pessoaEvidencias: {},
  pessoaMergeAudits: {},
  pessoaNotes: {},
  pessoasTable: {},
}));

import { deriveMergeDefaults } from "./pessoaMerge";

describe("pessoa merge defaults", () => {
  it("chooses the longest trimmed full name and fills blank contacts", () => {
    const defaults = deriveMergeDefaults(
      { nome: "  Maria", sobrenome: "da Silva", email: "maria@example.test", celular: "55119999" },
      { nome: "Ana", sobrenome: null, email: null, celular: null },
    );
    expect(defaults).toEqual({ nameFrom: "source", emailFrom: "source", phoneFrom: "source" });
  });

  it("keeps target values as defaults when both records have contacts", () => {
    const defaults = deriveMergeDefaults(
      { nome: "João", sobrenome: null, email: "source@example.test", celular: "111" },
      { nome: "Joana", sobrenome: "Long Name", email: "target@example.test", celular: "222" },
    );
    expect(defaults).toEqual({ nameFrom: "target", emailFrom: "target", phoneFrom: "target" });
  });
});