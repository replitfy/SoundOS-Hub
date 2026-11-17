// Arquivos do atendimento (WhatsApp) contra um banco descartável: envio pela equipe no chat do cartão, rota que
// serve o arquivo (autenticação, áreas, Range, cabeçalhos), marca de "visto", conversa na ficha e exclusão da
// ficha. Nunca fala com o Hablla de verdade (fetch falso por `deps`) nem usa o armazenamento do projeto (memória).
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";

const disposableMarker = process.env.CRM_CONFIRMATION_DISPOSABLE;
const databaseUrl = process.env.DATABASE_URL;
let databaseName: string | undefined;
try {
  databaseName = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) : undefined;
} catch {
  databaseName = undefined;
}
if (
  !disposableMarker ||
  !/^crm-confirmation-test-[0-9a-f]{32}$/.test(disposableMarker) ||
  databaseName !== disposableMarker
) {
  throw new Error(
    "Anexos do atendimento integration tests require a uniquely named disposable database. " +
    "Use a database named crm-confirmation-test-<32 hex>; refusing shared DATABASE_URL.",
  );
}

const { default: app } = await import("../app");
const { createSessionToken } = await import("../lib/session");
const { logger } = await import("../lib/logger");
const {
  accessProfilesTable, canalEnvios, classesTable, commercialOpportunityEvents, conversations, coursesTable, cursosInscricao, db,
  mensagemAnexos, messages, pessoasTable, usersTable,
} = await import("@workspace/db");
const { createOpportunity, transitionOpportunity, OpportunityRuleError } = await import("../services/commercialOpportunities");
const { registrarContato } = await import("../services/contatoAutorizacao");
const { assumirConversa } = await import("../services/crmChat");
const { enviarAnexoDaEquipe } = await import("../services/crmChatAnexos");
const { criarArmazenamentoEmMemoria, definirArmazenamentoDeAnexosParaTestes } = await import("../services/anexosArmazenamento");
const { JANELA_24H_MS } = await import("../services/crmChat");
const { limparCacheHablla } = await import("../services/habllaClient");
const { LIMITE_DE_ENVIO } = await import("../services/anexosConteudo");

const WS = "ws-anexos";
const ZAP = "conexao-zap-anexos";
const ENV = {
  HABLLA_API_TOKEN: "token-falso",
  HABLLA_WORKSPACE_ID: WS,
  HABLLA_WHATSAPP_CONNECTION_ID: ZAP,
  HABLLA_API_URL: "https://hablla.test",
} as NodeJS.ProcessEnv;
const BASE = `/v1/workspace/${WS}`;

const armazenamento = criarArmazenamentoEmMemoria();
definirArmazenamentoDeAnexosParaTestes(armazenamento);

const texto = (valor: string) => Buffer.from(valor, "latin1");
const comRelleno = (inicio: Buffer, total = 2048) => Buffer.concat([inicio, Buffer.alloc(Math.max(0, total - inicio.length), 7)]);
const PNG = comRelleno(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const MP3 = comRelleno(texto("ID3\u0004"));
const PDF = comRelleno(texto("%PDF-1.7\n"));
const HTML = texto("<html><script>alert(1)</script></html>");

type Envio = { campos: Record<string, string>; arquivo: { nome: string; tamanho: number } | null };

/** Hablla de mentira: aceita (202) ou recusa o envio multipart, sempre registrando o que recebeu. */
function habllaFalso(opcoes: { statusDoEnvio?: number; mensagemDeErro?: string } = {}) {
  const envios: Envio[] = [];
  let chamadas = 0;
  const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas += 1;
    const caminho = String(url).replace("https://hablla.test", "");
    const metodo = init?.method ?? "GET";
    const resposta = (status: number, corpo: unknown) => ({ status, text: async () => JSON.stringify(corpo) }) as Response;
    if (metodo === "GET" && caminho === `${BASE}/connection/${ZAP}`) {
      return resposta(200, { id: ZAP, workspace: WS, name: "Zap teste", scope: "WHATSAPP_MESSAGING", status: "active" });
    }
    if (metodo === "POST" && caminho.endsWith("/messages/send")) {
      const formulario = init!.body as FormData;
      const campos: Record<string, string> = {};
      let arquivo: Envio["arquivo"] = null;
      for (const [chave, valor] of formulario.entries()) {
        if (typeof valor === "string") campos[chave] = valor;
        else arquivo = { nome: valor.name, tamanho: valor.size };
      }
      envios.push({ campos, arquivo });
      return (opcoes.statusDoEnvio ?? 202) >= 400
        ? resposta(opcoes.statusDoEnvio!, { message: opcoes.mensagemDeErro ?? "falhou" })
        : resposta(202, { task_id: `fila-${envios.length}` });
    }
    throw new Error(`chamada inesperada ao Hablla falso: ${metodo} ${caminho}`);
  });
  return { deps: { fetch: fetchFalso as unknown as typeof fetch, env: ENV }, envios, chamadas: () => chamadas };
}

