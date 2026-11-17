// Modo simples: perguntas factuais sobre eventos passam pelo loop LLM + tools.
// Sem short-circuit de agenda, sem bloqueio por módulo, sem handoff por
// "preço"/"inscrição". Os casos do modo legado ficam em
// sofia.factual-route.legacy.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { asc, eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SOFIA_MODE = "simple";

const modelMocks = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }));
const catalogMock = vi.hoisted(() => ({ getOfficialEventCatalog: vi.fn() }));
const interesseMock = vi.hoisted(() => ({ interesseDoPedidoDeValor: vi.fn() }));

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = { id: "staff-test", name: "Equipe Teste", role: "admin" };
    next();
  },
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: modelMocks.chatCreate } },
    responses: { create: modelMocks.responsesCreate },
  },
}));

vi.mock("../services/sofiaEventCatalog", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/sofiaEventCatalog")>()),
  getOfficialEventCatalog: catalogMock.getOfficialEventCatalog,
}));

vi.mock("../services/sofiaTools/interesse.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/sofiaTools/interesse.js")>()),
  interesseDoPedidoDeValor: interesseMock.interesseDoPedidoDeValor,
}));

const { db, conversations, messages } = await import("@workspace/db");
const { default: sofiaRouter } = await import("./sofia");
const { installScript, parseSse, systemPromptOf, toolNamesOf } = await import("./testing/sofiaScriptedModel");
const { VALOR_NAO_CONFIRMADO } = await import("../services/sofiaSimpleGuards");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

const TERRA_URL = "https://www.soundfulness.online/event-details/ciclo-terra-2027";
const AGUA_URL = "https://www.soundfulness.online/event-details/ciclo-agua-2027";
const CONCERTO_URL = "https://www.soundfulness.online/event-details/concerto-rj-2027";

function item(eventId: number, name: string, startDate: string, extra: Record<string, unknown> = {}) {
  return {
    eventId, slug: `e-${eventId}`, name, description: `Sobre ${name}`, startDate, endDate: null,
    location: "São Paulo", nucleus: "education", eventType: "CURSO", classId: null, courseId: null,
    modality: null, workload: null, price: null,
    sourceUrl: `https://www.soundfulness.online/event-details/e-${eventId}`,
    ...extra,
  };
}

const agenda = [
  item(901, "CICLO TERRA - Sound Healing Avançado", "2027-02-10", { price: 4800, sourceUrl: TERRA_URL }),
  item(902, "CICLO ÁGUA - Sound Healing Individual", "2027-03-15", { price: 2800, sourceUrl: AGUA_URL }),
  item(903, "CONCERTO MEDITATIVO - Banho de Gongs", "2027-04-20", { location: "Rio de Janeiro", eventType: "CONCERTO", sourceUrl: CONCERTO_URL }),
];

const conversationIds: number[] = [];

async function chat(message: string) {
  const res = await request(app).post("/api/sofia/chat").send({ message });
  const parsed = parseSse(res.text);
  if (parsed.done?.conversationId) conversationIds.push(parsed.done.conversationId);
  return { res, ...parsed };
}

function toolOutputs(params: Record<string, unknown>): string[] {
  const input = (params.input ?? params.messages) as Array<{ type?: string; role?: string; output?: string; content?: string }>;
  return input.filter(i => i.type === "function_call_output" || i.role === "tool").map(i => i.output ?? i.content ?? "");
}

