// Sofia atendendo o WhatsApp pelo Hablla, de ponta a ponta: webhook com token próprio, idempotência,
// eventos ignorados com motivo, resposta pelo Hablla (simulado), estados de entrega sem regressão,
// janela de 24h sem plano B, handoff, mensagens simultâneas e logs sem dados pessoais. Banco de dev
// real; linhas próprias identificadas por `marker`/telefones sintéticos e removidas no fim.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray, like, or, sql } from "drizzle-orm";

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

const { db, conversations, messages, habllaConfig, habllaEventos, canalContatos, canalEnvios } = await import("@workspace/db");
const { logger } = await import("../lib/logger");
const { default: sofiaRouter } = await import("./sofia");
const { default: habllaRouter, habllaRouteTestHooks } = await import("./hablla");
const { criarRodarSofiaSimples } = await import("../services/sofiaCanalPipeline");
const { definirInstagramResponde, definirSofiaIniciaConversa, definirWhatsappResponde, gerarTokenWebhook, gerarTokenWebhookWhatsapp } = await import("../services/habllaConfig");
const { HabllaErro, enviarMensagemWhatsapp, limparCacheHablla } = await import("../services/habllaClient");
const { installScript } = await import("./testing/sofiaScriptedModel");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);
app.use("/api", habllaRouter);

const marker = randomUUID().slice(0, 8);
const WORKSPACE = `ws-wa-${marker}`;
const CONEXAO = `con-wa-${marker}`;
const ROTA = "/api/webhooks/hablla/whatsapp";
let contador = 0;
const trabalhos: Array<Promise<unknown>> = [];
const enviar = vi.fn<(p: { para: string; texto: string }) => Promise<{ externoId: string | null }>>();
let token = "";
let configOriginal: typeof habllaConfig.$inferSelect | undefined;
const ambienteOriginal: Record<string, string | undefined> = {};
const chavesUsadas = new Set<string>();

/** Celular brasileiro sintético, como a Meta envia: 55 + DDD + número. */
function novoTelefone(): string {
  const telefone = `55119${randomInt(10_000_000, 99_999_999)}`;
  chavesUsadas.add(telefone.slice(2));
  return telefone;
}
const novoWamid = () => `wamid.${marker}${++contador}`;

function mensagemRecebida(telefone: string, texto: string, extra: Record<string, unknown> = {}, corpo: Record<string, unknown> = {}) {
  return {
    workspace: WORKSPACE, connection: CONEXAO, meta_channel: "whatsapp",
    message_id: `int-${marker}-${++contador}`, external_id: novoWamid(),
    sender_name: "Maria Teste", sender_phone: telefone, sender_user_id: `u-${marker}`,
    message: { type: "text", body: texto, is_echo: false, ...corpo },
    ...extra,
  };
}

function status(wamid: string, estado: string, extra: Record<string, unknown> = {}) {
  return { workspace: WORKSPACE, connection: CONEXAO, meta_channel: "whatsapp", message_id: `int-${marker}-${++contador}`, external_id: wamid, status: estado, ...extra };
}

function resultadoDoEnvio(fila: string, wamid: string | null, estado: "success" | "error" = "success", extra: Record<string, unknown> = {}) {
  return {
    event: "astenir.meta_api.whatsapp.message_send", message_id: `int-${marker}-${++contador}`, task_id: fila, status: estado,
    ...(wamid ? { response: { messages: [{ id: wamid }] } } : {}), ...extra,
  };
}

async function receber(payload: unknown, autorizacao: string | null = `Bearer ${token}`) {
  const req = request(app).post(ROTA);
  if (autorizacao !== null) req.set("Authorization", autorizacao);
  const res = await req.send(payload as object);
  await Promise.all(trabalhos.splice(0));
  return res;
}

async function eventoPorId(externoId: string) {
  const [evento] = await db.select().from(habllaEventos).where(eq(habllaEventos.externoId, externoId));
  return evento;
}
const eventoDaMensagem = (p: { external_id: string }) => eventoPorId(`whatsapp:msg:${p.external_id}`);

async function conversaDoTelefone(telefone: string) {
  const [vinculo] = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, telefone.slice(2)));
  return vinculo ? (await db.select().from(conversations).where(eq(conversations.id, vinculo.conversationId)))[0] ?? null : null;
}

async function enviosDaConversa(conversationId: number) {
  return db.select().from(canalEnvios).where(eq(canalEnvios.conversationId, conversationId)).orderBy(canalEnvios.id);
}

