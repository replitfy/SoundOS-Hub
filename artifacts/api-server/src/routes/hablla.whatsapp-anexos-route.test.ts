// Arquivos recebidos pelo WhatsApp (imagem, vídeo, áudio, documento) de ponta a ponta: webhook → mensagem com
// o arquivo → cópia para o armazenamento (simulado, em memória) → frase fixa da Sofia → contagem de "não visto".
// Banco de dev real; linhas próprias identificadas por `marker`/telefones sintéticos e removidas no fim.
// Nunca envia nada a ninguém: o Hablla e o provedor de arquivos são simulados.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";

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

const { db, conversations, messages, habllaConfig, habllaEventos, canalContatos, canalEnvios, mensagemAnexos, usersTable } = await import("@workspace/db");
const { logger } = await import("../lib/logger");
const { default: habllaRouter, habllaRouteTestHooks } = await import("./hablla");
const { criarRodarSofiaSimples } = await import("../services/sofiaCanalPipeline");
const { definirWhatsappResponde, gerarTokenWebhookWhatsapp } = await import("../services/habllaConfig");
const { copiarAnexoRecebido, reivindicarNovaCopia, FRASE_DA_SOFIA_PARA_ARQUIVO } = await import("../services/anexosRecebidos");
const { anexosDaConversa, marcarAnexosComoVistos } = await import("../services/anexosAcesso");
const { criarArmazenamentoEmMemoria, definirArmazenamentoDeAnexosParaTestes } = await import("../services/anexosArmazenamento");
const { NOTA_DE_ANEXO_PARA_A_SOFIA } = await import("../services/anexosConteudo");
const { resumirConversasAguardandoEquipe } = await import("../services/conversasAguardandoEquipe");
const { installScript } = await import("./testing/sofiaScriptedModel");

const app = express();
app.use(express.json());
app.use("/api", habllaRouter);

const marker = randomUUID().slice(0, 8);
const WORKSPACE = `ws-an-${marker}`;
const CONEXAO = `con-an-${marker}`;
const ROTA = "/api/webhooks/hablla/whatsapp";
const HOST = "https://cdn.astenir.com";
let contador = 0;
const trabalhos: Array<Promise<unknown>> = [];
const enviar = vi.fn<(p: { para: string; texto: string }) => Promise<{ externoId: string | null }>>();
const armazenamento = criarArmazenamentoEmMemoria();
const arquivosDoProvedor = new Map<string, { corpo: Buffer; status?: number; local?: string }>();
const buscasNoProvedor: string[] = [];
let agoraDoTeste: Date | null = null;
let token = "";
let configOriginal: typeof habllaConfig.$inferSelect | undefined;
const ambienteOriginal: Record<string, string | undefined> = {};
const chavesUsadas = new Set<string>();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 3)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(500, 65)]);

async function fetchDoProvedor(url: string | URL | Request): Promise<Response> {
  const endereco = String(url);
  buscasNoProvedor.push(endereco);
  const arquivo = arquivosDoProvedor.get(endereco);
  if (!arquivo) throw new Error("rede indisponível (simulada)");
  if (arquivo.local) return new Response(null, { status: arquivo.status ?? 302, headers: { location: arquivo.local } });
  return new Response(arquivo.corpo, { status: arquivo.status ?? 200, headers: { "content-length": String(arquivo.corpo.length) } });
}

function novoTelefone(): string {
  const telefone = `55119${randomInt(10_000_000, 99_999_999)}`;
  chavesUsadas.add(telefone.slice(2));
  return telefone;
}
const novoWamid = () => `wamid.${marker}${++contador}`;

function arquivoRecebido(telefone: string, corpo: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    workspace: WORKSPACE, connection: CONEXAO, meta_channel: "whatsapp",
    message_id: `int-${marker}-${++contador}`, external_id: novoWamid(),
    sender_name: "Maria Teste", sender_phone: telefone, sender_user_id: `u-${marker}`,
    message: { type: "image", is_echo: false, mime_type: "image/png", ...corpo },
    ...extra,
  };
}

