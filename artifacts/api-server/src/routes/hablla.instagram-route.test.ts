// Sofia atendendo o Instagram pelo Hablla, de ponta a ponta: webhook protegido,
// idempotência, eco, chave desligada, resposta pelo Hablla (simulado), handoff,
// falha de envio visível e mensagens simultâneas. Banco de dev real, linhas
// próprias identificadas por `marker` e removidas no fim.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";

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
const { default: sofiaRouter } = await import("./sofia");
const { default: habllaRouter, habllaRouteTestHooks } = await import("./hablla");
const { criarRodarSofiaSimples } = await import("../services/sofiaCanalInstagram");
const { definirInstagramResponde, gerarTokenWebhook } = await import("../services/habllaConfig");
const { enviarMensagemInstagram, limparCacheHablla } = await import("../services/habllaClient");
const { installScript } = await import("./testing/sofiaScriptedModel");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);
app.use("/api", habllaRouter);

const marker = randomUUID().slice(0, 8);
let contador = 0;
const trabalhos: Array<Promise<unknown>> = [];
const enviar = vi.fn<(p: { para: string; texto: string }) => Promise<{ externoId: string | null }>>();
let token = "";
let configOriginal: typeof habllaConfig.$inferSelect | undefined;

const novoContato = () => `IG-${marker}-${++contador}`;
const novaMensagemId = () => `m-${marker}-${++contador}`;

function dm(contato: string, texto: string, extra: Record<string, unknown> = {}) {
  return {
    event: "message.received",
    data: {
      id: novaMensagemId(), type: "text", text: texto, direction: "inbound",
      sender: { id: contato, username: "@maria.teste" },
      ...extra,
    },
  };
}

async function receber(payload: unknown, autorizacao: string | null = `Bearer ${token}`) {
  const req = request(app).post("/api/webhooks/hablla/instagram");
  if (autorizacao !== null) req.set("Authorization", autorizacao);
  const res = await req.send(payload as object);
  await Promise.all(trabalhos.splice(0));
  return res;
}

async function eventoPorMensagem(payload: { data: { id: string } }) {
  const [evento] = await db.select().from(habllaEventos).where(eq(habllaEventos.externoId, `msg:${payload.data.id}`));
  return evento;
}

async function conversaDoContato(contato: string) {
  const [vinculo] = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, contato));
  return vinculo ? (await db.select().from(conversations).where(eq(conversations.id, vinculo.conversationId)))[0] ?? null : null;
}