const marker = `anexos-${randomUUID()}`;
const celular = () => `119${randomInt(10_000_000, 99_999_999)}`;

type Equipe = { id: number; token: string; actor: { kind: "HUMAN"; id: number; role: string } };
let ana: Equipe;
let soCrm: Equipe;
let crmEConversas: Equipe;
let soPessoas: Equipe;
let soChat: Equipe;
let administradora: Equipe;
let pastaTemporaria = "";
let ofertaA: number;
let ofertaB: number;

async function criarUsuario(nome: string, areas: string[], isAdmin = false): Promise<Equipe> {
  const [perfil] = await db.insert(accessProfilesTable).values({ name: `${marker} ${nome}`, areas, isAdmin }).returning({ id: accessProfilesTable.id });
  const [usuario] = await db.insert(usersTable).values({
    name: nome, email: `${marker}-${nome.toLowerCase().replace(/\W+/g, "")}@example.test`, role: "usuario", active: true, profileId: perfil!.id,
  }).returning({ id: usersTable.id });
  return { id: usuario!.id, token: createSessionToken(usuario!.id), actor: { kind: "HUMAN", id: usuario!.id, role: "usuario" } };
}
const auth = (equipe: Equipe) => ({ Authorization: `Bearer ${equipe.token}` });

async function criarPessoa() {
  const [pessoa] = await db.insert(pessoasTable).values({
    codigo: `${marker}-${randomUUID()}`, nome: "Marina Teste", celular: celular(),
  }).returning({ id: pessoasTable.id, celular: pessoasTable.celular });
  return { id: pessoa!.id, celular: pessoa!.celular!.replace(/\D/g, "") };
}

async function criarCartao(pessoaId: number, cursosInscricaoId: number = ofertaA) {
  const cartao = await createOpportunity({
    pessoaId, nucleus: "EXPERIENCES", cursosInscricaoId, offerLabel: "Teste de anexos", ownerUserId: ana.id,
    nextTaskType: "CALL", nextTaskText: "Ligar", nextTaskAt: new Date("2099-03-01T12:00:00.000Z"),
    source: "ANEXOS_TEST", actor: ana.actor, idempotencyKey: `anexos-${randomUUID()}`,
  });
  return cartao.id;
}

async function encerrarCartao(opportunityId: number) {
  await transitionOpportunity({
    opportunityId, toStage: "CLOSED", reason: "fim do teste", source: "ANEXOS_TEST",
    idempotencyKey: `anexos-fim-${opportunityId}-${randomUUID()}`, actor: ana.actor,
  });
}

async function conversaDoWhatsapp(pessoaId: number, celularNacional: string, status: "ativa" | "aguardando_humano" | "atendimento_humano" = "atendimento_humano") {
  const [conversa] = await db.insert(conversations).values({
    title: "WhatsApp teste", canal: "whatsapp", canalUsuario: `55${celularNacional}`, pessoaId, status,
  }).returning({ id: conversations.id });
  return conversa!.id;
}

async function mensagemDaPessoa(conversationId: number, quando = new Date()) {
  await db.insert(messages).values({ conversationId, role: "user", content: "Oi, quero saber mais", createdAt: quando });
}

/** Cartão aberto com conversa vinculada e janela de 24h aberta; por padrão o atendimento já foi assumido pela equipe. */
async function cenarioPronto(status: "ativa" | "atendimento_humano" = "atendimento_humano") {
  const pessoa = await criarPessoa();
  const id = await criarCartao(pessoa.id);
  const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular, status);
  await mensagemDaPessoa(conversationId);
  return { pessoa, id, conversationId };
}

