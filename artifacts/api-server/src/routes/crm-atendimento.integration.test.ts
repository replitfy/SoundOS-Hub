// Atendimento do cartão do CRM (informações, observações, tarefas, compromissos, autorização de contato,
// conversa e modelo de abertura do WhatsApp) contra um banco descartável. Nunca fala com o Hablla de
// verdade: os serviços recebem `deps` com um `fetch` falso que registra cada chamada.
import { randomInt, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, asc, eq } from "drizzle-orm";

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
    "CRM atendimento integration tests require a uniquely named disposable database. " +
    "Use pnpm test:integration:crm-confirmation; refusing shared DATABASE_URL.",
  );
}

const { default: app } = await import("../app");
const { createSessionToken } = await import("../lib/session");
const {
  accessProfilesTable, canalContatos, canalEnvios, classesTable, commercialOpportunities, commercialOpportunityEvents, conversations,
  coursesTable, cursosInscricao, db, messages, pessoaContatoRegistros, pessoaNotes, pessoasTable, usersTable,
} = await import("@workspace/db");
const { createOpportunity, transitionOpportunity, OpportunityRuleError } = await import("../services/commercialOpportunities");
const {
  adicionarObservacao, apagarCompromisso, apagarTarefa, criarCompromisso, criarTarefa, definirTarefaExecutada, salvarInformacoes,
} = await import("../services/crmAtendimento");
const { registrarContato } = await import("../services/contatoAutorizacao");
const { montarNotaConferencia, NOTA_CONTATO_DIVERGENTE, NOTA_FICHA_EM_CONFERENCIA } = await import("../services/identidadeConferencia");
const { assumirConversa, carregarChat, devolverConversaParaSofia, enviarTextoDaEquipe, JANELA_24H_MS } = await import("../services/crmChat");
const { enviarAbertura, previaDaAbertura } = await import("../services/whatsappModeloAbertura");
const { limparCacheHablla } = await import("../services/habllaClient");

const WS = "ws-teste";
const ZAP = "conexao-zap";
const ENV = {
  HABLLA_API_TOKEN: "token-falso",
  HABLLA_WORKSPACE_ID: WS,
  HABLLA_WHATSAPP_CONNECTION_ID: ZAP,
  HABLLA_API_URL: "https://hablla.test",
} as NodeJS.ProcessEnv;
const BASE = `/v1/workspace/${WS}`;

type Chamada = { metodo: string; caminho: string; corpo: Record<string, unknown> | null };

/** Hablla de mentira: devolve a conexão, o modelo e aceita (202) ou recusa o envio, sempre registrando a chamada. */
function habllaFalso(opcoes: { statusDoModelo?: string; corpoDoModelo?: string; statusDoEnvio?: number } = {}) {
  const chamadas: Chamada[] = [];
  const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
    const caminho = String(url).replace("https://hablla.test", "");
    const metodo = init?.method ?? "GET";
    chamadas.push({ metodo, caminho, corpo: init?.body ? JSON.parse(String(init.body)) : null });
    const resposta = (status: number, corpo: unknown) => ({ status, text: async () => JSON.stringify(corpo) }) as Response;
    if (metodo === "GET" && caminho === `${BASE}/connection/${ZAP}`) {
      return resposta(200, { id: ZAP, workspace: WS, name: "Zap teste", scope: "WHATSAPP_MESSAGING", status: "active" });
    }
    if (metodo === "GET" && caminho.startsWith(`${BASE}/meta/connection/${ZAP}/whatsapp-messaging/templates`)) {
      return resposta(200, {
        results: [{
          id: "modelo-1", name: "sofia_iniciar_conversa", language: "pt_BR", status: opcoes.statusDoModelo ?? "APPROVED",
          components: [{ type: "BODY", text: opcoes.corpoDoModelo ?? "Olá, {{1}}! Aqui é a equipe da Soundfulness." }],
        }],
      });
    }
    if (metodo === "POST" && caminho.endsWith("/templates/send")) {
      return (opcoes.statusDoEnvio ?? 202) >= 400 ? resposta(opcoes.statusDoEnvio!, { error: "falhou" }) : resposta(202, { task_id: `fila-${chamadas.length}` });
    }
    if (metodo === "POST" && caminho.endsWith("/messages/send")) {
      return (opcoes.statusDoEnvio ?? 202) >= 400 ? resposta(opcoes.statusDoEnvio!, { error: "falhou" }) : resposta(202, { task_id: `fila-${chamadas.length}` });
    }
    throw new Error(`chamada inesperada ao Hablla falso: ${metodo} ${caminho}`);
  });
  return {
    deps: { fetch: fetchFalso as unknown as typeof fetch, env: ENV },
    chamadas,
    envios: () => chamadas.filter(c => c.metodo === "POST"),
  };
}

const marker = `crm-atend-${randomUUID()}`;
const celular = () => `119${randomInt(10_000_000, 99_999_999)}`;

type Equipe = { id: number; token: string; actor: { kind: "HUMAN"; id: number; role: string } };
let ana: Equipe;
let paulo: Equipe;
let soCrm: Equipe;
let crmEConversas: Equipe;
let soPessoas: Equipe;
let offerId: number;
let courseId: number;
let otherCourseId: number;
let otherOfferId: number;

