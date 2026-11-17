import { describe, expect, it } from "vitest";
import { UpdatePessoaBody } from "@workspace/api-zod";

describe("UpdatePessoaBody", () => {
  it("accepts a name edit when other editable fields are blank", () => {
    const result = UpdatePessoaBody.safeParse({
      nome: "Ivone",
      sobrenome: "Pedroso",
      cpf: null,
      dataNascimento: null,
      email: null,
      celular: null,
      profissao: null,
      objetivosDeclarados: [],
    });

    expect(result.success).toBe(true);
  });

  it("does not accept clearing the required name", () => {
    expect(UpdatePessoaBody.safeParse({ nome: null }).success).toBe(false);
  });
});