import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";

const name = process.env.EVENT_FLOW_DISPOSABLE;
if (!name || !/^event-flow-test-[a-f0-9]{32}$/.test(name) || new URL(process.env.DATABASE_URL!).pathname !== `/${name}`) {
  throw new Error("Refusing shared database; use node scripts/test-event-flow.mjs");
}
const { db, usersTable, accessProfilesTable, pessoasTable, pessoaNotes, commercialOpportunities, commercialOpportunityEvents, interesseGeralSubmissoes, cursosInscricao } = await import("@workspace/db");
const { ensureSystemProfiles } = await import("../services/accessProfiles");
const { createSessionToken } = await import("../lib/session");
const { default: app } = await import("../app");

const tag = randomUUID();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let staffToken: string;
let eventFixture: { id: number; nome: string };
let counter = 0;

/** Cada chamada gera um contato novo para os testes não compartilharem celular nem e-mail. */
function newLead() {
  counter += 1;
  const suffix = String(10000000 + counter * 7919 + Math.floor(Math.random() * 1000)).slice(-8);
  return { nome: `Lead ${counter}`, celular: `119${suffix}`, instagram: `@lead${counter}`, email: `${tag}-${counter}@example.test` };
}
const submit = (respostas: Record<string, string>, extra: Record<string, unknown> = {}) =>
  request(app).post("/api/public/interesse/submissoes").send({ respostas, ...extra });
const submitFrom = (ip: string, respostas: Record<string, string>, extra: Record<string, unknown> = {}) =>
  request(app).post("/api/public/interesse/submissoes").set("X-Forwarded-For", ip).send({ respostas, ...extra });
const personByEmail = async (email: string) => (await db.select().from(pessoasTable).where(eq(pessoasTable.email, email)))[0];
const cardsOf = (pessoaId: number) => db.select().from(commercialOpportunities).where(eq(commercialOpportunities.pessoaId, pessoaId));
const notesOf = (pessoaId: number) => db.select().from(pessoaNotes).where(eq(pessoaNotes.pessoaId, pessoaId));
/** Ficha já existente no cadastro, com contatos próprios (o telefone é guardado como o trigger normaliza). */
async function existingPerson(values: { nome: string; sobrenome?: string; email?: string; celular?: string }) {
  const [row] = await db.insert(pessoasTable).values({ codigo: `FIX-${randomUUID()}`, ...values }).returning();
  return row!;
}
const personById = async (id: number) => (await db.select().from(pessoasTable).where(eq(pessoasTable.id, id)))[0]!;
const submissionsOf = (pessoaId: number) => db.select().from(interesseGeralSubmissoes).where(eq(interesseGeralSubmissoes.pessoaId, pessoaId));

beforeAll(async () => {
  await ensureSystemProfiles();
  const profiles = await db.select().from(accessProfilesTable);
  const [staff] = await db.insert(usersTable).values({
    name: "Fixture staff geral", email: `${tag}-staff@example.test`, role: "usuario",
    profileId: profiles.find(p => p.systemKey === "usuario")!.id,
  }).returning();
  staffToken = createSessionToken(staff!.id);
  const [event] = await db.insert(cursosInscricao).values({
    slug: `${tag}-evento-interesse`,
    nome: `Evento de interesse ${tag}`,
    tipoEvento: "CURSO",
  }).returning({ id: cursosInscricao.id, nome: cursosInscricao.nome });
  eventFixture = event!;
});

