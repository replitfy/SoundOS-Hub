import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, messages: {}, pessoasTable: {} }));

const { MAX_CARACTERES_MENSAGEM, MAX_MENSAGENS_CONTEXTO, contextoVazio, limparTrecho, montarContextoConversa } =
  await import("./interesseContexto.js");

const agora = new Date("2026-10-20T15:00:00.000Z");

describe("contexto do cartão de interesse", () => {
  it("guarda as últimas mensagens da pessoa em ordem e só os campos preenchidos da ficha", () => {
    const contexto = montarContextoConversa({
      conversationId: 12,
      now: agora,
      mensagensDaPessoa: ["  Oi,   tudo bem?  ", "", "Quero fazer o Ciclo Água"],
      ficha: { cidade: " Campinas ", profissao: "  ", servicoInteresse: null, objetivosDeclarados: ["Atender clientes", " "] },
    });
    expect(contexto).toEqual({
      conversationId: 12,
      capturadoEm: "2026-10-20T15:00:00.000Z",
      mensagens: ["Oi, tudo bem?", "Quero fazer o Ciclo Água"],
      ficha: { cidade: "Campinas", objetivos: ["Atender clientes"] },
    });
  });

  it("limita a quantidade e o tamanho das mensagens", () => {
    const longas = Array.from({ length: 9 }, (_, i) => `m${i} ${"x".repeat(1000)}`);
    const contexto = montarContextoConversa({ conversationId: 1, now: agora, mensagensDaPessoa: longas, ficha: null });
    expect(contexto.mensagens).toHaveLength(MAX_MENSAGENS_CONTEXTO);
    expect(contexto.mensagens[0]!.startsWith("m4 ")).toBe(true);
    expect(contexto.mensagens.every(m => m.length <= MAX_CARACTERES_MENSAGEM)).toBe(true);
    expect(limparTrecho("curta")).toBe("curta");
  });

  it("ficha ausente e conversa ausente geram contexto vazio, sem campos inventados", () => {
    expect(contextoVazio(null, agora)).toEqual({
      conversationId: null,
      capturadoEm: "2026-10-20T15:00:00.000Z",
      mensagens: [],
      ficha: {},
    });
  });

  it("não expõe campos sensíveis da ficha mesmo que venham no objeto", () => {
    const contexto = montarContextoConversa({
      conversationId: 1,
      now: agora,
      mensagensDaPessoa: [],
      ficha: { cidade: "Santos", cpf: "123.456.789-00", email: "a@b.c" } as never,
    });
    expect(JSON.stringify(contexto)).not.toMatch(/123\.456|a@b\.c|cpf|email/i);
  });
});