async function arquivoTemporario(conteudo: Buffer, nome: string) {
  const caminho = join(pastaTemporaria, `${randomUUID()}-${nome.replace(/[^\w.]/g, "_")}`);
  await writeFile(caminho, conteudo);
  return { caminho, tamanho: conteudo.length, sha256: createHash("sha256").update(conteudo).digest("hex"), nomeOriginal: nome };
}

async function codigoDoErro(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (erro) {
    if (erro instanceof OpportunityRuleError) return erro.code ?? "sem-codigo";
    throw erro;
  }
  return "nenhum-erro";
}

const acoesDoCartao = async (opportunityId: number) =>
  (await db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, opportunityId)))
    .map(e => (e.metadata as { action?: string }).action).filter(Boolean);

const arquivosTemporariosDoRecebimento = async () => (await readdir(tmpdir())).filter(n => n.startsWith("anexo-")).sort();

const objetosDaConversa = (conversationId: number) => [...armazenamento.objetos.keys()].filter(k => k.startsWith(`anexos/${conversationId}/`));

/** Insere um anexo recebido já guardado (mensagem + registro + objeto no armazenamento). */
async function anexoGuardado(conversationId: number, opcoes: {
  tipo?: "image" | "video" | "audio" | "document"; mime?: string; conteudo?: Buffer; nome?: string | null; copia?: "pendente" | "copiado" | "indisponivel" | "recusado"; naoVisto?: boolean;
} = {}) {
  const conteudo = opcoes.conteudo ?? PNG;
  const copia = opcoes.copia ?? "copiado";
  const chave = `anexos/${conversationId}/${randomUUID()}`;
  if (copia === "copiado") await armazenamento.gravar(chave, conteudo, "application/octet-stream");
  const [mensagem] = await db.insert(messages).values({ conversationId, role: "user", content: "", kind: "anexo" }).returning({ id: messages.id });
  const [anexo] = await db.insert(mensagemAnexos).values({
    messageId: mensagem!.id, conversationId, direcao: "recebido", tipo: opcoes.tipo ?? "image", nome: opcoes.nome ?? null,
    mimeType: opcoes.mime ?? "image/png", tamanhoBytes: copia === "copiado" ? conteudo.length : null,
    copia, storageKey: copia === "copiado" ? chave : null, motivo: copia === "recusado" ? "conteudo_nao_confere" : null,
    vistoEm: opcoes.naoVisto === false ? new Date() : null,
  }).returning({ id: mensagemAnexos.id });
  return { id: anexo!.id, messageId: mensagem!.id, chave };
}

beforeAll(async () => {
  pastaTemporaria = await mkdtemp(join(tmpdir(), "anexos-test-"));
  ana = await criarUsuario("Ana Prado", ["crm", "conversas", "pessoas"]);
  soCrm = await criarUsuario("So CRM", ["crm"]);
  crmEConversas = await criarUsuario("CRM e Conversas", ["crm", "conversas"]);
  soPessoas = await criarUsuario("So Pessoas", ["pessoas"]);
  soChat = await criarUsuario("So Chat", ["chat"]);
  administradora = await criarUsuario("Admin", ["pessoas", "conversas", "crm"], true);

  const [curso] = await db.insert(coursesTable).values({ name: `${marker} curso`, cycle: "t", modality: "presencial", workload: 1, price: "1.00" }).returning({ id: coursesTable.id });
  const [turma] = await db.insert(classesTable).values({ courseId: curso!.id, code: `${marker}-t1`, startDate: "2099-01-01", endDate: "2099-01-02", teacher: "t" }).returning({ id: classesTable.id });
  const [turmaB] = await db.insert(classesTable).values({ courseId: curso!.id, code: `${marker}-t2`, startDate: "2099-02-01", endDate: "2099-02-02", teacher: "t" }).returning({ id: classesTable.id });
  const [a] = await db.insert(cursosInscricao).values({ slug: `${marker}-a`, nome: `${marker} evento A`, nucleo: "EXPERIENCES", tipoEvento: "VIVENCIA", classId: turma!.id, courseId: curso!.id }).returning({ id: cursosInscricao.id });
  const [b] = await db.insert(cursosInscricao).values({ slug: `${marker}-b`, nome: `${marker} evento B`, nucleo: "EXPERIENCES", tipoEvento: "VIVENCIA", classId: turmaB!.id, courseId: curso!.id }).returning({ id: cursosInscricao.id });
  ofertaA = a!.id;
  ofertaB = b!.id;
});

