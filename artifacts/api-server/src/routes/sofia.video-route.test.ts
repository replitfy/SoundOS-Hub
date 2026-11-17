// Modo simples: vídeo vem de video_do_evento (video_eventos e, na falta,
// videos.curso), só aprovado, https e sem linguagem de cura, no máximo 2, sem
// pré-requisito. video_envios registra só o link que saiu no texto final. Os
// casos do modo legado ficam em sofia.video-route.legacy.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SOFIA_MODE = "simple";

const modelMocks = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }));
const catalogMock = vi.hoisted(() => ({ getOfficialEventCatalog: vi.fn() }));

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

const { db, conversations, videoEnvios, videoEventosTable, videosTable } = await import("@workspace/db");
const { default: sofiaRouter } = await import("./sofia");
const { installScript, parseSse } = await import("./testing/sofiaScriptedModel");
const { eventoChave } = await import("../services/sofiaTools/eventos");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

const marker = randomUUID().replace(/-/g, "").slice(0, 10);
const NOME_EVENTO = `VIVÊNCIA ${marker.toUpperCase()} - Imersão Sonora`;
const URL_EVENTO = `https://www.soundfulness.online/event-details/vivencia-${marker}`;
const CHAVE = eventoChave(NOME_EVENTO);
const link = (n: string) => `https://www.youtube.com/watch?v=${marker}${n}`;

const conversationIds: number[] = [];
const videoIds: number[] = [];

async function chat(message: string) {
  const res = await request(app).post("/api/sofia/chat").send({ message });
  const parsed = parseSse(res.text);
  if (parsed.done?.conversationId) conversationIds.push(parsed.done.conversationId);
  return parsed;
}

function toolOutputs(params: Record<string, unknown>): string[] {
  const input = (params.input ?? params.messages) as Array<{ type?: string; role?: string; output?: string; content?: string }>;
  return input.filter(i => i.type === "function_call_output" || i.role === "tool").map(i => i.output ?? i.content ?? "");
}

describe("Sofia modo simples — vídeos", () => {
  beforeAll(async () => {
    const inseridos = await db.insert(videosTable).values([
      { titulo: `Depoimento ${marker}`, tipo: "Depoimento", link: link("a"), temLinkReal: true, aprovadoParaSofia: true },
      { titulo: `Vivência oficial ${marker}`, tipo: "Video SFS", link: link("b"), temLinkReal: true, aprovadoParaSofia: true },
      { titulo: `Cura da ansiedade ${marker}`, tipo: "Video SFS", link: link("c"), temLinkReal: true, aprovadoParaSofia: true },
      { titulo: `Rascunho ${marker}`, tipo: "Video SFS", link: link("d"), temLinkReal: true, aprovadoParaSofia: false },
      { titulo: `Terceiro aprovado ${marker}`, tipo: "Depoimento", link: link("e"), temLinkReal: true, aprovadoParaSofia: true },
    ]).returning({ id: videosTable.id });
    videoIds.push(...inseridos.map(v => v.id));
    await db.insert(videoEventosTable).values(inseridos.map((v, ordem) => ({ videoId: v.id, eventoChave: CHAVE, ordem })));
  });

  beforeEach(() => {
    catalogMock.getOfficialEventCatalog.mockResolvedValue({
      source: { tables: ["cursos_inscricao", "classes", "courses"], fetchedAt: new Date().toISOString(), policy: "public_event_agenda" },
      items: [{
        eventId: 990, slug: `vivencia-${marker}`, name: NOME_EVENTO, description: "Imersão de som.", startDate: "2027-05-08",
        endDate: null, location: "São Paulo", nucleus: "education", eventType: "VIVENCIA", classId: null, courseId: null,
        modality: null, workload: null, price: null, sourceUrl: URL_EVENTO,
      }],
    });
  });

  afterAll(async () => {
    if (conversationIds.length > 0) {
      await db.delete(videoEnvios).where(inArray(videoEnvios.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (videoIds.length > 0) {
      await db.delete(videoEventosTable).where(inArray(videoEventosTable.videoId, videoIds));
      await db.delete(videosTable).where(inArray(videosTable.id, videoIds));
    }
  });

  it("evento + vídeo no mesmo turno: no máximo 2, só aprovados, sem cura, e registra o envio do link usado", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [
        { name: "detalhes_evento", args: { nome: `Vivência ${marker}` } },
        { name: "video_do_evento", args: { evento: `Vivência ${marker}` } },
      ] },
      { text: `A Vivência acontece em 08/05/2027, em São Paulo: ${URL_EVENTO}\n\n📹 *Vivência oficial ${marker}*\n${link("b")}` },
    ]);
    const { content, done } = await chat(`Me conta da Vivência ${marker}? Tem vídeo?`);

    const [, videoSaida] = toolOutputs(script.requests[1]!.params);
    const videos = (JSON.parse(videoSaida!) as { videos: Array<{ link: string; texto: string }> }).videos;
    expect(videos).toHaveLength(2);
    expect(videos[0]!.link).toBe(link("b"));
    expect(videos[0]!.texto).toBe(`📹 *Vivência oficial ${marker}*\n${link("b")}`);
    expect(videos.map(v => v.link)).not.toContain(link("c"));
    expect(videos.map(v => v.link)).not.toContain(link("d"));

    expect(content).toContain(link("b"));
    expect(content).toContain(URL_EVENTO);
    expect(content).not.toMatch(/pr[ée]-requisito/i);
    expect(done?.handoffTriggered).toBeUndefined();

    const envios = await db.select().from(videoEnvios).where(eq(videoEnvios.conversationId, done!.conversationId!));
    expect(envios.map(e => e.link)).toEqual([link("b")]);
    expect(envios[0]!.messageId).toBeTypeOf("number");
  });

  it("vídeo oferecido pela tool mas fora do texto final não é registrado", async () => {
    installScript(modelMocks, [
      { toolCalls: [{ name: "video_do_evento", args: { evento: `Vivência ${marker}` } }] },
      { text: `A Vivência é uma imersão de som. Inscrições: ${URL_EVENTO}` },
    ]);
    const { done } = await chat(`Tem vídeo da Vivência ${marker}?`);
    const envios = await db.select().from(videoEnvios).where(eq(videoEnvios.conversationId, done!.conversationId!));
    expect(envios).toHaveLength(0);
  });

  it("vídeo inventado pelo modelo é removido e não é registrado", async () => {
    installScript(modelMocks, [
      { toolCalls: [{ name: "video_do_evento", args: { evento: "Retiro inexistente" } }] },
      { text: "Olha esse vídeo: https://www.youtube.com/watch?v=inventado123 e me conta o que achou." },
    ]);
    const { content, done } = await chat("Tem vídeo do retiro?");
    expect(content).not.toContain("inventado123");
    expect(content).toContain("me conta o que achou");
    const envios = await db.select().from(videoEnvios).where(eq(videoEnvios.conversationId, done!.conversationId!));
    expect(envios).toHaveLength(0);
  });
});
