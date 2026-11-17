import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: { select: () => { throw new Error("sem banco no teste"); } },
}));
vi.mock("./produtos.js", () => ({ buscarProduto: vi.fn(), produtosSimilares: vi.fn() }));
vi.mock("./eventos.js", () => ({
  detalhesEvento: vi.fn(), listarEventos: vi.fn(), proximoEvento: vi.fn(), videoDoEvento: vi.fn(),
}));
vi.mock("./ficha.js", () => ({ atualizarFicha: vi.fn() }));
const enviarInteresse = vi.hoisted(() => vi.fn());
vi.mock("./interesse.js", () => ({ enviarInteresse }));
const registrarNaoQuerReceber = vi.hoisted(() => vi.fn());
vi.mock("./naoQuerReceber.js", () => ({ registrarNaoQuerReceber }));
const atualizarCartaoDaConversa = vi.hoisted(() => vi.fn());
vi.mock("../cartaoDaConversa.js", () => ({ atualizarCartaoDaConversa }));

import { CARTAO_TOOL, executarToolSimples, ocultarValoresEmReais, SIMPLE_MODE_TOOLS } from "./definicoes.js";

const chamada = (name: string, args: unknown) => ({
  id: "call-1", type: "function" as const, function: { name, arguments: JSON.stringify(args) },
});

describe("ocultarValoresEmReais", () => {
  it("troca qualquer valor em reais, com ou sem milhar", () => {
    expect(ocultarValoresEmReais("De R$ 4.800,00 por R$2800 ou R$ 97 em bônus")).toBe(
      "De [valor omitido] por [valor omitido] ou [valor omitido] em bônus",
    );
  });
});

describe("tools do modo simples", () => {
  it("expõe enviar_interesse e nenhuma tool de evento descreve preço cadastrado", () => {
    const nomes = SIMPLE_MODE_TOOLS.map(t => t.function.name);
    expect(nomes).toContain("enviar_interesse");
    for (const t of SIMPLE_MODE_TOOLS.filter(t => ["proximo_evento", "detalhes_evento"].includes(t.function.name))) {
      expect(t.function.description).not.toMatch(/preço cadastrado/i);
    }
  });

  it("enviar_interesse usa a pessoa e a conversa do backend, nunca os argumentos do modelo", async () => {
    enviarInteresse.mockResolvedValueOnce({ status: "ok" });
    await executarToolSimples(
      chamada("enviar_interesse", { evento: "Ciclo Água", data: "2027-01", pessoaId: 999, conversationId: 1 }),
      { pessoaId: 42, conversationId: 3072 },
    );
    expect(enviarInteresse).toHaveBeenCalledWith(expect.objectContaining({
      evento: "Ciclo Água", data: "2027-01", pessoaId: 42, conversationId: 3072,
    }));
  });

  it("distingue página informativa de formulário e respeita o contexto do lead", () => {
    const detalhes = SIMPLE_MODE_TOOLS.find(t => t.function.name === "detalhes_evento")!.function.description;
    const interesse = SIMPLE_MODE_TOOLS.find(t => t.function.name === "enviar_interesse")!.function.description;
    expect(detalhes).toContain("não é o formulário de inscrição");
    expect(detalhes).toContain("salvo pedido explícito desse link");
    expect(interesse).toContain("não chame só porque houve preenchimento");
    expect(interesse).toContain("Não invente link se ele estiver ausente");
  });

  it("registrar_nao_quer_receber é uma ferramenta sem argumentos e usa a pessoa e a conversa do backend", async () => {
    const definicao = SIMPLE_MODE_TOOLS.find(t => t.function.name === "registrar_nao_quer_receber");
    expect(definicao?.function.parameters).toMatchObject({ properties: {}, required: [] });
    registrarNaoQuerReceber.mockResolvedValueOnce({ ok: true });
    await executarToolSimples(chamada("registrar_nao_quer_receber", { pessoaId: 999, conversationId: 1 }), { pessoaId: 42, conversationId: 3072 });
    expect(registrarNaoQuerReceber).toHaveBeenCalledWith({ pessoaId: 42, conversationId: 3072 });
  });

  it("atualizar_cartao é uma ferramenta só do WhatsApp: fora da lista padrão e recusada em outro canal", async () => {
    expect(SIMPLE_MODE_TOOLS.map(t => t.function.name)).not.toContain("atualizar_cartao");
    expect(CARTAO_TOOL.function.name).toBe("atualizar_cartao");
    expect(Object.keys((CARTAO_TOOL.function.parameters as { properties: object }).properties).sort())
      .toEqual(["informacoes", "intencao", "necessidades", "remover"]);
    atualizarCartaoDaConversa.mockClear();
    const recusada = await executarToolSimples(chamada("atualizar_cartao", { intencao: "Quer o Ciclo Água" }), { pessoaId: 42, conversationId: 3072 });
    expect(JSON.parse(recusada)).toEqual({ erro: "Ferramenta indisponível neste canal." });
    expect(atualizarCartaoDaConversa).not.toHaveBeenCalled();
  });

  it("atualizar_cartao no WhatsApp usa a conversa do backend, nunca pessoa ou cartão vindos do modelo", async () => {
    atualizarCartaoDaConversa.mockResolvedValueOnce({ status: "atualizado" });
    await executarToolSimples(
      chamada("atualizar_cartao", { intencao: "Quer o Ciclo Água", necessidades: ["Relaxar"], informacoes: ["Mora em Campinas"], remover: ["x"], pessoaId: 999, conversationId: 1, opportunityId: 5 }),
      { pessoaId: 42, conversationId: 3072, canal: "whatsapp" },
    );
    expect(atualizarCartaoDaConversa).toHaveBeenCalledWith({
      conversationId: 3072,
      entrada: { intencao: "Quer o Ciclo Água", necessidades: ["Relaxar"], informacoes: ["Mora em Campinas"], remover: ["x"] },
      now: undefined,
    });
  });

  it("base de conhecimento nunca entrega valor em reais ao modelo", async () => {
    const saida = await executarToolSimples(chamada("searchKnowledgeBase", { query: "bônus" }), {
      pessoaId: null,
      conversationId: 1,
      searchKnowledge: async () => [{ title: "Matriz", contentPreview: "Pode ser pago, R$97, bônus ou cashback" }],
    });
    expect(saida).not.toMatch(/R\$|97/);
    expect(saida).toContain("[valor omitido]");
  });
});