/** Imagem PNG pronta no provedor; devolve o corpo da mensagem para o webhook. */
function imagem(nome = `${marker}-${++contador}.png`, conteudo: Buffer = PNG, extra: Record<string, unknown> = {}) {
  const url = `${HOST}/midia/${nome}`;
  arquivosDoProvedor.set(url, { corpo: conteudo });
  return { type: "image", mime_type: "image/png", url, ...extra };
}

function textoRecebido(telefone: string, texto: string) {
  return {
    workspace: WORKSPACE, connection: CONEXAO, meta_channel: "whatsapp",
    message_id: `int-${marker}-${++contador}`, external_id: novoWamid(),
    sender_name: "Maria Teste", sender_phone: telefone, sender_user_id: `u-${marker}`,
    message: { type: "text", body: texto, is_echo: false },
  };
}

async function receber(payload: unknown) {
  const res = await request(app).post(ROTA).set("Authorization", `Bearer ${token}`).send(payload as object);
  await Promise.all(trabalhos.splice(0));
  return res;
}

const eventoDaMensagem = async (p: { external_id: string }) =>
  (await db.select().from(habllaEventos).where(eq(habllaEventos.externoId, `whatsapp:msg:${p.external_id}`)))[0];

async function conversaDoTelefone(telefone: string) {
  const [vinculo] = await db.select().from(canalContatos).where(eq(canalContatos.contatoExternoId, telefone.slice(2)));
  return vinculo ? (await db.select().from(conversations).where(eq(conversations.id, vinculo.conversationId)))[0] ?? null : null;
}
const anexosDe = (conversationId: number) => db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversationId)).orderBy(mensagemAnexos.id);
const mensagensDe = (conversationId: number) => db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.id);

/** Cria a conversa (com um texto) e devolve a linha já pronta para receber arquivos. */
async function conversaAtiva(telefone: string, status: "ativa" | "aguardando_humano" | "atendimento_humano" = "ativa") {
  installScript(modelMocks, [{ text: "Olá, tudo bem?" }]);
  await receber(textoRecebido(telefone, "Oi"));
  const conversa = (await conversaDoTelefone(telefone))!;
  if (status !== "ativa") await db.update(conversations).set({ status }).where(eq(conversations.id, conversa.id));
  enviar.mockClear();
  modelMocks.chatCreate.mockReset();
  modelMocks.responsesCreate.mockReset();
  return conversa;
}

