// Primeiro contato automático da Sofia com quem preenche o formulário de interesse, contra um banco
// descartável. Nunca fala com o Hablla de verdade: o cliente recebe um `fetch` falso que registra cada chamada.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, asc, eq, ne, sql } from "drizzle-orm";

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
    "Primeiro contato automático: os testes exigem um banco descartável com nome único. " +
    "Use pnpm test:integration:crm-confirmation; recusando o DATABASE_URL compartilhado.",
  );
}

const { default: app } = await import("../app");
const {
  accessProfilesTable, canalEnvios, classesTable, commercialOpportunities, commercialOpportunityEvents, conversations,
  coursesTable, cursosInscricao, db, eventoFormularioSubmissoes,
  interesseGeralSubmissoes, messages, pessoaContatoRegistros, pessoasTable, primeiroContatoAutomatico, usersTable,
} = await import("@workspace/db");
const { createOpportunity, getOpportunityDetail, transitionOpportunity } = await import("../services/commercialOpportunities");
const { carregarEstadoDeContato, registrarContatoDoSistema } = await import("../services/contatoAutorizacao");
const { definirSofiaIniciaConversa } = await import("../services/habllaConfig");
const { iniciarPrimeiroContato, primeiroContatoTestHooks } = await import("../services/primeiroContatoFormulario");
const { previaDaAbertura } = await import("../services/whatsappModeloAbertura");
const { limparCacheHablla } = await import("../services/habllaClient");
const { executarToolSimples } = await import("../services/sofiaTools/definicoes");
const { carregarFormularioRecente } = await import("../services/sofiaTools/cartaoDoFormulario");
const { TEXTO_CONSENTIMENTO_WHATSAPP } = await import("../services/consentimentoFormulario");

const WS = "ws-teste";
const ZAP = "conexao-zap";
const ENV = {
  HABLLA_API_TOKEN: "token-falso",
  HABLLA_WORKSPACE_ID: WS,
  HABLLA_WHATSAPP_CONNECTION_ID: ZAP,
  HABLLA_API_URL: "https://hablla.test",
} as NodeJS.ProcessEnv;
const BASE = `/v1/workspace/${WS}`;

/** Hablla de mentira: devolve a conexão e o modelo, aceita (202) ou recusa o envio, e registra cada chamada. */
function habllaFalso(opcoes: { statusDoEnvio?: number; corpoDoErro?: unknown } = {}) {
  const chamadas: Array<{ metodo: string; caminho: string }> = [];
  const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
    const caminho = String(url).replace("https://hablla.test", "");
    const metodo = init?.method ?? "GET";
    chamadas.push({ metodo, caminho });
    const resposta = (status: number, corpo: unknown) => ({ status, text: async () => JSON.stringify(corpo) }) as Response;
    if (metodo === "GET" && caminho === `${BASE}/connection/${ZAP}`) {
      return resposta(200, { id: ZAP, workspace: WS, name: "Zap teste", scope: "WHATSAPP_MESSAGING", status: "active" });
    }
    if (metodo === "GET" && caminho.startsWith(`${BASE}/meta/connection/${ZAP}/whatsapp-messaging/templates`)) {
      return resposta(200, {
        results: [{
          id: "modelo-1", name: "sofia_iniciar_conversa", language: "pt_BR", status: "APPROVED",
          components: [{ type: "BODY", text: "Olá, {{1}}! Aqui é a equipe da Soundfulness." }],
        }],
      });
    }
    if (metodo === "POST" && caminho.endsWith("/templates/send")) {
      return (opcoes.statusDoEnvio ?? 202) >= 400
        ? resposta(opcoes.statusDoEnvio!, opcoes.corpoDoErro ?? { error: "falhou" })
        : resposta(202, { task_id: `fila-${chamadas.length}` });
    }
    throw new Error(`chamada inesperada ao Hablla falso: ${metodo} ${caminho}`);
  });
  return {
    deps: { fetch: fetchFalso as unknown as typeof fetch, env: ENV },
    envios: () => chamadas.filter(c => c.metodo === "POST"),
  };
}