afterAll(async () => {
  definirArmazenamentoDeAnexosParaTestes(null);
  await rm(pastaTemporaria, { recursive: true, force: true });
});

beforeEach(() => {
  limparCacheHablla();
  armazenamento.falharProximaGravacao = false;
});

describe("envio de arquivo pela equipe no chat do cartão", () => {
  it("antes de assumir o atendimento nada é guardado nem enviado", async () => {
    const { id, conversationId } = await cenarioPronto("ativa");
    const hablla = habllaFalso();
    const arquivo = await arquivoTemporario(PNG, "foto.png");
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda: "", deps: hablla.deps, armazenamento }))).toBe("ATTENDANCE_NOT_ASSUMED");
    expect(hablla.envios).toHaveLength(0);
    expect(objetosDaConversa(conversationId)).toEqual([]);
    expect(await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversationId))).toHaveLength(0);
    await encerrarCartao(id);
  });

  it("depois de assumir envia uma única vez, com legenda, e registra mensagem, arquivo, envio e histórico do cartão", async () => {
    const { pessoa, id } = await cenarioPronto("ativa");
    // Outro cartão aberto da mesma pessoa também recebe o registro no histórico.
    const outroId = await criarCartao(pessoa.id, ofertaB);
    await assumirConversa({ opportunityId: id, actor: ana.actor });
    const hablla = habllaFalso();
    const arquivo = await arquivoTemporario(PNG, "Foto do local.png");
    const { messageId, anexoId } = await enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda: "  Segue a foto  ", deps: hablla.deps, armazenamento });

    expect(hablla.envios).toHaveLength(1);
    expect(hablla.envios[0]!.campos).toMatchObject({ type: "image", phone: `55${pessoa.celular}`, caption: "Segue a foto" });
    expect(hablla.envios[0]!.arquivo).toEqual({ nome: "Foto do local.png", tamanho: PNG.length });

    const [mensagem] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(mensagem).toMatchObject({ role: "staff", kind: "anexo", content: "Segue a foto", authorUserId: ana.id });
    const [anexo] = await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.id, anexoId));
    expect(anexo).toMatchObject({ direcao: "enviado", tipo: "image", copia: "copiado", mimeType: "image/png", tamanhoBytes: PNG.length, nome: "Foto do local.png" });
    expect(armazenamento.objetos.get(anexo!.storageKey!)!.conteudo.equals(PNG)).toBe(true);
    const [envio] = await db.select().from(canalEnvios).where(eq(canalEnvios.messageId, messageId));
    expect(envio).toMatchObject({ status: "aceito", filaId: "fila-1" });

    for (const cartao of [id, outroId]) {
      expect((await acoesDoCartao(cartao)).filter(a => a === "ATTACHMENT_SENT")).toHaveLength(1);
    }
    await encerrarCartao(id);
    await encerrarCartao(outroId);
  });

  it("documento: o nome vai limpo e o arquivo segue como documento", async () => {
    const { pessoa, id } = await cenarioPronto();
    const hablla = habllaFalso();
    await enviarAnexoDaEquipe({
      opportunityId: id, actor: ana.actor, arquivo: await arquivoTemporario(PDF, "../../Contrato 2026.pdf"), legenda: "", deps: hablla.deps, armazenamento,
    });
    expect(hablla.envios[0]!.campos).toMatchObject({ type: "document", phone: `55${pessoa.celular}`, filename: "Contrato 2026.pdf" });
    expect(hablla.envios[0]!.campos.caption).toBeUndefined();
    await encerrarCartao(id);
  });

  it("janela de 24h fechada, pessoa que não quer receber e cartão encerrado: recusa sem guardar nem enviar", async () => {
    const hablla = habllaFalso();
    const arquivo = await arquivoTemporario(PNG, "foto.png");

    const fechada = await criarPessoa();
    const idFechada = await criarCartao(fechada.id);
    const conversaFechada = await conversaDoWhatsapp(fechada.id, fechada.celular);
    await mensagemDaPessoa(conversaFechada, new Date(Date.now() - JANELA_24H_MS - 60_000));
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: idFechada, actor: ana.actor, arquivo, legenda: "", deps: hablla.deps, armazenamento }))).toBe("OUTSIDE_WINDOW");

    const semContato = await criarPessoa();
    const idSemContato = await criarCartao(semContato.id);
    const conversaSemContato = await conversaDoWhatsapp(semContato.id, semContato.celular);
    await mensagemDaPessoa(conversaSemContato);
    await registrarContato({ pessoaId: semContato.id, kind: "NAO_QUER_RECEBER", origem: "CONVERSA_WHATSAPP", actor: ana.actor });
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: idSemContato, actor: ana.actor, arquivo, legenda: "", deps: hablla.deps, armazenamento }))).toBe("OPTED_OUT");

    const encerrado = await cenarioPronto();
    await encerrarCartao(encerrado.id);
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: encerrado.id, actor: ana.actor, arquivo, legenda: "", deps: hablla.deps, armazenamento }))).not.toBe("nenhum-erro");

    expect(hablla.chamadas()).toBe(0);
    for (const conversa of [conversaFechada, conversaSemContato, encerrado.conversationId]) {
      expect(objetosDaConversa(conversa)).toEqual([]);
      expect(await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversa))).toHaveLength(0);
    }
    await encerrarCartao(idFechada);
    await encerrarCartao(idSemContato);
  });

  it("só pessoa da equipe envia arquivo", async () => {
    const { id } = await cenarioPronto();
    const hablla = habllaFalso();
    const arquivo = await arquivoTemporario(PNG, "foto.png");
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: id, actor: { kind: "SOFIA" }, arquivo, legenda: "", deps: hablla.deps, armazenamento }))).toBe("HUMAN_REQUIRED");
    expect(hablla.chamadas()).toBe(0);
    await encerrarCartao(id);
  });

  it("arquivo que não confere é recusado antes de qualquer envio: tipo falso, vazio, grande demais, áudio com legenda, legenda longa", async () => {
    const { id, conversationId } = await cenarioPronto();
    const hablla = habllaFalso();
    const enviar = (conteudo: Buffer, nome: string, legenda = "") => arquivoTemporario(conteudo, nome).then(arquivo =>
      codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda, deps: hablla.deps, armazenamento })));

    expect(await enviar(HTML, "foto.png")).toBe("ATTACHMENT_TYPE_NOT_ALLOWED");
    expect(await enviar(texto("MZ"), "programa.pdf")).toBe("ATTACHMENT_TYPE_NOT_ALLOWED");
    expect(await enviar(Buffer.concat([PNG, Buffer.alloc(LIMITE_DE_ENVIO.image)]), "grande.png")).toBe("ATTACHMENT_TOO_LARGE");
    expect(await enviar(MP3, "audio.mp3", "legenda não vale em áudio")).toBe("CAPTION_NOT_ALLOWED");
    expect(await enviar(PNG, "foto.png", "x".repeat(1_025))).toBe("TEXT_TOO_LONG");
    expect(hablla.chamadas()).toBe(0);
    expect(objetosDaConversa(conversationId)).toEqual([]);
    await encerrarCartao(id);
  });

  it("falha no envio: uma tentativa só, o arquivo e a falha ficam visíveis e nada é reenviado nem entra no histórico como enviado", async () => {
    const { pessoa, id, conversationId } = await cenarioPronto();
    const hablla = habllaFalso({ statusDoEnvio: 500 });
    const arquivo = await arquivoTemporario(PNG, "foto.png");
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda: `Para ${pessoa.celular}`, deps: hablla.deps, armazenamento }))).toBe("SEND_FAILED");
    expect(hablla.envios).toHaveLength(1);

    const [mensagem] = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.kind, "anexo")));
    expect(mensagem).toMatchObject({ role: "staff", content: `Para ${pessoa.celular}` });
    const [envio] = await db.select().from(canalEnvios).where(eq(canalEnvios.messageId, mensagem!.id));
    expect(envio?.status).toBe("falhou");
    expect((await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.messageId, mensagem!.id)))[0]).toMatchObject({ direcao: "enviado", copia: "copiado" });
    expect(await acoesDoCartao(id)).not.toContain("ATTACHMENT_SENT");
    await encerrarCartao(id);
  });

  it("falha ao guardar o arquivo: nada é registrado nem enviado", async () => {
    const { id, conversationId } = await cenarioPronto();
    const hablla = habllaFalso();
    armazenamento.falharProximaGravacao = true;
    const arquivo = await arquivoTemporario(PNG, "foto.png");
    expect(await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda: "", deps: hablla.deps, armazenamento }))).toBe("ATTACHMENT_STORAGE_FAILED");
    expect(hablla.chamadas()).toBe(0);
    expect(objetosDaConversa(conversationId)).toEqual([]);
    expect(await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.kind, "anexo")))).toHaveLength(0);
    await encerrarCartao(id);
  });

  it("os logs não trazem telefone, nome do arquivo, legenda nem a mensagem de erro do provedor", async () => {
    const linhas: string[] = [];
    const registrar = (...args: unknown[]) => {
      linhas.push(JSON.stringify(args, (_chave, valor) => (valor instanceof Error ? { name: valor.name, message: valor.message, stack: valor.stack } : valor)));
    };
    const falso: Record<string, unknown> = {};
    for (const nivel of ["info", "warn", "error", "debug", "trace", "fatal"]) falso[nivel] = registrar;
    falso.child = () => falso;
    for (const nivel of ["info", "warn", "error", "debug", "trace", "fatal"] as const) vi.spyOn(logger, nivel).mockImplementation(registrar as never);
    vi.spyOn(logger, "child").mockImplementation((() => falso) as never);
    try {
      const { pessoa, id } = await cenarioPronto();
      const hablla = habllaFalso({ statusDoEnvio: 400, mensagemDeErro: `recusou 55${pessoa.celular} legenda-secreta` });
      const arquivo = await arquivoTemporario(PNG, "nome-secreto.png");
      await codigoDoErro(() => enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda: "legenda-secreta", deps: hablla.deps, armazenamento }));
      await codigoDoErro(() => {
        armazenamento.falharProximaGravacao = true;
        return enviarAnexoDaEquipe({ opportunityId: id, actor: ana.actor, arquivo, legenda: "legenda-secreta", deps: habllaFalso().deps, armazenamento });
      });
      const tudo = linhas.join("\n");
      expect(linhas.length).toBeGreaterThan(0);
      for (const proibido of [pessoa.celular, `55${pessoa.celular}`, "nome-secreto", "legenda-secreta", "Marina Teste"]) expect(tudo).not.toContain(proibido);
      await encerrarCartao(id);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("envio pelas rotas: áreas e recusas antes de qualquer envio", () => {
  const anexar = (id: number, equipe: Equipe | null, arquivo?: { conteudo: Buffer; nome: string }) => {
    const req = request(app).post(`/api/crm/opportunities/${id}/chat/anexos`);
    if (equipe) req.set(auth(equipe));
    if (arquivo) req.attach("arquivo", arquivo.conteudo, { filename: arquivo.nome });
    return req;
  };

  it("exige login e as duas áreas (CRM e Conversas)", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const foto = { conteudo: PNG, nome: "foto.png" };
    expect((await anexar(id, null, foto)).status).toBe(401);
    for (const sem of [soCrm, soPessoas, soChat]) expect((await anexar(id, sem, foto)).status).toBe(403);
    await encerrarCartao(id);
  });

  it("sem arquivo, tipo falso ou sem conversa vinculada: recusa com código claro e nada é gravado", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const antesDosTemporarios = await arquivosTemporariosDoRecebimento();
    expect((await anexar(id, crmEConversas)).body.code).toBe("FILE_REQUIRED");
    const falso = await anexar(id, crmEConversas, { conteudo: HTML, nome: "foto.png" });
    expect(falso.status).toBe(422);
    expect(falso.body.code).toBe("ATTACHMENT_TYPE_NOT_ALLOWED");
    const semConversa = await anexar(id, crmEConversas, { conteudo: PNG, nome: "foto.png" });
    expect(semConversa.status).toBe(409);
    expect(semConversa.body.code).toBe("CONVERSATION_NOT_LINKED");
    // O arquivo temporário do recebimento é apagado mesmo na recusa.
    expect(await arquivosTemporariosDoRecebimento()).toEqual(antesDosTemporarios);
    await encerrarCartao(id);
  });

  it("imagem acima do limite do tipo é recusada com 413", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const grande = await anexar(id, crmEConversas, { conteudo: Buffer.concat([PNG, Buffer.alloc(LIMITE_DE_ENVIO.image)]), nome: "grande.png" });
    expect(grande.status).toBe(413);
    expect(grande.body.code).toBe("ATTACHMENT_TOO_LARGE");
    await encerrarCartao(id);
  });
});