describe("arquivos recebidos pelo WhatsApp", () => {
  beforeAll(async () => {
    for (const chave of ["HABLLA_WORKSPACE_ID", "HABLLA_WHATSAPP_CONNECTION_ID", "HABLLA_MIDIA_HOSTS"]) ambienteOriginal[chave] = process.env[chave];
    process.env.HABLLA_WORKSPACE_ID = WORKSPACE;
    process.env.HABLLA_WHATSAPP_CONNECTION_ID = CONEXAO;
    delete process.env.HABLLA_MIDIA_HOSTS;
    [configOriginal] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, 1));
    token = (await gerarTokenWebhookWhatsapp()).token;
    definirArmazenamentoDeAnexosParaTestes(armazenamento);
    habllaRouteTestHooks.depsWhatsapp = {
      rodarSofia: criarRodarSofiaSimples(async () => [], "whatsapp"),
      enviar,
      esperaTravaMs: 20_000,
      copiarAnexo: anexoId => copiarAnexoRecebido(anexoId, { fetch: fetchDoProvedor as typeof fetch, armazenamento, env: {} }),
      agora: () => agoraDoTeste ?? new Date(),
    };
    habllaRouteTestHooks.rastrear = p => { trabalhos.push(p); };
  });

  beforeEach(async () => {
    enviar.mockReset();
    modelMocks.chatCreate.mockReset();
    modelMocks.responsesCreate.mockReset();
    enviar.mockImplementation(async () => ({ externoId: `fila-${marker}-${++contador}` }));
    arquivosDoProvedor.clear();
    buscasNoProvedor.length = 0;
    agoraDoTeste = null;
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
    definirArmazenamentoDeAnexosParaTestes(null);
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

  it("imagem sem legenda: guarda o arquivo, a Sofia manda só a frase fixa (sem IA) e a conversa continua com ela", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const payload = arquivoRecebido(telefone, imagem());
    expect((await receber(payload)).status).toBe(200);

    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0]).toEqual({ para: telefone, texto: FRASE_DA_SOFIA_PARA_ARQUIVO });
    expect(modelMocks.chatCreate).not.toHaveBeenCalled();
    expect(modelMocks.responsesCreate).not.toHaveBeenCalled();
    expect(await eventoDaMensagem(payload)).toMatchObject({ status: "respondido", motivo: "anexo_aviso_enviado" });

    const [anexo] = await anexosDe(conversa.id);
    expect(anexo).toMatchObject({ direcao: "recebido", tipo: "image", copia: "copiado", mimeType: "image/png", tamanhoBytes: PNG.length, vistoEm: null, urlOrigem: null });
    expect(anexo!.storageKey).toMatch(new RegExp(`^anexos/${conversa.id}/`));
    expect(armazenamento.objetos.get(anexo!.storageKey!)!.conteudo.equals(PNG)).toBe(true);

    const mensagens = await mensagensDe(conversa.id);
    const doArquivo = mensagens.find(m => m.id === anexo!.messageId)!;
    expect(doArquivo).toMatchObject({ role: "user", kind: "anexo", content: "" });
    expect(mensagens.at(-1)).toMatchObject({ role: "assistant", kind: "aviso_anexo", content: FRASE_DA_SOFIA_PARA_ARQUIVO });
    // Arquivo não muda o estado da conversa nem chama a equipe pelo handoff.
    expect((await conversaDoTelefone(telefone))).toMatchObject({ status: "ativa", handoffReason: null });
  });

  it("a frase fixa sai no máximo uma vez a cada 30 minutos por conversa; depois da janela, de novo", async () => {
    const telefone = novoTelefone();
    await conversaAtiva(telefone);
    await receber(arquivoRecebido(telefone, imagem()));
    await receber(arquivoRecebido(telefone, imagem()));
    await receber(arquivoRecebido(telefone, imagem()));
    expect(enviar).toHaveBeenCalledTimes(1);

    agoraDoTeste = new Date(Date.now() + 31 * 60_000);
    await receber(arquivoRecebido(telefone, imagem()));
    expect(enviar).toHaveBeenCalledTimes(2);
  });

  it("com legenda, a Sofia também responde à legenda; o que ela lê do arquivo é só a nota neutra", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const roteiro = installScript(modelMocks, [{ text: "A inscrição é pelo link do evento." }, { text: "Fico à disposição." }]);
    const nomeSecreto = `foto-secreta-${marker}.png`;
    const payload = arquivoRecebido(telefone, imagem(nomeSecreto, PNG, { caption: "Como faço a inscrição?", filename: nomeSecreto }));
    await receber(payload);

    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[0]![0].texto).toBe(FRASE_DA_SOFIA_PARA_ARQUIVO);
    expect(enviar.mock.calls[1]![0].texto).toContain("inscrição é pelo link");
    expect(await eventoDaMensagem(payload)).toMatchObject({ status: "respondido" });

    const pedido = JSON.stringify(roteiro.requests.map(r => r.params));
    expect(roteiro.requests).toHaveLength(1);
    expect(pedido).toContain("Como faço a inscrição?");
    expect(pedido).not.toContain(nomeSecreto);
    expect(pedido).not.toContain(`${HOST}/midia`);

    // Nos turnos seguintes o arquivo aparece no histórico só como a nota neutra (mais a legenda).
    await receber(textoRecebido(telefone, "Obrigada!"));
    const historico = JSON.stringify(roteiro.requests[1]!.params);
    expect(historico).toContain(`${NOTA_DE_ANEXO_PARA_A_SOFIA} Como faço a inscrição?`);
    expect(historico).not.toContain(nomeSecreto);
    expect(historico).not.toContain(`${HOST}/midia`);

    const [anexo] = await anexosDe(conversa.id);
    const doArquivo = (await mensagensDe(conversa.id)).find(m => m.id === anexo!.messageId)!;
    expect(doArquivo.content).toBe("Como faço a inscrição?");
    // A legenda não gera uma segunda mensagem do cliente.
    expect((await mensagensDe(conversa.id)).filter(m => m.role === "user" && m.content === "Como faço a inscrição?")).toHaveLength(1);
  });

  it.each(["aguardando_humano", "atendimento_humano"] as const)("conversa com a equipe (%s): arquivo guardado, a Sofia fica em silêncio e o estado não muda", async status => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone, status);
    const payload = arquivoRecebido(telefone, imagem(undefined, PNG, { caption: "Segue" }));
    await receber(payload);

    expect(enviar).not.toHaveBeenCalled();
    expect(modelMocks.chatCreate).not.toHaveBeenCalled();
    expect(await eventoDaMensagem(payload)).toMatchObject({ status: "ignorado", motivo: status === "aguardando_humano" ? "anexo_aguardando_equipe" : "anexo_atendimento_pela_equipe" });
    expect((await anexosDe(conversa.id))[0]).toMatchObject({ copia: "copiado" });
    expect((await mensagensDe(conversa.id)).some(m => m.kind === "aviso_anexo")).toBe(false);
    expect((await conversaDoTelefone(telefone))!.status).toBe(status);
  });

  it("arquivo não visto entra na contagem da equipe uma vez por conversa; abrir a conversa zera, e um novo arquivo volta a contar", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const noResumo = async () => (await resumirConversasAguardandoEquipe()).conversations.find(c => c.id === conversa.id);
    expect(await noResumo()).toBeUndefined();

    await receber(arquivoRecebido(telefone, imagem()));
    await receber(arquivoRecebido(telefone, imagem()));
    const antes = await resumirConversasAguardandoEquipe();
    expect(antes.conversations.filter(c => c.id === conversa.id)).toHaveLength(1);
    expect(await noResumo()).toMatchObject({ arquivosNaoVistos: 2, canal: "whatsapp" });
    expect((await anexosDaConversa(conversa.id)).size).toBe(2);
    expect([...(await anexosDaConversa(conversa.id)).values()].every(a => a.naoVisto)).toBe(true);

    // Conversa que também passou para a equipe conta uma só vez.
    await db.update(conversations).set({ status: "aguardando_humano", handoffTriggeredAt: new Date() }).where(eq(conversations.id, conversa.id));
    const duplo = await resumirConversasAguardandoEquipe();
    expect(duplo.conversations.filter(c => c.id === conversa.id)).toHaveLength(1);
    expect(duplo.total).toBe(antes.total);
    await db.update(conversations).set({ status: "ativa", handoffTriggeredAt: null }).where(eq(conversations.id, conversa.id));

    const [usuario] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    expect(usuario).toBeDefined();
    expect(await marcarAnexosComoVistos(conversa.id, usuario!.id)).toBe(2);
    expect(await noResumo()).toBeUndefined();
    expect([...(await anexosDaConversa(conversa.id)).values()].every(a => !a.naoVisto)).toBe(true);
    expect(await marcarAnexosComoVistos(conversa.id, usuario!.id)).toBe(0);

    await receber(arquivoRecebido(telefone, imagem()));
    expect(await noResumo()).toMatchObject({ arquivosNaoVistos: 1 });
  });

  it("falha ao baixar deixa o arquivo indisponível e a equipe pode pedir nova cópia, que não envia nada à pessoa", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const corpo = imagem();
    arquivosDoProvedor.delete(corpo.url as string);
    await receber(arquivoRecebido(telefone, corpo));
    enviar.mockClear();

    const [anexo] = await anexosDe(conversa.id);
    expect(anexo).toMatchObject({ copia: "indisponivel", motivo: "download_falhou", storageKey: null });
    expect(anexo!.urlOrigem).toBe(corpo.url);
    expect([...(await anexosDaConversa(conversa.id)).values()][0]).toMatchObject({ copia: "indisponivel", podeRecopiar: true });

    arquivosDoProvedor.set(corpo.url as string, { corpo: PNG });
    expect(await reivindicarNovaCopia(anexo!.id, conversa.id)).toBe(true);
    expect(await reivindicarNovaCopia(anexo!.id, conversa.id)).toBe(false);
    expect(await copiarAnexoRecebido(anexo!.id, { fetch: fetchDoProvedor as typeof fetch, armazenamento, env: {} })).toBe("copiado");
    expect((await anexosDe(conversa.id))[0]).toMatchObject({ copia: "copiado", motivo: null, urlOrigem: null });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("arquivo que não confere é recusado com motivo e nunca fica guardado: conteúdo falso, hash diferente, tamanho, endereço de fora", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const html = imagem(undefined, Buffer.from("<html><script>alert(1)</script></html>"));
    const hashErrado = imagem(undefined, PNG, { sha256: "ab".repeat(32) });
    const grande = imagem(undefined, Buffer.concat([PNG, Buffer.alloc(17 * 1024 * 1024)]));
    const deFora = { type: "image", mime_type: "image/png", url: "https://evil.example.com/a.png" };
    const gif = { type: "image", mime_type: "image/gif", url: `${HOST}/midia/a.gif` };
    for (const corpo of [html, hashErrado, grande, deFora, gif]) await receber(arquivoRecebido(telefone, corpo));

    const anexos = await anexosDe(conversa.id);
    expect(anexos.map(a => [a.copia, a.motivo])).toEqual([
      ["recusado", "conteudo_nao_confere"],
      ["recusado", "hash_diferente"],
      ["recusado", "tamanho_excedido"],
      ["recusado", "endereco_nao_confiavel"],
      ["recusado", "tipo_nao_permitido"],
    ]);
    expect(anexos.every(a => a.storageKey === null && a.urlOrigem === null)).toBe(true);
    expect([...armazenamento.objetos.keys()].filter(k => k.startsWith(`anexos/${conversa.id}/`))).toEqual([]);
    // Endereço de fora e formato fora da lista nem chegam a ser buscados.
    expect(buscasNoProvedor.some(u => u.includes("evil.example.com") || u.endsWith(".gif"))).toBe(false);
  });

  it("redirecionamento para fora do provedor é recusado; para um host do provedor é seguido", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const origemA = `${HOST}/midia/${marker}-a.png`;
    const origemB = `${HOST}/midia/${marker}-b.png`;
    arquivosDoProvedor.set(origemA, { corpo: Buffer.alloc(0), local: "http://169.254.169.254/latest/meta-data" });
    arquivosDoProvedor.set(origemB, { corpo: Buffer.alloc(0), local: `${HOST}/midia/${marker}-destino.png` });
    arquivosDoProvedor.set(`${HOST}/midia/${marker}-destino.png`, { corpo: PNG });
    await receber(arquivoRecebido(telefone, { type: "image", mime_type: "image/png", url: origemA }));
    await receber(arquivoRecebido(telefone, { type: "image", mime_type: "image/png", url: origemB }));
    const anexos = await anexosDe(conversa.id);
    expect(anexos[0]).toMatchObject({ copia: "recusado", motivo: "endereco_nao_confiavel" });
    expect(anexos[1]).toMatchObject({ copia: "copiado" });
    expect(buscasNoProvedor.some(u => u.includes("169.254"))).toBe(false);
  });

  it("documento: nome seguro, formato pelo conteúdo, e vídeo/áudio de tipos aceitos passam", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const url = `${HOST}/midia/${marker}-doc.pdf`;
    arquivosDoProvedor.set(url, { corpo: PDF });
    await receber(arquivoRecebido(telefone, { type: "document", mime_type: "application/pdf", url, filename: "../../Contrato 2026.pdf" }));
    const [documento] = await anexosDe(conversa.id);
    expect(documento).toMatchObject({ tipo: "document", copia: "copiado", mimeType: "application/pdf" });
    expect(documento!.nome).toBe("Contrato 2026.pdf");
  });

  it("a mesma notificação reenviada não duplica a mensagem, o arquivo nem a frase da Sofia", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    const payload = arquivoRecebido(telefone, imagem());
    await receber(payload);
    const repetida = await receber(payload);
    expect(repetida.body).toEqual({ ok: true, duplicado: true });
    expect(await anexosDe(conversa.id)).toHaveLength(1);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("se a frase não for entregue, a tentativa é única, a falha fica registrada e o arquivo continua guardado", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    enviar.mockRejectedValue(new Error(`O Hablla recusou o envio para ${telefone}`));
    const payload = arquivoRecebido(telefone, imagem());
    await receber(payload);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(await eventoDaMensagem(payload)).toMatchObject({ status: "falhou", motivo: "aviso_de_arquivo_falhou" });
    expect((await anexosDe(conversa.id))[0]).toMatchObject({ copia: "copiado" });
    const falhas = await db.select().from(canalEnvios).where(and(eq(canalEnvios.conversationId, conversa.id), eq(canalEnvios.status, "falhou")));
    expect(falhas.length).toBeGreaterThan(0);
  });

  it("com a resposta automática desligada nada é criado: nem conversa, nem arquivo, nem cópia", async () => {
    await definirWhatsappResponde(false);
    const telefone = novoTelefone();
    const payload = arquivoRecebido(telefone, imagem());
    await receber(payload);
    expect(await eventoDaMensagem(payload)).toMatchObject({ status: "ignorado", motivo: "resposta_automatica_desligada" });
    expect(await conversaDoTelefone(telefone)).toBeNull();
    expect(enviar).not.toHaveBeenCalled();
    expect(buscasNoProvedor).toEqual([]);
  });

  describe("Sofia desligada (chave ou modo): a conversa que já existe continua recebendo", () => {
    const semSofia: Array<[string, () => Promise<() => Promise<void>>, string]> = [
      ["resposta automática desligada", async () => { await definirWhatsappResponde(false); return async () => undefined; }, "resposta_automatica_desligada"],
      ["modo diferente de simple", async () => {
        const anterior = process.env.SOFIA_MODE;
        process.env.SOFIA_MODE = "legacy";
        return async () => { if (anterior === undefined) delete process.env.SOFIA_MODE; else process.env.SOFIA_MODE = anterior; };
      }, "modo_sofia_nao_suportado"],
    ];

    it.each(semSofia)("%s, atendimento pela equipe: arquivo e texto ficam registrados, o arquivo é copiado e nada é enviado", async (_nome, desligar, _motivo) => {
      const telefone = novoTelefone();
      const conversa = await conversaAtiva(telefone, "atendimento_humano");
      const restaurar = await desligar();
      try {
        const arquivo = arquivoRecebido(telefone, imagem(undefined, PNG, { caption: "Segue o comprovante" }));
        await receber(arquivo);
        expect(await eventoDaMensagem(arquivo)).toMatchObject({ status: "ignorado", motivo: "anexo_atendimento_pela_equipe" });
        const [anexo] = await anexosDe(conversa.id);
        expect(anexo).toMatchObject({ direcao: "recebido", tipo: "image", copia: "copiado", vistoEm: null });
        expect(await mensagensDe(conversa.id)).toContainEqual(expect.objectContaining({ role: "user", kind: "anexo", content: "Segue o comprovante" }));

        const texto = textoRecebido(telefone, "Mandei agora há pouco");
        await receber(texto);
        expect(await mensagensDe(conversa.id)).toContainEqual(expect.objectContaining({ role: "user", content: "Mandei agora há pouco" }));
        expect((await conversaDoTelefone(telefone))!.status).toBe("atendimento_humano");
        expect(enviar).not.toHaveBeenCalled();
        expect(modelMocks.chatCreate).not.toHaveBeenCalled();
        expect(modelMocks.responsesCreate).not.toHaveBeenCalled();
      } finally {
        await restaurar();
      }
    });

    it.each(semSofia)("%s, conversa com a Sofia: arquivo registrado e copiado, sem frase fixa nem resposta, estado intacto", async (_nome, desligar, motivo) => {
      const telefone = novoTelefone();
      const conversa = await conversaAtiva(telefone, "ativa");
      const restaurar = await desligar();
      try {
        const arquivo = arquivoRecebido(telefone, imagem());
        await receber(arquivo);
        expect(await eventoDaMensagem(arquivo)).toMatchObject({ status: "ignorado", motivo });
        expect((await anexosDe(conversa.id))[0]).toMatchObject({ direcao: "recebido", copia: "copiado" });
        expect((await mensagensDe(conversa.id)).filter(m => m.kind === "aviso_anexo")).toHaveLength(0);
        expect((await conversaDoTelefone(telefone))!.status).toBe("ativa");
        expect(enviar).not.toHaveBeenCalled();
        expect(modelMocks.chatCreate).not.toHaveBeenCalled();
        expect(modelMocks.responsesCreate).not.toHaveBeenCalled();
      } finally {
        await restaurar();
      }
    });
  });

  it("figurinha, localização, contato, reação e botão continuam ignorados, sem arquivo nem aviso", async () => {
    const telefone = novoTelefone();
    const conversa = await conversaAtiva(telefone);
    for (const tipo of ["sticker", "location", "contacts", "reaction", "button"]) {
      const payload = arquivoRecebido(telefone, { type: tipo, mime_type: undefined, url: `${HOST}/midia/${marker}-x` });
      await receber(payload);
      expect(await eventoDaMensagem(payload)).toMatchObject({ status: "ignorado", motivo: `mensagem_sem_texto:${tipo}` });
    }
    expect(await anexosDe(conversa.id)).toHaveLength(0);
    expect(enviar).not.toHaveBeenCalled();
    expect(buscasNoProvedor).toEqual([]);
  });

  it("os logs não trazem telefone, nome do arquivo, legenda, endereço do provedor nem mensagem de erro do provedor", async () => {
    const linhas: string[] = [];
    const registrar = (...args: unknown[]) => {
      linhas.push(JSON.stringify(args, (_chave, valor) => (valor instanceof Error ? { name: valor.name, message: valor.message, stack: valor.stack } : valor)));
    };
    const falso: Record<string, unknown> = {};
    for (const nivel of ["info", "warn", "error", "debug", "trace", "fatal"]) falso[nivel] = registrar;
    falso.child = () => falso;
    for (const nivel of ["info", "warn", "error", "debug", "trace", "fatal"] as const) vi.spyOn(logger, nivel).mockImplementation(registrar as never);
    vi.spyOn(logger, "child").mockImplementation((() => falso) as never);

    const telefone = novoTelefone();
    await conversaAtiva(telefone);
    installScript(modelMocks, [{ text: "Resposta confidencial." }]);
    const nome = `nome-secreto-${marker}.pdf`;
    const url = `${HOST}/midia/${nome}`;
    arquivosDoProvedor.set(url, { corpo: PDF });
    await receber(arquivoRecebido(telefone, { type: "document", mime_type: "application/pdf", url, filename: nome, caption: `legenda-secreta-${marker}` }));
    // Falhas de download e de envio, com mensagens que repetem dados pessoais.
    enviar.mockRejectedValue(new Error(`recusou ${telefone} legenda-secreta-${marker}`));
    await receber(arquivoRecebido(telefone, { type: "image", mime_type: "image/png", url: `${HOST}/midia/falha-${marker}.png` }));

    const tudo = linhas.join("\n");
    expect(linhas.length).toBeGreaterThan(0);
    for (const proibido of [telefone, telefone.slice(2), "Maria Teste", nome, "nome-secreto", "legenda-secreta", `${HOST}/midia`, "cdn.astenir.com", "Resposta confidencial"]) {
      expect(tudo).not.toContain(proibido);
    }
  });
});
