import { describe, expect, it } from "vitest";
import { planejarEscrita, validarCampos } from "./ficha.js";
import { decidirIdentificacao, nomeEhPlaceholder } from "../sofiaPessoa.js";

const hoje = new Date("2026-10-06T15:00:00Z");

describe("atualizar_ficha: validação", () => {
  it("aceita campos da lista e normaliza valores", () => {
    const { validos, rejeitados } = validarCampos({
      idade: 34, cidade: " Campinas ", estado: "sp", profissao: "psicóloga",
      email: " Maria@Exemplo.COM ", instagram: "https://instagram.com/maria.som/", objetivos_declarados: ["relaxar"],
    }, hoje);
    expect(rejeitados).toEqual([]);
    expect(validos).toEqual({
      idadeDeclarada: 34, cidade: "Campinas", estadoUf: "SP", profissao: "psicóloga",
      email: "maria@exemplo.com", instagram: "maria.som", objetivosDeclarados: ["relaxar"],
    });
  });

  it("rejeita null, vazio, campo fora da lista (CPF, saúde) e e-mail inválido", () => {
    const { validos, rejeitados } = validarCampos({
      cidade: null, profissao: "  ", cpf: "123.456.789-00", problema_saude: "x", pessoaId: 99, email: "maria@", idade: 200,
    }, hoje);
    expect(validos).toEqual({});
    expect(rejeitados).toEqual([
      { campo: "cidade", motivo: "vazio" },
      { campo: "profissao", motivo: "vazio" },
      { campo: "cpf", motivo: "campo_nao_permitido" },
      { campo: "problema_saude", motivo: "campo_nao_permitido" },
      { campo: "pessoaId", motivo: "campo_nao_permitido" },
      { campo: "email", motivo: "valor_invalido" },
      { campo: "idade", motivo: "valor_invalido" },
    ]);
  });

  it("aceita só data de nascimento ISO passada e plausível", () => {
    expect(validarCampos({ data_nascimento: "1990-05-20" }, hoje).validos).toEqual({ dataNascimento: "1990-05-20" });
    for (const data of ["2030-01-01", "1990-02-30", "20/05/1990", "1880-01-01"]) {
      expect(validarCampos({ data_nascimento: data }, hoje).rejeitados).toHaveLength(1);
    }
  });

  it("não aceita nome placeholder", () => {
    expect(validarCampos({ nome: "Nathalia" }, hoje).rejeitados).toEqual([{ campo: "nome", motivo: "valor_invalido" }]);
  });
});

describe("atualizar_ficha: nunca sobrescreve", () => {
  it("grava campo vazio e marca conflito em campo preenchido", () => {
    const r = planejarEscrita({ cidade: "São Paulo", profissao: null }, { cidade: "Rio de Janeiro", profissao: "música" });
    expect(r).toEqual({ gravar: { profissao: "música" }, conflitos: ["cidade"] });
  });

  it("mesmo valor não é conflito", () => {
    expect(planejarEscrita({ cidade: "Campinas" }, { cidade: "campinas" })).toEqual({ gravar: {}, conflitos: [] });
  });

  it("nome substitui placeholder e completa sobrenome vazio", () => {
    expect(planejarEscrita({ nome: "(ficha em criação)" }, { nome: "Maria" }).gravar).toEqual({ nome: "Maria" });
    expect(planejarEscrita({ nome: "Maria", sobrenome: null }, { nome: "Maria Souza" }).gravar).toEqual({ sobrenome: "Souza" });
    expect(planejarEscrita({ nome: "Maria" }, { nome: "Joana" }).conflitos).toEqual(["nome"]);
  });
});

describe("identificar_ou_criar_pessoa: decisão", () => {
  const ficha = (id: number, nome: string, extra: Partial<{ ativo: boolean; arquivado_em: string | null; sobrenome: string | null }> = {}) =>
    ({ id, nome, sobrenome: null, ativo: true, arquivado_em: null, ...extra });

  it("sem ficha cria", () => {
    expect(decidirIdentificacao([], "Maria")).toEqual({ status: "criar" });
  });

  it("reconhece ficha única com nome compatível", () => {
    expect(decidirIdentificacao([ficha(1, "Maria", { sobrenome: "Souza" })], "Maria")).toMatchObject({ status: "reconhecida", linha: { id: 1 } });
  });

  it("nome diferente na ficha única fica anônimo", () => {
    expect(decidirIdentificacao([ficha(1, "Joana")], "Maria")).toEqual({ status: "nome_divergente" });
  });

  it("celular compartilhado só reconhece com exatamente uma ficha compatível", () => {
    expect(decidirIdentificacao([ficha(1, "Joana"), ficha(2, "Maria")], "Maria")).toMatchObject({ status: "reconhecida", linha: { id: 2 } });
    expect(decidirIdentificacao([ficha(1, "Maria"), ficha(2, "Maria")], "Maria")).toEqual({ status: "celular_compartilhado" });
    expect(decidirIdentificacao([ficha(1, "Joana"), ficha(2, "Ana")], "Maria")).toEqual({ status: "celular_compartilhado" });
  });

  it("ficha arquivada ou inativa não é vinculada", () => {
    expect(decidirIdentificacao([ficha(1, "Maria", { ativo: false })], "Maria")).toMatchObject({ status: "ficha_inativa" });
    expect(decidirIdentificacao([ficha(1, "Maria", { arquivado_em: "2026-01-01" })], "Maria")).toMatchObject({ status: "ficha_inativa" });
  });

  it("placeholder de criação é compatível com qualquer nome; nomes placeholder são rejeitados", () => {
    expect(decidirIdentificacao([ficha(1, "(ficha em criação)")], "Maria")).toMatchObject({ status: "reconhecida" });
    expect(["Nathalia", "(sem nome)", "Fulano de Tal", ""].every(nomeEhPlaceholder)).toBe(true);
    expect(nomeEhPlaceholder("Nathalia Souza")).toBe(false);
  });
});
