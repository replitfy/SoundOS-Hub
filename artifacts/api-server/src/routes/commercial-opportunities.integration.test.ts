import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { and, eq, ne } from "drizzle-orm";

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
    "CRM confirmation integration tests require a uniquely named disposable database. " +
    "Use pnpm test:integration:crm-confirmation; refusing shared DATABASE_URL.",
  );
}

// Keep app/@workspace/db imports behind the guard above: this file is excluded
// from normal unit runs and can only initialize against the disposable clone.
const { default: app } = await import("../app");
const { createSessionToken } = await import("../lib/session");
const {
  classesTable,
  commercialOpportunities,
  commercialOpportunityEvents,
  coursesTable,
  cursosInscricao,
  db,
  enrollmentsTable,
  pessoasTable,
  usersTable,
} = await import("@workspace/db");
const { createOpportunity, transitionOpportunity, recordSofiaInterestMention, SOFIA_INTEREST_SOURCE } = await import(
  "../services/commercialOpportunities"
);
const { abrirCartaoPadrao } = await import("../services/sofiaTools/interesse");

type Fixture = {
  admin: { id: number; token: string };
  staff: { id: number; token: string };
  pessoaId: number;
  otherPessoaId: number;
  offerId: number;
  otherOfferId: number;
  validRegistrationId: number;
  otherPessoaRegistrationId: number;
  otherOfferRegistrationId: number;
};

let fixture: Fixture;

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function createFixture(): Promise<Fixture> {
  const marker = `crm-route-confirmation-${randomUUID()}`;

  const [admin] = await db.insert(usersTable).values({
    name: `${marker} admin`,
    email: `${marker}-admin@example.test`,
    role: "admin",
    active: true,
  }).returning({ id: usersTable.id });
  const [staff] = await db.insert(usersTable).values({
    name: `${marker} staff`,
    email: `${marker}-staff@example.test`,
    role: "usuario",
    active: true,
  }).returning({ id: usersTable.id });
  if (!admin || !staff) throw new Error("CRM route test users were not created.");

  const [pessoa] = await db.insert(pessoasTable).values({
    codigo: `${marker}-person`,
    nome: `${marker} primary`,
    email: `${marker}-person@example.test`,
  }).returning({ id: pessoasTable.id });
  const [otherPessoa] = await db.insert(pessoasTable).values({
    codigo: `${marker}-other-person`,
    nome: `${marker} other`,
    email: `${marker}-other@example.test`,
  }).returning({ id: pessoasTable.id });
  if (!pessoa || !otherPessoa) throw new Error("CRM route test people were not created.");

  const [course] = await db.insert(coursesTable).values({
    name: `${marker} course`,
    cycle: "test",
    modality: "presencial",
    workload: 1,
    price: "100.00",
  }).returning({ id: coursesTable.id });
  if (!course) throw new Error("CRM route test course was not created.");

  const [classForOffer] = await db.insert(classesTable).values({
    courseId: course.id,
    code: `${marker}-class`,
    startDate: "2099-01-01",
    endDate: "2099-01-02",
    teacher: "CRM route test",
  }).returning({ id: classesTable.id });
  const [classForOtherOffer] = await db.insert(classesTable).values({
    courseId: course.id,
    code: `${marker}-other-class`,
    startDate: "2099-02-01",
    endDate: "2099-02-02",
    teacher: "CRM route test",
  }).returning({ id: classesTable.id });
  if (!classForOffer || !classForOtherOffer) {
    throw new Error("CRM route test classes were not created.");
  }

  const [offer] = await db.insert(cursosInscricao).values({
    slug: `${marker}-offer`,
    nome: `${marker} Experiences offer`,
    nucleo: "EXPERIENCES",
    tipoEvento: "VIVENCIA",
    classId: classForOffer.id,
  }).returning({ id: cursosInscricao.id });
  const [otherOffer] = await db.insert(cursosInscricao).values({
    slug: `${marker}-other-offer`,
    nome: `${marker} other Experiences offer`,
    nucleo: "EXPERIENCES",
    tipoEvento: "VIVENCIA",
    classId: classForOtherOffer.id,
  }).returning({ id: cursosInscricao.id });
  if (!offer || !otherOffer) throw new Error("CRM route test offers were not created.");

  const [validRegistration] = await db.insert(enrollmentsTable).values({
    pessoaId: pessoa.id,
    classId: classForOffer.id,
    price: "100.00",
    paymentStatus: "paid",
    contractStatus: "pending",
  }).returning({ id: enrollmentsTable.id });
  const [otherPessoaRegistration] = await db.insert(enrollmentsTable).values({
    pessoaId: otherPessoa.id,
    classId: classForOffer.id,
    price: "100.00",
    paymentStatus: "paid",
    contractStatus: "pending",
  }).returning({ id: enrollmentsTable.id });
  const [otherOfferRegistration] = await db.insert(enrollmentsTable).values({
    pessoaId: pessoa.id,
    classId: classForOtherOffer.id,
    price: "100.00",
    paymentStatus: "paid",
    contractStatus: "pending",
  }).returning({ id: enrollmentsTable.id });
  if (!validRegistration || !otherPessoaRegistration || !otherOfferRegistration) {
    throw new Error("CRM route test registrations were not created.");
  }

  return {
    admin: { id: admin.id, token: createSessionToken(admin.id) },
    staff: { id: staff.id, token: createSessionToken(staff.id) },
    pessoaId: pessoa.id,
    otherPessoaId: otherPessoa.id,
    offerId: offer.id,
    otherOfferId: otherOffer.id,
    validRegistrationId: validRegistration.id,
    otherPessoaRegistrationId: otherPessoaRegistration.id,
    otherOfferRegistrationId: otherOfferRegistration.id,
  };
}