describe("rota que serve o arquivo", () => {
  const baixar = (id: number, equipe: Equipe | null, cabecalhos: Record<string, string> = {}) => {
    const req = request(app).get(`/api/anexos/${id}/arquivo`).set(cabecalhos).buffer(true).parse((res, cb) => {
      const partes: Buffer[] = [];
      res.on("data", (p: Buffer) => partes.push(p));
      res.on("end", () => cb(null, Buffer.concat(partes)));
    });
    if (equipe) req.set(auth(equipe));
    return req;
  };

  it("exige login e a área Conversas; só o servidor decide (sem link público)", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    const anexo = await anexoGuardado(conversationId);
    expect((await baixar(anexo.id, null)).status).toBe(401);
    for (const sem of [soCrm, soPessoas, soChat]) expect((await baixar(anexo.id, sem)).status).toBe(403);
    const ok = await baixar(anexo.id, crmEConversas);
    expect(ok.status).toBe(200);
    expect((ok.body as Buffer).equals(PNG)).toBe(true);
  });

  it("imagem abre na tela com cabeçalhos de segurança; o nome vem seguro e nada fica em cache", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    const anexo = await anexoGuardado(conversationId, { nome: 'fo"to\r\nX-Injetado: 1.png' });
    const res = await baixar(anexo.id, crmEConversas);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-disposition"]).toMatch(/^inline; filename="/);
    expect(res.headers["x-injetado"]).toBeUndefined();
    expect(res.headers["content-length"]).toBe(String(PNG.length));
  });

  it("documento nunca abre na tela: vai como download, com tipo genérico", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    const anexo = await anexoGuardado(conversationId, { tipo: "document", mime: "application/pdf", conteudo: PDF, nome: "contrato.pdf" });
    const res = await baixar(anexo.id, crmEConversas);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="contrato.pdf"/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("Range: devolve só o trecho (206) com Content-Range; pedido fora do arquivo dá 416", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    const anexo = await anexoGuardado(conversationId, { tipo: "audio", mime: "audio/mpeg", conteudo: MP3 });
    const trecho = await baixar(anexo.id, crmEConversas, { Range: "bytes=4-19" });
    expect(trecho.status).toBe(206);
    expect(trecho.headers["content-range"]).toBe(`bytes 4-19/${MP3.length}`);
    expect(trecho.headers["content-length"]).toBe("16");
    expect((trecho.body as Buffer).equals(MP3.subarray(4, 20))).toBe(true);
    const final = await baixar(anexo.id, crmEConversas, { Range: "bytes=-10" });
    expect(final.status).toBe(206);
    expect((final.body as Buffer).equals(MP3.subarray(MP3.length - 10))).toBe(true);
    const fora = await baixar(anexo.id, crmEConversas, { Range: `bytes=${MP3.length + 5}-` });
    expect(fora.status).toBe(416);
    expect(fora.headers["content-range"]).toBe(`bytes */${MP3.length}`);
  });

  it("arquivo ainda copiando, indisponível, recusado ou inexistente não é servido", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    for (const copia of ["pendente", "indisponivel", "recusado"] as const) {
      const anexo = await anexoGuardado(conversationId, { copia });
      const res = await baixar(anexo.id, crmEConversas);
      expect(res.status).toBe(404);
    }
    expect((await baixar(2_000_000_000, crmEConversas)).status).toBe(404);
    expect((await request(app).get("/api/anexos/abc/arquivo").set(auth(crmEConversas))).status).toBe(400);
  });

  it("pedir nova cópia de arquivo que já está copiado ou sem endereço não é permitido e exige Conversas", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    const copiado = await anexoGuardado(conversationId);
    const recusado = await anexoGuardado(conversationId, { copia: "recusado" });
    expect((await request(app).post(`/api/anexos/${copiado.id}/recopiar`).set(auth(crmEConversas))).status).toBe(409);
    expect((await request(app).post(`/api/anexos/${recusado.id}/recopiar`).set(auth(crmEConversas))).status).toBe(409);
    expect((await request(app).post(`/api/anexos/${copiado.id}/recopiar`).set(auth(soCrm))).status).toBe(403);
    expect((await request(app).post("/api/anexos/2000000000/recopiar").set(auth(crmEConversas))).status).toBe(404);
  });
});