async function criarUsuario(nome: string, areas: string[] | null): Promise<Equipe> {
  let profileId: number | undefined;
  if (areas) {
    const [perfil] = await db.insert(accessProfilesTable).values({ name: `${marker} ${nome}`, areas, isAdmin: false }).returning({ id: accessProfilesTable.id });
    profileId = perfil!.id;
  }
  const [usuario] = await db.insert(usersTable).values({
    name: nome, email: `${marker}-${nome.toLowerCase().replace(/\W+/g, "")}@example.test`, role: "usuario", active: true, profileId,
  }).returning({ id: usersTable.id });
  return { id: usuario!.id, token: createSessionToken(usuario!.id), actor: { kind: "HUMAN", id: usuario!.id, role: "usuario" } };
}

const auth = (equipe: Equipe) => ({ Authorization: `Bearer ${equipe.token}` });

async function criarPessoa(valores: { nome?: string | null; celular?: string | null; arquivada?: boolean } = {}) {
  const [pessoa] = await db.insert(pessoasTable).values({
    codigo: `${marker}-${randomUUID()}`,
    nome: valores.nome === undefined ? "Marina Teste" : valores.nome ?? "",
    celular: valores.celular === undefined ? celular() : valores.celular,
    arquivadoEm: valores.arquivada ? new Date() : null,
  }).returning({ id: pessoasTable.id, celular: pessoasTable.celular });
  // O banco guarda o celular formatado ("11-95677-8360"); o WhatsApp usa só os dígitos.
  return { id: pessoa!.id, celular: (pessoa!.celular ?? "").replace(/\D/g, "") };
}

async function criarCartao(pessoaId: number, opcoes: { cursosInscricaoId?: number } = {}) {
  const cartao = await createOpportunity({
    pessoaId, nucleus: "EXPERIENCES", cursosInscricaoId: opcoes.cursosInscricaoId ?? offerId, offerLabel: "Teste de atendimento",
    ownerUserId: ana.id, nextTaskType: "CALL", nextTaskText: "Ligar", nextTaskAt: new Date("2099-03-01T12:00:00.000Z"),
    source: "CRM_ATENDIMENTO_TEST", actor: ana.actor, idempotencyKey: `atend-${randomUUID()}`,
  });
  return cartao.id;
}

async function encerrarCartao(opportunityId: number) {
  await transitionOpportunity({
    opportunityId, toStage: "CLOSED", reason: "fim do teste", source: "CRM_ATENDIMENTO_TEST",
    idempotencyKey: `atend-fim-${opportunityId}-${randomUUID()}`, actor: ana.actor,
  });
}

async function conversaDoWhatsapp(pessoaId: number, celularNacional: string, status: "ativa" | "aguardando_humano" | "atendimento_humano" = "ativa") {
  const [conversa] = await db.insert(conversations).values({
    title: "WhatsApp teste", canal: "whatsapp", canalUsuario: `55${celularNacional}`, pessoaId, status,
  }).returning({ id: conversations.id });
  return conversa!.id;
}

async function mensagemDaPessoa(conversationId: number, quando = new Date()) {
  await db.insert(messages).values({ conversationId, role: "user", content: "Oi, quero saber mais", createdAt: quando });
}

async function autorizar(pessoaId: number) {
  await registrarContato({ pessoaId, kind: "AUTORIZOU", origem: "PRESENCIAL", actor: ana.actor });
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

async function eventos(opportunityId: number) {
  return db.select().from(commercialOpportunityEvents)
    .where(eq(commercialOpportunityEvents.opportunityId, opportunityId)).orderBy(asc(commercialOpportunityEvents.id));
}

async function versao(opportunityId: number) {
  const [linha] = await db.select({ version: commercialOpportunities.version }).from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId));
  return linha!.version;
}

beforeAll(async () => {
  ana = await criarUsuario("Ana Prado", ["crm", "conversas", "pessoas"]);
  paulo = await criarUsuario("Paulo Lima", ["crm", "conversas", "pessoas"]);
  soCrm = await criarUsuario("So CRM", ["crm"]);
  crmEConversas = await criarUsuario("CRM e Conversas", ["crm", "conversas"]);
  soPessoas = await criarUsuario("So Pessoas", ["pessoas"]);

  const [curso] = await db.insert(coursesTable).values({ name: `${marker} curso`, cycle: "t", modality: "presencial", workload: 1, price: "1.00" }).returning({ id: coursesTable.id });
  const [outroCurso] = await db.insert(coursesTable).values({ name: `${marker} outro curso`, cycle: "t", modality: "presencial", workload: 1, price: "1.00" }).returning({ id: coursesTable.id });
  courseId = curso!.id;
  otherCourseId = outroCurso!.id;
  const [turma] = await db.insert(classesTable).values({ courseId, code: `${marker}-t1`, startDate: "2099-01-01", endDate: "2099-01-02", teacher: "t" }).returning({ id: classesTable.id });
  const [outraTurma] = await db.insert(classesTable).values({ courseId: otherCourseId, code: `${marker}-t2`, startDate: "2099-02-01", endDate: "2099-02-02", teacher: "t" }).returning({ id: classesTable.id });
  const [oferta] = await db.insert(cursosInscricao).values({ slug: `${marker}-o1`, nome: `${marker} evento 1`, nucleo: "EXPERIENCES", tipoEvento: "VIVENCIA", classId: turma!.id, courseId }).returning({ id: cursosInscricao.id });
  const [outraOferta] = await db.insert(cursosInscricao).values({ slug: `${marker}-o2`, nome: `${marker} evento 2`, nucleo: "EXPERIENCES", tipoEvento: "VIVENCIA", classId: outraTurma!.id, courseId: otherCourseId }).returning({ id: cursosInscricao.id });
  offerId = oferta!.id;
  otherOfferId = outraOferta!.id;
});

