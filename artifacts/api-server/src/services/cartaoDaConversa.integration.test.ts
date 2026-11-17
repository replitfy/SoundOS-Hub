// Cartão "Conversa no WhatsApp" contra um banco descartável: eventos do CRM são só de acréscimo, então os
// cartões criados aqui nunca podem ir para o banco compartilhado. Nenhuma mensagem sai do sistema.
import { randomInt, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";

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
    "Cartão da conversa: os testes exigem um banco descartável com nome único. " +
    "Use pnpm test:integration:crm-confirmation; recusando o DATABASE_URL compartilhado.",
  );
}

const { accessProfilesTable, commercialOpportunities, commercialOpportunityEvents, conversations, db, messages, pessoasTable, usersTable } =
  await import("@workspace/db");
const { getOpportunityDetail, transitionOpportunity } = await import("./commercialOpportunities");
const {
  atualizarCartaoDaConversa, carregarEntendimentoDaPessoa, CONVERSA_IDENTIDADE, garantirCartaoDaConversa, prepararConversaWhatsapp,
} = await import("./cartaoDaConversa");
const { carregarFormularioRecente } = await import("./sofiaTools/cartaoDoFormulario");

const marker = `cartao-conversa-${randomUUID()}`;
let anaId: number;

beforeAll(async () => {
  const [perfil] = await db.insert(accessProfilesTable).values({ name: `${marker} perfil`, areas: ["crm"], isAdmin: false }).returning({ id: accessProfilesTable.id });
  const [ana] = await db.insert(usersTable).values({
    name: "Ana Prado", email: `${marker}-ana@example.test`, role: "usuario", active: true, profileId: perfil!.id,
  }).returning({ id: usersTable.id });
  anaId = ana!.id;
});

function telefone() {
  const miolo = String(randomInt(10_000_000, 99_999_999));
  return { nacional: `119${miolo}`, comPais: `55119${miolo}` };
}

async function criarConversa(canalUsuario: string) {
  const [conversa] = await db.insert(conversations).values({ title: marker, canal: "whatsapp", canalUsuario }).returning({ id: conversations.id });
  return conversa!.id;
}

async function mensagemDaPessoa(conversationId: number, content: string) {
  await db.insert(messages).values({ conversationId, role: "user", content });
}

async function criarFicha(celular: string, extra: { nome?: string; arquivado?: boolean } = {}) {
  const [ficha] = await db.insert(pessoasTable).values({
    codigo: `${marker}-${randomUUID()}`, nome: extra.nome ?? "Marina Real", celular, arquivadoEm: extra.arquivado ? new Date() : null,
  }).returning({ id: pessoasTable.id });
  return ficha!.id;
}

const cartoesDa = (pessoaId: number) =>
  db.select().from(commercialOpportunities)
    .where(and(eq(commercialOpportunities.pessoaId, pessoaId), eq(commercialOpportunities.offerIdentity, CONVERSA_IDENTIDADE)))
    .orderBy(asc(commercialOpportunities.id));
const eventosDe = (id: number) =>
  db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, id)).orderBy(asc(commercialOpportunityEvents.id));
const anotacoesDe = async (id: number) =>
  (await eventosDe(id)).filter(e => (e.metadata as { action?: string } | null)?.action === "SOFIA_ENTENDIMENTO");

/** Conversa nova de um número novo, já com a primeira mensagem e o cartão aberto. */
async function conversaNova(texto = "Oi, quero saber do Ciclo Água", perfil: string | null = "Maria Souza") {
  const tel = telefone();
  const conversationId = await criarConversa(tel.comPais);
  await mensagemDaPessoa(conversationId, texto);
  const preparo = await prepararConversaWhatsapp({ conversationId, texto, perfil });
  return { ...tel, conversationId, preparo };
}