async function withTemporaryOpportunity(
  run: (opportunityId: number) => Promise<void>,
): Promise<void> {
  const opportunity = await createOpportunity({
    pessoaId: fixture.pessoaId,
    nucleus: "EXPERIENCES",
    cursosInscricaoId: fixture.offerId,
    offerLabel: "CRM route confirmation test",
    ownerUserId: fixture.staff.id,
    nextTaskType: "CALL",
    nextTaskText: "Run CRM confirmation route test",
    nextTaskAt: new Date("2099-03-01T12:00:00.000Z"),
    source: "CRM_ROUTE_INTEGRATION_TEST",
    actor: { kind: "HUMAN", id: fixture.admin.id, role: "admin" },
    idempotencyKey: `crm-route-test-create-${randomUUID()}`,
  });

  try {
    await run(opportunity.id);
  } finally {
    // Events are append-only. Close through the production service instead of
    // deleting the opportunity or its dependent fixtures.
    const [current] = await db
      .select({ stage: commercialOpportunities.stage })
      .from(commercialOpportunities)
      .where(eq(commercialOpportunities.id, opportunity.id))
      .limit(1);
    if (current && current.stage !== "CLOSED") {
      await transitionOpportunity({
        opportunityId: opportunity.id,
        toStage: "CLOSED",
        reason: "CRM route integration test cleanup",
        source: "CRM_ROUTE_INTEGRATION_TEST",
        idempotencyKey: `crm-route-test-close-${opportunity.id}`,
        actor: { kind: "HUMAN", id: fixture.admin.id, role: "admin" },
      });
    }
  }
}