describe.sequential("formulário de interesse genérico", () => {
  it("publica os quatro campos e o grupo sem expor identificadores", async () => {
    const response = await request(app).get("/api/public/interesse/formulario").query({ grupo: "Água" });
    expect(response.status).toBe(200);
    expect(response.body.campos.map((field: { key: string }) => field.key)).toEqual(["nome", "celular", "instagram", "email"]);
    expect(response.body.grupo).toMatchObject({ slug: "agua", label: "Água", conhecido: true });
    expect(response.body.grupos.map((group: { slug: string }) => group.slug)).toEqual(["agua", "terra", "fogo", "ar"]);
    const empty = await request(app).get("/api/public/interesse/formulario");
    expect(empty.body.grupo).toBeNull();
  });

  it("cria pessoa, envio e cartão da Sofia com grupo e página de origem, sem vazar ids", async () => {
    const lead = newLead();
    const response = await submit(lead, { grupo: "agua", paginaOrigem: "https://site.example/agua?x=1#topo" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toEqual({ success: true, grupo: "agua" });

    const person = await personByEmail(lead.email);
    expect(person).toBeTruthy();
    const [submission] = await submissionsOf(person!.id);
    expect(submission).toMatchObject({ grupo: "agua", paginaOrigem: "https://site.example/agua?x=1" });
    expect(submission!.respostas).toMatchObject({ nome: lead.nome, email: lead.email });

    const [card] = await cardsOf(person!.id);
    expect(card).toMatchObject({
      nucleus: "EDUCATION", cursosInscricaoId: null, ownerUserId: null, ownerSystem: "SOFIA",
      stage: "NEW_INTEREST", offerIdentity: "interesse-geral:agua", offerLabel: "Lista de interesse — Água",
    });
    const events = await db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, card!.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "CREATED", source: "FORMULARIO_INTERESSE" });
    expect(events[0]!.metadata).toMatchObject({
      formSubmission: { grupo: "agua", paginaOrigem: "https://site.example/agua?x=1", eventName: "Lista de interesse — Água" },
    });

    const saved = await request(app).patch(`/api/crm/opportunities/${card!.id}`).set(auth(staffToken))
      .send({ ownerUserId: null, nextTaskText: "Acompanhar interesse com a Sofia", expectedVersion: card!.version });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const [after] = await cardsOf(person!.id);
    expect(after).toMatchObject({
      ownerUserId: null, ownerSystem: "SOFIA", nextTaskText: "Acompanhar interesse com a Sofia",
    });
  });

  it("vincula o cartão ao curso ou evento selecionado sem misturar com o cartão sem evento", async () => {
    const lead = newLead();
    expect((await submitFrom("10.20.30.41", lead, { grupo: "agua" })).status).toBe(201);

    const response = await submitFrom("10.20.30.41", lead, { grupo: "agua", eventoId: eventFixture.id });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toEqual({ success: true, grupo: "agua" });

    const person = await personByEmail(lead.email);
    const cards = await cardsOf(person!.id);
    expect(cards).toHaveLength(2);
    const eventCard = cards.find(card => card.cursosInscricaoId === eventFixture.id)!;
    expect(eventCard).toMatchObject({
      cursosInscricaoId: eventFixture.id,
      offerIdentity: `interesse-geral:agua:evento:${eventFixture.id}`,
      offerLabel: `Lista de interesse — Água — ${eventFixture.nome}`,
    });
    const events = await db.select().from(commercialOpportunityEvents)
      .where(eq(commercialOpportunityEvents.opportunityId, eventCard.id));
    expect(events[0]!.metadata).toMatchObject({
      formSubmission: { grupo: "agua", eventId: eventFixture.id, eventName: eventFixture.nome },
    });

    expect((await submitFrom("10.20.30.41", lead, { grupo: "agua", eventoId: eventFixture.id })).status).toBe(201);
    expect(await cardsOf(person!.id)).toHaveLength(2);
  });

  it("recusa um identificador de curso ou evento inválido antes de criar a pessoa", async () => {
    const lead = newLead();
    const response = await submitFrom("10.20.30.42", lead, { eventoId: "abc" });
    expect(response.status).toBe(400);
    expect(await personByEmail(lead.email)).toBeUndefined();
  });

  it("repetir o envio no mesmo grupo reaproveita pessoa e cartão e registra os dois envios", async () => {
    const lead = newLead();
    expect((await submit(lead, { grupo: "fogo" })).status).toBe(201);
    expect((await submit({ ...lead, nome: `${lead.nome} de novo` }, { grupo: "fogo" })).status).toBe(201);
    const people = await db.select().from(pessoasTable).where(eq(pessoasTable.email, lead.email));
    expect(people).toHaveLength(1);
    const cards = await cardsOf(people[0]!.id);
    expect(cards).toHaveLength(1);
    expect(await submissionsOf(people[0]!.id)).toHaveLength(2);
    const events = await db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, cards[0]!.id));
    expect(events.map(event => event.eventType).sort()).toEqual(["CREATED", "UPDATED"]);
  });

  it("grupos diferentes da mesma pessoa abrem cartões separados", async () => {
    const lead = newLead();
    expect((await submit(lead, { grupo: "terra" })).status).toBe(201);
    expect((await submit(lead, { grupo: "ar" })).status).toBe(201);
    const person = await personByEmail(lead.email);
    const identities = (await cardsOf(person!.id)).map(card => card.offerIdentity).sort();
    expect(identities).toEqual(["interesse-geral:ar", "interesse-geral:terra"]);
  });

  it("envios simultâneos do mesmo contato geram um único cartão ativo", async () => {
    const lead = newLead();
    const responses = await Promise.all([submit(lead, { grupo: "agua" }), submit(lead, { grupo: "agua" })]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const people = await db.select().from(pessoasTable).where(eq(pessoasTable.email, lead.email));
    expect(people).toHaveLength(1);
    expect(await cardsOf(people[0]!.id)).toHaveLength(1);
    expect(await submissionsOf(people[0]!.id)).toHaveLength(2);
  });

  it("grupo e página inválidos não recusam o cadastro: o lead entra sem grupo", async () => {
    const lead = newLead();
    const response = await submit(lead, { grupo: "!!!", paginaOrigem: "javascript:alert(1)" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.grupo).toBeNull();
    const person = await personByEmail(lead.email);
    const [submission] = await submissionsOf(person!.id);
    expect(submission).toMatchObject({ grupo: null, paginaOrigem: null });
    const [card] = await cardsOf(person!.id);
    expect(card).toMatchObject({ offerIdentity: "interesse-geral:geral", offerLabel: "Interesse geral" });
  });

  it("aceita grupo novo com cor padrão e normaliza o nome", async () => {
    const lead = newLead();
    const response = await submit(lead, { grupo: "Éter Novo" });
    expect(response.status).toBe(201);
    expect(response.body.grupo).toBe("eter-novo");
    const person = await personByEmail(lead.email);
    const [card] = await cardsOf(person!.id);
    expect(card).toMatchObject({ offerIdentity: "interesse-geral:eter-novo", offerLabel: "Lista de interesse — Eter novo" });
  });

  it("recusa campos ausentes, extras e contatos inválidos sem criar registros", async () => {
    const lead = newLead();
    const { instagram: _instagram, ...semInstagram } = lead;
    const attempts: Array<Record<string, string>> = [
      { ...semInstagram, email: "" },
      { ...lead, cpf: "52998224725" },
      { ...lead, email: "sem-arroba" },
      { ...lead, celular: "123" },
      { ...lead, nome: "   " },
    ];
    for (const attempt of attempts) {
      const response = await submit(attempt, { grupo: "agua" });
      expect(response.status, JSON.stringify(attempt)).toBe(400);
    }
    expect((await request(app).post("/api/public/interesse/submissoes").send({ respostas: "x" })).status).toBe(400);
    expect(await personByEmail(lead.email)).toBeUndefined();
  });

  it("aceita o envio sem Instagram e não grava a chave nas respostas nem na ficha", async () => {
    const lead = newLead();
    const { instagram: _instagram, ...semInstagram } = lead;
    for (const respostas of [semInstagram, { ...semInstagram, instagram: "  " }]) {
      const response = await submit({ ...respostas, email: respostas === semInstagram ? lead.email : `x-${lead.email}` }, { grupo: "agua" });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const person = await personByEmail(lead.email);
    expect(person!.instagram).toBeNull();
    const [submission] = await submissionsOf(person!.id);
    expect(submission!.respostas).not.toHaveProperty("instagram");
    expect(await cardsOf(person!.id)).toHaveLength(1);
  });

  it("não toma de volta o cartão que a equipe já assumiu", async () => {
    const lead = newLead();
    expect((await submit(lead, { grupo: "agua" })).status).toBe(201);
    const person = await personByEmail(lead.email);
    const [card] = await cardsOf(person!.id);
    const claimed = await request(app).post(`/api/crm/opportunities/${card!.id}/claim`).set(auth(staffToken)).send({});
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect((await submit(lead, { grupo: "agua" })).status).toBe(201);
    const [after] = await db.select().from(commercialOpportunities).where(and(eq(commercialOpportunities.id, card!.id)));
    expect(after!.ownerUserId).not.toBeNull();
    expect(after!.stage).toBe(card!.stage);
  });

  it("a ficha da pessoa lista o envio genérico com grupo e página, e exige login", async () => {
    const lead = newLead();
    expect((await submit(lead, { grupo: "ar", paginaOrigem: "https://site.example/ar" })).status).toBe(201);
    const person = await personByEmail(lead.email);
    expect((await request(app).get(`/api/pessoas/${person!.id}/formularios-evento`)).status).toBe(401);
    const response = await request(app).get(`/api/pessoas/${person!.id}/formularios-evento`).set(auth(staffToken));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      eventoId: null, version: null, formType: "INTERESSE_GERAL", grupo: "ar", grupoLabel: "Ar",
      paginaOrigem: "https://site.example/ar", eventoNome: "Lista de interesse — Ar",
    });
    expect(response.body[0].answers).toMatchObject({ email: lead.email });
  });

  it("limita envios em excesso do mesmo visitante", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25 && !statuses.includes(429); i += 1) {
      statuses.push((await submit({}, { grupo: "agua" })).status);
    }
    expect(statuses).toContain(429);
  });
});