beforeEach(() => { limparCacheHablla(); });

describe("ações do cartão: informações, observações, tarefas e compromissos", () => {
  it("cada ação vira um evento UPDATED com a ação em metadata, com o autor, e não muda a versão do cartão", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const versaoInicial = await versao(id);

    await salvarInformacoes({ opportunityId: id, actor: ana.actor, informacoes: "Prefere manhã" });
    await adicionarObservacao({ opportunityId: id, actor: ana.actor, texto: "Ligou de volta" });
    const tarefa = await criarTarefa({ opportunityId: id, actor: ana.actor, texto: "Mandar proposta", prazo: "2099-04-01T12:00:00.000Z" });
    await definirTarefaExecutada({ opportunityId: id, taskId: tarefa.id, actor: paulo.actor, executada: true });
    await apagarTarefa({ opportunityId: id, taskId: tarefa.id, actor: ana.actor });
    const compromisso = await criarCompromisso({ opportunityId: id, actor: ana.actor, titulo: "Conversa", dataHora: "2099-05-01T15:00:00.000Z", link: "https://meet.example/x" });
    await apagarCompromisso({ opportunityId: id, appointmentId: compromisso.id, actor: ana.actor });

    const acoes = (await eventos(id)).filter(e => e.eventType === "UPDATED");
    expect(acoes.map(e => (e.metadata as { action: string }).action)).toEqual([
      "INFORMATION_UPDATED", "NOTE_ADDED", "TASK_CREATED", "TASK_DONE", "TASK_DELETED", "APPOINTMENT_CREATED", "APPOINTMENT_DELETED",
    ]);
    expect(acoes.every(e => e.actorKind === "HUMAN" && e.actorId !== null)).toBe(true);
    expect(acoes.find(e => (e.metadata as { action: string }).action === "TASK_DONE")?.actorId).toBe(paulo.id);
    // O texto do que foi apagado continua no histórico.
    expect(acoes.find(e => (e.metadata as { action: string }).action === "TASK_DELETED")?.metadata).toMatchObject({ text: "Mandar proposta" });
    expect(acoes.find(e => (e.metadata as { action: string }).action === "APPOINTMENT_DELETED")?.metadata).toMatchObject({ title: "Conversa" });
    expect(await versao(id)).toBe(versaoInicial);
    await encerrarCartao(id);
  });

  it("regravar as mesmas informações não cria evento; Sofia e sistema não executam ações", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    await salvarInformacoes({ opportunityId: id, actor: ana.actor, informacoes: "Igual" });
    const antes = (await eventos(id)).length;
    await salvarInformacoes({ opportunityId: id, actor: ana.actor, informacoes: "Igual" });
    expect((await eventos(id)).length).toBe(antes);
    expect(await codigoDoErro(() => adicionarObservacao({ opportunityId: id, actor: { kind: "SOFIA" }, texto: "oi" }))).toBe("HUMAN_REQUIRED");
    expect(await codigoDoErro(() => criarTarefa({ opportunityId: id, actor: { kind: "SYSTEM" }, texto: "x" }))).toBe("HUMAN_REQUIRED");
    await encerrarCartao(id);
  });

  it("cartão encerrado é só leitura para todas as ações", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular, "atendimento_humano");
    await mensagemDaPessoa(conversationId);
    await encerrarCartao(id);
    expect(await codigoDoErro(() => salvarInformacoes({ opportunityId: id, actor: ana.actor, informacoes: "x" }))).toBe("OPPORTUNITY_CLOSED");
    expect(await codigoDoErro(() => adicionarObservacao({ opportunityId: id, actor: ana.actor, texto: "x" }))).toBe("OPPORTUNITY_CLOSED");
    expect(await codigoDoErro(() => criarTarefa({ opportunityId: id, actor: ana.actor, texto: "x" }))).toBe("OPPORTUNITY_CLOSED");
    expect(await codigoDoErro(() => criarCompromisso({ opportunityId: id, actor: ana.actor, titulo: "x", dataHora: "2099-05-01T15:00:00.000Z" }))).toBe("OPPORTUNITY_CLOSED");
    const hablla = habllaFalso();
    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "x", deps: hablla.deps }))).toBe("OPPORTUNITY_CLOSED");
    expect(await codigoDoErro(() => assumirConversa({ opportunityId: id, actor: ana.actor }))).toBe("OPPORTUNITY_CLOSED");
    expect(hablla.chamadas).toHaveLength(0);
  });
});