const marker = `primeiro-contato-${randomUUID()}`;
const celular = () => `119${randomInt(10_000_000, 99_999_999)}`;
const ator = { kind: "SYSTEM" as const };
let anaId: number;
let offerId: number;
let otherOfferId: number;
let courseId: number;

async function criarPessoa(valores: { nome?: string; celular?: string | null } = {}) {
  const [pessoa] = await db.insert(pessoasTable).values({
    codigo: `${marker}-${randomUUID()}`, nome: valores.nome ?? "Marina Teste",
    celular: valores.celular === undefined ? celular() : valores.celular,
  }).returning({ id: pessoasTable.id, celular: pessoasTable.celular });
  return { id: pessoa!.id, celular: pessoa!.celular!.replace(/\D/g, "") };
}

async function criarCartao(pessoaId: number, oferta = offerId) {
  const cartao = await createOpportunity({
    pessoaId, nucleus: "EXPERIENCES", cursosInscricaoId: oferta, offerLabel: "Teste primeiro contato",
    ownerUserId: anaId, nextTaskType: "CALL", nextTaskText: "Ligar", nextTaskAt: new Date("2099-03-01T12:00:00.000Z"),
    source: "PRIMEIRO_CONTATO_TEST", actor: { kind: "HUMAN", id: anaId, role: "usuario" }, idempotencyKey: `pc-${randomUUID()}`,
  });
  return cartao.id;
}

async function consentir(pessoaId: number) {
  await db.transaction(tx => registrarContatoDoSistema(tx, {
    pessoaId, kind: "AUTORIZOU", origem: "FORMULARIO", origemTexto: TEXTO_CONSENTIMENTO_WHATSAPP, actor: ator,
  }));
}

/** Pessoa com cartão novo e, opcionalmente, a autorização que o formulário registraria. */
async function pessoaDoFormulario(opcoes: { consentiu?: boolean } = {}) {
  const pessoa = await criarPessoa();
  const opportunityId = await criarCartao(pessoa.id);
  if (opcoes.consentiu !== false) await consentir(pessoa.id);
  return { ...pessoa, opportunityId };
}

const entrada = (p: { id: number; opportunityId: number }, extra: { consentiu?: boolean; conferencia?: boolean } = {}) => ({
  pessoaId: p.id, opportunityId: p.opportunityId, consentiu: extra.consentiu ?? true, conferencia: extra.conferencia ?? false,
});

const linhasDe = (opportunityId: number) =>
  db.select().from(primeiroContatoAutomatico).where(eq(primeiroContatoAutomatico.opportunityId, opportunityId));
const eventosDe = (opportunityId: number) =>
  db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, opportunityId)).orderBy(asc(commercialOpportunityEvents.id));
const acoesDe = async (opportunityId: number, acao: string) =>
  (await eventosDe(opportunityId)).filter(e => (e.metadata as { action?: string } | null)?.action === acao);

async function encerrarCartao(opportunityId: number) {
  await transitionOpportunity({
    opportunityId, toStage: "CLOSED", reason: "fim do teste", source: "PRIMEIRO_CONTATO_TEST",
    idempotencyKey: `pc-fim-${opportunityId}-${randomUUID()}`, actor: { kind: "HUMAN", id: anaId, role: "usuario" },
  });
}

