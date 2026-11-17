// Modo simples: handoff só nos quatro grupos (emergência emocional, reclamação
// séria, pedido explícito de pessoa, pagamento/transação), sem chamar o modelo.
// "Inscrição", "retiro", "preço" e "vou pensar" seguem com a Sofia. Os casos do
// modo legado ficam em sofia.handoff-route.legacy.test.ts.
import { afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { asc, eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SOFIA_MODE = "simple";

const modelMocks = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }));

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

const { db, conversations, messages } = await import("@workspace/db");
const { HANDOFF_ALREADY_ACTIVE_MESSAGE } = await import("../services/handoff");
const { default: sofiaRouter } = await import("./sofia");
const { installScript, parseSse } = await import("./testing/sofiaScriptedModel");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

const conversationIds: number[] = [];

async function chat(message: string, conversationId?: number) {
  const res = await request(app).post("/api/sofia/chat").send({ message, ...(conversationId ? { conversationId } : {}) });
  const parsed = parseSse(res.text);
  if (!conversationId && parsed.done?.conversationId) conversationIds.push(parsed.done.conversationId);
  return parsed;
}

function streamedModelCalls(): number {
  const chatStreams = modelMocks.chatCreate.mock.calls.filter(([p]) => (p as { stream?: boolean }).stream === true).length;
  return chatStreams + modelMocks.responsesCreate.mock.calls.length;
}

describe("Sofia modo simples — handoff em quatro grupos", () => {
  afterAll(async () => {
    if (conversationIds.length > 0) await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  });

  it.each([
    ["Como pago? Dá pra parcelar?", "fechamento_comercial", /Pagamento, parcelamento/],
    ["Quero reembolso da minha compra", "duvida_financeira", /Pagamento, parcelamento/],
    ["Quero falar com uma pessoa", "pedido_explicito", /equipe|time/i],
    ["Vou chamar meu advogado e fazer reclamação formal", "tema_sensivel", /equipe|time/i],
    ["Não aguento mais viver, quero morrer", "tema_sensivel", /188/],
  ])("'%s' → handoff %s sem chamar o modelo", async (mensagem, reason, textoEsperado) => {
    installScript(modelMocks, []);
    const { content, done } = await chat(mensagem);
    expect(streamedModelCalls()).toBe(0);
    expect(content).toMatch(textoEsperado);
    expect(done).toMatchObject({ handoffTriggered: true, handoffReason: reason });

    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, done!.conversationId!));
    expect(conversa?.status).toBe("aguardando_humano");
    expect(conversa?.handoffReason).toBe(reason);
    const resumo = JSON.parse(conversa?.handoffSummary ?? "{}") as { intentoPercebido?: string };
    expect(resumo.intentoPercebido).toBeTruthy();
    const persistidas = await db.select().from(messages)
      .where(eq(messages.conversationId, done!.conversationId!)).orderBy(asc(messages.createdAt), asc(messages.id));
    expect(persistidas.map(m => [m.role, m.content])).toEqual([["user", mensagem], ["assistant", content]]);
  });

  it("quem está começando e pergunta de parcelamento do Ciclo Terra vai para o time sem link nem cartão de interesse", async () => {
    installScript(modelMocks, []);
    const { content, done } = await chat("Dá pra parcelar o Ciclo Terra?");
    expect(streamedModelCalls()).toBe(0);
    expect(done).toMatchObject({ handoffTriggered: true, handoffReason: "fechamento_comercial" });
    expect(content).toMatch(/Pagamento, parcelamento/);
    expect(content).not.toMatch(/interesse|https?:\/\//i);
  });

  it.each([
    "Quero me inscrever no Ciclo Água",
    "Tem vaga no retiro?",
    "Quanto custa o Ciclo Terra?",
    "Quero participar da cerimônia, qual o valor?",
    "Vou pensar",
  ])("'%s' segue com a Sofia, sem handoff", async mensagem => {
    const resposta = mensagem === "Vou pensar"
      ? "Claro, sem pressa. Fico por aqui se quiser conversar."
      : "Te ajudo com isso! Vou confirmar os detalhes com o time interno.";
    installScript(modelMocks, [{ text: resposta }]);
    const { content, done } = await chat(mensagem);
    expect(streamedModelCalls()).toBe(1);
    expect(content).toBe(resposta);
    expect(done?.handoffTriggered).toBeUndefined();
    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, done!.conversationId!));
    expect(conversa?.status).toBe("ativa");
  });

  it("conversa em handoff fica congelada; ao ser retomada, a Sofia volta a responder", async () => {
    installScript(modelMocks, []);
    const primeira = await chat("Me passa pra um atendente");
    const id = primeira.done!.conversationId!;
    expect(primeira.done?.handoffTriggered).toBe(true);

    const congelada = await chat("Oi? Alguém aí?", id);
    expect(congelada.content).toBe(HANDOFF_ALREADY_ACTIVE_MESSAGE);
    expect(streamedModelCalls()).toBe(0);

    await db.update(conversations).set({ status: "ativa" }).where(eq(conversations.id, id));
    installScript(modelMocks, [{ text: "Oi! Estou aqui. Em que posso ajudar?" }]);
    const retomada = await chat("Voltei, pode me ajudar?", id);
    expect(retomada.content).toBe("Oi! Estou aqui. Em que posso ajudar?");
    expect(retomada.done?.handoffTriggered).toBeUndefined();

    // O histórico da conversa vai para o modelo, em ordem.
    const enviada = (modelMocks.responsesCreate.mock.calls[0]?.[0] ?? modelMocks.chatCreate.mock.calls.find(([p]) => (p as { stream?: boolean }).stream)?.[0]) as {
      input?: Array<{ role: string; content: string }>; messages?: Array<{ role: string; content: string }>;
    };
    const historico = (enviada.input ?? enviada.messages ?? []).filter(m => m.role !== "system").map(m => m.content);
    expect(historico[0]).toBe("Me passa pra um atendente");
    expect(historico.at(-1)).toBe("Voltei, pode me ajudar?");
    expect(historico).toContain("Oi? Alguém aí?");
  });
});