describe("autorização de contato", () => {
  it("é um registro que só cresce: autorizar, pedir para não receber (vence), desfazer", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);

    await registrarContato({ pessoaId: pessoa.id, opportunityId: id, kind: "AUTORIZOU", origem: "FORMULARIO", actor: ana.actor });
    // Repetir o que já vale não cria um segundo registro.
    await registrarContato({ pessoaId: pessoa.id, kind: "AUTORIZOU", origem: "FORMULARIO", actor: ana.actor });
    let { estado } = await registrarContato({ pessoaId: pessoa.id, kind: "NAO_QUER_RECEBER", origem: "OUTRO", origemTexto: "Pediu por telefone", actor: paulo.actor });
    expect(estado).toMatchObject({ autorizado: true, naoQuerReceber: true });
    ({ estado } = await registrarContato({ pessoaId: pessoa.id, kind: "NAO_QUER_RECEBER_DESFEITO", origem: undefined, actor: ana.actor }));
    expect(estado).toMatchObject({ autorizado: true, naoQuerReceber: false });

    const registros = await db.select().from(pessoaContatoRegistros).where(eq(pessoaContatoRegistros.pessoaId, pessoa.id));
    expect(registros.map(r => r.kind).sort()).toEqual(["AUTORIZOU", "NAO_QUER_RECEBER", "NAO_QUER_RECEBER_DESFEITO"]);
    const acoes = (await eventos(id)).map(e => (e.metadata as { action?: string }).action).filter(Boolean);
    expect(acoes).toEqual(["CONTACT_AUTHORIZED", "CONTACT_OPT_OUT", "CONTACT_OPT_OUT_UNDONE"]);
    await encerrarCartao(id);
  });

  it("valida origem, exige descrição para 'outro' e só desfaz o que está ativo", async () => {
    const pessoa = await criarPessoa();
    expect(await codigoDoErro(() => registrarContato({ pessoaId: pessoa.id, kind: "AUTORIZOU", origem: "OUTRO", actor: ana.actor }))).toBe("ORIGIN_TEXT_REQUIRED");
    expect(await codigoDoErro(() => registrarContato({ pessoaId: pessoa.id, kind: "AUTORIZOU", origem: "INVENTADA", actor: ana.actor }))).toBe("INVALID_CONTACT_ORIGIN");
    expect(await codigoDoErro(() => registrarContato({ pessoaId: pessoa.id, kind: "TALVEZ", origem: "OUTRO", origemTexto: "x", actor: ana.actor }))).toBe("INVALID_CONTACT_KIND");
    expect(await codigoDoErro(() => registrarContato({ pessoaId: pessoa.id, kind: "NAO_QUER_RECEBER_DESFEITO", origem: undefined, actor: ana.actor }))).toBe("NOT_OPTED_OUT");
    expect(await codigoDoErro(() => registrarContato({ pessoaId: pessoa.id, kind: "AUTORIZOU", origem: "PRESENCIAL", actor: { kind: "SOFIA" } }))).toBe("HUMAN_REQUIRED");
  });
});