beforeAll(async () => {
  const [perfil] = await db.insert(accessProfilesTable).values({ name: `${marker} perfil`, areas: ["crm"], isAdmin: false }).returning({ id: accessProfilesTable.id });
  const [ana] = await db.insert(usersTable).values({
    name: "Ana Prado", email: `${marker}-ana@example.test`, role: "usuario", active: true, profileId: perfil!.id,
  }).returning({ id: usersTable.id });
  anaId = ana!.id;
  const [curso] = await db.insert(coursesTable).values({ name: `${marker} curso`, cycle: "t", modality: "presencial", workload: 1, price: "1.00" }).returning({ id: coursesTable.id });
  courseId = curso!.id;
  const [turma] = await db.insert(classesTable).values({ courseId, code: `${marker}-t1`, startDate: "2099-01-01", endDate: "2099-01-02", teacher: "t" }).returning({ id: classesTable.id });
  const [outraTurma] = await db.insert(classesTable).values({ courseId, code: `${marker}-t2`, startDate: "2099-02-01", endDate: "2099-02-02", teacher: "t" }).returning({ id: classesTable.id });
  const [oferta] = await db.insert(cursosInscricao).values({ slug: `${marker}-o1`, nome: `${marker} evento 1`, nucleo: "EXPERIENCES", tipoEvento: "VIVENCIA", classId: turma!.id, courseId }).returning({ id: cursosInscricao.id });
  const [outraOferta] = await db.insert(cursosInscricao).values({ slug: `${marker}-o2`, nome: `${marker} evento 2`, nucleo: "EXPERIENCES", tipoEvento: "VIVENCIA", classId: outraTurma!.id, courseId }).returning({ id: cursosInscricao.id });
  offerId = oferta!.id;
  otherOfferId = outraOferta!.id;
});

beforeEach(async () => {
  limparCacheHablla();
  primeiroContatoTestHooks.executar = undefined;
  // Os limites reais (por hora e por dia) contam o banco inteiro: os testes não dependem de quanto já foi enviado.
  primeiroContatoTestHooks.limites = { hora: 1_000_000, dia: 1_000_000 };
  await definirSofiaIniciaConversa(true);
});

afterAll(async () => {
  await definirSofiaIniciaConversa(false);
});