describe("Sofia no WhatsApp pelo Hablla", () => {
  beforeAll(async () => {
    for (const chave of ["HABLLA_WORKSPACE_ID", "HABLLA_WHATSAPP_CONNECTION_ID"]) ambienteOriginal[chave] = process.env[chave];
    process.env.HABLLA_WORKSPACE_ID = WORKSPACE;
    process.env.HABLLA_WHATSAPP_CONNECTION_ID = CONEXAO;
    [configOriginal] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, 1));
    token = (await gerarTokenWebhookWhatsapp()).token;
    habllaRouteTestHooks.depsWhatsapp = {
      rodarSofia: criarRodarSofiaSimples(async () => [], "whatsapp"),
      enviar,
      esperaTravaMs: 20_000,
    };
    habllaRouteTestHooks.rastrear = p => { trabalhos.push(p); };
  });

  beforeEach(async () => {
    enviar.mockReset();
    modelMocks.chatCreate.mockReset();
    modelMocks.responsesCreate.mockReset();
    enviar.mockImplementation(async () => ({ externoId: `fila-${marker}-${++contador}` }));
    await definirWhatsappResponde(true);
    catalogMock.getOfficialEventCatalog.mockResolvedValue({
      source: { tables: ["cursos_inscricao", "classes", "courses"], fetchedAt: new Date().toISOString(), policy: "public_event_agenda" },
      items: [],
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  afterAll(async () => {
    habllaRouteTestHooks.depsWhatsapp = null;
    habllaRouteTestHooks.rastrear = null;
    await new Promise(resolve => setTimeout(resolve, 300));
    const vinculos = await db.select({ conversationId: canalContatos.conversationId }).from(canalContatos)
      .where(inArray(canalContatos.contatoExternoId, [...chavesUsadas]));
    const ids = vinculos.map(v => v.conversationId);
    await db.delete(habllaEventos).where(or(
      like(habllaEventos.externoId, `%${marker}%`),
      sql`${habllaEventos.payload}::text LIKE ${`%${marker}%`}`,
    ));
    if (ids.length > 0) await db.delete(conversations).where(inArray(conversations.id, ids));
    if (configOriginal) await db.update(habllaConfig).set(configOriginal).where(eq(habllaConfig.id, 1));
    else await db.delete(habllaConfig).where(eq(habllaConfig.id, 1));
    for (const [chave, valor] of Object.entries(ambienteOriginal)) {
      if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor;
    }
  });

  describe("webhook protegido por token próprio", () => {
    it.each([
      ["sem cabeçalho", null],
      ["token errado", "Bearer token-errado"],
      ["cabeçalho vazio", "Bearer "],
    ])("%s: 401 e nada é gravado nem respondido", async (_nome, autorizacao) => {
      const payload = mensagemRecebida(novoTelefone(), "Oi");
      const res = await receber(payload, autorizacao);
      expect(res.status).toBe(401);
      expect(await eventoDaMensagem(payload)).toBeUndefined();
      expect(enviar).not.toHaveBeenCalled();
    });

    it("o token do Instagram não abre o WhatsApp, e o do WhatsApp não abre o Instagram", async () => {
      const tokenInstagram = (await gerarTokenWebhook()).token;
      const payload = mensagemRecebida(novoTelefone(), "Oi");
      expect((await receber(payload, `Bearer ${tokenInstagram}`)).status).toBe(401);
      expect(await eventoDaMensagem(payload)).toBeUndefined();
      const noInstagram = await request(app).post("/api/webhooks/hablla/instagram").set("Authorization", `Bearer ${token}`).send({});
      expect(noInstagram.status).toBe(401);
    });

    it("aceita o token com ou sem o prefixo Bearer; gerar outro invalida o anterior", async () => {
      installScript(modelMocks, [{ text: "Olá!" }]);
      expect((await receber(mensagemRecebida(novoTelefone(), "Oi"), token)).status).toBe(200);
      const antigo = token;
      token = (await gerarTokenWebhookWhatsapp()).token;
      expect((await receber(mensagemRecebida(novoTelefone(), "Oi"), `Bearer ${antigo}`)).status).toBe(401);
      installScript(modelMocks, [{ text: "Olá!" }]);
      expect((await receber(mensagemRecebida(novoTelefone(), "Oi"), `Bearer ${token}`)).status).toBe(200);
    });
  });

  it("texto de cliente gera resposta no mesmo número, formatada para WhatsApp, enviada como 'aceito' com o id da fila", async () => {
    const telefone = novoTelefone();
    installScript(modelMocks, [{ text: "Oi! **Que bom** ter você aqui." }, { text: "Claro, conte mais." }]);

    const primeira = mensagemRecebida(telefone, "Oi, tudo bem?");
    expect((await receber(primeira)).status).toBe(200);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0]).toEqual({ para: telefone, texto: "Oi! *Que bom* ter você aqui." });
    expect(await eventoDaMensagem(primeira)).toMatchObject({ status: "respondido", motivo: null });

    const conversa = await conversaDoTelefone(telefone);
    expect(conversa).toMatchObject({ canal: "whatsapp", canalUsuario: telefone, status: "ativa" });
    expect(conversa!.title).toMatch(/^WhatsApp \+55 11 9\d{4}-\d{4}$/);
    const envios = await enviosDaConversa(conversa!.id);
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ canal: "whatsapp", status: "aceito", metaMessageId: null });
    expect(envios[0]!.filaId).toBe(envios[0]!.externoId);
    expect(envios[0]!.filaId).toMatch(new RegExp(`^fila-${marker}-`));

    // Mesmo número escrito de outro jeito: a mesma conversa.
    const formatado = mensagemRecebida(`+${telefone.slice(0, 2)} (${telefone.slice(2, 4)}) ${telefone.slice(4, 9)}-${telefone.slice(9)}`, "Me conta mais");
    await receber(formatado);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[1]![0].para).toBe(telefone);
    const vinculos = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, telefone.slice(2)));
    expect(vinculos).toHaveLength(1);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conversa!.id));
    expect(msgs.map(m => m.role).sort()).toEqual(["assistant", "assistant", "user", "user"]);
  });

  it("o contexto da Sofia diz que é WhatsApp (formato, sem pedir telefone) e o prompt padrão não muda", async () => {
    const telefone = novoTelefone();
    installScript(modelMocks, [{ text: "Olá!" }]);
    await receber(mensagemRecebida(telefone, "Oi"));
    const chamadas = [...modelMocks.chatCreate.mock.calls, ...modelMocks.responsesCreate.mock.calls];
    const prompts = JSON.stringify(chamadas);
    expect(prompts).toContain("canal: WhatsApp");
    expect(prompts).toContain("nunca peça o telefone");
  });

  it("com o cliente real do Hablla: confere a conexão e envia type/phone/body pela rota de WhatsApp da Astenir", async () => {
    const depsAntes = habllaRouteTestHooks.depsWhatsapp!;
    const envHablla = {
      HABLLA_API_TOKEN: "tok", HABLLA_WORKSPACE_ID: "ws-rota", HABLLA_WHATSAPP_CONNECTION_ID: "wa-rota", HABLLA_API_URL: "https://hablla.test",
    } as NodeJS.ProcessEnv;
    const chamadas: Array<{ metodo: string; caminho: string; corpo: unknown }> = [];
    const fetchHablla = vi.fn(async (url: string, init?: RequestInit) => {
      const caminho = url.replace("https://hablla.test", "");
      chamadas.push({ metodo: init?.method ?? "GET", caminho, corpo: init?.body ? JSON.parse(String(init.body)) : null });
      const ehConexao = caminho.endsWith("/connection/wa-rota");
      const corpo = ehConexao
        ? { id: "wa-rota", workspace: "ws-rota", scope: "WHATSAPP_MESSAGING", status: "active", name: "Número de teste" }
        : { task_id: `fila-real-${marker}`, message: "queued" };
      return { status: ehConexao ? 200 : 202, text: async () => JSON.stringify(corpo) } as Response;
    });
    limparCacheHablla();
    habllaRouteTestHooks.depsWhatsapp = {
      ...depsAntes,
      enviar: entrada => enviarMensagemWhatsapp(entrada, { env: envHablla, fetch: fetchHablla as unknown as typeof fetch }),
    };
    try {
      const telefone = novoTelefone();
      installScript(modelMocks, [{ text: "Oi! Posso ajudar." }]);
      const payload = mensagemRecebida(telefone, "Oi, tudo bem?");
      expect((await receber(payload)).status).toBe(200);
      expect(chamadas).toEqual([
        { metodo: "GET", caminho: "/v1/workspace/ws-rota/connection/wa-rota", corpo: null },
        {
          metodo: "POST",
          caminho: "/v1/workspace/ws-rota/meta/connection/wa-rota/whatsapp-messaging/messages/send",
          corpo: { type: "text", phone: telefone, body: "Oi! Posso ajudar." },
        },
      ]);
      expect(await eventoDaMensagem(payload)).toMatchObject({ status: "respondido", motivo: null });
      const envios = await enviosDaConversa((await conversaDoTelefone(telefone))!.id);
      // 202 = na fila: nada de "entregue" enquanto a Meta não confirmar.
      expect(envios).toHaveLength(1);
      expect(envios[0]).toMatchObject({ status: "aceito", canal: "whatsapp", externoId: `fila-real-${marker}`, filaId: `fila-real-${marker}` });
    } finally {
      habllaRouteTestHooks.depsWhatsapp = depsAntes;
      limparCacheHablla();
    }
  });

  describe("preparo da conversa antes da resposta (ficha e cartão)", () => {
    /** Troca só o necessário nas dependências e restaura no fim. */
    async function comDeps(extra: Record<string, unknown>, teste: () => Promise<void>) {
      const depsAntes = habllaRouteTestHooks.depsWhatsapp!;
      habllaRouteTestHooks.depsWhatsapp = { ...depsAntes, ...extra } as typeof depsAntes;
      try { await teste(); } finally { habllaRouteTestHooks.depsWhatsapp = depsAntes; }
    }
    const sofiaFalsa = () => vi.fn(async (_p: { conversationId: number; pessoaId: number | null; texto: string }) => (
      { texto: "Oi! Posso ajudar.", erro: null, handoffAcionado: false }
    ));

    it("recebe a conversa, o texto e o nome de perfil, e a ficha devolvida chega à Sofia", async () => {
      const prepararConversa = vi.fn(async () => 4242);
      const rodarSofia = sofiaFalsa();
      await comDeps({ prepararConversa, rodarSofia }, async () => {
        const telefone = novoTelefone();
        const payload = mensagemRecebida(telefone, "Quero saber do Ciclo Água");
        expect((await receber(payload)).status).toBe(200);
        const conversa = (await conversaDoTelefone(telefone))!;
        expect(prepararConversa).toHaveBeenCalledTimes(1);
        expect(prepararConversa).toHaveBeenCalledWith({ conversationId: conversa.id, texto: "Quero saber do Ciclo Água", perfil: "Maria Teste" });
        expect(rodarSofia).toHaveBeenCalledWith(expect.objectContaining({ conversationId: conversa.id, pessoaId: 4242 }));
        expect(await eventoDaMensagem(payload)).toMatchObject({ status: "respondido" });
      });
    });

    it("sem ficha segura (devolve null) a Sofia segue com o que a conversa já tinha", async () => {
      const rodarSofia = sofiaFalsa();
      await comDeps({ prepararConversa: vi.fn(async () => null), rodarSofia }, async () => {
        const payload = mensagemRecebida(novoTelefone(), "Oi");
        await receber(payload);
        expect(rodarSofia).toHaveBeenCalledWith(expect.objectContaining({ pessoaId: null }));
        expect(enviar).toHaveBeenCalledTimes(1);
      });
    });

    it("se o preparo falhar, a resposta sai do mesmo jeito e o erro não vai para o cliente", async () => {
      const rodarSofia = sofiaFalsa();
      await comDeps({ prepararConversa: vi.fn(async () => { throw new Error("banco fora do ar"); }), rodarSofia }, async () => {
        const payload = mensagemRecebida(novoTelefone(), "Oi");
        expect((await receber(payload)).status).toBe(200);
        expect(rodarSofia).toHaveBeenCalledTimes(1);
        expect(enviar).toHaveBeenCalledTimes(1);
        expect(enviar.mock.calls[0]![0].texto).toBe("Oi! Posso ajudar.");
        expect(await eventoDaMensagem(payload)).toMatchObject({ status: "respondido", motivo: null });
      });
    });
  });

  describe("idempotência", () => {
    it("o mesmo evento reenviado pelo Hablla é processado uma vez só", async () => {
      installScript(modelMocks, [{ text: "Olá!" }, { text: "Olá de novo!" }]);
      const payload = mensagemRecebida(novoTelefone(), "Oi");
      const primeira = await receber(payload);
      const repetida = await receber(payload);
      expect(primeira.body).toEqual({ ok: true });
      expect(repetida.status).toBe(200);
      expect(repetida.body).toEqual({ ok: true, duplicado: true });
      expect(enviar).toHaveBeenCalledTimes(1);
      expect(await db.select().from(habllaEventos).where(eq(habllaEventos.externoId, `whatsapp:msg:${payload.external_id}`))).toHaveLength(1);
    });

    it("o mesmo id da Meta com status diferentes são eventos distintos", async () => {
      const wamid = novoWamid();
      for (const estado of ["sent", "delivered", "read"]) {
        const res = await receber(status(wamid, estado));
        expect(res.body).toEqual({ ok: true });
      }
      const repetido = await receber(status(wamid, "read"));
      expect(repetido.body).toEqual({ ok: true, duplicado: true });
      const eventos = await db.select().from(habllaEventos).where(like(habllaEventos.externoId, `whatsapp:status:%:${wamid}`));
      expect(eventos.map(e => e.externoId).sort()).toEqual([
        `whatsapp:status:delivered:${wamid}`, `whatsapp:status:read:${wamid}`, `whatsapp:status:sent:${wamid}`,
      ]);
    });
  });

  describe("tudo que não é texto de cliente da conexão certa é ignorado com motivo", () => {
    it.each([
      ["outro workspace", (t: string) => mensagemRecebida(t, "Olá", { workspace: "ws-de-outro" }), "outro_workspace"],
      ["outra conexão", (t: string) => mensagemRecebida(t, "Olá", { connection: "con-de-outra" }), "outra_conexao"],
      ["sem workspace nem conexão", (t: string) => ({ ...mensagemRecebida(t, "Olá"), workspace: undefined, connection: undefined }), "workspace_ou_conexao_ausente"],
      ["eco da própria conta", (t: string) => mensagemRecebida(t, "Olá", {}, { is_echo: true }), "mensagem_enviada_pela_conta"],
      ["figurinha", (t: string) => mensagemRecebida(t, "Olá", {}, { type: "sticker", body: undefined }), "mensagem_sem_texto:sticker"],
      ["localização", (t: string) => mensagemRecebida(t, "Olá", {}, { type: "location", body: undefined }), "mensagem_sem_texto:location"],
      ["remetente sem telefone", (t: string) => mensagemRecebida(t, "Olá", { sender_phone: undefined }), "remetente_sem_telefone"],
      ["chamada de voz", (t: string) => mensagemRecebida(t, "Olá", { event: "CONNECT", call_id: `c-${marker}` }), "chamada_de_voz"],
      ["evento de conta", (t: string) => mensagemRecebida(t, "Olá", { field: "account_update" }), "evento_de_conta"],
    ])("%s", async (_nome, montar, motivo) => {
      const telefone = novoTelefone();
      const payload = montar(telefone) as { external_id: string };
      const res = await receber(payload);
      expect(res.status).toBe(200);
      expect(enviar).not.toHaveBeenCalled();
      expect(modelMocks.chatCreate).not.toHaveBeenCalled();
      const [evento] = await db.select().from(habllaEventos).where(sql`${habllaEventos.payload}::text LIKE ${`%${payload.external_id}%`}`);
      expect(evento).toMatchObject({ status: "ignorado", motivo });
      expect(await conversaDoTelefone(telefone)).toBeNull();
    });

    it("chave desligada: registra o evento, mas não cria conversa nem responde (e o Instagram continua independente)", async () => {
      await definirWhatsappResponde(false);
      await definirInstagramResponde(true);
      const telefone = novoTelefone();
      const payload = mensagemRecebida(telefone, "Oi, queria saber do workshop");
      await receber(payload);
      expect(enviar).not.toHaveBeenCalled();
      expect(modelMocks.chatCreate).not.toHaveBeenCalled();
      expect(modelMocks.responsesCreate).not.toHaveBeenCalled();
      expect(await eventoDaMensagem(payload)).toMatchObject({ status: "ignorado", motivo: "resposta_automatica_desligada" });
      expect(await conversaDoTelefone(telefone)).toBeNull();
      await definirInstagramResponde(false);
    });

    it("repetição do texto que a Sofia acabou de enviar é eco, mesmo com o envio ainda só 'aceito'", async () => {
      const telefone = novoTelefone();
      installScript(modelMocks, [{ text: "Resposta de teste da Sofia." }, { text: "Não deveria ser usada." }]);
      await receber(mensagemRecebida(telefone, "Oi"));
      const enviado = enviar.mock.calls[0]![0].texto;
      const eco = mensagemRecebida(telefone, enviado);
      await receber(eco);
      expect(enviar).toHaveBeenCalledTimes(1);
      expect(await eventoDaMensagem(eco)).toMatchObject({ status: "ignorado", motivo: "eco_de_resposta_enviada" });
    });
  });

  describe("estados de entrega", () => {
    async function enviarUmaResposta(texto = "Oi!") {
      const telefone = novoTelefone();
      installScript(modelMocks, [{ text: "Olá, tudo bem?" }]);
      await receber(mensagemRecebida(telefone, texto));
      const conversa = (await conversaDoTelefone(telefone))!;
      const [envio] = await enviosDaConversa(conversa.id);
      return { telefone, conversa, envio: envio!, wamid: novoWamid() };
    }
    const estadoDe = async (id: number) => (await db.select().from(canalEnvios).where(eq(canalEnvios.id, id)))[0]!;

    it("o resultado do envio liga a fila ao id da Meta; sent, delivered e read avançam e nunca regridem, mesmo fora de ordem", async () => {
      const { envio, wamid } = await enviarUmaResposta();
      const resultado = await receber(resultadoDoEnvio(envio.filaId!, wamid));
      expect(resultado.status).toBe(200);
      expect(await estadoDe(envio.id)).toMatchObject({ status: "aceito", metaMessageId: wamid });

      // Fora de ordem: entregue chega antes de enviado; lido antes de entregue.
      await receber(status(wamid, "delivered"));
      expect((await estadoDe(envio.id)).status).toBe("entregue");
      await receber(status(wamid, "sent"));
      expect((await estadoDe(envio.id)).status).toBe("entregue");
      await receber(status(wamid, "read"));
      expect((await estadoDe(envio.id)).status).toBe("lido");
      // Repetido tardio de um estágio anterior: continua lido.
      const tardio = status(wamid, "delivered", { message_id: `int-${marker}-tardio` });
      await db.delete(habllaEventos).where(eq(habllaEventos.externoId, `whatsapp:status:delivered:${wamid}`));
      await receber(tardio);
      expect((await estadoDe(envio.id)).status).toBe("lido");
      const evento = await eventoPorId(`whatsapp:status:delivered:${wamid}`);
      expect(evento).toMatchObject({ status: "ignorado", motivo: "entrega_sem_mudanca:lido" });
    });

    it("o estado de entrega aparece nas mensagens da conversa", async () => {
      const { conversa, envio, wamid } = await enviarUmaResposta();
      await receber(resultadoDoEnvio(envio.filaId!, wamid));
      await receber(status(wamid, "delivered"));
      const lista = await request(app).get(`/api/sofia/conversations/${conversa.id}/messages`);
      const daSofia = (lista.body as Array<Record<string, unknown>>).find(m => m.role === "assistant");
      expect(daSofia).toMatchObject({ envioStatus: "entregue", envioErro: null });
    });

    it("status que chega antes do resultado do envio fica guardado e é aplicado quando a fila é ligada ao id da Meta", async () => {
      const { envio, wamid } = await enviarUmaResposta();
      // Ordem trocada: o WhatsApp avisa antes de o Hablla informar qual mensagem saiu da fila.
      await receber(status(wamid, "sent"));
      await receber(status(wamid, "read"));
      await receber(status(wamid, "delivered"));
      expect(await eventoPorId(`whatsapp:status:read:${wamid}`)).toMatchObject({ status: "ignorado", motivo: "envio_desconhecido" });
      expect(await estadoDe(envio.id)).toMatchObject({ status: "aceito", metaMessageId: null });

      await receber(resultadoDoEnvio(envio.filaId!, wamid));
      expect(await estadoDe(envio.id)).toMatchObject({ status: "lido", metaMessageId: wamid });
      for (const estado of ["sent", "read", "delivered"]) {
        expect(await eventoPorId(`whatsapp:status:${estado}:${wamid}`)).toMatchObject({ status: "ignorado" });
        expect((await eventoPorId(`whatsapp:status:${estado}:${wamid}`))!.motivo).toMatch(/^reconciliado:/);
      }
    });

    it("falha que chega antes do resultado do envio também não se perde", async () => {
      const { conversa, envio, wamid } = await enviarUmaResposta();
      await receber(status(wamid, "failed", { errors: [{ code: 131047, title: "Re-engagement message" }] }));
      expect((await estadoDe(envio.id)).status).toBe("aceito");
      await receber(resultadoDoEnvio(envio.filaId!, wamid));
      const falhou = await estadoDe(envio.id);
      expect(falhou.status).toBe("falhou");
      expect(falhou.erro).toContain("Fora da janela de 24h");
      const lista = await request(app).get("/api/sofia/conversations");
      expect((lista.body as Array<Record<string, unknown>>).find(c => c.id === conversa.id)).toMatchObject({ ultimoEnvioFalhou: true });
    });

    it("status com a fila e o id da Meta liga o envio sozinho e libera os que chegaram antes dele", async () => {
      const { envio, wamid } = await enviarUmaResposta();
      await receber(status(wamid, "sent"));
      expect((await estadoDe(envio.id)).status).toBe("aceito");
      await receber(status(wamid, "delivered", { task_id: envio.filaId }));
      expect(await estadoDe(envio.id)).toMatchObject({ status: "entregue", metaMessageId: wamid });
      expect((await eventoPorId(`whatsapp:status:sent:${wamid}`))!.motivo).toMatch(/^reconciliado:/);
    });

    it("avisos que chegam antes de o envio ser gravado são aplicados assim que ele é gravado", async () => {
      const telefone = novoTelefone();
      const fila = `fila-${marker}-adiantada`;
      const wamid = novoWamid();
      const autorizacao = { Authorization: `Bearer ${token}` };
      const concluido = async (externoId: string) => {
        for (let i = 0; i < 100; i++) {
          const evento = await eventoPorId(externoId);
          if (evento && evento.status !== "recebido") return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`evento não concluiu: ${externoId.slice(0, 40)}`);
      };
      installScript(modelMocks, [{ text: "Olá, tudo bem?" }]);
      // O Hablla já informou o resultado e o WhatsApp já confirmou entrega e leitura enquanto o SoundOS
      // ainda não gravou o envio (a chamada de envio ainda não terminou).
      enviar.mockImplementationOnce(async () => {
        await request(app).post(ROTA).set(autorizacao).send(resultadoDoEnvio(fila, wamid));
        await request(app).post(ROTA).set(autorizacao).send(status(wamid, "delivered"));
        await request(app).post(ROTA).set(autorizacao).send(status(wamid, "read"));
        await Promise.all([
          concluido(`whatsapp:envio:${fila}:success`),
          concluido(`whatsapp:status:delivered:${wamid}`),
          concluido(`whatsapp:status:read:${wamid}`),
        ]);
        return { externoId: fila };
      });
      await receber(mensagemRecebida(telefone, "Oi"));

      const conversa = (await conversaDoTelefone(telefone))!;
      const [gravado] = await enviosDaConversa(conversa.id);
      expect(gravado).toMatchObject({ filaId: fila, status: "lido", metaMessageId: wamid });
      for (const id of [`whatsapp:envio:${fila}:success`, `whatsapp:status:delivered:${wamid}`, `whatsapp:status:read:${wamid}`]) {
        expect((await eventoPorId(id))!.motivo).toMatch(/^reconciliado:/);
      }
    });

    it("falha de envio recusada pela fila antes de o envio ser gravado também marca 'falhou'", async () => {
      const telefone = novoTelefone();
      const fila = `fila-${marker}-recusada`;
      installScript(modelMocks, [{ text: "Olá!" }]);
      enviar.mockImplementationOnce(async () => {
        await request(app).post(ROTA).set({ Authorization: `Bearer ${token}` })
          .send(resultadoDoEnvio(fila, null, "error", { error_data: { message: "Número fora da lista de teste" } }));
        for (let i = 0; i < 100; i++) {
          const evento = await eventoPorId(`whatsapp:envio:${fila}:error`);
          if (evento && evento.status !== "recebido") break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return { externoId: fila };
      });
      await receber(mensagemRecebida(telefone, "Oi"));
      const [gravado] = await enviosDaConversa((await conversaDoTelefone(telefone))!.id);
      expect(gravado!.status).toBe("falhou");
      expect(gravado!.erro).toContain("Número fora da lista de teste");
    });

    it("falha de entrega marca 'falhou' com o motivo, é final e aparece em Conversas", async () => {
      const { conversa, envio, wamid } = await enviarUmaResposta();
      await receber(resultadoDoEnvio(envio.filaId!, wamid));
      await receber(status(wamid, "sent"));
      await receber(status(wamid, "failed", { errors: [{ code: 131047, title: "Re-engagement message" }] }));
      const falhou = await estadoDe(envio.id);
      expect(falhou.status).toBe("falhou");
      expect(falhou.erro).toContain("Fora da janela de 24h");

      // Nada tira o 'falhou' (um "delivered" atrasado não vira entregue).
      await receber(status(wamid, "delivered"));
      expect((await estadoDe(envio.id)).status).toBe("falhou");

      const lista = await request(app).get("/api/sofia/conversations");
      const item = (lista.body as Array<Record<string, unknown>>).find(c => c.id === conversa.id);
      expect(item).toMatchObject({ canal: "whatsapp", canalUsuario: conversa.canalUsuario, ultimoEnvioFalhou: true });
      expect(String(item!.ultimoEnvioErro)).toContain("24h");
      const msgs = await request(app).get(`/api/sofia/conversations/${conversa.id}/messages`);
      expect((msgs.body as Array<Record<string, unknown>>).find(m => m.role === "assistant")).toMatchObject({ envioStatus: "falhou" });
    });

    it("o Hablla recusar o envio na fila (resultado com erro) também marca 'falhou'", async () => {
      const { envio } = await enviarUmaResposta();
      await receber(resultadoDoEnvio(envio.filaId!, null, "error", { error_data: { message: "Número fora da lista de teste" } }));
      const falhou = await estadoDe(envio.id);
      expect(falhou.status).toBe("falhou");
      expect(falhou.erro).toContain("Número fora da lista de teste");
    });

    it("status de uma mensagem que o SoundOS não enviou é ignorado e não muda nada", async () => {
      const { envio } = await enviarUmaResposta();
      const desconhecido = novoWamid();
      await receber(status(desconhecido, "read"));
      expect(await eventoPorId(`whatsapp:status:read:${desconhecido}`)).toMatchObject({ status: "ignorado", motivo: "envio_desconhecido" });
      expect((await estadoDe(envio.id)).status).toBe("aceito");
    });

    it("uma resposta em várias partes: um envio por parte, sem repetir e dentro do limite; a pior parte vale", async () => {
      const telefone = novoTelefone();
      const paragrafo = "Este é um parágrafo de apresentação bastante longo para ocupar espaço na mensagem. ".repeat(14);
      installScript(modelMocks, [{ text: `${paragrafo}\n\n${paragrafo}\n\n${paragrafo}` }]);
      await receber(mensagemRecebida(telefone, "Me conte tudo"));
      expect(enviar.mock.calls.length).toBeGreaterThan(1);
      for (const [entrada] of enviar.mock.calls) expect(entrada.texto.length).toBeLessThanOrEqual(1500);
      const conversa = (await conversaDoTelefone(telefone))!;
      const envios = await enviosDaConversa(conversa.id);
      expect(envios).toHaveLength(enviar.mock.calls.length);
      expect(new Set(envios.map(e => e.filaId)).size).toBe(envios.length);
      expect(envios.every(e => e.status === "aceito")).toBe(true);

      // A primeira parte é entregue; a segunda falha: a mensagem aparece como falha para a equipe.
      const wamids = envios.map(() => novoWamid());
      for (const [i, envio] of envios.entries()) await receber(resultadoDoEnvio(envio.filaId!, wamids[i]!));
      await receber(status(wamids[0]!, "delivered"));
      await receber(status(wamids[1]!, "failed", { errors: [{ code: 131026, title: "Message undeliverable" }] }));
      const lista = await request(app).get(`/api/sofia/conversations/${conversa.id}/messages`);
      expect((lista.body as Array<Record<string, unknown>>).find(m => m.role === "assistant")).toMatchObject({ envioStatus: "falhou" });
    });
  });

  describe("falha de envio", () => {
    it("fora da janela de 24h: registra a falha com o motivo, tenta uma vez só e não há plano B", async () => {
      const telefone = novoTelefone();
      installScript(modelMocks, [{ text: "Oi! Posso ajudar." }]);
      enviar.mockRejectedValue(new HabllaErro("janela_24h", "Fora da janela de 24h do WhatsApp: sessão fechada", 400));
      const payload = mensagemRecebida(telefone, "Oi");
      const res = await receber(payload);
      expect(res.status).toBe(200);
      expect(enviar).toHaveBeenCalledTimes(1);
      const evento = await eventoDaMensagem(payload);
      expect(evento).toMatchObject({ status: "falhou", motivo: "fora_da_janela_24h" });

      const conversa = (await conversaDoTelefone(telefone))!;
      const envios = await enviosDaConversa(conversa.id);
      expect(envios).toHaveLength(1);
      expect(envios[0]).toMatchObject({ status: "falhou", canal: "whatsapp" });
      expect(envios[0]!.erro).toContain("janela de 24h");
      // Nem modelo de mensagem nem texto alternativo: só a Sofia gerou texto, e uma vez.
      expect(modelMocks.chatCreate.mock.calls.length + modelMocks.responsesCreate.mock.calls.length).toBeGreaterThan(0);
      expect(enviar.mock.calls.every(([e]) => e.texto === "Oi! Posso ajudar.")).toBe(true);
    });

    it("a Sofia falhar não gera mensagem automática ao cliente e fica registrado", async () => {
      const telefone = novoTelefone();
      installScript(modelMocks, []);
      const payload = mensagemRecebida(telefone, "Oi");
      await receber(payload);
      expect(enviar).not.toHaveBeenCalled();
      const evento = await eventoDaMensagem(payload);
      expect(evento).toMatchObject({ status: "falhou" });
      expect(evento!.motivo).toContain("sofia_falhou");
    });
  });

  describe("falha de envio visível para a equipe", () => {
    type Resumo = { total: number; respostasNaoEntregues: number };
    const resumo = async () => (await request(app).get("/api/sofia/conversations/awaiting-staff")).body as Resumo;
    const estadoDoCanal = async () => (await request(app).get("/api/sofia/canais/whatsapp")).body as { ultimaFalhaDeEnvio: { falhouEm: string; codigo: number | null } | null };

    it("nome de exibição não aprovado (131037): aparece no aviso do menu, na lista e no cartão, e some quando um envio seguinte é registrado", async () => {
      const telefone = novoTelefone();
      const antes = await resumo();
      installScript(modelMocks, [{ text: "Olá, tudo bem?" }]);
      await receber(mensagemRecebida(telefone, "Oi"));
      const conversa = (await conversaDoTelefone(telefone))!;
      const [envio] = await enviosDaConversa(conversa.id);
      const wamid = novoWamid();
      await receber(resultadoDoEnvio(envio!.filaId!, wamid));
      await receber(status(wamid, "failed", { errors: [{ code: 131037, title: "display name approval needed", message: "texto do provedor que não deve aparecer" }] }));
      expect(enviar).toHaveBeenCalledTimes(1);

      const falhou = (await db.select().from(canalEnvios).where(eq(canalEnvios.id, envio!.id)))[0]!;
      expect(falhou.status).toBe("falhou");
      expect(falhou.erro).toMatch(/nome de exibição.*não foi aprovado pela Meta \(131037\)/);

      // Aviso do menu: conta como resposta não entregue e não como conversa aguardando a equipe.
      const comFalha = await resumo();
      expect(comFalha.respostasNaoEntregues - antes.respostasNaoEntregues).toBe(1);
      expect(comFalha.total).toBe(antes.total);
      // Lista de Conversas: falha com o motivo em português.
      const lista = (await request(app).get("/api/sofia/conversations")).body as Array<Record<string, unknown>>;
      expect(lista.find(c => c.id === conversa.id)).toMatchObject({ ultimoEnvioFalhou: true });
      expect(String(lista.find(c => c.id === conversa.id)!.ultimoEnvioErro)).toMatch(/nome de exibição/);
      // Cartão do canal: só a data e o código, sem texto do provedor, telefone ou conteúdo de mensagem.
      const cartao = (await estadoDoCanal()).ultimaFalhaDeEnvio;
      expect(cartao).toEqual({ falhouEm: expect.any(String), codigo: 131037 });
      expect(Number.isNaN(new Date(cartao!.falhouEm).getTime())).toBe(false);
      const bruto = JSON.stringify((await request(app).get("/api/sofia/canais/whatsapp")).body);
      for (const proibido of [telefone, telefone.slice(2), "texto do provedor", "Olá, tudo bem?"]) expect(bruto).not.toContain(proibido);

      // Falha gravada antes da tradução existir: o motivo continua legível nas telas.
      await db.update(canalEnvios).set({ erro: "Falha da Meta, código 131037." }).where(eq(canalEnvios.id, envio!.id));
      expect((await estadoDoCanal()).ultimaFalhaDeEnvio).toMatchObject({ codigo: 131037 });
      const antiga = (await request(app).get("/api/sofia/conversations")).body as Array<Record<string, unknown>>;
      expect(String(antiga.find(c => c.id === conversa.id)!.ultimoEnvioErro)).toMatch(/nome de exibição/);

      // Um envio seguinte da conversa, desta vez aceito: o aviso e o cartão se limpam sozinhos, sem mensagem extra ao cliente.
      installScript(modelMocks, [{ text: "Voltei!" }]);
      await receber(mensagemRecebida(telefone, "Alguém aí?"));
      expect(enviar).toHaveBeenCalledTimes(2);
      expect((await resumo()).respostasNaoEntregues).toBe(antes.respostasNaoEntregues);
      expect((await estadoDoCanal()).ultimaFalhaDeEnvio).toBeNull();
    });
  });

  it("handoff: envia a mensagem de transição e depois só registra o que a pessoa escrever", async () => {
    const telefone = novoTelefone();
    installScript(modelMocks, [{ text: "não deve ser usada" }]);
    const pedido = mensagemRecebida(telefone, "Quero falar com um atendente humano");
    await receber(pedido);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(await eventoDaMensagem(pedido)).toMatchObject({ status: "respondido", motivo: "passou_para_equipe" });
    const conversa = (await conversaDoTelefone(telefone))!;
    expect(conversa).toMatchObject({ status: "aguardando_humano", handoffReason: "pedido_explicito" });

    // A equipe é avisada no SoundOS sem nenhuma mensagem a mais para o cliente (segue um único envio).
    const aguardando = async () => ((await request(app).get("/api/sofia/conversations/awaiting-staff")).body as { conversations: Array<{ id: number; canal: string; canalUsuario: string | null }> }).conversations;
    expect((await aguardando()).find(c => c.id === conversa.id)).toMatchObject({ canal: "whatsapp", canalUsuario: telefone });
    expect(enviar).toHaveBeenCalledTimes(1);

    const seguinte = mensagemRecebida(telefone, "Alguém aí?");
    await receber(seguinte);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(await eventoDaMensagem(seguinte)).toMatchObject({ status: "ignorado", motivo: "aguardando_equipe" });
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conversa.id)).orderBy(messages.id);
    expect(msgs.filter(m => m.role === "user").map(m => m.content)).toEqual(["Quero falar com um atendente humano", "Alguém aí?"]);

    // Quando alguém assume, o aviso some.
    expect((await request(app).post(`/api/sofia/conversations/${conversa.id}/handoff/assume`)).status).toBe(200);
    expect((await aguardando()).map(c => c.id)).not.toContain(conversa.id);
    expect(enviar).toHaveBeenCalledTimes(1);

    await db.update(conversations).set({ status: "ativa" }).where(eq(conversations.id, conversa.id));
    installScript(modelMocks, [{ text: "Voltei! Como posso ajudar?" }]);
    await receber(mensagemRecebida(telefone, "Obrigada, quero saber mais"));
    expect(enviar).toHaveBeenCalledTimes(2);
  });

  it("duas mensagens seguidas do mesmo número: uma conversa, duas respostas, sem erro", async () => {
    const telefone = novoTelefone();
    installScript(modelMocks, [{ text: "Primeira resposta." }, { text: "Segunda resposta." }]);
    const [a, b] = [mensagemRecebida(telefone, "Primeira pergunta"), mensagemRecebida(telefone, "Segunda pergunta")];
    const [ra, rb] = await Promise.all([
      request(app).post(ROTA).set("Authorization", `Bearer ${token}`).send(a),
      request(app).post(ROTA).set("Authorization", `Bearer ${token}`).send(b),
    ]);
    await Promise.all(trabalhos.splice(0));
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(await eventoDaMensagem(a)).toMatchObject({ status: "respondido" });
    expect(await eventoDaMensagem(b)).toMatchObject({ status: "respondido" });
    const vinculos = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, telefone.slice(2)));
    expect(vinculos).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.conversationId, vinculos[0]!.conversationId))).toHaveLength(4);
  });

  it("os logs trazem só a estrutura: nenhum telefone, texto, nome ou id de mensagem", async () => {
    const linhas: string[] = [];
    const registrar = (...args: unknown[]) => {
      linhas.push(JSON.stringify(args, (_chave, valor) => (valor instanceof Error ? { name: valor.name, message: valor.message, stack: valor.stack } : valor)));
    };
    const falso: Record<string, unknown> = {};
    for (const nivel of ["info", "warn", "error", "debug", "trace", "fatal"]) falso[nivel] = registrar;
    falso.child = () => falso;
    for (const nivel of ["info", "warn", "error", "debug", "trace", "fatal"] as const) {
      vi.spyOn(logger, nivel).mockImplementation(registrar as never);
    }
    vi.spyOn(logger, "child").mockImplementation((() => falso) as never);

    const telefone = novoTelefone();
    const textoSecreto = `texto-secreto-${marker} quero saber sobre o curso`;
    installScript(modelMocks, [{ text: "Resposta confidencial da Sofia sobre o curso." }]);
    const recebida = mensagemRecebida(telefone, textoSecreto);
    await receber(recebida);
    const envio = (await enviosDaConversa((await conversaDoTelefone(telefone))!.id))[0]!;
    await receber(resultadoDoEnvio(envio.filaId!, recebida.external_id));
    await receber(status(recebida.external_id, "delivered"));
    await receber(status(novoWamid(), "read"));
    // Falha de envio com um erro que repete telefone e texto.
    const outro = novoTelefone();
    installScript(modelMocks, [{ text: "Outra resposta." }]);
    enviar.mockRejectedValueOnce(new HabllaErro("http", `O Hablla recusou o envio para ${outro}: texto-secreto-${marker}`, 400));
    await receber(mensagemRecebida(outro, "Oi de novo"));

    const tudo = linhas.join("\n");
    expect(linhas.length).toBeGreaterThan(0);
    for (const proibido of [telefone, telefone.slice(2), outro, outro.slice(2), "Maria Teste", textoSecreto, "texto-secreto", "Resposta confidencial", recebida.external_id]) {
      expect(tudo).not.toContain(proibido);
    }
  });

  describe("administração do canal", () => {
    it("começa desligado por padrão no banco (sem dado inserido) e é independente do Instagram", async () => {
      const { rows } = await db.execute(sql`
        SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'hablla_config' AND column_name IN ('whatsapp_responde', 'instagram_responde')`);
      const padroes = Object.fromEntries((rows as Array<{ column_name: string; column_default: string }>).map(r => [r.column_name, r.column_default]));
      expect(padroes.whatsapp_responde).toBe("false");

      await definirWhatsappResponde(false);
      await definirInstagramResponde(true);
      expect((await request(app).get("/api/sofia/canais/whatsapp")).body.respondeAtivo).toBe(false);
      expect((await request(app).get("/api/sofia/canais/instagram")).body.respondeAtivo).toBe(true);
      await definirInstagramResponde(false);
    });

    it("só liga com token do webhook gerado e credenciais do WhatsApp no ambiente", async () => {
      const chaves = ["HABLLA_API_TOKEN", "HABLLA_WORKSPACE_ID", "HABLLA_WHATSAPP_CONNECTION_ID", "HABLLA_INSTAGRAM_CONNECTION_ID"] as const;
      const antes = Object.fromEntries(chaves.map(c => [c, process.env[c]]));
      for (const c of chaves) delete process.env[c];
      try {
        const semCredenciais = await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: true });
        expect(semCredenciais.status).toBe(409);
        process.env.HABLLA_API_TOKEN = "teste";
        process.env.HABLLA_WORKSPACE_ID = WORKSPACE;
        // Só a conexão do Instagram configurada não basta: nunca se adivinha a conta.
        process.env.HABLLA_INSTAGRAM_CONNECTION_ID = "so-instagram";
        const semConexao = await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: true });
        expect(semConexao.status).toBe(409);
        expect(semConexao.body.error).toContain("conexão de WhatsApp");
        process.env.HABLLA_WHATSAPP_CONNECTION_ID = CONEXAO;
        const ok = await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: true });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ respondeAtivo: true, tokenConfigurado: true, credenciaisHabllaConfiguradas: true });
        expect(JSON.stringify(ok.body)).not.toContain(token);
        expect((await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: false })).body.respondeAtivo).toBe(false);
        expect((await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: "sim" })).status).toBe(400);
      } finally {
        for (const c of chaves) {
          if (antes[c] === undefined) delete process.env[c]; else process.env[c] = antes[c];
        }
      }
    });

    it("o início de conversa da Sofia nasce desligado, exige a resposta ligada e cai junto com ela", async () => {
      const chaves = ["HABLLA_API_TOKEN", "HABLLA_WORKSPACE_ID", "HABLLA_WHATSAPP_CONNECTION_ID"] as const;
      const antes = Object.fromEntries(chaves.map(c => [c, process.env[c]]));
      process.env.HABLLA_API_TOKEN = "teste";
      process.env.HABLLA_WORKSPACE_ID = WORKSPACE;
      process.env.HABLLA_WHATSAPP_CONNECTION_ID = CONEXAO;
      try {
        await definirWhatsappResponde(false);
        await definirSofiaIniciaConversa(false);
        const estado = (await request(app).get("/api/sofia/canais/whatsapp")).body;
        expect(estado).toMatchObject({ iniciaConversaAtivo: false, limiteIniciosPorHora: 20, limiteIniciosPorDia: 100 });

        // Sem a resposta automática ligada, ninguém leria a resposta ao modelo: recusa.
        const recusado = await request(app).put("/api/sofia/canais/whatsapp").send({ iniciaConversaAtivo: true });
        expect(recusado.status).toBe(409);
        expect(recusado.body.error).toContain("resposta automática");

        const ligado = await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: true, iniciaConversaAtivo: true });
        expect(ligado.status).toBe(200);
        expect(ligado.body).toMatchObject({ respondeAtivo: true, iniciaConversaAtivo: true });

        // Desligar a resposta desliga também o início de conversa.
        const desligado = await request(app).put("/api/sofia/canais/whatsapp").send({ respondeAtivo: false });
        expect(desligado.body).toMatchObject({ respondeAtivo: false, iniciaConversaAtivo: false });

        expect((await request(app).put("/api/sofia/canais/whatsapp").send({})).status).toBe(400);
        expect((await request(app).put("/api/sofia/canais/whatsapp").send({ iniciaConversaAtivo: "sim" })).status).toBe(400);
      } finally {
        await definirSofiaIniciaConversa(false);
        for (const c of chaves) {
          if (antes[c] === undefined) delete process.env[c]; else process.env[c] = antes[c];
        }
      }
    });

    it("o token gerado aparece uma vez e só o hash fica guardado, sem mexer no token do Instagram", async () => {
      const tokenInstagram = (await gerarTokenWebhook()).token;
      const [antes] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, 1));
      const res = await request(app).post("/api/sofia/canais/whatsapp/token");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      token = res.body.token;
      const [linha] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, 1));
      expect(linha!.whatsappWebhookTokenHash).toBeTruthy();
      expect(linha!.whatsappWebhookTokenHash).not.toContain(token);
      expect(linha!.whatsappWebhookTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(linha!.webhookTokenHash).toBe(antes!.webhookTokenHash);
      expect(JSON.stringify((await request(app).get("/api/sofia/canais/whatsapp")).body)).not.toContain(token);
      // O token do Instagram continua valendo no Instagram.
      expect((await request(app).post("/api/webhooks/hablla/instagram").set("Authorization", `Bearer ${tokenInstagram}`).send({})).status).toBe(200);
    });

    it("cada canal lista só os seus eventos", async () => {
      const textoWa = `Texto WA ${marker}`;
      await definirWhatsappResponde(false);
      const telefone = novoTelefone();
      await receber(mensagemRecebida(telefone, textoWa));
      const igToken = (await gerarTokenWebhook()).token;
      const textoIg = `Texto IG ${marker}`;
      await request(app).post("/api/webhooks/hablla/instagram").set("Authorization", `Bearer ${igToken}`)
        .send({ event: "message.received", data: { id: `m-${marker}-${++contador}`, type: "text", text: textoIg, direction: "inbound", sender: { id: `IG-${marker}`, username: "x.y" } } });
      await Promise.all(trabalhos.splice(0));

      const wa = await request(app).get("/api/sofia/canais/whatsapp/eventos");
      expect(wa.status).toBe(200);
      expect(wa.body[0]).toMatchObject({ status: "ignorado", motivo: "resposta_automatica_desligada", telefone, texto: textoWa });
      expect(JSON.stringify(wa.body)).not.toContain(textoIg);
      const ig = await request(app).get("/api/sofia/canais/instagram/eventos");
      expect(JSON.stringify(ig.body)).toContain(textoIg);
      expect(JSON.stringify(ig.body)).not.toContain(textoWa);

      await db.delete(habllaEventos).where(like(habllaEventos.externoId, `msg:m-${marker}-%`));
      await db.delete(canalContatos).where(eq(canalContatos.contatoExternoId, `IG-${marker}`));
    });
  });
});