describe("arquivo visto pela equipe", () => {
  const naoVistos = async (conversationId: number) =>
    (await db.select().from(mensagemAnexos).where(and(eq(mensagemAnexos.conversationId, conversationId), eq(mensagemAnexos.direcao, "recebido")))).filter(a => a.vistoEm === null).length;

  it("abrir o chat do cartão marca como visto quem tem CRM e Conversas; sem as duas áreas nada é marcado", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    await anexoGuardado(conversationId);
    await anexoGuardado(conversationId);
    expect(await naoVistos(conversationId)).toBe(2);

    expect((await request(app).post(`/api/crm/opportunities/${id}/chat/vistos`).set(auth(soCrm))).status).toBe(403);
    expect(await naoVistos(conversationId)).toBe(2);
    expect((await request(app).post(`/api/crm/opportunities/${id}/chat/vistos`).set(auth(crmEConversas))).status).toBe(204);
    expect(await naoVistos(conversationId)).toBe(0);
    const [marcado] = await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversationId));
    expect(marcado!.vistoPor).toBe(crmEConversas.id);
    await encerrarCartao(id);
  });

  it("cartão sem conversa vinculada: nada a marcar, sem erro", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    expect((await request(app).post(`/api/crm/opportunities/${id}/chat/vistos`).set(auth(crmEConversas))).status).toBe(204);
    await encerrarCartao(id);
  });

  it("abrir a conversa em Conversas marca como visto; a área Chat (teste da Sofia) não marca", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    await anexoGuardado(conversationId);
    expect((await request(app).post(`/api/sofia/conversations/${conversationId}/anexos/vistos`).set(auth(soChat))).status).toBe(403);
    expect((await request(app).post(`/api/sofia/conversations/${conversationId}/anexos/vistos`).set(auth(soPessoas))).status).toBe(403);
    expect(await naoVistos(conversationId)).toBe(1);
    expect((await request(app).post(`/api/sofia/conversations/${conversationId}/anexos/vistos`).set(auth(crmEConversas))).status).toBe(204);
    expect(await naoVistos(conversationId)).toBe(0);
  });

  it("a conversa na ficha mostra tudo, só exige Conversas e nunca marca como visto", async () => {
    const pessoa = await criarPessoa();
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    await mensagemDaPessoa(conversationId);
    const anexo = await anexoGuardado(conversationId, { nome: null });

    expect((await request(app).get(`/api/pessoas/${pessoa.id}/whatsapp/conversa`).set(auth(soPessoas))).status).toBe(403);
    const res = await request(app).get(`/api/pessoas/${pessoa.id}/whatsapp/conversa`).set(auth(ana));
    expect(res.status).toBe(200);
    const doArquivo = (res.body.mensagens as Array<{ id: number; anexo: Record<string, unknown> | null }>).find(m => m.id === anexo.messageId)!;
    expect(doArquivo.anexo).toMatchObject({ id: anexo.id, tipo: "image", copia: "copiado", naoVisto: true });
    // O endereço, a chave do armazenamento e o hash nunca chegam à tela.
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|urlOrigem|sha256|anexos\//);
    expect(await naoVistos(conversationId)).toBe(1);
  });
});

describe("apagar a ficha", () => {
  it("apaga também os arquivos guardados da conversa, e só os dela", async () => {
    const apagada = await criarPessoa();
    const mantida = await criarPessoa();
    const conversaApagada = await conversaDoWhatsapp(apagada.id, apagada.celular);
    const conversaMantida = await conversaDoWhatsapp(mantida.id, mantida.celular);
    await anexoGuardado(conversaApagada);
    await anexoGuardado(conversaApagada, { tipo: "audio", mime: "audio/mpeg", conteudo: MP3 });
    await anexoGuardado(conversaMantida);
    expect(objetosDaConversa(conversaApagada)).toHaveLength(2);

    expect((await request(app).delete(`/api/pessoas/${apagada.id}`).set(auth(ana))).status).toBe(403);
    expect(objetosDaConversa(conversaApagada)).toHaveLength(2);
    expect((await request(app).delete(`/api/pessoas/${apagada.id}`).set(auth(administradora))).status).toBe(204);

    expect(objetosDaConversa(conversaApagada)).toEqual([]);
    expect(objetosDaConversa(conversaMantida)).toHaveLength(1);
    expect(await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversaApagada))).toHaveLength(0);
    expect(await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversaMantida))).toHaveLength(1);
  });
});