describe.sequential("primeiro contato automático", () => {
  it("com a chave desligada não envia nem registra nada", async () => {
    await definirSofiaIniciaConversa(false);
    const p = await pessoaDoFormulario();
    const hablla = habllaFalso();
    expect(await iniciarPrimeiroContato(entrada(p), hablla.deps)).toEqual({ resultado: "desligado" });
    expect(hablla.envios()).toHaveLength(0);
    expect(await linhasDe(p.opportunityId)).toHaveLength(0);
    expect(await acoesDe(p.opportunityId, "AUTO_OPENING_NOT_SENT")).toHaveLength(0);
  });

  it("com consentimento e modelo aprovado, envia uma vez, em nome da Sofia, e registra no histórico", async () => {
    const p = await pessoaDoFormulario();
    const hablla = habllaFalso();
    const desfecho = await iniciarPrimeiroContato(entrada(p), hablla.deps);
    expect(desfecho.resultado).toBe("enviado");
    expect(hablla.envios()).toHaveLength(1);

    const [linha] = await linhasDe(p.opportunityId);
    expect(linha).toMatchObject({ resultado: "ENVIADO", pessoaId: p.id, telefoneChave: expect.any(String) });
    const [mensagem] = await db.select().from(messages).where(eq(messages.id, linha!.messageId!));
    expect(mensagem).toMatchObject({ role: "assistant", kind: "modelo_abertura", authorUserId: null });
    expect(mensagem!.content).toContain("Marina");
    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, linha!.conversationId!));
    expect(conversa).toMatchObject({ canal: "whatsapp", pessoaId: p.id, status: "ativa" });

    const [envio] = await acoesDe(p.opportunityId, "TEMPLATE_SENT");
    expect(envio).toMatchObject({ actorKind: "SOFIA", actorId: null });

    // O mesmo cartão nunca é analisado duas vezes, nem manda de novo.
    expect(await iniciarPrimeiroContato(entrada(p), hablla.deps)).toEqual({ resultado: "ja_processado" });
    expect(hablla.envios()).toHaveLength(1);
  });

  it("o histórico do cartão traz o estado de entrega atual do modelo, traduzido, sem gravá-lo no evento", async () => {
    const p = await pessoaDoFormulario();
    await iniciarPrimeiroContato(entrada(p), habllaFalso().deps);
    const [linha] = await linhasDe(p.opportunityId);

    const antes = await getOpportunityDetail(p.opportunityId);
    const eventoAntes = antes!.events.find(e => (e.metadata as { action?: string } | null)?.action === "TEMPLATE_SENT");
    expect(eventoAntes!.metadata).toMatchObject({ delivery: { status: "aceito", error: null } });

    await db.update(canalEnvios).set({ status: "falhou", erro: "(#131030) Recipient phone number not in allowed list" })
      .where(eq(canalEnvios.messageId, linha!.messageId!));
    const depois = await getOpportunityDetail(p.opportunityId);
    const eventoDepois = depois!.events.find(e => (e.metadata as { action?: string } | null)?.action === "TEMPLATE_SENT");
    expect((eventoDepois!.metadata as { delivery: { status: string; error: string } }).delivery.status).toBe("falhou");
    expect((eventoDepois!.metadata as { delivery: { error: string } }).delivery.error).toMatch(/lista de teste da Meta \(131030\)/);
    expect((eventoDepois!.metadata as { delivery: { error: string } }).delivery.error).not.toMatch(/Recipient/);

    const [gravado] = await acoesDe(p.opportunityId, "TEMPLATE_SENT");
    expect(gravado!.metadata).not.toHaveProperty("delivery");
  });

  it("sem consentimento registra o motivo no histórico e não envia", async () => {
    const p = await pessoaDoFormulario({ consentiu: false });
    const hablla = habllaFalso();
    expect(await iniciarPrimeiroContato(entrada(p, { consentiu: false }), hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "sem_consentimento" });
    expect(hablla.envios()).toHaveLength(0);
    expect((await linhasDe(p.opportunityId))[0]).toMatchObject({ resultado: "NAO_ENVIADO", motivo: "sem_consentimento" });
    const [acao] = await acoesDe(p.opportunityId, "AUTO_OPENING_NOT_SENT");
    expect(acao).toMatchObject({ actorKind: "SOFIA" });
    expect(acao!.metadata).toMatchObject({ reason: "sem_consentimento" });
    // Análise única por cartão: repetir não duplica o aviso.
    await iniciarPrimeiroContato(entrada(p, { consentiu: false }), hablla.deps);
    expect(await acoesDe(p.opportunityId, "AUTO_OPENING_NOT_SENT")).toHaveLength(1);
  });

  it("identidade em conferência não envia, mesmo com consentimento marcado", async () => {
    const p = await pessoaDoFormulario({ consentiu: false });
    const hablla = habllaFalso();
    expect(await iniciarPrimeiroContato(entrada(p, { conferencia: true }), hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "pessoa_em_conferencia" });
    expect(hablla.envios()).toHaveLength(0);
    expect((await acoesDe(p.opportunityId, "AUTO_OPENING_NOT_SENT"))[0]!.metadata).toMatchObject({ reason: "pessoa_em_conferencia" });
  });

  it("bloqueios do modelo de abertura viram motivo: sem autorização e quem pediu para não receber", async () => {
    const semAutorizacao = await pessoaDoFormulario({ consentiu: false });
    const hablla = habllaFalso();
    expect(await iniciarPrimeiroContato(entrada(semAutorizacao), hablla.deps)).toMatchObject({ resultado: "nao_enviado", motivo: "sem_autorizacao" });

    const optOut = await pessoaDoFormulario();
    await db.transaction(tx => registrarContatoDoSistema(tx, {
      pessoaId: optOut.id, kind: "NAO_QUER_RECEBER", origem: "OUTRO", origemTexto: "Pediu para parar", actor: ator,
    }));
    expect(await iniciarPrimeiroContato(entrada(optOut), hablla.deps)).toMatchObject({ resultado: "nao_enviado", motivo: "nao_quer_receber" });
    expect(hablla.envios()).toHaveLength(0);
  });

  it("conversa que já está com a equipe não recebe o modelo", async () => {
    const p = await pessoaDoFormulario();
    await db.insert(conversations).values({ title: "WhatsApp", canal: "whatsapp", canalUsuario: `55${p.celular}`, pessoaId: p.id, status: "atendimento_humano" });
    const hablla = habllaFalso();
    expect(await iniciarPrimeiroContato(entrada(p), hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "conversa_com_equipe" });
    expect(hablla.envios()).toHaveLength(0);
  });

  it("cada pessoa recebe um envio automático só, mesmo com outro cartão novo", async () => {
    const p = await pessoaDoFormulario();
    const hablla = habllaFalso();
    expect((await iniciarPrimeiroContato(entrada(p), hablla.deps)).resultado).toBe("enviado");
    const segundoCartao = await criarCartao(p.id, otherOfferId);
    expect(await iniciarPrimeiroContato({ ...entrada(p), opportunityId: segundoCartao }, hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "ja_recebeu_modelo" });
    expect(hablla.envios()).toHaveLength(1);
    expect((await acoesDe(segundoCartao, "AUTO_OPENING_NOT_SENT"))[0]!.metadata).toMatchObject({ reason: "ja_recebeu_modelo" });
  });

  it("cada telefone recebe um envio automático só, mesmo vindo de outra ficha", async () => {
    const anterior = await pessoaDoFormulario();
    const nova = await pessoaDoFormulario();
    const [linhaNova] = await db.select({ celular: pessoasTable.celular }).from(pessoasTable).where(eq(pessoasTable.id, nova.id));
    // Um envio anterior, de outra ficha, para o mesmo telefone (a chave é o número sem o 55).
    await db.insert(primeiroContatoAutomatico).values({
      pessoaId: anterior.id, opportunityId: anterior.opportunityId, telefoneChave: linhaNova!.celular!.replace(/\D/g, ""), resultado: "ENVIADO",
    });
    const hablla = habllaFalso();
    expect(await iniciarPrimeiroContato(entrada(nova), hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "ja_recebeu_modelo" });
    expect(hablla.envios()).toHaveLength(0);
  });

  it("limites por hora e por dia contam enviados e recusam o excedente com o motivo no cartão", async () => {
    const hablla = habllaFalso();
    const contar = async () => {
      const [c] = await db.select({
        hora: sql<number>`count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int`,
        dia: sql<number>`count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int`,
      }).from(primeiroContatoAutomatico).where(ne(primeiroContatoAutomatico.resultado, "NAO_ENVIADO"));
      return c!;
    };
    const antes = await contar();
    const primeira = await pessoaDoFormulario();
    expect((await iniciarPrimeiroContato(entrada(primeira), hablla.deps)).resultado).toBe("enviado");

    primeiroContatoTestHooks.limites = { hora: antes.hora + 1, dia: antes.dia + 1000 };
    const porHora = await pessoaDoFormulario();
    expect(await iniciarPrimeiroContato(entrada(porHora), hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "limite_por_hora" });

    primeiroContatoTestHooks.limites = { hora: antes.hora + 1000, dia: antes.dia + 1 };
    const porDia = await pessoaDoFormulario();
    expect(await iniciarPrimeiroContato(entrada(porDia), hablla.deps)).toEqual({ resultado: "nao_enviado", motivo: "limite_por_dia" });
    expect((await acoesDe(porDia.opportunityId, "AUTO_OPENING_NOT_SENT"))[0]!.metadata).toMatchObject({ reason: "limite_por_dia" });

    // "Não enviado" não conta para o limite: com folga, o próximo vai.
    primeiroContatoTestHooks.limites = { hora: antes.hora + 1000, dia: antes.dia + 1000 };
    const folga = await pessoaDoFormulario();
    expect((await iniciarPrimeiroContato(entrada(folga), hablla.deps)).resultado).toBe("enviado");
  });

  it("falha de envio tem uma tentativa só, fica visível com o motivo traduzido e não é repetida", async () => {
    const p = await pessoaDoFormulario();
    const hablla = habllaFalso({ statusDoEnvio: 400, corpoDoErro: { message: "(#131030) Recipient phone number not in allowed list" } });
    const desfecho = await iniciarPrimeiroContato(entrada(p), hablla.deps);
    expect(desfecho).toMatchObject({ resultado: "falhou", motivo: "falha_no_envio" });
    expect(hablla.envios()).toHaveLength(1);

    const [linha] = await linhasDe(p.opportunityId);
    expect(linha).toMatchObject({ resultado: "FALHOU", motivo: "falha_no_envio" });
    const [acao] = await acoesDe(p.opportunityId, "AUTO_OPENING_NOT_SENT");
    expect(acao!.metadata).toMatchObject({ reason: "falha_no_envio" });
    expect((acao!.metadata as { detail: string }).detail).toMatch(/lista de teste da Meta \(131030\)/);

    // A falha da tentativa fica na conversa como mensagem da equipe (não da Sofia), com o motivo em português.
    const [conversa] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.pessoaId, p.id));
    const [mensagemFalha] = await db.select().from(messages).where(eq(messages.conversationId, conversa!.id));
    expect(mensagemFalha).toMatchObject({ role: "staff", kind: "modelo_abertura", authorUserId: null });
    const [envioFalho] = await db.select().from(canalEnvios).where(eq(canalEnvios.messageId, mensagemFalha!.id));
    expect(envioFalho).toMatchObject({ status: "falhou" });
    expect(envioFalho!.erro).toMatch(/lista de teste da Meta \(131030\)/);

    expect(await iniciarPrimeiroContato(entrada(p), hablla.deps)).toEqual({ resultado: "ja_processado" });
    expect(hablla.envios()).toHaveLength(1);
  });

  it("análises simultâneas do mesmo cartão enviam uma vez só", async () => {
    const p = await pessoaDoFormulario();
    const hablla = habllaFalso();
    const desfechos = await Promise.all([
      iniciarPrimeiroContato(entrada(p), hablla.deps),
      iniciarPrimeiroContato(entrada(p), hablla.deps),
      iniciarPrimeiroContato(entrada(p), hablla.deps),
    ]);
    expect(desfechos.filter(d => d.resultado === "enviado")).toHaveLength(1);
    expect(hablla.envios()).toHaveLength(1);
    expect(await linhasDe(p.opportunityId)).toHaveLength(1);
  });
});

