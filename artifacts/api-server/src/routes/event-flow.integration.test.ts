import { randomUUID, createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";

const name = process.env.EVENT_FLOW_DISPOSABLE;
if (!name || !/^event-flow-test-[a-f0-9]{32}$/.test(name) || new URL(process.env.DATABASE_URL!).pathname !== `/${name}`) {
  throw new Error("Refusing shared database; use node scripts/test-event-flow.mjs");
}
const { db, usersTable, accessProfilesTable, pessoasTable, coursesTable, classesTable, cursosInscricao, eventoFormularios, eventoFormularioVersoes, commercialOpportunities, commercialOpportunityEvents, eventFormalizations, enrollmentsTable, eventoPreinscricoes, eventoFormularioSubmissoes, pessoaNotes } = await import("@workspace/db");
const { ensureSystemProfiles } = await import("../services/accessProfiles");
const { createSessionToken } = await import("../lib/session");
const { default: app } = await import("../app");
const { normalizeCpf, resolveEventPerson } = await import("../services/eventIdentity");
const { registrarEdicaoHumana } = await import("../services/evidencias");

let adminToken: string, staffToken: string, limitedToken: string, eventId: number, classId: number, interestSlug: string;
const tag = randomUUID();
const base = { nome: "Teste", sobrenome: "Fluxo", celular: "11987654321", instagram: "@teste", email: `${tag}@example.test` };
let pessoaId: number, preId: number, opportunityId: number, bearer: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const paymentPath = () => `/api/cursos-inscricao/${eventId}/preinscricoes/${preId}/pagamento`;
const submit = (answers: Record<string, string> = base) => request(app).post(`/api/public/formularios/${interestSlug}/submissoes`).send({ respostas: answers });
const formAnswers = { ...base, cpf: "529.982.247-25" };

beforeAll(async () => {
  await ensureSystemProfiles();
  const profiles = await db.select().from(accessProfilesTable);
  const [admin] = await db.insert(usersTable).values({ name: "Fixture admin", email: `${tag}-admin@example.test`, role: "admin_master", profileId: profiles.find(p => p.systemKey === "admin_master")!.id }).returning();
  const [staff] = await db.insert(usersTable).values({ name: "Fixture staff", email: `${tag}-staff@example.test`, role: "usuario", profileId: profiles.find(p => p.systemKey === "usuario")!.id }).returning();
  const [restricted] = await db.insert(accessProfilesTable).values({ name: `Restrito ${tag}`, areas: ["chat"], isAdmin: true }).returning();
  const [limited] = await db.insert(usersTable).values({ name: "Fixture limited", email: `${tag}-limited@example.test`, role: "admin", profileId: restricted!.id }).returning();
  adminToken = createSessionToken(admin!.id); staffToken = createSessionToken(staff!.id); limitedToken = createSessionToken(limited!.id);
  const [course] = await db.insert(coursesTable).values({ name: `Fixture ${tag}`, cycle: "I", modality: "Presencial", workload: 8, price: "100" }).returning();
  const [klass] = await db.insert(classesTable).values({ courseId: course!.id, code: `FIX-${tag}`, teacher: "Fixture", startDate: "2030-01-02", endDate: "2030-01-03", status: "Planejada" }).returning();
  classId = klass!.id;
  const [event] = await db.insert(cursosInscricao).values({ nome: `Fixture ${tag}`, slug: `fixture-${tag}`, nucleo: "EDUCATION", classId, courseId: course!.id }).returning();
  eventId = event!.id;
  // Route ensures defaults, then replace complete fields with a minimal fixture.
  await request(app).get(`/api/public/cursos-inscricao/${event!.slug}`);
  const forms = await db.select().from(eventoFormularios).where(eq(eventoFormularios.eventoId, eventId));
  interestSlug = forms.find(f => f.tipo === "INTERESSE")!.slug;
  for (const form of forms) await db.insert(eventoFormularioVersoes).values({
    formularioId: form.id, numero: 100,
    campos: [
      { key: "nome", label: "Nome", type: "text", required: true },
      { key: "sobrenome", label: "Sobrenome", type: "text" },
      { key: "email", label: "Email", type: "email", required: true },
      { key: "celular", label: "Celular", type: "tel", required: true },
      { key: "instagram", label: "Instagram", type: "text" },
      { key: "cpf", label: "CPF", type: "text" },
    ],
  });
});

describe.sequential("interest -> manual payment -> formalization", () => {
  it("validates CPF including check digits", () => {
    expect(normalizeCpf("529.982.247-25")).toBe("52998224725");
    expect(() => normalizeCpf("11111111111")).toThrow();
    expect(() => normalizeCpf("52998224724")).toThrow();
  });
  it("creates a person, original answers and Sofia-owned CRM card atomically", async () => {
    const result = await submit();
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    ({ pessoaId, preinscricaoId: preId, opportunityId } = result.body);
    const [card] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId));
    expect(card).toMatchObject({ pessoaId, ownerUserId: null, ownerSystem: "SOFIA", stage: "NEW_INTEREST", offerIdentity: `curso:${eventId}` });
    const [event] = await db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, opportunityId));
    expect(event!.metadata).toMatchObject({ formSubmission: { answers: base } });
  });
  it("concurrent interest retries enrich the same card, no duplicate people or registrations", async () => {
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map(r => r.status)).toEqual([201, 201]);
    expect(responses.map(r => r.body.pessoaId)).toEqual([pessoaId, pessoaId]);
    const cards = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.pessoaId, pessoaId));
    expect(cards).toHaveLength(1);
  });
  it("does not take back a human-owned card on resubmission", async () => {
    const claimed = await request(app).post(`/api/crm/opportunities/${opportunityId}/claim`).set(auth(staffToken)).send({});
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect((await submit()).status).toBe(201);
    const [card] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId));
    expect(card!.ownerUserId).not.toBeNull();
  });
  it("blocks generic complete submissions and legacy enrollment before payment", async () => {
    const forms = await db.select().from(eventoFormularios).where(eq(eventoFormularios.eventoId, eventId));
    expect((await request(app).post(`/api/public/formularios/${forms.find(f => f.tipo === "COMPLETO")!.slug}/submissoes`).send({ respostas: formAnswers })).status).toBe(403);
    expect((await request(app).post("/api/public/inscricao").send(formAnswers)).status).toBe(403);
    expect((await request(app).get("/api/public/pessoas/lookup").query({ email: base.email })).body).toEqual({ found: false });
  });
  it("requires administrator AND area for payment and enforces valid amount/reference", async () => {
    for (const token of [staffToken, limitedToken]) expect((await request(app).post(paymentPath()).set(auth(token)).send({ amount: "100", reference: "PIX" })).status).toBe(403);
    expect((await request(app).post(paymentPath()).set(auth(adminToken)).send({ amount: "0", reference: "" })).status).toBe(400);
    const result = await request(app).post(paymentPath()).set(auth(adminToken)).send({ amount: "100.00", reference: "PIX fixture" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    bearer = result.body.token;
    expect(bearer).toMatch(/^[a-f0-9]{64}$/);
    const [payment] = await db.select().from(eventFormalizations).where(eq(eventFormalizations.pessoaId, pessoaId));
    expect(payment!.tokenHash).toBe(createHash("sha256").update(bearer).digest("hex"));
    expect(JSON.stringify(payment)).not.toContain(bearer);
    const detail = await request(app).get(`/api/cursos-inscricao/${eventId}/detalhe`).set(auth(adminToken));
    expect(detail.body.interessados[0].formalizacao.amount).toBe("100.00");
    expect(JSON.stringify(detail.body)).not.toContain("tokenHash");
  });
  it("rotates, revokes, and rejects expired or invalid links without person data", async () => {
    const old = bearer;
    let result = await request(app).post(paymentPath()).set(auth(adminToken)).send({ amount: "100", reference: "PIX fixture" });
    bearer = result.body.token;
    expect((await request(app).get(`/api/public/formalizacao/${old}`)).status).toBe(404);
    const get = await request(app).get(`/api/public/formalizacao/${bearer}`);
    expect(get.status).toBe(200); expect(get.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(get.body)).not.toContain(base.email);
    expect((await request(app).post(`${paymentPath()}/revogar`).set(auth(adminToken))).status).toBe(204);
    expect((await request(app).post(`/api/public/formalizacao/${bearer}`).send({ respostas: formAnswers })).status).toBe(404);
    result = await request(app).post(paymentPath()).set(auth(adminToken)).send({ amount: "100", reference: "PIX fixture" });
    bearer = result.body.token;
    await db.update(eventFormalizations).set({ expiresAt: new Date(0) }).where(eq(eventFormalizations.pessoaId, pessoaId));
    expect((await request(app).get(`/api/public/formalizacao/${bearer}`)).status).toBe(404);
    result = await request(app).post(paymentPath()).set(auth(adminToken)).send({ amount: "100", reference: "PIX fixture" });
    bearer = result.body.token;
  });
  it("rejects another person, financial injections and invalid CPF without partial records", async () => {
    const post = (body: object) => request(app).post(`/api/public/formalizacao/${bearer}`).send(body);
    expect((await post({ respostas: { ...formAnswers, email: "different@example.test", celular: "21987650000" } })).status).toBe(409);
    expect((await post({ respostas: formAnswers, pessoaId: 999 })).status).toBe(400);
    expect((await post({ respostas: { ...formAnswers, paymentStatus: "paid" } })).status).toBe(400);
    expect((await post({ respostas: { ...formAnswers, cpf: "11111111111" } })).status).toBe(400);
    const registrations = await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.pessoaId, pessoaId));
    expect(registrations).toHaveLength(0);
  });
  it("completes concurrently once, links payment/submission/enrollment/CRM and preserves paid status", async () => {
    const responses = await Promise.all([1,2].map(() => request(app).post(`/api/public/formalizacao/${bearer}`).send({ respostas: formAnswers })));
    expect(responses.map(r => r.status), JSON.stringify(responses.map(r => r.body))).toEqual([200,200]);
    expect(responses[0]!.body.enrollmentId).toBe(responses[1]!.body.enrollmentId);
    const [payment] = await db.select().from(eventFormalizations).where(eq(eventFormalizations.pessoaId, pessoaId));
    expect(payment!.completedAt).not.toBeNull(); expect(payment!.submissionId).not.toBeNull();
    const [enrollment] = await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, payment!.enrollmentId!));
    expect(enrollment).toMatchObject({ pessoaId, classId, price: "100.00", paymentStatus: "paid", contractStatus: "pending" });
    const [card] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId));
    expect(card!.stage).toBe("CONFIRMED");
    const details = await request(app).get(`/api/cursos-inscricao/${eventId}/detalhe`).set(auth(adminToken));
    expect(details.body.matriculados).toHaveLength(1);
    expect((await request(app).get(`/api/public/formalizacao/${bearer}`)).body.status).toBe("completed");
  });
  it("matches existing CPF and blocks contradictory CPF, shared phones and archived people", async () => {
    const same = await db.transaction(tx => resolveEventPerson(tx, formAnswers));
    expect(same).toBe(pessoaId);
    await expect(db.transaction(tx => resolveEventPerson(tx, { ...formAnswers, cpf: "11144477735" }))).rejects.toThrow(/CPF/);
    const [family] = await db.insert(pessoasTable).values({ codigo: `FIX-${randomUUID()}`, nome: "Outra Pessoa", celular: base.celular }).returning();
    await expect(db.transaction(tx => resolveEventPerson(tx, { nome: "Sem CPF", celular: base.celular }))).rejects.toThrow(/ambíguos/);
    // CPF disambiguates a shared phone when compatible.
    expect(await db.transaction(tx => resolveEventPerson(tx, formAnswers))).toBe(pessoaId);
    await db.update(pessoasTable).set({ arquivadoEm: new Date() }).where(eq(pessoasTable.id, family!.id));
    await expect(db.transaction(tx => resolveEventPerson(tx, { nome: "Outra Pessoa", celular: base.celular, email: "unused@example.test" }))).rejects.toThrow();
  });
  it("creates a genuinely new CPF once under concurrency", async () => {
    const answers = { nome: "CPF novo", cpf: "12345678909", email: `${tag}-new@example.test`, celular: "31988776655" };
    const ids = await Promise.all([1,2].map(() => db.transaction(tx => resolveEventPerson(tx, answers))));
    expect(ids[0]).toBe(ids[1]); expect(ids[0]).not.toBe(pessoaId);
  });
  it("preserves confirmed human fields, retaining the submitted answer in evidence", async () => {
    await db.transaction(async tx => {
      await registrarEdicaoHumana(pessoaId, { profissao: "Confirmado pela equipe" }, "fixture_humana", tx);
      await tx.update(pessoasTable).set({ profissao: "Confirmado pela equipe" }).where(eq(pessoasTable.id, pessoaId));
    });
    await db.transaction(tx => resolveEventPerson(tx, { ...formAnswers, profissao: "Outro texto" }));
    const [person] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, pessoaId));
    expect(person!.profissao).toBe("Confirmado pela equipe");
  });
  it("never shows an identity conflict to the person filling the interest form: staff gets a review record instead", async () => {
    const [owner] = await db.insert(pessoasTable).values({ codigo: `FIX-${randomUUID()}`, nome: "Dona", sobrenome: "Do Numero", celular: "51977665544", email: `${tag}-owner@example.test` }).returning();
    const answers = { nome: "Visitante", sobrenome: "Diferente", celular: "51977665544", email: `${tag}-visitor@example.test` };
    const response = await submit(answers);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(JSON.stringify(response.body)).not.toMatch(/confer[êe]ncia|amb[íi]guo|diverg|pertencer/i);
    expect(response.body.pessoaId).not.toBe(owner!.id);

    const [visitor] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, response.body.pessoaId));
    expect(visitor).toMatchObject({ nome: "Visitante", email: answers.email, celular: null });
    const [note] = await db.select().from(pessoaNotes).where(eq(pessoaNotes.pessoaId, visitor!.id));
    expect(note).toMatchObject({ noteType: "conferencia_cadastro" });
    expect(note!.body).toContain(owner!.codigo);
    const [card] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.id, response.body.opportunityId));
    expect(card).toMatchObject({ pessoaId: visitor!.id, nextTaskText: "Conferir o cadastro e retornar ao interesse recebido pelo formulário" });
    expect(card!.informacoes).toContain(owner!.codigo);
    const ownerPre = await db.select().from(eventoPreinscricoes).where(eq(eventoPreinscricoes.pessoaId, owner!.id));
    expect(ownerPre).toHaveLength(0);
    expect(await db.select().from(pessoaNotes).where(eq(pessoaNotes.pessoaId, owner!.id))).toHaveLength(0);
  });
  it("confirms a Sofia-owned card without fabricating a human owner", async () => {
    const answers = { ...base, nome: "Nova Pessoa", email: `${tag}-sofia@example.test`, celular: "41999887766", cpf: "11144477735" };
    const interest = await submit(answers);
    expect(interest.status, JSON.stringify(interest.body)).toBe(201);
    const path = `/api/cursos-inscricao/${eventId}/preinscricoes/${interest.body.preinscricaoId}/pagamento`;
    const payment = await request(app).post(path).set(auth(adminToken)).send({ amount: "50", reference: "PIX Sofia fixture" });
    expect(payment.status).toBe(200);
    const result = await request(app).post(`/api/public/formalizacao/${payment.body.token}`).send({ respostas: answers });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const [card] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.id, interest.body.opportunityId));
    expect(card).toMatchObject({ stage: "CONFIRMED", ownerUserId: null, ownerSystem: "SOFIA" });
  });
  it("accepts the event interest form without Instagram even when an older stored version made it required", async () => {
    const [form] = await db.select().from(eventoFormularios).where(and(eq(eventoFormularios.eventoId, eventId), eq(eventoFormularios.tipo, "INTERESSE")));
    await db.insert(eventoFormularioVersoes).values({
      formularioId: form!.id, numero: 101,
      campos: [
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "celular", label: "Celular", type: "tel", required: true },
        { key: "instagram", label: "Instagram", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
      ],
    });
    const published = await request(app).get(`/api/public/formularios/${interestSlug}`);
    expect(published.body.versao.campos.find((f: { key: string }) => f.key === "instagram").required).toBe(false);
    expect(published.body.versao.campos.find((f: { key: string }) => f.key === "email").required).toBe(true);
    const response = await submit({ nome: "Sem Insta", celular: "61988776655", email: `${tag}-sem-insta@example.test` });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [person] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, response.body.pessoaId));
    expect(person!.instagram).toBeNull();
    // Os outros campos obrigatórios continuam obrigatórios.
    expect((await submit({ nome: "Sem Email", celular: "61988776655" })).status).toBe(400);
    const admin = await request(app).get(`/api/cursos-inscricao/${eventId}/formularios`).set(auth(adminToken));
    const interestForm = admin.body.find((f: { tipo: string }) => f.tipo === "INTERESSE");
    expect(interestForm.versoes[0].campos.find((f: { key: string }) => f.key === "instagram").required).toBe(false);
  });
});