describe("CRM confirmation authorization and audit routes", () => {
  beforeAll(async () => {
    fixture = await createFixture();
  });

  it("returns different confirmation options for staff and administrators", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      const staffResponse = await request(app)
        .get(`/api/crm/opportunities/${opportunityId}/confirmation-options`)
        .set(authorization(fixture.staff.token));
      const adminResponse = await request(app)
        .get(`/api/crm/opportunities/${opportunityId}/confirmation-options`)
        .set(authorization(fixture.admin.token));

      expect(staffResponse.status).toBe(200);
      expect(adminResponse.status).toBe(200);
      expect(staffResponse.body.options).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "EXPERIENCE_REGISTRATION",
          id: fixture.validRegistrationId,
        }),
      ]));
      expect(staffResponse.body.options).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "HUMAN_ADMIN" }),
      ]));
      expect(adminResponse.body.options).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "HUMAN_ADMIN" }),
      ]));
    });
  });

  it("rejects an Experiences registration belonging to another person or offer", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      for (const [registrationId, expectedMessage] of [
        [fixture.otherPessoaRegistrationId, "person"],
        [fixture.otherOfferRegistrationId, "offer"],
      ] as const) {
        const response = await request(app)
          .post(`/api/crm/opportunities/${opportunityId}/transition`)
          .set(authorization(fixture.staff.token))
          .send({
            toStage: "CONFIRMED",
            confirmation: {
              kind: "EXPERIENCE_REGISTRATION",
              registrationId,
            },
            source: "CRM_ROUTE_INTEGRATION_TEST",
            idempotencyKey: `crm-route-invalid-registration-${expectedMessage}-${randomUUID()}`,
          });

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("CONFIRMATION_EVIDENCE_INVALID");
      }
    });
  });

  it("persists CONFIRMED and an attributed exact confirmation audit event", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      const transitionResponse = await request(app)
        .post(`/api/crm/opportunities/${opportunityId}/transition`)
        .set(authorization(fixture.staff.token))
        .send({
          toStage: "CONFIRMED",
          confirmation: {
            kind: "EXPERIENCE_REGISTRATION",
            registrationId: fixture.validRegistrationId,
          },
          source: "CRM_ROUTE_INTEGRATION_TEST",
          idempotencyKey: `crm-route-valid-confirmation-${randomUUID()}`,
        });

      expect(transitionResponse.status).toBe(200);
      expect(transitionResponse.body.stage).toBe("CONFIRMED");

      const historyResponse = await request(app)
        .get(`/api/crm/opportunities/${opportunityId}/history`)
        .set(authorization(fixture.staff.token));
      expect(historyResponse.status).toBe(200);
      const confirmationEvent = historyResponse.body.find(
        (event: { eventType: string }) => event.eventType === "CONFIRMATION_RECORDED",
      );
      expect(confirmationEvent).toEqual(expect.objectContaining({
        actorKind: "HUMAN",
        actorId: fixture.staff.id,
        toStage: "CONFIRMED",
        source: "CRM_ROUTE_INTEGRATION_TEST",
        metadata: expect.objectContaining({
          confirmation: {
            kind: "EXPERIENCE_REGISTRATION",
            registrationId: fixture.validRegistrationId,
          },
        }),
      }));
      expect(confirmationEvent.metadata.confirmation).toEqual({
        kind: "EXPERIENCE_REGISTRATION",
        registrationId: fixture.validRegistrationId,
      });
    });
  });

  it("rejects staff HUMAN_ADMIN confirmation with no confirmation event", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      const response = await request(app)
        .post(`/api/crm/opportunities/${opportunityId}/transition`)
        .set(authorization(fixture.staff.token))
        .send({
          toStage: "CONFIRMED",
          confirmation: { kind: "HUMAN_ADMIN" },
          source: "CRM_ROUTE_INTEGRATION_TEST",
          idempotencyKey: `crm-route-staff-human-confirmation-${randomUUID()}`,
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ADMIN_CONFIRMATION_REQUIRED");

      const historyResponse = await request(app)
        .get(`/api/crm/opportunities/${opportunityId}/history`)
        .set(authorization(fixture.staff.token));
      expect(historyResponse.status).toBe(200);
      expect(historyResponse.body).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "CONFIRMATION_RECORDED" }),
      ]));
    });
  });

  it("allows admin HUMAN_ADMIN confirmation and attributes its audit metadata", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      const response = await request(app)
        .post(`/api/crm/opportunities/${opportunityId}/transition`)
        .set(authorization(fixture.admin.token))
        .send({
          toStage: "CONFIRMED",
          confirmation: { kind: "HUMAN_ADMIN" },
          source: "CRM_ROUTE_INTEGRATION_TEST",
          idempotencyKey: `crm-route-admin-human-confirmation-${randomUUID()}`,
        });

      expect(response.status).toBe(200);
      expect(response.body.stage).toBe("CONFIRMED");

      const historyResponse = await request(app)
        .get(`/api/crm/opportunities/${opportunityId}/history`)
        .set(authorization(fixture.admin.token));
      expect(historyResponse.status).toBe(200);
      const confirmationEvent = historyResponse.body.find(
        (event: { eventType: string }) => event.eventType === "CONFIRMATION_RECORDED",
      );
      expect(confirmationEvent).toEqual(expect.objectContaining({
        actorKind: "HUMAN",
        actorId: fixture.admin.id,
        toStage: "CONFIRMED",
        source: "CRM_ROUTE_INTEGRATION_TEST",
        metadata: expect.objectContaining({
          confirmation: { kind: "HUMAN_ADMIN" },
        }),
      }));
      expect(confirmationEvent.metadata.confirmation).toEqual({ kind: "HUMAN_ADMIN" });
    });
  });

  it("rejects extra confirmation fields", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      const response = await request(app)
        .post(`/api/crm/opportunities/${opportunityId}/transition`)
        .set(authorization(fixture.staff.token))
        .send({
          toStage: "CONFIRMED",
          confirmation: {
            kind: "EXPERIENCE_REGISTRATION",
            registrationId: fixture.validRegistrationId,
            operationalReference: "free-form-reference-must-not-be-accepted",
          },
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe("CONFIRMATION_EVIDENCE_INVALID");
    });
  });

  it("rejects confirmation payloads on non-CONFIRMED transitions", async () => {
    await withTemporaryOpportunity(async (opportunityId) => {
      const confirmation = {
        kind: "EXPERIENCE_REGISTRATION",
        registrationId: fixture.validRegistrationId,
      };
      const response = await request(app)
        .post(`/api/crm/opportunities/${opportunityId}/transition`)
        .set(authorization(fixture.staff.token))
        .send({
          toStage: "DECIDING",
          confirmation,
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe("CONFIRMATION_EVIDENCE_INVALID");
    });
  });
});