describe("conversa de WhatsApp no cartão (texto livre)", () => {
  it("sem conversa vinculada não há o que enviar", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const hablla = habllaFalso();
    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "oi", deps: hablla.deps }))).toBe("CONVERSATION_NOT_LINKED");
    expect(hablla.chamadas).toHaveLength(0);
    expect((await carregarChat(id)).bloqueiosDeTexto).toContain("sem_conversa");
    await encerrarCartao(id);
  });

  it("antes de assumir a equipe não envia; depois de assumir envia uma única vez, identificada como equipe", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular);
    await mensagemDaPessoa(conversationId);
    const hablla = habllaFalso();

    expect((await carregarChat(id)).bloqueiosDeTexto).toContain("atendimento_nao_assumido");
    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "Olá!", deps: hablla.deps }))).toBe("ATTENDANCE_NOT_ASSUMED");
    expect(hablla.envios()).toHaveLength(0);

    await assumirConversa({ opportunityId: id, actor: ana.actor });
    const { messageId } = await enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "  Olá, tudo bem?  ", deps: hablla.deps });

    expect(hablla.envios()).toHaveLength(1);
    expect(hablla.envios()[0]!.corpo).toMatchObject({ type: "text", phone: `55${pessoa.celular}`, body: "Olá, tudo bem?" });
    const [mensagem] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(mensagem).toMatchObject({ role: "staff", authorUserId: ana.id, content: "Olá, tudo bem?" });
    const [envio] = await db.select().from(canalEnvios).where(eq(canalEnvios.messageId, messageId));
    expect(envio?.status).toBe("aceito");

    const chat = await carregarChat(id);
    expect(chat.podeEnviarTexto).toBe(true);
    expect(chat.mensagens.find(m => m.id === messageId)).toMatchObject({ role: "staff", authorName: "Ana Prado" });
    const acoes = (await eventos(id)).map(e => (e.metadata as { action?: string }).action).filter(Boolean);
    expect(acoes).toEqual(["ATTENDANCE_ASSUMED", "MESSAGE_SENT"]);

    // Devolver para a Sofia fecha de novo o envio da equipe.
    await devolverConversaParaSofia({ opportunityId: id, actor: paulo.actor });
    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "mais uma", deps: hablla.deps }))).toBe("ATTENDANCE_NOT_ASSUMED");
    expect(hablla.envios()).toHaveLength(1);
    await encerrarCartao(id);
  });

  it("janela de 24h fechada: recusa sem enviar e sem trocar por modelo", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular, "atendimento_humano");
    const ultima = new Date(Date.now() - JANELA_24H_MS - 60_000);
    await mensagemDaPessoa(conversationId, ultima);
    const hablla = habllaFalso();

    const chat = await carregarChat(id);
    expect(chat.janelaAberta).toBe(false);
    expect(chat.bloqueiosDeTexto).toContain("janela_fechada");
    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "oi", deps: hablla.deps }))).toBe("OUTSIDE_WINDOW");
    expect(hablla.chamadas).toHaveLength(0);
    await encerrarCartao(id);
  });

  it("quem pediu para não receber nunca recebe texto", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular, "atendimento_humano");
    await mensagemDaPessoa(conversationId);
    await registrarContato({ pessoaId: pessoa.id, kind: "NAO_QUER_RECEBER", origem: "CONVERSA_WHATSAPP", actor: ana.actor });
    const hablla = habllaFalso();
    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "oi", deps: hablla.deps }))).toBe("OPTED_OUT");
    expect(hablla.chamadas).toHaveLength(0);
    await encerrarCartao(id);
  });

  it("falha no envio: uma tentativa só, a falha fica visível e nada é reenviado", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);
    const conversationId = await conversaDoWhatsapp(pessoa.id, pessoa.celular, "atendimento_humano");
    await mensagemDaPessoa(conversationId);
    const hablla = habllaFalso({ statusDoEnvio: 500 });

    expect(await codigoDoErro(() => enviarTextoDaEquipe({ opportunityId: id, actor: ana.actor, texto: "Olá!", deps: hablla.deps }))).toBe("SEND_FAILED");
    expect(hablla.envios()).toHaveLength(1);
    const [falha] = await db.select().from(canalEnvios).where(eq(canalEnvios.conversationId, conversationId));
    expect(falha?.status).toBe("falhou");
    const [mensagem] = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.role, "staff")));
    expect(mensagem?.content).toBe("Olá!");
    const acoes = (await eventos(id)).map(e => (e.metadata as { action?: string }).action);
    expect(acoes).not.toContain("MESSAGE_SENT");
    await encerrarCartao(id);
  });
});

describe("telefone repetido no cartão", () => {
  it("o chat lista as fichas ativas com o número (sem arquivadas) e a lista some quando sobra uma só", async () => {
    const numero = celular();
    const primeira = await criarPessoa({ celular: numero, nome: "Ana Primeira" });
    const segunda = await criarPessoa({ celular: numero, nome: "Ana Segunda" });
    const arquivada = await criarPessoa({ celular: numero, nome: "Ana Arquivada", arquivada: true });
    // Conversa do número ainda sem ficha: é ela que não pode ser ligada com duas fichas ativas.
    const [conversa] = await db.insert(conversations).values({
      title: "WhatsApp repetido", canal: "whatsapp", canalUsuario: `55${primeira.celular}`, pessoaId: null, status: "ativa",
    }).returning({ id: conversations.id });
    await db.insert(canalContatos).values({ canal: "whatsapp", contatoExternoId: primeira.celular, conversationId: conversa!.id });
    const id = await criarCartao(primeira.id);

    const bloqueado = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
    expect(bloqueado.status).toBe(200);
    expect(bloqueado.body.vinculo).toMatchObject({ tipo: "bloqueada", motivo: "telefone_em_varias_fichas" });
    expect(bloqueado.body.fichasComMesmoTelefone.map((ficha: { id: number }) => ficha.id)).toEqual([primeira.id, segunda.id]);
    expect(bloqueado.body.fichasComMesmoTelefone[0]).toMatchObject({ id: primeira.id, nome: "Ana Primeira" });
    expect(bloqueado.body.fichasComMesmoTelefone.map((ficha: { id: number }) => ficha.id)).not.toContain(arquivada.id);

    await db.update(pessoasTable).set({ arquivadoEm: new Date() }).where(eq(pessoasTable.id, segunda.id));
    const liberado = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
    expect(liberado.body.vinculo).toMatchObject({ tipo: "a_confirmar", conversationId: conversa!.id });
    expect(liberado.body.fichasComMesmoTelefone).toEqual([]);
    await encerrarCartao(id);
  });

  it("sem conversa do número a lista não aparece, mesmo com duas fichas", async () => {
    const numero = celular();
    const pessoa = await criarPessoa({ celular: numero });
    await criarPessoa({ celular: numero });
    const id = await criarCartao(pessoa.id);
    const semConversa = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
    expect(semConversa.body.vinculo.tipo).toBe("nenhuma");
    expect(semConversa.body.fichasComMesmoTelefone).toEqual([]);
    await encerrarCartao(id);
  });
});