describe("Sofia modo simples — eventos", () => {
  beforeEach(() => {
    interesseMock.interesseDoPedidoDeValor.mockReset();
    interesseMock.interesseDoPedidoDeValor.mockResolvedValue(null);
    // Respeita o filtro de local como o catálogo real (sem acento, por trecho).
    const semAcento = (v: string) => v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    catalogMock.getOfficialEventCatalog.mockImplementation(async (filters: { location?: string } = {}) => ({
      source: { tables: ["cursos_inscricao", "classes", "courses"], fetchedAt: new Date().toISOString(), policy: "public_event_agenda" },
      items: filters.location ? agenda.filter(e => semAcento(e.location).includes(semAcento(filters.location!))) : agenda,
    }));
  });

  afterAll(async () => {
    if (conversationIds.length > 0) await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  });

  it("responde o próximo evento com nome, data, local e link reais, sem handoff", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "proximo_evento", args: {} }] },
      { text: `O próximo é o *Ciclo Terra*, em 10/02/2027, em São Paulo. Inscrições: ${TERRA_URL}` },
    ]);
    const { content, done } = await chat("Qual é o próximo evento?");

    expect(content).toContain(TERRA_URL);
    expect(content).toContain("10/02/2027");
    expect(content).not.toMatch(/link ainda não/i);
    expect(done?.handoffTriggered).toBeUndefined();
    expect(script.remaining()).toBe(0);

    const saida = toolOutputs(script.requests[1]!.params).join("\n");
    expect(saida).toContain(TERRA_URL);
    expect(saida).toContain("2027-02-10");

    const system = systemPromptOf(script.requests[0]);
    expect(system).toContain("CONTEXTO");
    expect(system).toContain("ficha: nenhuma");
    expect(toolNamesOf(script.requests[0])).toEqual(expect.arrayContaining([
      "buscar_produto", "produtos_similares", "proximo_evento", "detalhes_evento", "listar_eventos", "enviar_interesse", "video_do_evento", "atualizar_ficha",
    ]));
    expect(toolNamesOf(script.requests[0])).not.toContain("escalateToHuman");
    if (script.requests[0]!.transport === "responses") {
      expect(script.requests[0]!.params.reasoning).toEqual({ effort: "low" });
    }

    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, done!.conversationId!));
    expect(conversa?.status).toBe("ativa");
    const persistidas = await db.select().from(messages)
      .where(eq(messages.conversationId, done!.conversationId!)).orderBy(asc(messages.createdAt), asc(messages.id));
    expect(persistidas.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(persistidas[1]!.content).toBe(content);
  });

  it("'Me fala do Ciclo Terra' responde normalmente, sem mensagem de pré-requisito", async () => {
    const resposta = `O Ciclo Terra é o módulo avançado de Sound Healing. Próxima turma em 10/02/2027: ${TERRA_URL}`;
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "detalhes_evento", args: { nome: "Ciclo Terra" } }] },
      { text: resposta },
    ]);
    const { content, done } = await chat("Me fala do Ciclo Terra");
    expect(content).toBe(resposta);
    expect(content).not.toMatch(/pr[ée]-requisito|antes precisa|concluir o ciclo/i);
    expect(done?.handoffTriggered).toBeUndefined();
    expect(toolOutputs(script.requests[1]!.params).join("")).toContain(TERRA_URL);
  });

  it("preço de evento nunca sai, nem o cadastrado nem um inventado pelo modelo", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "detalhes_evento", args: { nome: "Ciclo Terra" } }] },
      { text: `O Ciclo Terra custa R$ 4.800,00 (ou R$ 999 no pix). Link: ${TERRA_URL}` },
    ]);
    const { content, done } = await chat("Quanto custa o Ciclo Terra?");
    // O catálogo tem o preço cadastrado (4800), mas a tool não o repassa; a guarda
    // troca qualquer valor que o modelo escreva por conta própria.
    expect(toolOutputs(script.requests[1]!.params).join("")).not.toMatch(/R\$|4800|preco|price/i);
    expect(content).not.toContain("4.800");
    expect(content).not.toContain("R$ 999");
    expect(content).toContain(VALOR_NAO_CONFIRMADO);
    expect(done?.handoffTriggered).toBeUndefined();
  });

  it("pergunta de preço chama enviar_interesse, que não devolve valor e orienta a mandar o link", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "enviar_interesse", args: { evento: "Ciclo Água" } }] },
      { text: "Os valores e condições quem passa é o time interno; deixe seu interesse pelo cadastro e eles retornam 🙂" },
    ]);
    const { content, done } = await chat("Quanto custa o Ciclo Água?");
    const saida = toolOutputs(script.requests[1]!.params).join("");
    expect(saida).toContain("CICLO ÁGUA");
    expect(saida).toContain("2027-03-15");
    expect(saida).toMatch(/NUNCA informe preço/);
    expect(saida).not.toMatch(/R\$|2800|preco|price/i);
    expect(content).not.toContain("R$");
    expect(done?.handoffTriggered).toBeUndefined();
    expect(script.remaining()).toBe(0);
  });

  it("'Tem vaga no Ciclo Água?' segue sem handoff e com link", async () => {
    const resposta = `As vagas eu confirmo com o time interno. A próxima turma é em 15/03/2027: ${AGUA_URL}`;
    installScript(modelMocks, [
      { toolCalls: [{ name: "detalhes_evento", args: { nome: "Ciclo Água" } }] },
      { text: resposta },
    ]);
    const { content, done } = await chat("Tem vaga no Ciclo Água?");
    expect(content).toBe(resposta);
    expect(done?.handoffTriggered).toBeUndefined();
  });

  it("preço + parcelamento de evento: o handoff de pagamento também entrega o link de interesse", async () => {
    const link = "https://soundfulness.net/interesse/ciclo-agua-2027-interesse";
    interesseMock.interesseDoPedidoDeValor.mockResolvedValue(
      `Para agilizar, deixe seu interesse no cadastro da edição de 15/03/2027: ${link}`,
    );
    modelMocks.chatCreate.mockReset();
    modelMocks.responsesCreate.mockReset();
    const mensagem = "Quanto custa o Ciclo Água? Dá pra parcelar?";
    const { content, done } = await chat(mensagem);

    expect(done?.handoffTriggered).toBe(true);
    expect(content).toContain("condições ficam com o nosso time");
    expect(content).toContain(link);
    expect(content).not.toMatch(/R\$|\d+\s*x\b|reais/);
    expect(interesseMock.interesseDoPedidoDeValor).toHaveBeenCalledWith(expect.objectContaining({
      mensagem, pessoaId: null, conversationId: expect.any(Number),
    }));
    expect(modelMocks.chatCreate).not.toHaveBeenCalled();
    expect(modelMocks.responsesCreate).not.toHaveBeenCalled();
    const [resposta] = await db.select().from(messages)
      .where(eq(messages.conversationId, done!.conversationId!)).orderBy(asc(messages.id)).then(r => r.filter(m => m.role === "assistant"));
    expect(resposta?.content).toContain(link);
  });

  it("o handoff de pagamento entrega ao fluxo de interesse as mensagens da pessoa na conversa, para saber se ela já fez um ciclo", async () => {
    installScript(modelMocks, [{ text: "Que bom ter você de volta!" }]);
    const primeira = await chat("Oi! Eu já fiz o Ciclo Água com vocês ano passado.");
    const conversationId = primeira.done!.conversationId!;
    interesseMock.interesseDoPedidoDeValor.mockClear();

    const mensagem = "Dá pra parcelar o Ciclo Terra?";
    const res = await request(app).post("/api/sofia/chat").send({ message: mensagem, conversationId });
    expect(parseSse(res.text).done?.handoffTriggered).toBe(true);
    const chamada = interesseMock.interesseDoPedidoDeValor.mock.calls[0]?.[0] as { mensagem: string; mensagensDaPessoa: string[] };
    expect(chamada.mensagem).toBe(mensagem);
    expect(chamada.mensagensDaPessoa).toContain("Oi! Eu já fiz o Ciclo Água com vocês ano passado.");
    expect(chamada.mensagensDaPessoa).not.toContain("Que bom ter você de volta!");
  });

  it("preço + parcelamento sem link disponível: só o handoff, e uma falha no fluxo de interesse não derruba a resposta", async () => {
    const { content, done } = await chat("Posso parcelar o Ciclo Água no cartão de crédito?");
    expect(done?.handoffTriggered).toBe(true);
    expect(content).toContain("condições ficam com o nosso time");
    expect(content).not.toContain("http");

    interesseMock.interesseDoPedidoDeValor.mockRejectedValue(new Error("catálogo fora do ar"));
    const falha = await chat("Tem desconto no Ciclo Fogo?");
    expect(falha.done?.handoffTriggered).toBe(true);
    expect(falha.content).toContain("condições ficam com o nosso time");
  });

  it("remove só a URL inventada; o restante da resposta chega", async () => {
    installScript(modelMocks, [
      { toolCalls: [{ name: "detalhes_evento", args: { nome: "workshop Água" } }] },
      { text: `O Ciclo Água acontece em 15/03/2027.\nInscrição: ${AGUA_URL}\nMais fotos: https://inventado.example.com/galeria` },
    ]);
    const { content } = await chat("O que é o workshop Água?");
    expect(content).toContain("O Ciclo Água acontece em 15/03/2027.");
    expect(content).toContain(AGUA_URL);
    expect(content).not.toContain("inventado.example.com");
    expect(content).not.toContain("Mais fotos");
  });

  it("lista eventos por cidade e executa várias tools no mesmo turno", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [
        { name: "listar_eventos", args: { cidade: "São Paulo" } },
        { name: "listar_eventos", args: { cidade: "RJ" } },
      ] },
      { text: `Em São Paulo: Ciclo Terra (10/02/2027) ${TERRA_URL} e Ciclo Água (15/03/2027) ${AGUA_URL}. No Rio: Concerto (20/04/2027) ${CONCERTO_URL}` },
    ]);
    const { content } = await chat("Quais eventos têm em São Paulo e no Rio?");
    const saidas = toolOutputs(script.requests[1]!.params);
    expect(saidas).toHaveLength(2);
    expect(saidas[0]).toContain(TERRA_URL);
    expect(saidas[0]).not.toContain(CONCERTO_URL);
    expect(saidas[1]).toContain(CONCERTO_URL);
    expect(content).toContain(TERRA_URL);
    expect(content).toContain(AGUA_URL);
    expect(content).toContain(CONCERTO_URL);
  });

  it("falha do modelo vira erro SSE e preserva a mensagem da pessoa", async () => {
    modelMocks.chatCreate.mockReset();
    modelMocks.responsesCreate.mockReset();
    modelMocks.chatCreate.mockRejectedValue(new Error("provider down"));
    modelMocks.responsesCreate.mockRejectedValue(new Error("provider down"));
    const res = await request(app).post("/api/sofia/chat").send({ message: "Qual é o próximo evento?" });
    const { events } = parseSse(res.text);
    const erro = events.find(e => e.error);
    expect(erro?.code).toBe("SOFIA_COMPLETION_FAILED");
    expect(erro?.conversationId).toBeTypeOf("number");
    conversationIds.push(erro!.conversationId!);
    const persistidas = await db.select().from(messages).where(eq(messages.conversationId, erro!.conversationId!));
    expect(persistidas.map(m => m.role)).toEqual(["user"]);
  });
});
