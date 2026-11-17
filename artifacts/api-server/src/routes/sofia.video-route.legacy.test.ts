import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
// Rede de segurança do rollback: estes casos fixam o modo legado.
process.env.SOFIA_MODE = "legacy";

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/evidencias", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/evidencias")>();
  return { ...actual, registrarEvidencia: vi.fn(async () => undefined) };
});

const PROMISE_WITHOUT_DELIVERY = "Vou buscar um vídeo oficial para você e já te envio.";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              choices: [{
                delta: { content: PROMISE_WITHOUT_DELIVERY },
                finish_reason: "stop",
              }],
            };
          },
        })),
      },
    },
    responses: {
      create: vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "response.created", response: { id: "video-response-test" } };
          yield { type: "response.output_text.delta", delta: PROMISE_WITHOUT_DELIVERY };
          yield { type: "response.completed", response: { id: "video-response-test" } };
        },
      })),
    },
  },
}));

const {
  conversations,
  db,
  decisionRuns,
  messages,
  pessoasTable,
  videoEnvios,
  videosTable,
} = await import("@workspace/db");
const { registrarEvidencia } = await import("../services/evidencias");
const { default: sofiaRouter } = await import("./sofia");

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
const videoIds: number[] = [];
let pessoaId: number;

describe("Sofia video delivery route", () => {
  beforeAll(async () => {
    const marker = randomUUID();
    const [person] = await db.insert(pessoasTable).values({
      codigo: `SOFIA-VIDEO-${marker}`,
      nome: `Sofia video test ${marker}`,
    }).returning({ id: pessoasTable.id });
    if (!person) throw new Error("video test person insert failed");
    pessoaId = person.id;
  });

  afterAll(async () => {
    if (conversationIds.length > 0) {
      await db.delete(decisionRuns).where(inArray(decisionRuns.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (videoIds.length > 0) {
      await db.delete(videosTable).where(inArray(videosTable.id, videoIds));
    }
    if (pessoaId) await db.delete(pessoasTable).where(eq(pessoasTable.id, pessoaId));
  });

  it("delivers and records an approved matching video even when the model only promises one", async () => {
    const marker = randomUUID();
    const course = `Formação Aurora ${marker}`;
    const title = `Conheça a Formação Aurora ${marker}`;
    const link = `https://www.youtube.com/watch?v=${marker.replaceAll("-", "").slice(0, 11)}`;
    const [video] = await db.insert(videosTable).values({
      titulo: title,
      curso: course,
      tipo: "Apresentação",
      link,
      temLinkReal: true,
      aprovadoParaSofia: true,
    }).returning({ id: videosTable.id });
    if (!video) throw new Error("approved video insert failed");
    videoIds.push(video.id);

    const [conversation] = await db.insert(conversations).values({
      title: `video-delivery-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("video conversation insert failed");
    conversationIds.push(conversation.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: "user",
        content: `Quero entender melhor a ${course}.`,
        conduta: "triagem",
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        content: `Posso explicar essa formação e compartilhar materiais aprovados.`,
        conduta: "triagem",
      },
    ]);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Tem algum vídeo para eu entender melhor essa formação?",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain(title);
    expect(answer).toContain(link);
    expect(answer).not.toContain(PROMISE_WITHOUT_DELIVERY);

    const sends = await db.select().from(videoEnvios)
      .where(eq(videoEnvios.conversationId, conversation.id));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      pessoaId,
      conversationId: conversation.id,
      videoId: video.id,
      titulo: title,
      link,
      curso: course,
    });
    expect(sends[0]?.messageId).not.toBeNull();
  });

  it("answers a direct video request without replacing it with module eligibility", async () => {
    const marker = randomUUID();
    const course = `Curso Fogo ${marker}`;
    const title = `Introdução ao Fogo ${marker}`;
    const link = `https://www.youtube.com/watch?v=${marker.replaceAll("-", "").slice(0, 11)}`;
    const [video] = await db.insert(videosTable).values({
      codigo: `FOGO-${marker}`,
      titulo: title,
      curso: course,
      tipo: "Apresentação",
      link,
      temLinkReal: true,
      aprovadoParaSofia: true,
    }).returning({ id: videosTable.id });
    if (!video) throw new Error("blocked video insert failed");
    videoIds.push(video.id);

    const [conversation] = await db.insert(conversations).values({
      title: `video-blocked-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("blocked video conversation insert failed");
    conversationIds.push(conversation.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: "user",
        content: `Quero entender melhor o ${course}.`,
        conduta: "triagem",
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        content: "Entendi qual módulo você quer conhecer.",
        conduta: "triagem",
      },
    ]);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Me envie um vídeo para entender melhor esse módulo.",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain("Encontrei estes vídeos aprovados");
    expect(answer).toContain("http");
    expect(answer).not.toContain("passo necessário antes é Água");

    const sends = await db.select().from(videoEnvios)
      .where(eq(videoEnvios.conversationId, conversation.id));
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.every(send =>
      send.pessoaId === pessoaId &&
      send.conversationId === conversation.id &&
      Boolean(send.titulo) &&
      Boolean(send.link),
    )).toBe(true);
  });

  it("treats a fresh nominal breathing-video request as informational despite adversarial Fogo model text", async () => {
    const marker = randomUUID();
    const title = `Prática de respiração consciente ${marker}`;
    const link = `https://www.youtube.com/watch?v=bre${marker.replaceAll("-", "").slice(0, 8)}`;
    const [video] = await db.insert(videosTable).values({
      codigo: `BREATH-${marker}`,
      titulo: title,
      curso: `Curso Fogo ${marker}`,
      tipo: "Prática",
      link,
      temLinkReal: true,
      aprovadoParaSofia: true,
    }).returning({ id: videosTable.id });
    if (!video) throw new Error("breathing video insert failed");
    videoIds.push(video.id);

    const [conversation] = await db.insert(conversations).values({
      title: `video-fresh-breathing-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("fresh breathing conversation insert failed");
    conversationIds.push(conversation.id);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "vídeo de prática de respiração consciente",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain(link);
    expect(answer).not.toContain("passo necessário antes é Água");
    expect(answer).not.toContain(PROMISE_WITHOUT_DELIVERY);
  });

  it("does not let an Água denial hide an explicit informational video request in the same message", async () => {
    const marker = randomUUID();
    const title = `Respiração serena guiada ${marker}`;
    const link = `https://www.youtube.com/watch?v=ser${marker.replaceAll("-", "").slice(0, 8)}`;
    const [video] = await db.insert(videosTable).values({
      codigo: `SERENE-${marker}`,
      titulo: title,
      curso: `Respiração serena ${marker}`,
      tipo: "Prática",
      link,
      temLinkReal: true,
      aprovadoParaSofia: true,
    }).returning({ id: videosTable.id });
    if (!video) throw new Error("same-message informational video insert failed");
    videoIds.push(video.id);

    const [conversation] = await db.insert(conversations).values({
      title: `video-with-denial-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("same-message informational conversation insert failed");
    conversationIds.push(conversation.id);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: `Nunca fiz Água, quero um vídeo introdutório de prática de respiração serena ${marker}`,
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain(link);
    expect(answer).not.toContain("continua bloqueado");
    expect(answer).not.toContain("passo necessário");
  });

  it("acknowledges a denied Água prerequisite and answers the first-step follow-up without looping", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `eligibility-denial-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("eligibility conversation insert failed");
    conversationIds.push(conversation.id);

    const first = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Posso fazer o Ciclo Fogo mesmo nunca tendo feito nenhum ciclo?",
    });
    const denied = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Nunca fiz o módulo Água",
    });
    const firstStep = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Ainda não fiz o Água, o que preciso fazer primeiro?",
    });
    const firstAnswer = sseContent(first.text);
    const deniedAnswer = sseContent(denied.text);
    const firstStepAnswer = sseContent(firstStep.text);

    expect(firstAnswer).toContain("Você já concluiu Água?");
    expect(deniedAnswer).toContain("Água ainda não foi concluído");
    expect(deniedAnswer).toContain("Fogo continua bloqueado");
    expect(firstStepAnswer).toContain("O primeiro passo é fazer o módulo Água");
    expect(firstStepAnswer).not.toBe(deniedAnswer);
    expect(firstStepAnswer).not.toContain("Você já concluiu Água?");
  });

  it("routes a denied Fogo module through its first unmet recorded prerequisite", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `eligibility-denied-fogo-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("denied Fogo conversation insert failed");
    conversationIds.push(conversation.id);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Nunca fiz Fogo, mas concluí Água",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain("Água ainda não foi concluído");
    expect(answer).toContain("Fogo continua bloqueado");
    expect(answer).toContain("caminho começa pelo módulo Água");
    expect(answer).not.toContain("caminho começa pelo módulo Fogo");
  });

  it("does not infer an Água intent from a bare denial without a target or first-step request", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `eligibility-bare-denial-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("bare denial conversation insert failed");
    conversationIds.push(conversation.id);
    vi.mocked(registrarEvidencia).mockClear();

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Nunca fiz o módulo Água",
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(registrarEvidencia)).not.toHaveBeenCalled();
  });

  it("recovers Terra as the target from the latest explicit user intent, not assistant prerequisite names", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `eligibility-terra-target-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("Terra target conversation insert failed");
    conversationIds.push(conversation.id);

    await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Posso fazer o módulo Terra?",
    });
    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Nunca fiz o módulo Água",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain("Terra continua bloqueado");
    expect(answer).not.toContain("Fogo continua bloqueado");
  });

  it("asks for clarification instead of contradicting a verified completion", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `eligibility-verified-conflict-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("verified conflict conversation insert failed");
    conversationIds.push(conversation.id);

    await db.update(pessoasTable)
      .set({ fogoPresencial: "concluído" })
      .where(eq(pessoasTable.id, pessoaId));
    try {
      const response = await request(app).post("/api/sofia/chat").send({
        conversationId: conversation.id,
        pessoaId,
        message: "Nunca fiz o módulo Fogo",
      });
      const answer = sseContent(response.text);

      expect(response.status).toBe(200);
      expect(answer).toContain("Fogo consta como concluído");
      expect(answer).toContain("divergência");
      expect(answer).not.toContain("caminho começa");
    } finally {
      await db.update(pessoasTable)
        .set({ fogoPresencial: null })
        .where(eq(pessoasTable.id, pessoaId));
    }
  });

  it.each([
    "vocês têm joão da silva?",
    "Vocês têm João?",
  ])("keeps an ambiguous person-shaped availability query outside product not-found: %s", async message => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `ambiguous-person-availability-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("ambiguous availability conversation insert failed");
    conversationIds.push(conversation.id);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message,
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain("pessoa ou um produto");
    expect(answer).not.toContain("não existe no catálogo");
  });

  it("uses the latest formation topic and does not send a stale-topic video", async () => {
    const marker = randomUUID();
    const oldCourse = `Programa Solar ${marker}`;
    const currentCourse = `Programa Lunar ${marker}`;
    const oldLink = `https://www.youtube.com/watch?v=old${marker.replaceAll("-", "").slice(0, 8)}`;
    const currentLink = `https://www.youtube.com/watch?v=new${marker.replaceAll("-", "").slice(0, 8)}`;
    const inserted = await db.insert(videosTable).values([
      {
        codigo: `OLD-${marker}`,
        titulo: `Vídeo do tema anterior ${marker}`,
        curso: oldCourse,
        tipo: "Apresentação",
        link: oldLink,
        temLinkReal: true,
        aprovadoParaSofia: true,
      },
      {
        codigo: `CURRENT-${marker}`,
        titulo: `Vídeo do tema atual ${marker}`,
        curso: currentCourse,
        tipo: "Apresentação",
        link: currentLink,
        temLinkReal: true,
        aprovadoParaSofia: true,
      },
    ]).returning({ id: videosTable.id });
    videoIds.push(...inserted.map(video => video.id));

    const [conversation] = await db.insert(conversations).values({
      title: `video-latest-topic-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("latest-topic conversation insert failed");
    conversationIds.push(conversation.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: "user",
        content: `Primeiro eu estava vendo o ${oldCourse}.`,
        conduta: "triagem",
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        content: `Anotei o interesse no ${oldCourse}.`,
        conduta: "triagem",
      },
      {
        conversationId: conversation.id,
        role: "user",
        content: `Agora quero conhecer o ${currentCourse}.`,
        conduta: "triagem",
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        content: `Certo, vamos falar do ${currentCourse}.`,
        conduta: "triagem",
      },
    ]);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Tem algum vídeo para eu entender melhor esse programa?",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain(currentLink);
    expect(answer).not.toContain(oldLink);

    const sends = await db.select().from(videoEnvios)
      .where(eq(videoEnvios.conversationId, conversation.id));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ link: currentLink, pessoaId, videoId: inserted[1]?.id });
  });

  it("answers transparently and records nothing when no approved video matches", async () => {
    const marker = randomUUID();
    const [conversation] = await db.insert(conversations).values({
      title: `video-empty-${marker}`,
      pessoaId,
      status: "ativa",
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("empty video conversation insert failed");
    conversationIds.push(conversation.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: "user",
        content: `Quero entender melhor o Programa Lunar Inexistente ${marker}.`,
        conduta: "triagem",
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        content: "Entendi qual formação você quer conhecer.",
        conduta: "triagem",
      },
    ]);

    const response = await request(app).post("/api/sofia/chat").send({
      conversationId: conversation.id,
      pessoaId,
      message: "Me envie um vídeo para conhecer melhor esse programa.",
    });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain("Não encontrei um vídeo aprovado e compatível");
    expect(answer).not.toContain(PROMISE_WITHOUT_DELIVERY);

    const sends = await db.select().from(videoEnvios)
      .where(eq(videoEnvios.conversationId, conversation.id));
    expect(sends).toHaveLength(0);
  });
});