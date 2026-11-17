// Aviso de conversas do WhatsApp/Instagram aguardando a equipe: só canais externos em
// "aguardando_humano" contam, e a conversa sai da contagem quando alguém assume ou resolve.
// Banco de dev real; as conversas do teste levam um marcador no título e são apagadas no fim.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { inArray, like } from "drizzle-orm";

process.env.NODE_ENV = "test";

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = { id: "staff-test", name: "Equipe Teste", role: "admin" };
    next();
  },
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { db, conversations, canalEnvios, messages } = await import("@workspace/db");
const { default: sofiaRouter } = await import("./sofia");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

const marker = randomUUID().slice(0, 8);
const URL_AVISO = "/api/sofia/conversations/awaiting-staff";

type NovaConversa = Partial<typeof conversations.$inferInsert> & { rotulo: string };
async function criar({ rotulo, ...valores }: NovaConversa) {
  const [c] = await db.insert(conversations).values({ title: `${rotulo} ${marker}`, model: "teste", ...valores }).returning();
  return c!;
}

interface Resumo {
  total: number;
  respostasNaoEntregues: number;
  oldestWaitingSince: string | null;
  conversations: Array<{ id: number; title: string; canal: string; canalUsuario: string | null; waitingSince: string }>;
}
async function resumo(): Promise<Resumo> {
  const res = await request(app).get(URL_AVISO);
  expect(res.status).toBe(200);
  return res.body as Resumo;
}