describe("ficha sem telefone no cartão", () => {
  async function notaDeConferencia(pessoaId: number, tipo: string, naoGravados: Array<{ rotulo: string; valor: string }>) {
    await db.insert(pessoaNotes).values({
      pessoaId, noteType: tipo, value: randomUUID(), createdBy: "sistema:formulario_publico",
      body: montarNotaConferencia({
        origem: "formulário de interesse", motivo: "Contatos ambíguos ou divergentes.",
        desfecho: tipo === NOTA_CONTATO_DIVERGENTE ? "ficha_existente" : "ficha_em_conferencia", fichas: [], naoGravados,
      }),
    });
  }

  it("celular ausente ou vazio é 'sem telefone'; a explicação do formulário só aparece quando a nota registra o celular", async () => {
    const hablla = habllaFalso();
    for (const celularDaFicha of [null, ""]) {
      const pessoa = await criarPessoa({ celular: celularDaFicha });
      await autorizar(pessoa.id);
      const id = await criarCartao(pessoa.id);

      const semNota = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
      expect(semNota.status).toBe(200);
      expect(semNota.body.vinculo).toEqual({ tipo: "bloqueada", motivo: "sem_telefone" });
      expect(semNota.body.celularInformadoNaoGravado).toBe(false);
      const previaSemNota = await previaDaAbertura(pessoa.id, hablla.deps);
      expect(previaSemNota.bloqueios).toContain("sem_telefone");
      expect(previaSemNota.bloqueios).not.toContain("telefone_invalido");
      expect(previaSemNota.celularInformadoNaoGravado).toBe(false);

      // A nota de conferência que não fala do celular não explica a ausência dele.
      await notaDeConferencia(pessoa.id, NOTA_FICHA_EM_CONFERENCIA, [{ rotulo: "e-mail", valor: "maria@example.test" }]);
      const notaSemCelular = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
      expect(notaSemCelular.body.celularInformadoNaoGravado).toBe(false);

      await notaDeConferencia(pessoa.id, NOTA_FICHA_EM_CONFERENCIA, [{ rotulo: "celular", valor: "11987654321" }]);
      const comNota = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
      expect(comNota.body.vinculo).toEqual({ tipo: "bloqueada", motivo: "sem_telefone" });
      expect(comNota.body.celularInformadoNaoGravado).toBe(true);
      const previaComNota = await previaDaAbertura(pessoa.id, hablla.deps);
      expect(previaComNota.bloqueios).toContain("sem_telefone");
      expect(previaComNota.celularInformadoNaoGravado).toBe(true);
      await encerrarCartao(id);
    }
  });

  it("a ficha certa com celular de outra (nota de contato divergente) também explica o celular que ficou de fora", async () => {
    const pessoa = await criarPessoa({ celular: null });
    await notaDeConferencia(pessoa.id, NOTA_CONTATO_DIVERGENTE, [{ rotulo: "celular", valor: "11987654321" }]);
    const id = await criarCartao(pessoa.id);
    const chat = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
    expect(chat.body.vinculo).toEqual({ tipo: "bloqueada", motivo: "sem_telefone" });
    expect(chat.body.celularInformadoNaoGravado).toBe(true);
    await encerrarCartao(id);
  });

  it("a nota de outra ficha não explica esta, e telefone preenchido inválido ou estrangeiro mantém a mensagem atual", async () => {
    const hablla = habllaFalso();
    const outra = await criarPessoa({ celular: null });
    await notaDeConferencia(outra.id, NOTA_FICHA_EM_CONFERENCIA, [{ rotulo: "celular", valor: "11987654321" }]);
    const semNota = await criarPessoa({ celular: null });
    const idSemNota = await criarCartao(semNota.id);
    expect((await request(app).get(`/api/crm/opportunities/${idSemNota}/chat`).set(auth(crmEConversas))).body.celularInformadoNaoGravado).toBe(false);
    await encerrarCartao(idSemNota);

    for (const [celularDaFicha, motivo] of [["1234", "telefone_invalido"], ["+351 912 345 678", "telefone_estrangeiro"]] as const) {
      const pessoa = await criarPessoa({ celular: celularDaFicha });
      await autorizar(pessoa.id);
      await notaDeConferencia(pessoa.id, NOTA_FICHA_EM_CONFERENCIA, [{ rotulo: "celular", valor: "11987654321" }]);
      const id = await criarCartao(pessoa.id);
      const chat = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
      expect(chat.body.vinculo).toEqual({ tipo: "bloqueada", motivo });
      expect(chat.body.celularInformadoNaoGravado).toBe(false);
      const previa = await previaDaAbertura(pessoa.id, hablla.deps);
      expect(previa.bloqueios).toContain(motivo);
      expect(previa.bloqueios).not.toContain("sem_telefone");
      expect(previa.celularInformadoNaoGravado).toBe(false);
      await encerrarCartao(id);
    }
  });
});