describe("Sofia no Instagram pelo Hablla", () => {
  beforeAll(async () => {
    [configOriginal] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, 1));
    token = (await gerarTokenWebhook()).token;
    habllaRouteTestHooks.deps = {
      rodarSofia: criarRodarSofiaSimples(async () => []),
      enviar,
      esperaTravaMs: 20_000,
    };
    habllaRouteTestHooks.rastrear = p => { trabalhos.push(p); };
  });

  beforeEach(async () => {
    enviar.mockReset();
    modelMocks.chatCreate.mockReset();
    modelMocks.responsesCreate.mockReset();
    enviar.mockImplementation(async () => ({ externoId: `out-${++contador}` }));
    await definirInstagramResponde(true);
    catalogMock.getOfficialEventCatalog.mockResolvedValue({
      source: { tables: ["cursos_inscricao", "classes", "courses"], fetchedAt: new Date().toISOString(), policy: "public_event_agenda" },
      items: [],
    });
  });

  afterAll(async () => {
    habllaRouteTestHooks.deps = null;
    habllaRouteTestHooks.rastrear = null;
    await new Promise(resolve => setTimeout(resolve, 300));
    const vinculos = await db.select({ conversationId: canalContatos.conversationId }).from(canalContatos)
      .where(like(canalContatos.contatoExternoId, `IG-${marker}-%`));
    const ids = vinculos.map(v => v.conversationId);
    await db.delete(habllaEventos).where(like(habllaEventos.externoId, `msg:m-${marker}-%`));
    if (ids.length > 0) await db.delete(conversations).where(inArray(conversations.id, ids));
    // Restaura a configuração como estava antes dos testes.
    if (configOriginal) await db.update(habllaConfig).set(configOriginal).where(eq(habllaConfig.id, 1));
    else await db.delete(habllaConfig).where(eq(habllaConfig.id, 1));
  });

  describe("webhook protegido", () => {
    it.each([
      ["sem cabeçalho", null],
      ["token errado", "Bearer token-errado"],
      ["cabeçalho vazio", "Bearer "],
    ])("%s: 401 e nada é gravado nem respondido", async (_nome, autorizacao) => {
      const payload = dm(novoContato(), "Oi");
      const res = await receber(payload, autorizacao);
      expect(res.status).toBe(401);
      expect(await eventoPorMensagem(payload)).toBeUndefined();
      expect(enviar).not.toHaveBeenCalled();
    });

    it("aceita o token com ou sem o prefixo Bearer", async () => {
      installScript(modelMocks, [{ text: "Olá!" }]);
      const res = await receber(dm(novoContato(), "Oi"), token);
      expect(res.status).toBe(200);
      expect(enviar).toHaveBeenCalledTimes(1);
    });

    it("gerar um novo token invalida o anterior", async () => {
      const antigo = token;
      const novo = (await gerarTokenWebhook()).token;
      token = novo;
      expect((await receber(dm(novoContato(), "Oi"), `Bearer ${antigo}`)).status).toBe(401);
      installScript(modelMocks, [{ text: "Olá!" }]);
      expect((await receber(dm(novoContato(), "Oi"), `Bearer ${novo}`)).status).toBe(200);
    });
  });

  it("DM de texto gera resposta enviada ao mesmo contato, sem markdown, e a conversa continua", async () => {
    const contato = novoContato();
    installScript(modelMocks, [{ text: "Oi! **Que bom** ter você aqui." }, { text: "Claro, conte mais." }]);

    const primeira = dm(contato, "Oi, tudo bem?");
    expect((await receber(primeira)).status).toBe(200);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0]).toEqual({ para: contato, texto: "Oi! Que bom ter você aqui." });
    const evento = await eventoPorMensagem(primeira);
    expect(evento).toMatchObject({ status: "respondido", motivo: null });

    const conversa = await conversaDoContato(contato);
    expect(conversa).toMatchObject({ canal: "instagram", canalUsuario: "maria.teste", status: "ativa", title: "Instagram @maria.teste" });

    await receber(dm(contato, "Me conta mais"));
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[1]![0].para).toBe(contato);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conversa!.id));
    expect(msgs.map(m => m.role).sort()).toEqual(["assistant", "assistant", "user", "user"]);
    const vinculos = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, contato));
    expect(vinculos).toHaveLength(1);
  });

  it("com o cliente real do Hablla: confere a conexão e responde pela rota de DM de Instagram da Astenir", async () => {
    const depsAntes = habllaRouteTestHooks.deps!;
    const envHablla = {
      HABLLA_API_TOKEN: "tok", HABLLA_WORKSPACE_ID: "ws-rota", HABLLA_INSTAGRAM_CONNECTION_ID: "ig-rota", HABLLA_API_URL: "https://hablla.test",
    } as NodeJS.ProcessEnv;
    const chamadas: Array<{ metodo: string; caminho: string; corpo: unknown }> = [];
    const fetchHablla = vi.fn(async (url: string, init?: RequestInit) => {
      const caminho = url.replace("https://hablla.test", "");
      chamadas.push({ metodo: init?.method ?? "GET", caminho, corpo: init?.body ? JSON.parse(String(init.body)) : null });
      const corpo = caminho.endsWith("/connection/ig-rota")
        ? { id: "ig-rota", workspace: "ws-rota", scope: "INSTAGRAM", status: "active", name: "Conta de teste" }
        : { task_id: "fila-1", message: "queued" };
      return { status: caminho.endsWith("/connection/ig-rota") ? 200 : 202, text: async () => JSON.stringify(corpo) } as Response;
    });
    limparCacheHablla();
    habllaRouteTestHooks.deps = {
      ...depsAntes,
      enviar: entrada => enviarMensagemInstagram(entrada, { env: envHablla, fetch: fetchHablla as unknown as typeof fetch }),
    };
    try {
      const contato = novoContato();
      installScript(modelMocks, [{ text: "Oi! Posso ajudar." }]);
      const payload = dm(contato, "Oi, tudo bem?");
      expect((await receber(payload)).status).toBe(200);
      expect(chamadas).toEqual([
        { metodo: "GET", caminho: "/v1/workspace/ws-rota/connection/ig-rota", corpo: null },
        {
          metodo: "POST",
          caminho: "/v1/workspace/ws-rota/meta/connection/ig-rota/instagram-messaging/messages/send",
          corpo: { instagram_id: contato, text: "Oi! Posso ajudar." },
        },
      ]);
      expect(await eventoPorMensagem(payload)).toMatchObject({ status: "respondido", motivo: null });
      const conversa = await conversaDoContato(contato);
      const envios = await db.select().from(canalEnvios).where(eq(canalEnvios.conversationId, conversa!.id));
      // 202 = aceito na fila: guardamos o ID da fila, não fingimos que há ID de entrega.
      expect(envios).toHaveLength(1);
      expect(envios[0]).toMatchObject({ status: "enviado", canal: "instagram", externoId: "fila-1" });
    } finally {
      habllaRouteTestHooks.deps = depsAntes;
      limparCacheHablla();
    }
  });

  it("o mesmo evento reenviado pelo Hablla é processado uma vez só", async () => {
    installScript(modelMocks, [{ text: "Olá!" }, { text: "Olá de novo!" }]);
    const payload = dm(novoContato(), "Oi");
    const primeira = await receber(payload);
    const repetida = await receber(payload);
    expect(primeira.body).toEqual({ ok: true });
    expect(repetida.status).toBe(200);
    expect(repetida.body).toEqual({ ok: true, duplicado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
    const eventos = await db.select().from(habllaEventos).where(eq(habllaEventos.externoId, `msg:${payload.data.id}`));
    expect(eventos).toHaveLength(1);
  });

  describe("eco e origem desconhecida nunca disparam resposta", () => {
    it.each([
      ["direção de saída", { direction: "outbound" }, "mensagem_enviada_pela_conta"],
      ["remetente é a Sofia/bot", { direction: undefined, sender_type: "bot" }, "mensagem_enviada_pela_conta"],
      ["eco marcado", { is_echo: true }, "mensagem_enviada_pela_conta"],
    ])("%s", async (_nome, extra, motivo) => {
      const contato = novoContato();
      const payload = dm(contato, "Olá, tudo bem?", extra);
      await receber(payload);
      expect(enviar).not.toHaveBeenCalled();
      expect(await eventoPorMensagem(payload)).toMatchObject({ status: "ignorado", motivo });
      expect(await conversaDoContato(contato)).toBeNull();
    });

    it("sem indício de direção: ignorado com motivo", async () => {
      const contato = novoContato();
      const payload = { data: { id: novaMensagemId(), text: "Olá", sender: { id: contato } } };
      await receber(payload);
      expect(enviar).not.toHaveBeenCalled();
      expect(await eventoPorMensagem(payload)).toMatchObject({ status: "ignorado", motivo: "origem_nao_reconhecida" });
    });

    it("payload desconhecido vira ignorado com motivo e fica guardado", async () => {
      const payload = { coisa: `qualquer-${marker}-${++contador}` };
      const res = await receber(payload);
      expect(res.status).toBe(200);
      const [evento] = await db.select().from(habllaEventos).where(eq(habllaEventos.status, "ignorado"))
        .then(linhas => linhas.filter(l => JSON.stringify(l.payload).includes(payload.coisa)));
      expect(evento).toMatchObject({ status: "ignorado", motivo: "origem_nao_reconhecida" });
      expect(evento!.payload).toEqual(payload);
      await db.delete(habllaEventos).where(eq(habllaEventos.id, evento!.id));
    });

    it("repetição do texto que a Sofia acabou de enviar é eco", async () => {
      const contato = novoContato();
      installScript(modelMocks, [{ text: "Resposta de teste da Sofia." }, { text: "Não deveria ser usada." }]);
      await receber(dm(contato, "Oi"));
      const enviado = enviar.mock.calls[0]![0].texto;
      const eco = dm(contato, enviado);
      await receber(eco);
      expect(enviar).toHaveBeenCalledTimes(1);
      expect(await eventoPorMensagem(eco)).toMatchObject({ status: "ignorado", motivo: "eco_de_resposta_enviada" });
    });

    it("mensagem sem texto (imagem, figurinha) é ignorada e visível", async () => {
      const contato = novoContato();
      const payload = {
        event: "message.received",
        data: { id: novaMensagemId(), direction: "inbound", sender: { id: contato }, attachments: [{ type: "image", url: "https://x/y.jpg" }] },
      };
      await receber(payload);
      expect(enviar).not.toHaveBeenCalled();
      expect(await eventoPorMensagem(payload)).toMatchObject({ status: "ignorado", motivo: "mensagem_sem_texto" });
    });
  });

  it("chave desligada: registra o evento, mas não cria conversa nem responde", async () => {
    await definirInstagramResponde(false);
    const contato = novoContato();
    const payload = dm(contato, "Oi, queria saber do workshop");
    await receber(payload);
    expect(enviar).not.toHaveBeenCalled();
    expect(modelMocks.chatCreate).not.toHaveBeenCalled();
    expect(modelMocks.responsesCreate).not.toHaveBeenCalled();
    expect(await eventoPorMensagem(payload)).toMatchObject({ status: "ignorado", motivo: "resposta_automatica_desligada" });
    expect(await conversaDoContato(contato)).toBeNull();
  });

  it("handoff: envia a mensagem de transição e depois só registra o que a pessoa escrever", async () => {
    const contato = novoContato();
    installScript(modelMocks, [{ text: "não deve ser usada" }]);
    const pedido = dm(contato, "Quero falar com um atendente humano");
    await receber(pedido);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(await eventoPorMensagem(pedido)).toMatchObject({ status: "respondido", motivo: "passou_para_equipe" });
    const conversa = await conversaDoContato(contato);
    expect(conversa).toMatchObject({ status: "aguardando_humano", handoffReason: "pedido_explicito" });

    // A equipe é avisada no SoundOS sem nenhuma mensagem a mais para o cliente; o aviso some quando alguém assume.
    const aguardando = async () => ((await request(app).get("/api/sofia/conversations/awaiting-staff")).body as { conversations: Array<{ id: number; canal: string }> }).conversations;
    expect((await aguardando()).find(c => c.id === conversa!.id)).toMatchObject({ canal: "instagram" });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`/api/sofia/conversations/${conversa!.id}/handoff/assume`)).status).toBe(200);
    expect((await aguardando()).map(c => c.id)).not.toContain(conversa!.id);
    expect(enviar).toHaveBeenCalledTimes(1);
    await db.update(conversations).set({ status: "aguardando_humano" }).where(eq(conversations.id, conversa!.id));

    const seguinte = dm(contato, "Alguém aí?");
    await receber(seguinte);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(await eventoPorMensagem(seguinte)).toMatchObject({ status: "ignorado", motivo: "aguardando_equipe" });
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conversa!.id));
    expect(msgs.filter(m => m.role === "user").map(m => m.content)).toEqual(["Quero falar com um atendente humano", "Alguém aí?"]);

    // Depois que a equipe resolve, a Sofia volta a responder.
    await db.update(conversations).set({ status: "ativa" }).where(eq(conversations.id, conversa!.id));
    installScript(modelMocks, [{ text: "Voltei! Como posso ajudar?" }]);
    await receber(dm(contato, "Obrigada, quero saber mais"));
    expect(enviar).toHaveBeenCalledTimes(2);
  });

  it("falha de envio fica registrada e visível em Conversas, sem derrubar nada", async () => {
    const contato = novoContato();
    installScript(modelMocks, [{ text: "Oi! Posso ajudar." }]);
    enviar.mockRejectedValue(new Error("O Hablla recusou o envio (HTTP 400): fora da janela de 24h"));
    const payload = dm(contato, "Oi");
    const res = await receber(payload);
    expect(res.status).toBe(200);
    expect(enviar).toHaveBeenCalledTimes(1);
    const evento = await eventoPorMensagem(payload);
    expect(evento).toMatchObject({ status: "falhou" });
    expect(evento!.motivo).toContain("envio_falhou");

    const conversa = await conversaDoContato(contato);
    const envios = await db.select().from(canalEnvios).where(eq(canalEnvios.conversationId, conversa!.id));
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ status: "falhou", canal: "instagram" });

    const lista = await request(app).get("/api/sofia/conversations");
    const item = (lista.body as Array<Record<string, unknown>>).find(c => c.id === conversa!.id);
    expect(item).toMatchObject({ canal: "instagram", canalUsuario: "maria.teste", ultimoEnvioFalhou: true });
    expect(String(item!.ultimoEnvioErro)).toContain("24h");

    const msgs = await request(app).get(`/api/sofia/conversations/${conversa!.id}/messages`);
    const daSofia = (msgs.body as Array<Record<string, unknown>>).find(m => m.role === "assistant");
    expect(daSofia).toMatchObject({ envioStatus: "falhou" });

    // Próxima mensagem entregue com sucesso tira o marcador de falha.
    enviar.mockResolvedValue({ externoId: "ok" });
    installScript(modelMocks, [{ text: "Tudo certo agora." }]);
    await receber(dm(contato, "Oi de novo"));
    const depois = await request(app).get("/api/sofia/conversations");
    expect((depois.body as Array<Record<string, unknown>>).find(c => c.id === conversa!.id)).toMatchObject({ ultimoEnvioFalhou: false });
  });

  it("a Sofia falhar não gera mensagem automática ao cliente e fica registrado", async () => {
    const contato = novoContato();
    installScript(modelMocks, []); // roteiro vazio: o modelo falha
    const payload = dm(contato, "Oi");
    await receber(payload);
    expect(enviar).not.toHaveBeenCalled();
    const evento = await eventoPorMensagem(payload);
    expect(evento).toMatchObject({ status: "falhou" });
    expect(evento!.motivo).toContain("sofia_falhou");
    const conversa = await conversaDoContato(contato);
    const envios = await db.select().from(canalEnvios).where(eq(canalEnvios.conversationId, conversa!.id));
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ status: "falhou", messageId: null });
  });

  it("duas mensagens seguidas da mesma pessoa: uma conversa, duas respostas, sem erro", async () => {
    const contato = novoContato();
    installScript(modelMocks, [{ text: "Primeira resposta." }, { text: "Segunda resposta." }]);
    const [a, b] = [dm(contato, "Primeira pergunta"), dm(contato, "Segunda pergunta")];
    const [ra, rb] = await Promise.all([
      request(app).post("/api/webhooks/hablla/instagram").set("Authorization", `Bearer ${token}`).send(a),
      request(app).post("/api/webhooks/hablla/instagram").set("Authorization", `Bearer ${token}`).send(b),
    ]);
    await Promise.all(trabalhos.splice(0));
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(await eventoPorMensagem(a)).toMatchObject({ status: "respondido" });
    expect(await eventoPorMensagem(b)).toMatchObject({ status: "respondido" });
    const vinculos = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, contato));
    expect(vinculos).toHaveLength(1);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, vinculos[0]!.conversationId));
    expect(msgs).toHaveLength(4);
  });

  describe("administração do canal", () => {
    it("não liga a resposta sem credenciais da API do Hablla", async () => {
      const chaves = ["HABLLA_API_TOKEN", "HABLLA_WORKSPACE_ID", "HABLLA_INSTAGRAM_CONNECTION_ID"] as const;
      const antes = Object.fromEntries(chaves.map(c => [c, process.env[c]]));
      for (const c of chaves) delete process.env[c];
      try {
        const res = await request(app).put("/api/sofia/canais/instagram").send({ respondeAtivo: true });
        expect(res.status).toBe(409);
        // Sem o ID da conexão de Instagram também não liga: nunca se adivinha a conta.
        process.env.HABLLA_API_TOKEN = "teste";
        process.env.HABLLA_WORKSPACE_ID = "ws-teste";
        const semConexao = await request(app).put("/api/sofia/canais/instagram").send({ respondeAtivo: true });
        expect(semConexao.status).toBe(409);
        expect(semConexao.body.error).toContain("ID da conexão de Instagram");
        process.env.HABLLA_INSTAGRAM_CONNECTION_ID = "conexao-teste";
        const ok = await request(app).put("/api/sofia/canais/instagram").send({ respondeAtivo: true });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ respondeAtivo: true, tokenConfigurado: true, credenciaisHabllaConfiguradas: true });
        expect(JSON.stringify(ok.body)).not.toContain(token);
        const desligado = await request(app).put("/api/sofia/canais/instagram").send({ respondeAtivo: false });
        expect(desligado.body.respondeAtivo).toBe(false);
      } finally {
        for (const c of chaves) {
          if (antes[c] === undefined) delete process.env[c]; else process.env[c] = antes[c];
        }
      }
    });

    it("a verificação das credenciais devolve só estados e nomes, sem segredos", async () => {
      const verificacao = {
        token: "ok" as const,
        conexoes: {
          instagram: { estado: "ok" as const, nome: "Pierre Stocker | Sound Healing" },
          whatsapp: { estado: "nao_configurada" as const, nome: null },
        },
        conexoesNoWorkspace: [{ nome: "Pierre Stocker | Sound Healing", tipo: "INSTAGRAM" }],
      };
      habllaRouteTestHooks.verificar = async () => verificacao;
      try {
        const res = await request(app).get("/api/sofia/canais/hablla/verificacao");
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.body).toEqual(verificacao);
        expect(JSON.stringify(res.body)).not.toContain(process.env.HABLLA_API_TOKEN ?? "token-inexistente-no-teste");
      } finally {
        habllaRouteTestHooks.verificar = null;
      }
    });

    it("o token gerado aparece uma vez e só o hash fica guardado", async () => {
      const res = await request(app).post("/api/sofia/canais/instagram/token");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      token = res.body.token;
      const [linha] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, 1));
      expect(linha!.webhookTokenHash).toBeTruthy();
      expect(linha!.webhookTokenHash).not.toContain(token);
      const estado = await request(app).get("/api/sofia/canais/instagram");
      expect(JSON.stringify(estado.body)).not.toContain(token);
    });

    it("lista os eventos recentes com texto e motivo", async () => {
      const payload = dm(novoContato(), "Texto para a listagem");
      await definirInstagramResponde(false);
      await receber(payload);
      const res = await request(app).get("/api/sofia/canais/instagram/eventos");
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ status: "ignorado", motivo: "resposta_automatica_desligada", usuario: "maria.teste", texto: "Texto para a listagem" });
    });
  });
});