describe.sequential("formulários públicos e consentimento", () => {
  const lead = () => {
    const sufixo = randomInt(10_000_000, 99_999_999);
    return { nome: "Lead Consentimento", celular: `119${sufixo}`, instagram: "", email: `${marker}-${sufixo}@example.test` };
  };
  const dispararam: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    dispararam.length = 0;
    primeiroContatoTestHooks.executar = async dados => {
      dispararam.push(dados as unknown as Record<string, unknown>);
      return { resultado: "desligado" };
    };
  });
  const pessoaPorEmail = async (email: string) => (await db.select().from(pessoasTable).where(eq(pessoasTable.email, email)))[0]!;
  const registrosDe = (pessoaId: number) =>
    db.select().from(pessoaContatoRegistros).where(eq(pessoaContatoRegistros.pessoaId, pessoaId)).orderBy(asc(pessoaContatoRegistros.id));

  it("a tela recebe o texto do consentimento do servidor, nos dois formulários", async () => {
    const geral = await request(app).get("/api/public/interesse/formulario");
    expect(geral.body.consentimento).toEqual({ texto: TEXTO_CONSENTIMENTO_WHATSAPP });
  });

  it("caixa marcada: registra a autorização do formulário com o texto exato e dispara o primeiro contato do cartão novo", async () => {
    const dados = lead();
    const resposta = await request(app).post("/api/public/interesse/submissoes").send({ respostas: dados, grupo: "agua", consentimentoWhatsapp: true, paginaOrigem: "https://site.example/agua?x=1" });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    const pessoa = await pessoaPorEmail(dados.email);

    const [registro] = await registrosDe(pessoa.id);
    expect(registro).toMatchObject({
      kind: "AUTORIZOU", origem: "FORMULARIO", origemTexto: TEXTO_CONSENTIMENTO_WHATSAPP, registradoPorUserId: null, registradoPeloSistema: true,
    });
    const [envio] = await db.select().from(interesseGeralSubmissoes).where(eq(interesseGeralSubmissoes.pessoaId, pessoa.id));
    expect(envio).toMatchObject({ consentimentoWhatsapp: true, consentimentoTexto: TEXTO_CONSENTIMENTO_WHATSAPP });

    const [cartao] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.pessoaId, pessoa.id));
    expect((await acoesDe(cartao!.id, "CONTACT_AUTHORIZED")).length).toBe(1);

    await vi.waitFor(() => expect(dispararam).toHaveLength(1));
    expect(dispararam[0]).toMatchObject({ pessoaId: pessoa.id, opportunityId: cartao!.id, consentiu: true, conferencia: false });
    expect(await carregarEstadoDeContato(pessoa.id)).toMatchObject({ autorizado: true, naoQuerReceber: false });

    // A Sofia recebe o formulário como contexto: título do cartão, grupo e a página sem parâmetros.
    const contexto = await carregarFormularioRecente(pessoa.id);
    expect(contexto).toMatchObject({ titulo: "Lista de interesse — Água", paginaOrigem: "https://site.example/agua?x=1" });
    expect(contexto!.grupo).toBeTruthy();
  });

  it("caixa desmarcada, ausente ou como texto: nenhuma autorização é registrada, mas o cartão novo é analisado", async () => {
    for (const consentimentoWhatsapp of [false, undefined, "true", "on", 1]) {
      const dados = lead();
      const corpo: Record<string, unknown> = { respostas: dados, grupo: "fogo" };
      if (consentimentoWhatsapp !== undefined) corpo.consentimentoWhatsapp = consentimentoWhatsapp;
      expect((await request(app).post("/api/public/interesse/submissoes").send(corpo)).status).toBe(201);
      const pessoa = await pessoaPorEmail(dados.email);
      expect(await registrosDe(pessoa.id)).toHaveLength(0);
      const [envio] = await db.select().from(interesseGeralSubmissoes).where(eq(interesseGeralSubmissoes.pessoaId, pessoa.id));
      expect(envio!.consentimentoWhatsapp).toBe(false);
    }
    await vi.waitFor(() => expect(dispararam).toHaveLength(5));
    expect(dispararam.every(d => d.consentiu === false)).toBe(true);
  });

  it("repetir o formulário com cartão aberto não dispara de novo (só cartão novo recebe o primeiro contato)", async () => {
    const dados = lead();
    const corpo = { respostas: dados, grupo: "terra", consentimentoWhatsapp: true };
    expect((await request(app).post("/api/public/interesse/submissoes").send(corpo)).status).toBe(201);
    await vi.waitFor(() => expect(dispararam).toHaveLength(1));
    expect((await request(app).post("/api/public/interesse/submissoes").send(corpo)).status).toBe(201);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(dispararam).toHaveLength(1);
    const pessoa = await pessoaPorEmail(dados.email);
    // A autorização também não se duplica.
    expect((await registrosDe(pessoa.id)).filter(r => r.kind === "AUTORIZOU")).toHaveLength(1);
  });

  it("formulário de evento: marcado registra a autorização; o corpo antigo, com respostas soltas, nunca consente", async () => {
    // O formulário de interesse do evento nasce com o evento (gatilho do banco); o Instagram é opcional na leitura.
    const slugDoFormulario = `${marker}-o1-interesse`;
    const publico = await request(app).get(`/api/public/formularios/${slugDoFormulario}`);
    expect(publico.status).toBe(200);
    expect(publico.body.consentimento).toEqual({ texto: TEXTO_CONSENTIMENTO_WHATSAPP });

    const marcado = lead();
    const resposta = await request(app).post(`/api/public/formularios/${slugDoFormulario}/submissoes`)
      .send({ respostas: { nome: marcado.nome, celular: marcado.celular, email: marcado.email }, consentimentoWhatsapp: true });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    const pessoaMarcada = await pessoaPorEmail(marcado.email);
    expect((await registrosDe(pessoaMarcada.id)).map(r => [r.kind, r.origem])).toEqual([["AUTORIZOU", "FORMULARIO"]]);
    const [submissao] = await db.select().from(eventoFormularioSubmissoes).where(eq(eventoFormularioSubmissoes.pessoaId, pessoaMarcada.id));
    expect(submissao).toMatchObject({ consentimentoWhatsapp: true, consentimentoTexto: TEXTO_CONSENTIMENTO_WHATSAPP });
    await vi.waitFor(() => expect(dispararam.filter(d => d.pessoaId === pessoaMarcada.id)).toHaveLength(1));

    const antigo = lead();
    const respostaAntiga = await request(app).post(`/api/public/formularios/${slugDoFormulario}/submissoes`)
      .send({ nome: antigo.nome, celular: antigo.celular, email: antigo.email });
    expect(respostaAntiga.status, JSON.stringify(respostaAntiga.body)).toBe(201);
    const pessoaAntiga = await pessoaPorEmail(antigo.email);
    expect(await registrosDe(pessoaAntiga.id)).toHaveLength(0);
  });
});