describe.sequential("identidade em dúvida nunca chega ao cliente", () => {
  // Outro visitante: o limite de envios é por IP e a última prova do arquivo esgota o do primeiro.
  const submitOtherVisitor = (respostas: Record<string, string>, extra: Record<string, unknown> = {}) =>
    request(app).post("/api/public/interesse/submissoes").set("X-Forwarded-For", "10.20.30.40").send({ respostas, ...extra });
  const LEAK = /confer[êe]ncia|amb[íi]guo|diverg|pode pertencer|arquivad/i;

  it("celular de outra pessoa: o cliente recebe sucesso, a equipe recebe ficha, nota e cartão, e a ficha antiga fica intacta", async () => {
    const lead = newLead();
    const dona = await existingPerson({ nome: "Maria", sobrenome: "Antiga", email: `${tag}-dona-${counter}@example.test`, celular: lead.celular });
    const response = await submitOtherVisitor({ ...lead, nome: "João Visitante" }, { grupo: "agua" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toEqual({ success: true, grupo: "agua" });
    expect(JSON.stringify(response.body)).not.toMatch(LEAK);

    const novo = await personByEmail(lead.email);
    expect(novo).toBeTruthy();
    expect(novo!.id).not.toBe(dona.id);
    expect(novo!.nome).toBe("João Visitante");
    // O celular pertence à ficha antiga: não é copiado para a nova.
    expect(novo!.celular).toBeNull();
    const [notaDoNovo] = await notesOf(novo!.id);
    expect(notaDoNovo).toMatchObject({ noteType: "conferencia_cadastro", createdBy: "sistema:formulario_publico" });
    expect(notaDoNovo!.body).toContain(dona.codigo);
    expect(notaDoNovo!.body).toContain("mesmo celular");
    expect(notaDoNovo!.body).toContain(`celular ${lead.celular}`);
    expect(notaDoNovo!.body).toContain("mescle as fichas");

    const [cartao] = await cardsOf(novo!.id);
    expect(cartao).toMatchObject({ offerIdentity: "interesse-geral:agua", nextTaskText: "Conferir o cadastro e retornar ao interesse recebido pelo formulário" });
    expect(cartao!.informacoes).toContain(dona.codigo);
    expect((await submissionsOf(novo!.id))[0]!.respostas).toMatchObject({ celular: lead.celular, email: lead.email });

    const depois = await personById(dona.id);
    expect(depois).toMatchObject({ nome: "Maria", sobrenome: "Antiga", email: dona.email, celular: dona.celular });
    expect(await notesOf(dona.id)).toHaveLength(0);
    expect(await cardsOf(dona.id)).toHaveLength(0);
  });

  it("repetir o mesmo envio reaproveita a ficha em conferência e o cartão, e acrescenta outra nota", async () => {
    const lead = newLead();
    await existingPerson({ nome: "Maria", email: `${tag}-dona-${counter}@example.test`, celular: lead.celular });
    const body = { ...lead, nome: "João Repetido" };
    expect((await submitOtherVisitor(body, { grupo: "fogo" })).status).toBe(201);
    expect((await submitOtherVisitor(body, { grupo: "fogo" })).status).toBe(201);
    const pessoas = await db.select().from(pessoasTable).where(eq(pessoasTable.email, lead.email));
    expect(pessoas).toHaveLength(1);
    expect(await cardsOf(pessoas[0]!.id)).toHaveLength(1);
    expect(await submissionsOf(pessoas[0]!.id)).toHaveLength(2);
    expect(await notesOf(pessoas[0]!.id)).toHaveLength(2);
  });

  it("e-mail de uma ficha e celular de outra: nenhuma das duas é alterada e a pessoa fica em conferência", async () => {
    const lead = newLead();
    const doEmail = await existingPerson({ nome: "Ana", sobrenome: "Email", email: lead.email });
    const doCelular = await existingPerson({ nome: "Bruno", sobrenome: "Celular", celular: lead.celular });
    const response = await submitOtherVisitor({ ...lead, nome: "Carla Terceira" }, { grupo: "terra" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(JSON.stringify(response.body)).not.toMatch(LEAK);

    const emConferencia = (await db.select().from(pessoasTable).where(eq(pessoasTable.nome, "Carla Terceira")))[0];
    expect(emConferencia).toBeTruthy();
    expect(emConferencia!.email).toBeNull();
    expect(emConferencia!.celular).toBeNull();
    const [nota] = await notesOf(emConferencia!.id);
    expect(nota!.body).toContain(doEmail.codigo);
    expect(nota!.body).toContain(doCelular.codigo);
    expect(await personById(doEmail.id)).toMatchObject({ email: lead.email, instagram: null });
    expect(await personById(doCelular.id)).toMatchObject({ instagram: null });
    expect(await cardsOf(doEmail.id)).toHaveLength(0);
    expect(await cardsOf(doCelular.id)).toHaveLength(0);
  });

  it("mesmo nome e e-mail com o celular de outra pessoa: atualiza a ficha certa sem o celular e deixa nota", async () => {
    const lead = newLead();
    const certa = await existingPerson({ nome: "Ana", sobrenome: "Silva", email: lead.email, celular: "11911110000" });
    const outra = await existingPerson({ nome: "Bruno", sobrenome: "Silva", celular: lead.celular });
    const response = await submitOtherVisitor({ ...lead, nome: "Ana Silva" }, { grupo: "ar" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(JSON.stringify(response.body)).not.toMatch(LEAK);

    const depois = await personById(certa.id);
    expect(depois.celular).toBe(certa.celular);
    expect(depois.instagram).toBe(lead.instagram);
    const [nota] = await notesOf(certa.id);
    expect(nota).toMatchObject({ noteType: "conferencia_contato" });
    expect(nota!.body).toContain(outra.codigo);
    expect(nota!.body).toContain(`celular ${lead.celular}`);
    expect(await personById(outra.id)).toMatchObject({ instagram: null });
    expect(await db.select().from(pessoasTable).where(eq(pessoasTable.nome, "Ana Silva"))).toHaveLength(1);

    const [cartao] = await cardsOf(certa.id);
    expect(cartao).toMatchObject({ nextTaskText: "Retornar ao interesse recebido pelo formulário", informacoes: null });
  });

  it("ficha arquivada não volta sozinha: o envio abre ficha própria e avisa a equipe", async () => {
    const lead = newLead();
    const arquivada = await existingPerson({ nome: "Dora", sobrenome: "Arquivada", email: lead.email });
    await db.update(pessoasTable).set({ arquivadoEm: new Date() }).where(eq(pessoasTable.id, arquivada.id));
    const response = await submitOtherVisitor({ ...lead, nome: "Dora Arquivada" }, { grupo: "agua" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(JSON.stringify(response.body)).not.toMatch(LEAK);

    const nova = (await db.select().from(pessoasTable).where(eq(pessoasTable.nome, "Dora Arquivada")))[0];
    expect(nova).toBeTruthy();
    expect(nova!.email).toBeNull();
    const [nota] = await notesOf(nova!.id);
    expect(nota!.body).toContain(arquivada.codigo);
    expect(nota!.body).toContain("arquivada");
    expect((await personById(arquivada.id)).arquivadoEm).not.toBeNull();
    expect(await cardsOf(arquivada.id)).toHaveLength(0);
  });
});
