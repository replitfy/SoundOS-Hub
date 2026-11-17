import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
// Rede de segurança do rollback: estes casos fixam o modo legado.
process.env.SOFIA_MODE = "legacy";

const modelMocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
}));

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

const {
  conversations,
  db,
  decisionRuns,
  messages,
  pessoaEvidencias,
  pessoasTable,
} = await import("@workspace/db");
const { HANDOFF_ALREADY_ACTIVE_MESSAGE } = await import("../services/handoff");
const { default: sofiaRouter, handoffRouteTestHooks } = await import("./sofia");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

function textStream(content: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content }, finish_reason: "stop" }] };
    },
  };
}

function responseStream(content: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.created", response: { id: "handoff-route-test" } };
      yield { type: "response.output_text.delta", delta: content };
      yield { type: "response.completed", response: { id: "handoff-route-test" } };
    },
  };
}

function sseContent(text: string): string {
  return text.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as { content?: string })
    .map(event => event.content ?? "")
    .join("");
}

function modelCallCount(): number {
  return modelMocks.chatCreate.mock.calls.length + modelMocks.responsesCreate.mock.calls.length;
}

const conversationIds: number[] = [];
const personIds: number[] = [];

describe("Sofia sensitive handoff route", () => {
  beforeAll(() => {
    modelMocks.chatCreate.mockImplementation(async () => textStream("Que bom que você voltou. Como posso ajudar?"));
    modelMocks.responsesCreate.mockImplementation(async () => responseStream("Que bom que você voltou. Como posso ajudar?"));
  });

  afterEach(() => {
    handoffRouteTestHooks.beforePersistPreTrigger = null;
  });

  afterAll(async () => {
    if (conversationIds.length > 0) {
      await db.delete(decisionRuns).where(inArray(decisionRuns.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (personIds.length > 0) {
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL app.allow_evidencia_cascade_delete = 'on'`);
        await tx.delete(pessoasTable).where(inArray(pessoasTable.id, personIds));
      });
    }
  });

  it("persists, freezes, assumes, resolves, and resumes a sensitive handoff", async () => {
    const marker = randomUUID();
    const firstMessage = `Estou passando por um momento emocional muito difícil e me sinto desesperada. ${marker}`;
    const requestForTeam = "Preciso conversar com alguém da equipe agora.";
    const unrelatedEvidence = `interesse não mencionado nesta conversa ${marker}`;
    const [person] = await db.insert(pessoasTable).values({
      codigo: `HANDOFF-${marker}`,
      nome: "Pessoa Handoff",
    }).returning({ id: pessoasTable.id });
    if (!person) throw new Error("sensitive handoff person insert failed");
    personIds.push(person.id);
    await db.insert(pessoaEvidencias).values({
      pessoaId: person.id,
      campo: "servicoInteresse",
      valor: unrelatedEvidence,
      tipoEvidencia: "inferida",
      origem: "teste",
      nivelConfianca: "baixa",
    });
    const [conversation] = await db.insert(conversations).values({
      title: `sensitive-handoff-${marker}`,
      status: "ativa",
      pessoaId: person.id,
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("sensitive handoff conversation insert failed");
    conversationIds.push(conversation.id);
    const fillerMessages = Array.from({ length: 52 }, (_, index) => ([
      {
        conversationId: conversation.id,
        role: "user" as const,
        content: `Mensagem antiga ${index} ${marker}`,
        conduta: "triagem" as const,
      },
      {
        conversationId: conversation.id,
        role: "assistant" as const,
        content: `Resposta antiga ${index} ${marker}`,
        conduta: "triagem" as const,
      },
    ])).flat();
    await db.insert(messages).values([
      ...fillerMessages,
      { conversationId: conversation.id, role: "user", content: firstMessage, conduta: "triagem" },
      {
        conversationId: conversation.id,
        role: "assistant",
        content: "Sinto muito que você esteja passando por isso. Posso chamar nossa equipe.",
        conduta: "triagem",
      },
    ]);

    const invalidAssume = await request(app)
      .post(`/api/sofia/conversations/${conversation.id}/handoff/assume`);
    expect(invalidAssume.status).toBe(409);

    let enterPersistence!: () => void;
    const persistenceEntered = new Promise<void>(resolve => { enterPersistence = resolve; });
    let allowPersistence!: () => void;
    const persistenceAllowed = new Promise<void>(resolve => { allowPersistence = resolve; });
    handoffRouteTestHooks.beforePersistPreTrigger = async () => {
      enterPersistence();
      await persistenceAllowed;
    };

    const callsBeforeHandoff = modelCallCount();
    const handoffRequest = request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: requestForTeam,
    });
    const handoffPromise = handoffRequest.then(response => response);
    await persistenceEntered;
    const concurrentPromises = Array.from({ length: 12 }, (_, index) =>
      request(app).post("/api/sofia/chat").send({
        conversationId: conversation.id,
        message: `Esta mensagem concorrente ${index} não pode chamar a Sofia.`,
      })
    );
    allowPersistence();
    const [handoffResponse, ...concurrentResponses] = await Promise.all([
      handoffPromise,
      ...concurrentPromises,
    ]);
    handoffRouteTestHooks.beforePersistPreTrigger = null;
    const handoffAnswer = sseContent(handoffResponse.text);

    expect(handoffResponse.status).toBe(200);
    expect(concurrentResponses).toHaveLength(12);
    for (const concurrentResponse of concurrentResponses) {
      expect(concurrentResponse.status).toBe(200);
      expect(sseContent(concurrentResponse.text)).toBe(HANDOFF_ALREADY_ACTIVE_MESSAGE);
    }
    expect(modelCallCount()).toBe(callsBeforeHandoff);
    expect(handoffAnswer).toContain("equipe");
    expect(handoffAnswer).toContain("risco imediato");
    expect(handoffAnswer).toContain("188");
    expect(handoffAnswer).not.toMatch(/\b(diagnóstico|diagnosticar|prescrever|medicação)\b/i);

    const [waiting] = await db.select().from(conversations)
      .where(eq(conversations.id, conversation.id)).limit(1);
    expect(waiting).toMatchObject({
      status: "aguardando_humano",
      handoffReason: "tema_sensivel",
    });
    expect(waiting?.handoffTriggeredAt).toBeInstanceOf(Date);
    const summary = JSON.parse(waiting?.handoffSummary ?? "{}") as {
      contextoSensivel?: string;
      mensagemDisparadora?: string;
      evidenciasRelevantes?: string[];
    };
    expect(summary.contextoSensivel).toContain(firstMessage);
    expect(summary.contextoSensivel).toContain(requestForTeam);
    expect(summary.mensagemDisparadora).toBe(requestForTeam);
    expect(summary.evidenciasRelevantes?.join("\n")).toContain(firstMessage);
    expect(summary.evidenciasRelevantes?.join("\n")).toContain(requestForTeam);
    expect(summary.evidenciasRelevantes?.join("\n")).not.toContain(unrelatedEvidence);

    const frozenResponse = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: "Ainda preciso de ajuda.",
    });
    expect(sseContent(frozenResponse.text)).toBe(HANDOFF_ALREADY_ACTIVE_MESSAGE);
    expect(modelCallCount()).toBe(callsBeforeHandoff);

    const assumeResponse = await request(app)
      .post(`/api/sofia/conversations/${conversation.id}/handoff/assume`);
    expect(assumeResponse.status).toBe(200);
    expect(assumeResponse.body.status).toBe("atendimento_humano");

    const assumedFrozenResponse = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: "A equipe já viu minha mensagem?",
    });
    expect(sseContent(assumedFrozenResponse.text)).toBe(HANDOFF_ALREADY_ACTIVE_MESSAGE);
    expect(modelCallCount()).toBe(callsBeforeHandoff);

    const resolveResponse = await request(app)
      .post(`/api/sofia/conversations/${conversation.id}/handoff/resolve`);
    expect(resolveResponse.status).toBe(200);
    expect(resolveResponse.body).toMatchObject({
      status: "ativa",
      handoffResolvedBy: "Equipe Teste",
    });
    expect(resolveResponse.body.handoffResolvedAt).toBeTypeOf("string");
    const repeatedResolve = await request(app)
      .post(`/api/sofia/conversations/${conversation.id}/handoff/resolve`);
    expect(repeatedResolve.status).toBe(409);

    const resumedResponse = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: "Obrigada, já posso continuar.",
    });
    expect(resumedResponse.status).toBe(200);
    expect(sseContent(resumedResponse.text)).toContain("Que bom que você voltou");
    expect(modelCallCount()).toBeGreaterThan(callsBeforeHandoff);
  });

  it("keeps emotional safety above a simultaneous commercial request", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `sensitive-commercial-${marker}`,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("sensitive commercial conversation insert failed");
    conversationIds.push(conversation.id);
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "user",
      content: "Estou em um momento emocional muito difícil e me sinto desesperada.",
      conduta: "triagem",
    });

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: "Preciso conversar com alguém da equipe e também quero pagar o curso agora.",
    });
    expect(response.status).toBe(200);
    expect(sseContent(response.text)).toContain("188");

    const [updated] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversation.id)).limit(1);
    expect(updated).toEqual({
      status: "aguardando_humano",
      handoffReason: "tema_sensivel",
    });
  });

  it("hands off the exact sensitive QA scenario and keeps the conversation frozen", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `sensitive-qa-${marker}`,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("sensitive QA conversation insert failed");
    conversationIds.push(conversation.id);
    const callsBefore = modelCallCount();

    const firstResponse = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: "Estou em uma situação emocional muito sensível e preciso de orientação terapêutica agora. Quero falar com uma pessoa da equipe.",
    });
    expect(firstResponse.status).toBe(200);
    expect(sseContent(firstResponse.text)).toContain("equipe");
    expect(modelCallCount()).toBe(callsBefore);

    const [waiting] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversation.id)).limit(1);
    expect(waiting).toEqual({
      status: "aguardando_humano",
      handoffReason: "tema_sensivel",
    });

    const followUp = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      message: "Enquanto isso, pode continuar me orientando sozinha?",
    });
    expect(sseContent(followUp.text)).toBe(HANDOFF_ALREADY_ACTIVE_MESSAGE);
    expect(modelCallCount()).toBe(callsBefore);
  });
});