describe("modelo de abertura do WhatsApp", () => {
  it("sem autorização registrada o envio fica bloqueado; com autorização mostra o texto exato e envia uma vez", async () => {
    const pessoa = await criarPessoa({ nome: "Marina Souza" });
    const id = await criarCartao(pessoa.id);
    const hablla = habllaFalso();

    const semAutorizacao = await previaDaAbertura(pessoa.id, hablla.deps);
    expect(semAutorizacao.podeEnviar).toBe(false);
    expect(semAutorizacao.bloqueios).toContain("sem_autorizacao");
    expect(await codigoDoErro(() => enviarAbertura({ pessoaId: pessoa.id, actor: ana.actor, deps: hablla.deps }))).toBe("OPENING_BLOCKED");
    expect(hablla.envios()).toHaveLength(0);

    await autorizar(pessoa.id);
    const previa = await previaDaAbertura(pessoa.id, hablla.deps);
    expect(previa).toMatchObject({ podeEnviar: true, bloqueios: [], texto: "Olá, Marina! Aqui é a equipe da Soundfulness." });

    const enviada = await enviarAbertura({ pessoaId: pessoa.id, actor: ana.actor, opportunityId: id, deps: hablla.deps });
    expect(hablla.envios()).toHaveLength(1);
    expect(hablla.envios()[0]!.corpo).toMatchObject({ template_id: "modelo-1", phone: `55${pessoa.celular}`, variables: { "1": "Marina" } });
    expect(enviada.texto).toBe(previa.texto);

    const [mensagem] = await db.select().from(messages).where(eq(messages.id, enviada.messageId));
    expect(mensagem).toMatchObject({ role: "assistant", kind: "modelo_abertura", authorUserId: ana.id, content: previa.texto });
    const [conversa] = await db.select({ pessoaId: conversations.pessoaId, canal: conversations.canal }).from(conversations).where(eq(conversations.id, enviada.conversationId));
    expect(conversa).toMatchObject({ pessoaId: pessoa.id, canal: "whatsapp" });
    const acoes = (await eventos(id)).filter(e => (e.metadata as { action?: string }).action === "TEMPLATE_SENT");
    expect(acoes).toHaveLength(1);
    expect(acoes[0]!.actorId).toBe(ana.id);
    await encerrarCartao(id);
  });

  it("'não quer receber' vence a autorização; modelo em análise, ficha sem nome e telefone de fora bloqueiam", async () => {
    const hablla = habllaFalso();

    const bloqueada = await criarPessoa();
    await autorizar(bloqueada.id);
    await registrarContato({ pessoaId: bloqueada.id, kind: "NAO_QUER_RECEBER", origem: "PRESENCIAL", actor: ana.actor });
    expect((await previaDaAbertura(bloqueada.id, hablla.deps)).bloqueios).toContain("nao_quer_receber");

    const semNome = await criarPessoa({ nome: null });
    await autorizar(semNome.id);
    expect((await previaDaAbertura(semNome.id, hablla.deps)).bloqueios).toContain("sem_primeiro_nome");

    const estrangeira = await criarPessoa({ celular: "+351 912 345 678" });
    await autorizar(estrangeira.id);
    expect((await previaDaAbertura(estrangeira.id, hablla.deps)).bloqueios).toContain("telefone_estrangeiro");

    const normal = await criarPessoa();
    await autorizar(normal.id);
    const emAnalise = habllaFalso({ statusDoModelo: "PENDING" });
    expect(await previaDaAbertura(normal.id, emAnalise.deps)).toMatchObject({ podeEnviar: false, texto: null });
    limparCacheHablla();
    expect((await previaDaAbertura(normal.id, emAnalise.deps)).bloqueios).toContain("modelo_em_analise");
    limparCacheHablla();
    const incompativel = habllaFalso({ corpoDoModelo: "Olá, {{1}}! Código {{2}}." });
    expect((await previaDaAbertura(normal.id, incompativel.deps)).bloqueios).toContain("modelo_incompativel");
    expect(emAnalise.envios()).toHaveLength(0);
  });

  it("telefone em mais de uma ficha ativa bloqueia; arquivar a outra libera", async () => {
    const hablla = habllaFalso();
    const numero = celular();
    const primeira = await criarPessoa({ celular: numero });
    const segunda = await criarPessoa({ celular: numero });
    await autorizar(primeira.id);
    expect((await previaDaAbertura(primeira.id, hablla.deps)).bloqueios).toContain("telefone_em_varias_fichas");
    expect(await codigoDoErro(() => enviarAbertura({ pessoaId: primeira.id, actor: ana.actor, deps: hablla.deps }))).toBe("OPENING_BLOCKED");
    await db.update(pessoasTable).set({ arquivadoEm: new Date() }).where(eq(pessoasTable.id, segunda.id));
    expect((await previaDaAbertura(primeira.id, hablla.deps)).podeEnviar).toBe(true);
    expect(hablla.envios()).toHaveLength(0);
  });

  it("falha no envio do modelo: uma tentativa, registrada como mensagem da equipe (a Sofia não a lê como dela)", async () => {
    const pessoa = await criarPessoa();
    await autorizar(pessoa.id);
    const hablla = habllaFalso({ statusDoEnvio: 500 });
    expect(await codigoDoErro(() => enviarAbertura({ pessoaId: pessoa.id, actor: ana.actor, deps: hablla.deps }))).toBe("OPENING_SEND_FAILED");
    expect(hablla.envios()).toHaveLength(1);
    const [conversa] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.pessoaId, pessoa.id));
    const [mensagem] = await db.select().from(messages).where(eq(messages.conversationId, conversa!.id));
    expect(mensagem).toMatchObject({ role: "staff", kind: "modelo_abertura" });
    const [envio] = await db.select().from(canalEnvios).where(eq(canalEnvios.conversationId, conversa!.id));
    expect(envio?.status).toBe("falhou");
  });

  it("só pessoa da equipe envia o modelo", async () => {
    const pessoa = await criarPessoa();
    await autorizar(pessoa.id);
    const hablla = habllaFalso();
    expect(await codigoDoErro(() => enviarAbertura({ pessoaId: pessoa.id, actor: { kind: "SOFIA" }, deps: hablla.deps }))).toBe("HUMAN_REQUIRED");
    expect(hablla.chamadas).toHaveLength(0);
  });
});