describe("conversas aguardando a equipe", () => {
  afterAll(async () => {
    await db.delete(conversations).where(like(conversations.title, `% ${marker}`));
  });

  it("oculta e restaura sem apagar mensagens; lista padrão e aviso excluem ocultas", async () => {
    const c = await criar({ rotulo: "Visibilidade", canal: "whatsapp", status: "aguardando_humano" });
    const [msg] = await db.insert(messages).values({
      conversationId: c.id, role: "user", content: "Histórico de teste preservado",
    }).returning();
    const mudar = (hidden: boolean) => request(app).patch(`/api/sofia/conversations/${c.id}/visibility`).send({ hidden });
    expect((await mudar(true)).status).toBe(204);
    const padrao = await request(app).get("/api/sofia/conversations");
    expect(padrao.body.some((row: { id: number }) => row.id === c.id)).toBe(false);
    const todas = await request(app).get("/api/sofia/conversations?includeHidden=true");
    expect(todas.body.find((row: { id: number }) => row.id === c.id)).toMatchObject({ hidden: true, status: "aguardando_humano" });
    expect((await resumo()).conversations.some(row => row.id === c.id)).toBe(false);
    const historico = await request(app).get(`/api/sofia/conversations/${c.id}/messages`);
    expect(historico.body.some((row: { id: number }) => row.id === msg!.id)).toBe(true);
    expect((await mudar(false)).status).toBe(204);
    const restauradas = await request(app).get("/api/sofia/conversations");
    expect(restauradas.body.some((row: { id: number }) => row.id === c.id)).toBe(true);
    expect((await request(app).patch(`/api/sofia/conversations/${c.id}/visibility`).send({ hidden: "false" })).status).toBe(400);
    expect((await request(app).patch("/api/sofia/conversations/0/visibility").send({ hidden: true })).status).toBe(400);
  });

  it("a rota fixa não é confundida com /conversations/:id", async () => {
    const corpo = await resumo();
    expect(Number.isInteger(corpo.total)).toBe(true);
    expect(Array.isArray(corpo.conversations)).toBe(true);
  });

  it("conta só WhatsApp e Instagram em aguardando_humano; o chat interno e os outros estados ficam de fora", async () => {
    const antes = await resumo();
    const agora = Date.now();
    const whatsapp = await criar({ rotulo: "WhatsApp", canal: "whatsapp", canalUsuario: "5511999990001", status: "aguardando_humano", handoffTriggeredAt: new Date(agora - 10 * 60_000) });
    const instagram = await criar({ rotulo: "Instagram", canal: "instagram", canalUsuario: "maria.teste", status: "aguardando_humano", handoffTriggeredAt: new Date(agora - 2 * 60_000) });
    const interno = await criar({ rotulo: "Interno", canal: "interno", status: "aguardando_humano", handoffTriggeredAt: new Date(agora - 60_000) });
    const ativa = await criar({ rotulo: "Ativa", canal: "whatsapp", status: "ativa" });
    const emAtendimento = await criar({ rotulo: "Atendimento", canal: "instagram", status: "atendimento_humano", handoffTriggeredAt: new Date(agora - 30 * 60_000) });

    const depois = await resumo();
    expect(depois.total - antes.total).toBe(2);
    const ids = depois.conversations.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining([whatsapp.id, instagram.id]));
    for (const fora of [interno, ativa, emAtendimento]) expect(ids).not.toContain(fora.id);

    // Mais recente primeiro, com o canal, o contato e desde quando espera.
    expect(ids.indexOf(instagram.id)).toBeLessThan(ids.indexOf(whatsapp.id));
    expect(depois.conversations.find(c => c.id === whatsapp.id)).toEqual({
      id: whatsapp.id, title: `WhatsApp ${marker}`, canal: "whatsapp", canalUsuario: "5511999990001",
      waitingSince: new Date(agora - 10 * 60_000).toISOString(), arquivosNaoVistos: 0,
    });
    expect(new Date(depois.oldestWaitingSince!).getTime()).toBeLessThanOrEqual(agora - 10 * 60_000);
  });

  it("a conversa sai da contagem quando alguém assume e quando alguém resolve", async () => {
    const [a, b] = [
      await criar({ rotulo: "Assumida", canal: "whatsapp", status: "aguardando_humano", handoffTriggeredAt: new Date() }),
      await criar({ rotulo: "Resolvida", canal: "instagram", status: "aguardando_humano", handoffTriggeredAt: new Date() }),
    ];
    const antes = await resumo();
    expect(antes.conversations.map(c => c.id)).toEqual(expect.arrayContaining([a.id, b.id]));

    expect((await request(app).post(`/api/sofia/conversations/${a.id}/handoff/assume`)).status).toBe(200);
    const apos1 = await resumo();
    expect(apos1.total).toBe(antes.total - 1);
    expect(apos1.conversations.map(c => c.id)).not.toContain(a.id);

    expect((await request(app).post(`/api/sofia/conversations/${b.id}/handoff/resolve`)).status).toBe(200);
    const apos2 = await resumo();
    expect(apos2.total).toBe(antes.total - 2);
    expect(apos2.conversations.map(c => c.id)).not.toContain(b.id);
  });

  it("sem o horário do handoff, espera a partir da criação da conversa", async () => {
    const velha = await criar({ rotulo: "SemHorario", canal: "whatsapp", status: "aguardando_humano", createdAt: new Date(Date.now() - 3 * 3_600_000) });
    const { conversations: lista } = await resumo();
    const item = lista.find(c => c.id === velha.id);
    expect(item?.waitingSince).toBe(velha.createdAt.toISOString());
  });

  it("com muitas conversas, o total é exato e a lista traz só as mais recentes (no máximo 20)", async () => {
    const antes = await resumo();
    const criadas = await db.insert(conversations).values(
      Array.from({ length: 22 }, (_, i) => ({
        title: `Lote ${i} ${marker}`, model: "teste", canal: "whatsapp" as const, status: "aguardando_humano" as const,
        handoffTriggeredAt: new Date(Date.now() + (i + 1) * 1000),
      })),
    ).returning({ id: conversations.id });
    const depois = await resumo();
    expect(depois.total - antes.total).toBe(22);
    expect(depois.conversations).toHaveLength(20);
    // As 20 mais recentes do lote (com horário no futuro) vêm primeiro; as duas mais antigas ficam só na contagem.
    const maisRecentes = criadas.slice(2).map(c => c.id).reverse();
    expect(depois.conversations.map(c => c.id)).toEqual(maisRecentes);
    await db.delete(conversations).where(inArray(conversations.id, criadas.map(c => c.id)));
  });

  describe("respostas da Sofia não entregues", () => {
    const base = Date.now() - 3_600_000;
    const minutos = (n: number) => new Date(base + n * 60_000);
    async function envio(conversationId: number, valores: { status: "aceito" | "entregue" | "lido" | "falhou"; minuto: number; messageId?: number | null; canal?: "whatsapp" | "instagram" }) {
      await db.insert(canalEnvios).values({
        conversationId, messageId: valores.messageId ?? null, canal: valores.canal ?? "whatsapp", texto: "resposta",
        status: valores.status, erro: valores.status === "falhou" ? "Falha da Meta, código 131037." : null, createdAt: minutos(valores.minuto),
      });
    }
    async function mensagem(conversationId: number) {
      const [m] = await db.insert(messages).values({ conversationId, role: "assistant", content: "resposta" }).returning({ id: messages.id });
      return m!.id;
    }

    it("conta WhatsApp e Instagram cuja última resposta falhou, sem mexer no total de aguardando a equipe", async () => {
      const antes = await resumo();
      const whatsapp = await criar({ rotulo: "EnvioWA", canal: "whatsapp", canalUsuario: "5511999990011" });
      const instagram = await criar({ rotulo: "EnvioIG", canal: "instagram", canalUsuario: "maria.envio" });
      await envio(whatsapp.id, { status: "falhou", minuto: 1 });
      await envio(instagram.id, { status: "falhou", minuto: 1, canal: "instagram" });

      const depois = await resumo();
      expect(depois.respostasNaoEntregues - antes.respostasNaoEntregues).toBe(2);
      expect(depois.total).toBe(antes.total);
      expect(depois.conversations.map(c => c.id)).not.toEqual(expect.arrayContaining([whatsapp.id]));
    });

    it("a conversa sai da contagem quando um envio seguinte é registrado, e volta se esse também falhar", async () => {
      const conversa = await criar({ rotulo: "EnvioSeguinte", canal: "whatsapp" });
      const antes = await resumo();
      await envio(conversa.id, { status: "falhou", minuto: 1 });
      expect((await resumo()).respostasNaoEntregues - antes.respostasNaoEntregues).toBe(1);

      await envio(conversa.id, { status: "entregue", minuto: 2 });
      expect((await resumo()).respostasNaoEntregues).toBe(antes.respostasNaoEntregues);

      await envio(conversa.id, { status: "falhou", minuto: 3 });
      expect((await resumo()).respostasNaoEntregues - antes.respostasNaoEntregues).toBe(1);
    });

    it("uma parte recusada da última resposta conta, mesmo com a parte seguinte aceita", async () => {
      const conversa = await criar({ rotulo: "EnvioPartes", canal: "whatsapp" });
      const antes = await resumo();
      const resposta = await mensagem(conversa.id);
      await envio(conversa.id, { status: "falhou", minuto: 1, messageId: resposta });
      await envio(conversa.id, { status: "entregue", minuto: 2, messageId: resposta });
      expect((await resumo()).respostasNaoEntregues - antes.respostasNaoEntregues).toBe(1);

      const proxima = await mensagem(conversa.id);
      await envio(conversa.id, { status: "aceito", minuto: 3, messageId: proxima });
      expect((await resumo()).respostasNaoEntregues).toBe(antes.respostasNaoEntregues);
    });

    it("o chat interno do SoundOS não entra na contagem", async () => {
      const antes = await resumo();
      const interno = await criar({ rotulo: "EnvioInterno", canal: "interno" });
      await envio(interno.id, { status: "falhou", minuto: 1 });
      expect((await resumo()).respostasNaoEntregues).toBe(antes.respostasNaoEntregues);
    });

    it("a lista de Conversas e o aviso concordam, e a falha antiga aparece traduzida", async () => {
      const conversa = await criar({ rotulo: "EnvioLista", canal: "whatsapp", canalUsuario: "5511999990012" });
      const entregue = await criar({ rotulo: "EnvioListaOk", canal: "whatsapp", canalUsuario: "5511999990013" });
      await envio(conversa.id, { status: "falhou", minuto: 1 });
      await envio(entregue.id, { status: "falhou", minuto: 1 });
      await envio(entregue.id, { status: "lido", minuto: 2 });

      const lista = (await request(app).get("/api/sofia/conversations")).body as Array<{ id: number; canal: string; ultimoEnvioFalhou: boolean; ultimoEnvioErro: string | null }>;
      const daLista = lista.filter(c => c.ultimoEnvioFalhou && [conversa.id, entregue.id].includes(c.id));
      expect(daLista.map(c => c.id)).toEqual([conversa.id]);
      expect(daLista[0]!.ultimoEnvioErro).toMatch(/nome de exibição.*não foi aprovado pela Meta \(131037\)/);
      expect(lista.find(c => c.id === entregue.id)).toMatchObject({ ultimoEnvioFalhou: false, ultimoEnvioErro: null });

      // O total do aviso é o mesmo número de conversas externas com falha que a lista mostra.
      const externasComFalha = lista.filter(c => c.canal !== "interno" && c.ultimoEnvioFalhou).length;
      expect((await resumo()).respostasNaoEntregues).toBe(externasComFalha);
    });
  });
});