describe.sequential("Sofia: contexto do formulário e pedido para não receber", () => {
  it("só cartões abertos que nasceram de formulário viram contexto; cartão encerrado ou criado por outra origem, não", async () => {
    const semFormulario = await criarPessoa();
    await criarCartao(semFormulario.id);
    expect(await carregarFormularioRecente(semFormulario.id)).toBeNull();

    const sufixo = randomInt(10_000_000, 99_999_999);
    const dados = { nome: "Lead Contexto", celular: `119${sufixo}`, instagram: "", email: `${marker}-ctx-${sufixo}@example.test` };
    primeiroContatoTestHooks.executar = async () => ({ resultado: "desligado" });
    expect((await request(app).post("/api/public/interesse/submissoes").send({ respostas: dados, grupo: "ar" })).status).toBe(201);
    const [pessoa] = await db.select().from(pessoasTable).where(eq(pessoasTable.email, dados.email));
    expect(await carregarFormularioRecente(pessoa!.id)).toMatchObject({ titulo: "Lista de interesse — Ar" });
    const [cartao] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.pessoaId, pessoa!.id));
    await encerrarCartao(cartao!.id);
    expect(await carregarFormularioRecente(pessoa!.id)).toBeNull();
  });

  it("registrar_nao_quer_receber: registra pelo sistema, avisa os cartões abertos e bloqueia o modelo de abertura", async () => {
    const p = await pessoaDoFormulario();
    const [conversa] = await db.insert(conversations).values({ title: "WhatsApp", canal: "whatsapp", canalUsuario: `55${p.celular}`, pessoaId: p.id }).returning({ id: conversations.id });
    const chamada = { id: "call-1", type: "function" as const, function: { name: "registrar_nao_quer_receber", arguments: "{}" } };

    const saida = JSON.parse(await executarToolSimples(chamada, { pessoaId: p.id, conversationId: conversa!.id }));
    expect(saida).toMatchObject({ ok: true, registrado: true });
    expect(saida.instrucao).toMatch(/UMA frase curta/);

    const registros = await db.select().from(pessoaContatoRegistros).where(and(eq(pessoaContatoRegistros.pessoaId, p.id), eq(pessoaContatoRegistros.kind, "NAO_QUER_RECEBER")));
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ origem: "CONVERSA_WHATSAPP", registradoPorUserId: null, registradoPeloSistema: true });
    const [aviso] = await acoesDe(p.opportunityId, "CONTACT_OPT_OUT");
    expect(aviso).toMatchObject({ actorKind: "SOFIA" });
    expect((await previaDaAbertura(p.id, habllaFalso().deps)).bloqueios).toContain("nao_quer_receber");

    // Repetir o pedido não duplica o registro.
    expect(JSON.parse(await executarToolSimples(chamada, { pessoaId: p.id, conversationId: conversa!.id }))).toMatchObject({ ok: true, registrado: false });
    expect(await db.select().from(pessoaContatoRegistros).where(and(eq(pessoaContatoRegistros.pessoaId, p.id), eq(pessoaContatoRegistros.kind, "NAO_QUER_RECEBER")))).toHaveLength(1);
  });

  it("conversa sem ficha: despede-se sem registrar nada", async () => {
    const [conversa] = await db.insert(conversations).values({ title: "WhatsApp sem ficha", canal: "whatsapp", canalUsuario: `55${celular()}` }).returning({ id: conversations.id });
    const chamada = { id: "call-2", type: "function" as const, function: { name: "registrar_nao_quer_receber", arguments: "{}" } };
    expect(JSON.parse(await executarToolSimples(chamada, { pessoaId: null, conversationId: conversa!.id }))).toMatchObject({ ok: true, registrado: false });
  });
});