describe.sequential("cartão da conversa no WhatsApp", () => {
  it("número novo: abre ficha com nome provisório e um cartão sem responsável em Novo interesse, com a conversa no histórico", async () => {
    const { conversationId, preparo, comPais } = await conversaNova();
    expect(preparo.cartao).toBe("criado");
    expect(preparo.pessoaId).not.toBeNull();

    const [ficha] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, preparo.pessoaId!));
    expect(ficha!.nome).toBe("Maria Souza (WhatsApp)");
    expect(ficha!.celularNormalizado).toBe(comPais.slice(2));

    const [cartao] = await cartoesDa(preparo.pessoaId!);
    expect(cartao).toMatchObject({
      nucleus: "EDUCATION", offerLabel: "Conversa no WhatsApp", stage: "NEW_INTEREST", source: "SOFIA_INTERESSE",
      ownerUserId: null, nextTaskType: "WHATSAPP",
    });
    const [criado] = await eventosDe(cartao!.id);
    expect(criado).toMatchObject({ eventType: "CREATED", actorKind: "SOFIA" });
    const trecho = (criado!.metadata as { sofiaConversation?: { conversationId: number; mensagens: string[] } }).sofiaConversation;
    expect(trecho?.conversationId).toBe(conversationId);
    expect(trecho?.mensagens).toEqual(["Oi, quero saber do Ciclo Água"]);

    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conversa!.pessoaId).toBe(preparo.pessoaId);
  });

  it("a segunda mensagem reaproveita o cartão e não cria outro; chamadas simultâneas também não duplicam", async () => {
    const { conversationId, preparo } = await conversaNova();
    const [antes] = await cartoesDa(preparo.pessoaId!);
    expect((await prepararConversaWhatsapp({ conversationId, texto: "Outra mensagem", perfil: "Maria Souza" })).cartao).toBe("ja_existia");
    expect(await cartoesDa(preparo.pessoaId!)).toHaveLength(1);
    expect((await eventosDe(antes!.id))).toHaveLength(1);

    const outra = await conversaNova();
    // O cartão já existe; apagar não é possível, então a corrida é entre pessoas sem cartão ativo.
    const semCartao = await criarFicha(telefone().nacional);
    const resultados = await Promise.all([
      garantirCartaoDaConversa({ pessoaId: semCartao, conversationId: outra.conversationId }),
      garantirCartaoDaConversa({ pessoaId: semCartao, conversationId: outra.conversationId }),
      garantirCartaoDaConversa({ pessoaId: semCartao, conversationId: outra.conversationId }),
    ]);
    expect(resultados.filter(r => r === "criado")).toHaveLength(1);
    expect(await cartoesDa(semCartao)).toHaveLength(1);
  });

  it("a Sofia anota no histórico sem mexer em etapa, responsável, próxima ação nem versão", async () => {
    const { conversationId, preparo } = await conversaNova();
    const [antes] = await cartoesDa(preparo.pessoaId!);

    const r = await atualizarCartaoDaConversa({
      conversationId,
      entrada: { intencao: "Quer fazer o Ciclo Água", necessidades: ["Aprender sound healing para atender"], informacoes: ["Mora em Campinas"] },
    });
    expect(r).toMatchObject({ status: "atualizado", anotado: { intencao: true, necessidades: 1, informacoes: 1, removidos: 0 } });

    const [depois] = await cartoesDa(preparo.pessoaId!);
    expect(depois).toMatchObject({
      version: antes!.version, stage: antes!.stage, ownerUserId: null, ownerSystem: antes!.ownerSystem,
      nextTaskType: antes!.nextTaskType, nextTaskText: antes!.nextTaskText, informacoes: antes!.informacoes,
    });
    expect(depois!.lastInteractionAt!.getTime()).toBeGreaterThanOrEqual(antes!.lastInteractionAt?.getTime() ?? 0);

    const [anotacao] = await anotacoesDe(antes!.id);
    expect(anotacao).toMatchObject({ eventType: "UPDATED", actorKind: "SOFIA", source: "SOFIA_CONVERSA", toStage: antes!.stage });
    expect(anotacao!.metadata).toMatchObject({
      conversationId,
      sofiaEntendimento: { intencao: "Quer fazer o Ciclo Água", necessidades: ["Aprender sound healing para atender"], informacoes: ["Mora em Campinas"] },
    });

    // O mesmo retrato chega à tela do cartão pelo detalhe.
    const detalhe = await getOpportunityDetail(antes!.id);
    expect(detalhe!.events.some(e => (e.metadata as { action?: string } | null)?.action === "SOFIA_ENTENDIMENTO")).toBe(true);
    expect(await carregarEntendimentoDaPessoa(preparo.pessoaId!)).toEqual({
      intencao: "Quer fazer o Ciclo Água", necessidades: ["Aprender sound healing para atender"], informacoes: ["Mora em Campinas"],
    });
  });

  it("repetir o que já está anotado não grava evento novo; o que é novo se soma ao retrato", async () => {
    const { conversationId, preparo } = await conversaNova();
    const [cartao] = await cartoesDa(preparo.pessoaId!);
    await atualizarCartaoDaConversa({ conversationId, entrada: { intencao: "Quer o Ciclo Água", necessidades: ["Relaxar"] } });
    const repetida = await atualizarCartaoDaConversa({ conversationId, entrada: { intencao: "quer o ciclo agua", necessidades: ["relaxar"] } });
    expect(repetida.status).toBe("sem_mudanca");
    expect(await anotacoesDe(cartao!.id)).toHaveLength(1);

    await atualizarCartaoDaConversa({ conversationId, entrada: { necessidades: ["Estudar à noite"], informacoes: ["Trabalha de dia"], remover: ["Relaxar"] } });
    const anotacoes = await anotacoesDe(cartao!.id);
    expect(anotacoes).toHaveLength(2);
    expect(anotacoes[1]!.metadata).toMatchObject({
      sofiaEntendimento: { intencao: "Quer o Ciclo Água", necessidades: ["Estudar à noite"], informacoes: ["Trabalha de dia"] },
      mudancas: { removidos: ["Relaxar"] },
    });
  });

  it("dado sensível, contato ou preço nunca chega ao banco nem volta para o modelo", async () => {
    const { conversationId, preparo } = await conversaNova();
    const [cartao] = await cartoesDa(preparo.pessoaId!);
    const r = await atualizarCartaoDaConversa({
      conversationId,
      entrada: { necessidades: ["Escreva para ana@exemplo.com"], informacoes: ["Tem diagnóstico de depressão", "Pagou R$ 500", "Gosta de yoga"] },
    });
    expect(r.status).toBe("atualizado");
    expect(r.anotado).toMatchObject({ necessidades: 0, informacoes: 1 });
    expect(r.rejeitados).toHaveLength(3);
    expect(JSON.stringify(r)).not.toMatch(/ana@exemplo|diagn|R\$ 500/);
    const gravado = JSON.stringify(await eventosDe(cartao!.id));
    expect(gravado).toContain("Gosta de yoga");
    expect(gravado).not.toMatch(/ana@exemplo|depress|R\$ 500/);
  });

  it("número que já tem ficha: o cartão vai para a ficha, mas ela não é ligada à conversa nem renomeada", async () => {
    const tel = telefone();
    const fichaId = await criarFicha(tel.nacional, { nome: "Marina Real" });
    const conversationId = await criarConversa(tel.comPais);
    const preparo = await prepararConversaWhatsapp({ conversationId, texto: "Oi", perfil: "Apelido Qualquer" });
    expect(preparo).toEqual({ pessoaId: null, cartao: "criado" });
    expect(await cartoesDa(fichaId)).toHaveLength(1);
    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conversa!.pessoaId).toBeNull();
    const [ficha] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, fichaId));
    expect(ficha!.nome).toBe("Marina Real");

    const anotada = await atualizarCartaoDaConversa({ conversationId, entrada: { intencao: "Quer o Ciclo Fogo" } });
    expect(anotada.status).toBe("atualizado");
    expect(JSON.stringify(anotada)).not.toContain("Marina");
    expect((await anotacoesDe((await cartoesDa(fichaId))[0]!.id))).toHaveLength(1);
  });

  it("telefone de duas fichas, ficha arquivada ou número estrangeiro: sem ficha nova e sem cartão", async () => {
    const compartilhado = telefone();
    const mae = await criarFicha(compartilhado.nacional, { nome: "Mãe" });
    const filha = await criarFicha(compartilhado.nacional, { nome: "Filha" });
    const conversaCompartilhada = await criarConversa(compartilhado.comPais);
    expect(await prepararConversaWhatsapp({ conversationId: conversaCompartilhada, texto: "Oi", perfil: null })).toEqual({ pessoaId: null, cartao: "sem_ficha" });
    expect(await cartoesDa(mae)).toHaveLength(0);
    expect(await cartoesDa(filha)).toHaveLength(0);
    expect((await atualizarCartaoDaConversa({ conversationId: conversaCompartilhada, entrada: { intencao: "Quer X" } })).status).toBe("sem_ficha");

    const arquivado = telefone();
    const fichaArquivada = await criarFicha(arquivado.nacional, { arquivado: true });
    const conversaArquivada = await criarConversa(arquivado.comPais);
    expect(await prepararConversaWhatsapp({ conversationId: conversaArquivada, texto: "Oi", perfil: null })).toEqual({ pessoaId: null, cartao: "sem_ficha" });
    expect(await cartoesDa(fichaArquivada)).toHaveLength(0);

    const conversaEstrangeira = await criarConversa("14155550123");
    expect(await prepararConversaWhatsapp({ conversationId: conversaEstrangeira, texto: "Hi", perfil: "John" })).toEqual({ pessoaId: null, cartao: "sem_ficha" });
    const [conversa] = await db.select().from(conversations).where(eq(conversations.id, conversaEstrangeira));
    expect(conversa!.pessoaId).toBeNull();
  });

  it("cartão encerrado: a próxima mensagem abre um novo, que começa sem as anotações do antigo", async () => {
    const { conversationId, preparo } = await conversaNova();
    await atualizarCartaoDaConversa({ conversationId, entrada: { intencao: "Quer o Ciclo Água", informacoes: ["Mora em Campinas"] } });
    const [primeiro] = await cartoesDa(preparo.pessoaId!);
    await transitionOpportunity({
      opportunityId: primeiro!.id, toStage: "CLOSED", reason: "fim do teste", source: "CARTAO_CONVERSA_TEST",
      idempotencyKey: `cc-fim-${randomUUID()}`, actor: { kind: "HUMAN", id: anaId, role: "usuario" },
    });
    expect(await carregarEntendimentoDaPessoa(preparo.pessoaId!)).toBeNull();

    expect((await prepararConversaWhatsapp({ conversationId, texto: "Voltei", perfil: null })).cartao).toBe("criado");
    const cartoes = await cartoesDa(preparo.pessoaId!);
    expect(cartoes).toHaveLength(2);
    expect(cartoes[0]!.stage).toBe("CLOSED");
    expect(cartoes[1]!.stage).toBe("NEW_INTEREST");
    expect(await carregarEntendimentoDaPessoa(preparo.pessoaId!)).toEqual({ intencao: null, necessidades: [], informacoes: [] });
    // O cartão encerrado não recebe mais nada.
    await atualizarCartaoDaConversa({ conversationId, entrada: { necessidades: ["Estudar à noite"] } });
    expect(await anotacoesDe(cartoes[0]!.id)).toHaveLength(1);
    expect(await anotacoesDe(cartoes[1]!.id)).toHaveLength(1);
  });

  it("o cartão da conversa não esconde o cartão do formulário de interesse", async () => {
    const { preparo } = await conversaNova();
    // Só existe o cartão da conversa: nada a contar sobre formulário.
    expect(await carregarFormularioRecente(preparo.pessoaId!)).toBeNull();
    const { rows } = await db.execute(sql`SELECT count(*)::int AS total FROM commercial_opportunities WHERE pessoa_id = ${preparo.pessoaId!} AND stage <> 'CLOSED'`);
    expect(Number((rows[0] as { total: number }).total)).toBe(1);
  });
});