describe("acesso por área e filtros (rotas)", () => {
  it("conversa e modelo exigem CRM e Conversas; ficha da pessoa exige Pessoas; o resto do cartão exige CRM", async () => {
    const pessoa = await criarPessoa();
    const id = await criarCartao(pessoa.id);

    expect((await request(app).get(`/api/crm/opportunities/${id}/atendimento`).set(auth(soCrm))).status).toBe(200);
    expect((await request(app).get(`/api/crm/opportunities/${id}/atendimento`).set(auth(soPessoas))).status).toBe(403);

    const chatSoCrm = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(soCrm));
    expect(chatSoCrm.status).toBe(403);
    expect(chatSoCrm.body.code).toBe("CHAT_FORBIDDEN");
    expect((await request(app).get(`/api/crm/opportunities/${id}/chat/modelo-abertura`).set(auth(soCrm))).status).toBe(403);
    expect((await request(app).post(`/api/crm/opportunities/${id}/chat/mensagens`).set(auth(soCrm)).send({ texto: "oi" })).status).toBe(403);
    expect((await request(app).post(`/api/crm/opportunities/${id}/chat/assumir`).set(auth(soCrm))).status).toBe(403);

    const chatOk = await request(app).get(`/api/crm/opportunities/${id}/chat`).set(auth(crmEConversas));
    expect(chatOk.status).toBe(200);
    expect(chatOk.body.vinculo.tipo).toBe("nenhuma");
    // Sem conversa vinculada, mesmo quem tem as duas áreas não envia nada (e nada sai para o Hablla).
    const envio = await request(app).post(`/api/crm/opportunities/${id}/chat/mensagens`).set(auth(crmEConversas)).send({ texto: "oi" });
    expect(envio.status).toBe(409);
    expect(envio.body.code).toBe("CONVERSATION_NOT_LINKED");

    expect((await request(app).get(`/api/pessoas/${pessoa.id}/contato`).set(auth(soPessoas))).status).toBe(200);
    expect((await request(app).get(`/api/pessoas/${pessoa.id}/whatsapp/modelo-abertura`).set(auth(soPessoas))).status).toBe(403);
    const registro = await request(app).post(`/api/pessoas/${pessoa.id}/contato/registros`).set(auth(soPessoas)).send({ kind: "AUTORIZOU", origem: "PRESENCIAL" });
    expect(registro.status).toBe(201);
    expect(registro.body).toMatchObject({ autorizado: true, naoQuerReceber: false });
    expect((await request(app).get(`/api/pessoas/${pessoa.id}/contato`).set(auth(soCrm))).status).toBe(403);
    await encerrarCartao(id);
  });

  it("a lista filtra por curso e por evento", async () => {
    const pessoa = await criarPessoa();
    const doEvento = await criarCartao(pessoa.id, { cursosInscricaoId: offerId });
    const outraPessoa = await criarPessoa();
    const doOutroEvento = await criarCartao(outraPessoa.id, { cursosInscricaoId: otherOfferId });

    const idsDe = async (consulta: string) => {
      const resposta = await request(app).get(`/api/crm/opportunities?${consulta}`).set(auth(soCrm));
      expect(resposta.status).toBe(200);
      return (resposta.body as Array<{ id: number }>).map(c => c.id);
    };
    expect(await idsDe(`cursoId=${courseId}`)).toEqual([doEvento]);
    expect(await idsDe(`cursoId=${otherCourseId}`)).toEqual([doOutroEvento]);
    expect(await idsDe(`eventoId=${offerId}`)).toEqual([doEvento]);
    expect(await idsDe(`cursoId=${courseId}&eventoId=${otherOfferId}`)).toEqual([]);
    expect((await request(app).get("/api/crm/opportunities/filter-options").set(auth(soCrm))).status).toBe(200);
    expect((await request(app).get("/api/crm/opportunities/filter-options").set(auth(soPessoas))).status).toBe(403);
    await encerrarCartao(doEvento);
    await encerrarCartao(doOutroEvento);
  });
});
