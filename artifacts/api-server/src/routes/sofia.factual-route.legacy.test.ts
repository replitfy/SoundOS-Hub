import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { desc, eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
// Rede de segurança do rollback: estes casos fixam o modo legado.
process.env.SOFIA_MODE = "legacy";

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const interesseMock = vi.hoisted(() => ({ interesseDoPedidoDeValor: vi.fn() }));
vi.mock("../services/sofiaTools/interesse", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/sofiaTools/interesse")>()),
  interesseDoPedidoDeValor: interesseMock.interesseDoPedidoDeValor,
}));

const {
  db,
  condutaConfigTable,
  conversations,
  coursesTable,
  cursosInscricao,
  decisionRuns,
  messages,
  pessoasTable,
} = await import("@workspace/db");
const { default: sofiaRouter, factualRouteTestHooks } = await import("./sofia");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

function sseContent(text: string): string {
  return text.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as { content?: string })
    .map(event => event.content ?? "")
    .join("");
}

const conversationIds: number[] = [];
let pessoaId: number;
let previousFastPathEnabled = false;

async function latestConversationByTitle(title: string) {
  const [conversation] = await db.select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.title, title))
    .orderBy(desc(conversations.id))
    .limit(1);
  if (!conversation) throw new Error(`conversation not found for ${title}`);
  conversationIds.push(conversation.id);
  return conversation.id;
}