describe("cartão de interesse aberto pela Sofia sem responsável", () => {
  async function closeIfOpen(opportunityId: number): Promise<void> {
    const [current] = await db
      .select({ stage: commercialOpportunities.stage })
      .from(commercialOpportunities)
      .where(eq(commercialOpportunities.id, opportunityId))
      .limit(1);
    if (current && current.stage !== "CLOSED") {
      await transitionOpportunity({
        opportunityId,
        toStage: "CLOSED",
        reason: "CRM route integration test cleanup",
        source: "CRM_ROUTE_INTEGRATION_TEST",
        idempotencyKey: `crm-route-test-close-${opportunityId}`,
        actor: { kind: "HUMAN", id: fixture.admin.id, role: "admin" },
      });
    }
  }

  const interesse = () => ({
    pessoaId: fixture.pessoaId,
    nucleus: "EXPERIENCES" as const,
    cursosInscricaoId: fixture.otherOfferId,
    offerLabel: "Interesse via Sofia (teste)",
    nextTaskType: "WHATSAPP" as const,
    nextTaskText: "Enviar valores e condições",
    nextTaskAt: new Date("2099-03-01T12:00:00.000Z"),
    source: SOFIA_INTEREST_SOURCE,
    actor: { kind: "SOFIA" as const },
    allowUnowned: true,
    idempotencyKey: `sofia-interesse-test-${randomUUID()}`,
  });

  it("nasce sem responsável, aparece no filtro 'sem responsável' e segue a regra de uma oferta ativa", async () => {
    const created = await createOpportunity(interesse());
    try {
      expect(created.ownerUserId).toBeNull();
      expect(created.stage).toBe("NEW_INTEREST");
      expect(created.nextTaskText).toBe("Enviar valores e condições");

      const unassigned = await request(app)
        .get("/api/crm/opportunities?unassigned=true")
        .set(authorization(fixture.staff.token));
      expect(unassigned.status).toBe(200);
      const rows: Array<{ id: number }> = unassigned.body.opportunities ?? unassigned.body;
      expect(rows.some((row) => row.id === created.id)).toBe(true);

      await expect(createOpportunity({ ...interesse(), idempotencyKey: `sofia-interesse-test-${randomUUID()}` }))
        .rejects.toMatchObject({ code: "ACTIVE_OPPORTUNITY_EXISTS", status: 409 });
    } finally {
      await closeIfOpen(created.id);
    }
  });

  describe("Assumir", () => {
    const claim = (id: number, token: string) =>
      request(app).post(`/api/crm/opportunities/${id}/claim`).set(authorization(token));

    async function eventsOf(opportunityId: number) {
      return db
        .select()
        .from(commercialOpportunityEvents)
        .where(eq(commercialOpportunityEvents.opportunityId, opportunityId));
    }

    it("define o usuário logado como responsável, mantém a próxima ação e registra o evento", async () => {
      const created = await createOpportunity(interesse());
      try {
        const response = await claim(created.id, fixture.staff.token);
        expect(response.status).toBe(200);
        expect(response.body.ownerUserId).toBe(fixture.staff.id);
        expect(response.body.stage).toBe("NEW_INTEREST");
        expect(response.body.version).toBe(created.version + 1);
        expect(response.body.nextTaskType).toBe(created.nextTaskType);
        expect(response.body.nextTaskText).toBe(created.nextTaskText);
        expect(new Date(response.body.nextTaskAt).toISOString()).toBe(created.nextTaskAt?.toISOString());

        const claimEvents = (await eventsOf(created.id)).filter((event) => event.eventType === "OWNER_CHANGED");
        expect(claimEvents).toHaveLength(1);
        expect(claimEvents[0]).toMatchObject({ actorKind: "HUMAN", actorId: fixture.staff.id });
        expect(claimEvents[0]?.metadata).toMatchObject({
          claimed: true,
          previousOwnerUserId: null,
          ownerUserId: fixture.staff.id,
        });

        const unassigned = await request(app)
          .get("/api/crm/opportunities?unassigned=true")
          .set(authorization(fixture.staff.token));
        const rows: Array<{ id: number }> = unassigned.body.opportunities ?? unassigned.body;
        expect(rows.some((row) => row.id === created.id)).toBe(false);
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("avisa com 409 em vez de sobrescrever quando outra pessoa assumiu primeiro", async () => {
      const created = await createOpportunity(interesse());
      try {
        expect((await claim(created.id, fixture.staff.token)).status).toBe(200);
        const second = await claim(created.id, fixture.admin.token);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe("OPPORTUNITY_ALREADY_CLAIMED");

        const [current] = await db
          .select({ ownerUserId: commercialOpportunities.ownerUserId })
          .from(commercialOpportunities)
          .where(eq(commercialOpportunities.id, created.id));
        expect(current?.ownerUserId).toBe(fixture.staff.id);
        expect((await eventsOf(created.id)).filter((event) => event.eventType === "OWNER_CHANGED")).toHaveLength(1);
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("com dois cliques simultâneos só um atendente vence", async () => {
      const created = await createOpportunity(interesse());
      try {
        const [first, second] = await Promise.all([
          claim(created.id, fixture.staff.token),
          claim(created.id, fixture.admin.token),
        ]);
        expect([first.status, second.status].sort()).toEqual([200, 409]);
        const winner = first.status === 200 ? fixture.staff.id : fixture.admin.id;
        const [current] = await db
          .select({ ownerUserId: commercialOpportunities.ownerUserId })
          .from(commercialOpportunities)
          .where(eq(commercialOpportunities.id, created.id));
        expect(current?.ownerUserId).toBe(winner);
        expect((await eventsOf(created.id)).filter((event) => event.eventType === "OWNER_CHANGED")).toHaveLength(1);
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("assumir de novo o próprio cartão não muda nada nem duplica o evento", async () => {
      const created = await createOpportunity(interesse());
      try {
        const first = await claim(created.id, fixture.staff.token);
        const again = await claim(created.id, fixture.staff.token);
        expect(again.status).toBe(200);
        expect(again.body.version).toBe(first.body.version);
        expect((await eventsOf(created.id)).filter((event) => event.eventType === "OWNER_CHANGED")).toHaveLength(1);
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("não assume cartão encerrado, inexistente ou sem login", async () => {
      const created = await createOpportunity(interesse());
      await closeIfOpen(created.id);
      const closed = await claim(created.id, fixture.staff.token);
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe("OPPORTUNITY_CLOSED");

      const missing = await claim(2147483647, fixture.staff.token);
      expect(missing.status).toBe(404);

      const anonymous = await request(app).post(`/api/crm/opportunities/${created.id}/claim`);
      expect(anonymous.status).toBe(401);
    });
  });

  describe("conversa da Sofia no histórico do cartão", () => {
    const contexto = (conversationId: number, mensagem: string) => ({
      conversationId,
      capturadoEm: new Date().toISOString(),
      mensagens: [mensagem],
      ficha: { cidade: "Campinas" },
    });
    const params = (conversationId: number, mensagem: string) => ({
      pessoaId: fixture.pessoaId,
      nucleus: "EXPERIENCES" as const,
      eventoId: fixture.otherOfferId,
      rotulo: "Interesse via Sofia (teste)",
      textoProximaAcao: "Enviar valores e condições",
      agora: new Date(),
      conversationId,
      contexto: contexto(conversationId, mensagem),
    });
    const eventosDe = (opportunityId: number) =>
      db.select().from(commercialOpportunityEvents).where(eq(commercialOpportunityEvents.opportunityId, opportunityId));
    const cartaoDe = async (opportunityId: number) => {
      const [row] = await db.select().from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId)).limit(1);
      return row!;
    };

    it("o evento de criação guarda a conversa e a impressão digital da requisição", async () => {
      const created = await createOpportunity({
        ...interesse(),
        eventMetadata: { sofiaConversation: contexto(9001, "Quero fazer o Ciclo Água") },
      });
      try {
        const [criacao] = (await eventosDe(created.id)).filter((e) => e.eventType === "CREATED");
        expect(criacao?.metadata).toMatchObject({
          sofiaConversation: { conversationId: 9001, mensagens: ["Quero fazer o Ciclo Água"], ficha: { cidade: "Campinas" } },
        });
        expect(criacao?.metadata?.requestFingerprint).toBeTruthy();
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("interesse repetido não duplica: registra a conversa e atualiza a última interação sem mexer em dono, etapa, ação e versão", async () => {
      const created = await createOpportunity(interesse());
      try {
        const antes = await cartaoDe(created.id);
        const resultado = await abrirCartaoPadrao(params(9002, "Quero saber como participar"));
        expect(resultado).toBe("ja_existia");

        const depois = await cartaoDe(created.id);
        expect(depois.ownerUserId).toBeNull();
        expect(depois.stage).toBe(antes.stage);
        expect(depois.version).toBe(antes.version);
        expect(depois.nextTaskType).toBe(antes.nextTaskType);
        expect(depois.nextTaskText).toBe(antes.nextTaskText);
        expect(depois.nextTaskAt?.toISOString()).toBe(antes.nextTaskAt?.toISOString());
        expect(depois.lastInteractionAt?.getTime() ?? 0).toBeGreaterThan(antes.lastInteractionAt?.getTime() ?? 0);

        const ativos = await db.select({ id: commercialOpportunities.id }).from(commercialOpportunities).where(and(
          eq(commercialOpportunities.pessoaId, fixture.pessoaId),
          eq(commercialOpportunities.cursosInscricaoId, fixture.otherOfferId),
          ne(commercialOpportunities.stage, "CLOSED"),
        ));
        expect(ativos).toHaveLength(1);

        const atualizacoes = (await eventosDe(created.id)).filter((e) => e.eventType === "UPDATED");
        expect(atualizacoes).toHaveLength(1);
        expect(atualizacoes[0]).toMatchObject({ actorKind: "SOFIA", source: SOFIA_INTEREST_SOURCE });
        expect(atualizacoes[0]?.metadata).toMatchObject({
          sofiaConversation: { conversationId: 9002, mensagens: ["Quero saber como participar"] },
        });
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("a mesma conversa não enche o histórico, mas outra conversa registra o novo trecho", async () => {
      const created = await createOpportunity({
        ...interesse(),
        eventMetadata: { sofiaConversation: contexto(9003, "primeira") },
      });
      try {
        // Mesma conversa que abriu o cartão, dentro da janela: nada novo no histórico.
        await abrirCartaoPadrao(params(9003, "segunda mensagem"));
        expect((await eventosDe(created.id)).filter((e) => e.eventType === "UPDATED")).toHaveLength(0);

        await abrirCartaoPadrao(params(9004, "outra conversa"));
        await abrirCartaoPadrao(params(9004, "outra conversa de novo"));
        const atualizacoes = (await eventosDe(created.id)).filter((e) => e.eventType === "UPDATED");
        expect(atualizacoes).toHaveLength(1);
        expect(atualizacoes[0]?.metadata).toMatchObject({ sofiaConversation: { conversationId: 9004 } });
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("cartão assumido por uma pessoa continua dela e também recebe o trecho", async () => {
      const created = await createOpportunity(interesse());
      try {
        const assumido = await request(app)
          .post(`/api/crm/opportunities/${created.id}/claim`)
          .set(authorization(fixture.staff.token));
        expect(assumido.status).toBe(200);
        const antes = await cartaoDe(created.id);

        expect(await abrirCartaoPadrao(params(9005, "voltei a pedir"))).toBe("ja_existia");

        const depois = await cartaoDe(created.id);
        expect(depois.ownerUserId).toBe(fixture.staff.id);
        expect(depois.version).toBe(antes.version);
        expect(depois.stage).toBe(antes.stage);
        expect((await eventosDe(created.id)).filter((e) => e.eventType === "UPDATED")).toHaveLength(1);
      } finally {
        await closeIfOpen(created.id);
      }
    });

    it("sem cartão ativo não há o que atualizar: cartão encerrado não recebe registro", async () => {
      const created = await createOpportunity(interesse());
      await closeIfOpen(created.id);
      const registrado = await recordSofiaInterestMention({
        pessoaId: fixture.pessoaId,
        nucleus: "EXPERIENCES",
        cursosInscricaoId: fixture.otherOfferId,
        conversationId: 9006,
        metadata: { sofiaConversation: contexto(9006, "tarde demais") },
      });
      expect(registrado).toBe(false);
      expect((await eventosDe(created.id)).filter((e) => e.eventType === "UPDATED")).toHaveLength(0);
    });
  });

  it("o banco recusa cartão ativo sem responsável de qualquer outra origem", async () => {
    await expect(db.insert(commercialOpportunities).values({
      pessoaId: fixture.pessoaId,
      nucleus: "EXPERIENCES",
      cursosInscricaoId: fixture.offerId,
      offerIdentity: `curso:${fixture.offerId}`,
      ownerUserId: null,
      nextTaskType: "WHATSAPP",
      nextTaskText: "Sem dono",
      nextTaskAt: new Date("2099-03-01T12:00:00.000Z"),
      source: "CRM",
    })).rejects.toBeTruthy();
  });

  it("a rota humana não aceita cartão sem responsável nem o parâmetro allowUnowned", async () => {
    const response = await request(app)
      .post("/api/crm/opportunities")
      .set(authorization(fixture.staff.token))
      .send({
        pessoaId: fixture.pessoaId,
        nucleus: "EXPERIENCES",
        cursosInscricaoId: fixture.offerId,
        nextTaskType: "WHATSAPP",
        nextTaskText: "Sem dono",
        nextTaskAt: "2099-03-01T12:00:00.000Z",
        ownerUserId: null,
        allowUnowned: true,
        source: SOFIA_INTEREST_SOURCE,
      });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("OPPORTUNITY_RULE_VIOLATION");
  });
});