describe("Sofia factual route integration", () => {
  beforeAll(async () => {
    const [config] = await db.select({ fastPathEnabled: condutaConfigTable.fastPathEnabled })
      .from(condutaConfigTable)
      .where(eq(condutaConfigTable.id, 1))
      .limit(1);
    previousFastPathEnabled = config?.fastPathEnabled ?? false;
    await db.update(condutaConfigTable)
      .set({ fastPathEnabled: true })
      .where(eq(condutaConfigTable.id, 1));

    const marker = randomUUID();
    const [person] = await db.insert(pessoasTable).values({
      codigo: `SOFIA-FACT-${marker}`,
      nome: `Sofia factual test ${marker}`,
    }).returning({ id: pessoasTable.id });
    if (!person) throw new Error("test person insert failed");
    pessoaId = person.id;
  });

  afterAll(async () => {
    factualRouteTestHooks.beforeDecisionRun = null;
    if (conversationIds.length > 0) {
      await db.delete(decisionRuns).where(inArray(decisionRuns.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (pessoaId) await db.delete(pessoasTable).where(eq(pessoasTable.id, pessoaId));
    await db.update(condutaConfigTable)
      .set({ fastPathEnabled: previousFastPathEnabled })
      .where(eq(condutaConfigTable.id, 1));
  });

  it("persists ANSWER_FACT with all real commercial gates before returning SSE", async () => {
    const message = `O que é o Ciclo Água presencial? ${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });
    expect(response.status).toBe(200);
    expect(response.text).toContain("Ciclo Água Presencial");

    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [run] = await db.select({
      messageId: decisionRuns.messageId,
      metadata: decisionRuns.metadata,
    }).from(decisionRuns)
      .where(eq(decisionRuns.conversationId, conversationId))
      .orderBy(desc(decisionRuns.id))
      .limit(1);
    expect(run?.messageId).toBeTypeOf("number");
    expect(run?.metadata?.nba_code).toBe("ANSWER_FACT");
    expect((run?.metadata?.gates as { commercial?: unknown[] })?.commercial).toHaveLength(4);
  });

  it("emits and persists no factual assistant response when real route audit fails", async () => {
    const message = `O que é o Ciclo Fogo presencial? ${randomUUID()}`;
    factualRouteTestHooks.beforeDecisionRun = () => {
      throw new Error("forced decision audit failure");
    };

    let responseText = "";
    try {
      const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });
      responseText = response.text;
    } catch {
      // Express may abort because SSE headers were already established.
    } finally {
      factualRouteTestHooks.beforeDecisionRun = null;
    }
    expect(responseText).not.toContain("Ciclo Fogo Presencial:");

    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const persisted = await db.select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(persisted.some(row => row.role === "assistant" && row.content.includes("Ciclo Fogo Presencial:"))).toBe(false);
    const runs = await db.select({ id: decisionRuns.id })
      .from(decisionRuns)
      .where(eq(decisionRuns.conversationId, conversationId));
    expect(runs).toHaveLength(0);
  });

  it("replays conversation 209 by answering the repeated next-course request before triage", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `replay-209-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("replay conversation insert failed");
    conversationIds.push(conversation.id);
    await db.insert(messages).values([
      { conversationId: conversation.id, role: "user", content: "Quero saber qual é o próximo evento?", conduta: "triagem" },
      { conversationId: conversation.id, role: "assistant", content: "Qual tipo de evento você está buscando?", conduta: "triagem" },
      { conversationId: conversation.id, role: "user", content: "curso", conduta: "triagem" },
      { conversationId: conversation.id, role: "assistant", content: "Você busca um curso para quê exatamente?", conduta: "triagem" },
    ]);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Quero informações sobre o próximo curso presencial em São Paulo",
    });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte:");
    expect(response.text).not.toContain("para quê");
    expect(response.text).not.toContain("conectar com alguém");

    const [persistedConversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversation.id)).limit(1);
    expect(persistedConversation).toEqual({ status: "ativa", handoffReason: null });

    const [run] = await db.select({ metadata: decisionRuns.metadata })
      .from(decisionRuns)
      .where(eq(decisionRuns.conversationId, conversation.id))
      .orderBy(desc(decisionRuns.id))
      .limit(1);
    expect(run?.metadata).toMatchObject({
      nba_code: "ANSWER_FACT",
      result: "success",
      intent: "upcoming_offering",
      repeated_request: true,
      offering_kind: "course",
      filters: { modality: "presencial", location: "São Paulo" },
    });
  });

  it("answers an unqualified next-event request from structured official data", async () => {
    const message = "vim saber do proximo evento";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toMatch(/CICLO AR/i);
    expect(response.text).not.toContain("Fonte:");
    expect(response.text).not.toContain("Paraná");
    expect(response.text).not.toContain("qual tipo");
    await latestConversationByTitle(message.slice(0, 60).trim());
  });

  it("answers short date continuations from the latest named event and keeps archived events private", async () => {
    const marker = randomUUID();
    const activeName = `Ciclo da Água ${marker}`;
    const secondActiveName = `Ciclo do Sol ${marker}`;
    const archivedName = `Ciclo da Terra ${marker}`;
    const [contextCourse] = await db.insert(coursesTable).values({
      name: `Curso de contexto ${marker}`,
      cycle: "Contexto",
      modality: "Presencial",
      workload: 1,
      price: "1.00",
      description: "Curso usado para validar modalidade no contexto.",
      active: true,
    }).returning({ id: coursesTable.id });
    if (!contextCourse) throw new Error("context course insert failed");
    const insertedEvents = await db.insert(cursosInscricao).values([
      {
        slug: `ciclo-agua-${marker}`,
        nome: activeName,
        dataInicio: "2099-05-17",
        ativo: true,
        tipoEvento: "CURSO",
        courseId: contextCourse.id,
      },
      {
        slug: `ciclo-sol-${marker}`,
        nome: secondActiveName,
        dataInicio: "2099-05-24",
        ativo: true,
        tipoEvento: "CURSO",
      },
      {
        slug: `ciclo-terra-${marker}`,
        nome: archivedName,
        dataInicio: "2099-06-21",
        ativo: false,
        tipoEvento: "CURSO",
      },
    ]).returning({ id: cursosInscricao.id });

    try {
      const [activeConversation] = await db.insert(conversations).values({
        title: `contextual-active-${marker}`,
        pessoaId,
        status: "ativa",
      }).returning({ id: conversations.id });
      if (!activeConversation) throw new Error("active contextual conversation insert failed");
      conversationIds.push(activeConversation.id);
      await db.insert(messages).values([
        {
          conversationId: activeConversation.id,
          role: "user",
          content: `Quando é o Retiro anterior ${marker}?`,
          conduta: "triagem",
        },
        {
          conversationId: activeConversation.id,
          role: "assistant",
          content: "Qual outro evento você quer consultar?",
          conduta: "triagem",
        },
        {
          conversationId: activeConversation.id,
          role: "user",
          content: `e o ciclo da água ${marker}`,
          conduta: "triagem",
        },
        {
          conversationId: activeConversation.id,
          role: "assistant",
          content: "Quais informações você procura?",
          conduta: "triagem",
        },
      ]);

      const activeResponse = await request(app).post("/api/sofia/chat").send({
        conversationId: activeConversation.id,
        pessoaId,
        message: "quais são as datas",
      });
      expect(activeResponse.status).toBe(200);
      expect(activeResponse.text).toContain(activeName);
      expect(activeResponse.text).toContain("17/05/2099");
      expect(activeResponse.text).not.toContain("Retiro anterior");

      const explicitSwitchResponse = await request(app).post("/api/sofia/chat").send({
        conversationId: activeConversation.id,
        pessoaId,
        message: `Quando acontece o ${secondActiveName}?`,
      });
      expect(explicitSwitchResponse.status).toBe(200);
      expect(explicitSwitchResponse.text).toContain(secondActiveName);
      expect(explicitSwitchResponse.text).toContain("24/05/2099");
      expect(explicitSwitchResponse.text).not.toContain(activeName);
      expect(explicitSwitchResponse.text).not.toContain("17/05/2099");

      const [resolvedByAssistantConversation] = await db.insert(conversations).values({
        title: `assistant-resolved-${marker}`,
        pessoaId,
        status: "ativa",
      }).returning({ id: conversations.id });
      if (!resolvedByAssistantConversation) throw new Error("assistant-resolved conversation insert failed");
      conversationIds.push(resolvedByAssistantConversation.id);
      await db.insert(messages).values([
        {
          conversationId: resolvedByAssistantConversation.id,
          role: "user",
          content: "Qual é o próximo curso ou evento presencial da Soundfulness?",
          conduta: "triagem",
        },
        {
          conversationId: resolvedByAssistantConversation.id,
          role: "assistant",
          content: [
            "A próxima opção encontrada é:",
            `${activeName} — Data: 17/05/2099 — Modalidade: Presencial`,
            "Fonte: agenda oficial de Eventos.",
          ].join("\n"),
          conduta: "triagem",
        },
      ]);

      const locationFollowUp = await request(app).post("/api/sofia/chat").send({
        conversationId: resolvedByAssistantConversation.id,
        pessoaId,
        message: "E onde acontece? Tem link oficial?",
      });
      expect(locationFollowUp.status).toBe(200);
      expect(sseContent(locationFollowUp.text)).toBe(
        "Local: ainda não informado.\nLink oficial: ainda não informado.",
      );
      expect(locationFollowUp.text).not.toContain(activeName);
      expect(locationFollowUp.text).not.toContain("17/05/2099");
      expect(locationFollowUp.text).not.toContain("http");
      expect(locationFollowUp.text).not.toContain("Fonte:");

      const repeatFollowUp = await request(app).post("/api/sofia/chat").send({
        conversationId: resolvedByAssistantConversation.id,
        pessoaId,
        message: "Repita só o nome e a data.",
      });
      expect(repeatFollowUp.status).toBe(200);
      expect(sseContent(repeatFollowUp.text)).toBe(`${activeName}\nData: 17/05/2099`);
      expect(repeatFollowUp.text).not.toContain("Local:");
      expect(repeatFollowUp.text).not.toContain("Modalidade:");
      expect(repeatFollowUp.text).not.toContain("Fonte:");
      expect(repeatFollowUp.text).not.toContain("passo necessário");

      const [archivedConversation] = await db.insert(conversations).values({
        title: `contextual-archived-${marker}`,
        pessoaId,
        status: "ativa",
      }).returning({ id: conversations.id });
      if (!archivedConversation) throw new Error("archived contextual conversation insert failed");
      conversationIds.push(archivedConversation.id);
      await db.insert(messages).values([
        {
          conversationId: archivedConversation.id,
          role: "user",
          content: `Quero informações sobre o evento ${marker}`,
          conduta: "triagem",
        },
        {
          conversationId: archivedConversation.id,
          role: "assistant",
          content: "Qual evento?",
          conduta: "triagem",
        },
        {
          conversationId: archivedConversation.id,
          role: "user",
          content: `e o ciclo da terra ${marker}`,
          conduta: "triagem",
        },
      ]);

      const archivedResponse = await request(app).post("/api/sofia/chat").send({
        conversationId: archivedConversation.id,
        pessoaId,
        message: "quais são as datas",
      });
      expect(archivedResponse.status).toBe(200);
      expect(archivedResponse.text).toContain("Não há data publicada");
      expect(archivedResponse.text).not.toContain("21/06/2099");
    } finally {
      if (insertedEvents.length > 0) {
        await db.delete(cursosInscricao).where(inArray(
          cursosInscricao.id,
          insertedEvents.map(event => event.id),
        ));
      }
      await db.delete(coursesTable).where(eq(coursesTable.id, contextCourse.id));
    }
  });

  it.each([
    "qual é o próximo evento que vai acontecer?",
    "qual é o próximo evento disponível?",
    "qual é o próximo evento da agenda?",
  ])("keeps generic next-event wording on the unfiltered official agenda: %s", async question => {
    const message = `${question} ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toMatch(/CICLO AR/i);
    expect(response.text).not.toContain("Fonte:");
    expect(response.text).not.toContain("Não encontrei evento futuro");
    await latestConversationByTitle(message.slice(0, 60).trim());
  });

  it("keeps explicit-human safety precedence above a factual request", async () => {
    const message = `Quero falar com um atendente humano sobre o próximo curso ${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte: tabelas oficiais de turmas e cursos.");
    expect(response.text).toContain("equipe");

    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [conversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(conversation).toEqual({ status: "aguardando_humano", handoffReason: "pedido_explicito" });
  });

  it("audits an official factual answer even before the conversation has a pessoa", async () => {
    const message = `Quando é o próximo evento? anon-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte:");
    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [run] = await db.select({
      pessoaId: decisionRuns.pessoaId,
      messageId: decisionRuns.messageId,
      metadata: decisionRuns.metadata,
    }).from(decisionRuns)
      .where(eq(decisionRuns.conversationId, conversationId))
      .limit(1);
    expect(run).toMatchObject({
      pessoaId: null,
      metadata: { nba_code: "ANSWER_FACT", intent: "upcoming_offering" },
    });
    expect(run?.messageId).toBeTypeOf("number");
  });

  it.each([
    {
      question: "Qual o conteúdo da Formação Avançada?",
      expected: ["Formação Avançada", "Sobre: Aprofundamento em técnicas terapêuticas avançadas."],
      omitted: ["29/10/2026", "Local:", "Valor:"],
    },
    {
      question: "Onde acontece a Formação Avançada?",
      expected: ["Local: Vila Mariana — São Paulo – SP"],
      omitted: ["29/10/2026", "Modalidade:", "Valor:"],
    },
    {
      question: "Qual o preço da Formação Avançada?",
      expected: ["Formação Avançada", "Valor: o time interno informa valores e condições."],
      omitted: ["29/10/2026", "Local:", "Sobre:", "R$", "4.800"],
    },
    {
      question: "Quando é a Formação Avançada?",
      expected: ["Formação Avançada", "Data: 29/10/2026"],
      omitted: ["Local:", "Sobre:", "Valor:"],
    },
  ])("answers only the requested fact from the matching official row: $question", async ({
    question,
    expected,
    omitted,
  }) => {
    const message = `${question} ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    for (const value of expected) expect(answer).toContain(value);
    for (const value of omitted) expect(answer).not.toContain(value);
    expect(answer).not.toContain("Retiro de Imersão");
    expect(answer).not.toContain("Formação Básica");
    expect(answer).not.toContain("Fonte:");
    await latestConversationByTitle(message.slice(0, 60).trim());
  });

  it("does not substitute an unknown named course with the globally next offering", async () => {
    const message = `Qual o conteúdo do curso de Sound Healing? ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toContain("Não encontrei");
    expect(response.text).not.toContain("Formação Avançada");
    expect(response.text).not.toContain("Retiro de Imersão");
    await latestConversationByTitle(message.slice(0, 60).trim());
  });

  it("never states a retreat price and does not hand off for a price question", async () => {
    const message = `Qual é o preço do próximo retiro? ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toContain("Retiro de Imersão");
    expect(response.text).toContain("Valor: o time interno informa valores e condições.");
    expect(response.text).not.toContain("R$");
    expect(response.text).not.toContain("1.800");
    expect(response.text).not.toContain("conectar com alguém");
    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [conversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(conversation).toEqual({ status: "ativa", handoffReason: null });
  });

  it("a price question gets the interest link and the pessoa/conversation reach the interest flow", async () => {
    const link = "https://soundfulness.net/interesse/retiro-de-imersao-interesse";
    interesseMock.interesseDoPedidoDeValor.mockResolvedValueOnce(
      `Para agilizar, deixe seu interesse no cadastro da edição de 29/10/2026: ${link}`,
    );
    const message = `Qual é o preço do próximo retiro? ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toContain("Valor: o time interno informa valores e condições.");
    expect(response.text).toContain(link);
    expect(response.text).not.toContain("R$");
    expect(interesseMock.interesseDoPedidoDeValor).toHaveBeenCalledWith(expect.objectContaining({ pessoaId }));
    await latestConversationByTitle(message.slice(0, 60).trim());
  });

  it("answers stable official facts for an active course without a future class, without its price", async () => {
    const marker = randomUUID();
    const courseName = `Curso Catálogo ${marker}`;
    const [course] = await db.insert(coursesTable).values({
      name: courseName,
      cycle: "Catálogo",
      modality: "Online",
      workload: 12,
      price: "350.00",
      description: "Conteúdo oficial sem turma futura.",
      active: true,
    }).returning({ id: coursesTable.id });
    if (!course) throw new Error("catalog-only course insert failed");
    try {
      const message = `Qual o preço do ${courseName}?`;
      const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

      expect(response.status).toBe(200);
      expect(response.text).toContain(courseName);
      expect(response.text).toContain("Valor: o time interno informa valores e condições.");
      expect(response.text).not.toContain("R$");
      expect(response.text).not.toContain("350,00");
      expect(response.text).not.toContain("Data:");
      expect(response.text).not.toContain("Formação Avançada");
      await latestConversationByTitle(message.slice(0, 60).trim());
    } finally {
      await db.delete(coursesTable).where(eq(coursesTable.id, course.id));
    }
  });

  it.each([
    "Quero fazer a inscrição no curso Formação Avançada",
    "Quero realizar minha inscrição na Formação Avançada",
  ])("hands enrollment actions to a human while factual availability stays autonomous: %s", async requestText => {
    const message = `${requestText} ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte: tabelas oficiais de turmas e cursos.");
    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [conversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(conversation).toEqual({
      status: "aguardando_humano",
      handoffReason: "informacao_comercial_bloqueada",
    });
  });

  it.each([
    "Quero comprar o curso Formação Avançada, qual é o preço?",
    "Gostaria de comprar o curso Formação Avançada. Qual é o preço?",
    "Pode fechar o curso Formação Avançada para mim? Qual é o preço?",
    "Adquira o próximo curso para mim",
    "Adquira o próximo curso",
    "Contrate o próximo curso",
    "Pague o próximo curso",
    "Compre o curso Formação Avançada. Qual é o preço?",
    "Faça minha matrícula no próximo curso",
    "Pode reservar minha vaga no próximo curso para mim?",
    "Pode fazer minha matrícula no próximo curso?",
    "Gostaria de confirmar minha matrícula no próximo curso",
  ])("hands a course purchase request to a human even when it also asks a fact: %s", async requestText => {
    const message = `${requestText} ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte: tabelas oficiais de turmas e cursos.");
    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [conversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(conversation).toEqual({
      status: "aguardando_humano",
      handoffReason: "informacao_comercial_bloqueada",
    });
  });

  it.each([
    "Quero comprar o próximo retiro",
    "Gostaria de comprar o próximo retiro",
    "Pode fechar o próximo retiro para mim?",
    "Feche o próximo retiro",
    "Poderia reservar o próximo retiro para mim?",
  ])("does not use the factual-sensitive exception for a retreat transaction: %s", async requestText => {
    const message = `${requestText} ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte: tabelas oficiais de turmas e cursos.");
    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [conversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(conversation).toEqual({
      status: "aguardando_humano",
      handoffReason: "informacao_comercial_bloqueada",
    });
  });

  it.each([
    "Qual o preço e as condições especiais do próximo retiro?",
    "Qual o desconto e o preço do próximo retiro?",
    "Qual o preço e o parcelamento do próximo retiro?",
    "Qual o preço e o checkout do próximo retiro?",
  ])("does not apply the sensitive factual exception to restricted mixed requests: %s", async requestText => {
    const message = `${requestText} ref-${randomUUID()}`;
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("Fonte: tabelas oficiais de turmas e cursos.");
    const conversationId = await latestConversationByTitle(message.slice(0, 60).trim());
    const [conversation] = await db.select({
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(conversation).toEqual({
      status: "aguardando_humano",
      handoffReason: "informacao_comercial_bloqueada",
    });
  });
});