import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbMock,
  queryResults,
  deleteWhereMock,
  eventTable,
  submissionsTable,
  preRegistrationsTable,
  formalizationsTable,
  servicesTable,
  opportunitiesTable,
  opportunityNuclei,
  classTable,
  courseTable,
  enrollmentsTable,
} = vi.hoisted(() => {
  const queryResults = new Map<unknown, unknown[]>();
  const deleteWhereMock = vi.fn(async () => []);
  const transactionMock = vi.fn();
  const eventTable = {
    id: "events.id",
    nome: "events.nome",
    slug: "events.slug",
    classId: "events.class_id",
    courseId: "events.course_id",
  };
  const submissionsTable = { eventoId: "submissions.evento_id" };
  const preRegistrationsTable = { eventoId: "pre_registrations.evento_id" };
  const formalizationsTable = { eventoId: "formalizations.evento_id", classId: "formalizations.class_id" };
  const servicesTable = {
    cursosInscricaoId: "services.cursos_inscricao_id",
    servicoNome: "services.servico_nome",
    obs: "services.obs",
  };
  const opportunitiesTable = { cursosInscricaoId: "opportunities.cursos_inscricao_id" };
  const classTable = { id: "classes.id", code: "classes.code", courseId: "classes.course_id" };
  const courseTable = { id: "courses.id", name: "courses.name" };
  const enrollmentsTable = { id: "enrollments.id", pessoaId: "enrollments.pessoa_id", classId: "enrollments.class_id" };
  const opportunityNuclei = ["EDUCATION", "EXPERIENCES"];
  const dbMock = {
    transaction: transactionMock,
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return {
    dbMock, queryResults, deleteWhereMock, transactionMock,
    eventTable, submissionsTable, preRegistrationsTable,
    formalizationsTable, servicesTable, opportunitiesTable,
    opportunityNuclei, classTable, courseTable, enrollmentsTable,
  };
});

vi.mock("@workspace/db", () => ({
  db: dbMock,
  cursosInscricao: eventTable,
  eventoFormularioSubmissoes: submissionsTable,
  eventoPreinscricoes: preRegistrationsTable,
  eventFormalizations: formalizationsTable,
  pessoaServicos: servicesTable,
  commercialOpportunities: opportunitiesTable,
  classesTable: classTable,
  coursesTable: courseTable,
  enrollmentsTable,
  OPPORTUNITY_NUCLEI: opportunityNuclei,
}));

vi.mock("drizzle-orm", () => {
  const sql = Object.assign(vi.fn(() => ({ as: vi.fn(() => ({})) })), { raw: vi.fn() });
  return {
    eq: vi.fn(() => ({})),
    desc: vi.fn(() => ({})),
    ilike: vi.fn(() => ({})),
    and: vi.fn(() => ({})),
    or: vi.fn(() => ({})),
    inArray: vi.fn(() => ({})),
    isNull: vi.fn(() => ({})),
    sql,
  };
});

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/evidencias", () => ({
  registrarDeclaracaoPublica: vi.fn(),
  withPessoaLock: vi.fn(),
}));

import express from "express";
import request from "supertest";
import router from "./cursos-inscricao";

const app = express();
app.use(express.json());
app.use("/", router);
app.use((error: unknown, _req: unknown, res: any, _next: unknown) => {
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

function installTransaction() {
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const result = queryResults.get(table) ?? [];
        const query = {
          where: vi.fn(() => query),
          for: vi.fn(async () => result),
          limit: vi.fn(async () => result),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
        };
        return query;
      }),
    })),
    delete: vi.fn(() => ({ where: deleteWhereMock })),
  };
  dbMock.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(tx));
  return tx;
}

describe("DELETE /cursos-inscricao/bulk-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.clear();
    queryResults.set(eventTable, [{ id: 20 }, { id: 21 }]);
    installTransaction();
  });

  it("permanently removes selected events as one batch", async () => {
    const response = await request(app)
      .delete("/cursos-inscricao/bulk-delete")
      .send({ ids: [20, 21] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ deletedCount: 2 });
    expect(deleteWhereMock).toHaveBeenCalledOnce();
  });

  it("blocks the whole batch when an event has submitted history", async () => {
    queryResults.set(submissionsTable, [{ eventoId: 20 }]);

    const response = await request(app)
      .delete("/cursos-inscricao/bulk-delete")
      .send({ ids: [20, 21] });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("histórico");
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("does not delete a partial batch when an id is missing", async () => {
    queryResults.set(eventTable, [{ id: 20 }]);

    const response = await request(app)
      .delete("/cursos-inscricao/bulk-delete")
      .send({ ids: [20, 21] });

    expect(response.status).toBe(404);
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("validates ids before opening a transaction", async () => {
    const response = await request(app)
      .delete("/cursos-inscricao/bulk-delete")
      .send({ ids: [20, 20] });

    expect(response.status).toBe(400);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

describe("DELETE /cursos-inscricao/bulk-cascade-test-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.clear();
    queryResults.set(eventTable, [{
      id: 20,
      name: "E2E CRM Education",
      slug: "e2e-crm-20",
      classId: 77,
      courseId: 99,
    }]);
    queryResults.set(classTable, [{ id: 77, code: "E2E-CLASS-20", courseId: 99 }]);
    queryResults.set(courseTable, [{ id: 99, name: "E2E Course 20" }]);
    queryResults.set(enrollmentsTable, [
      { id: 1, pessoaId: 500 },
      { id: 2, pessoaId: 501 },
      { id: 3, pessoaId: 502 },
    ]);
    queryResults.set(opportunitiesTable, []);
    queryResults.set(formalizationsTable, []);
    installTransaction();
  });

  it("deletes a test event, its exclusive class/course, and enrollments", async () => {
    const response = await request(app)
      .delete("/cursos-inscricao/bulk-cascade-test-delete")
      .send({ ids: [20], confirmation: "123mudar" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({
      deletedEventCount: 1,
      deletedClassCount: 1,
      deletedCourseCount: 1,
      deletedEnrollmentCount: 3,
    });
    expect(deleteWhereMock).toHaveBeenCalledTimes(6);
  });

  it("rejects a non-test event before deleting anything", async () => {
    queryResults.set(eventTable, [{
      id: 20,
      name: "Public workshop",
      slug: "public-workshop",
      classId: null,
      courseId: null,
    }]);

    const response = await request(app)
      .delete("/cursos-inscricao/bulk-cascade-test-delete")
      .send({ ids: [20], confirmation: "123mudar" });

    expect(response.status).toBe(409);
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("rejects the batch when the linked class is not marked as test data", async () => {
    queryResults.set(classTable, [{ id: 77, code: "CLASS-77", courseId: 99 }]);

    const response = await request(app)
      .delete("/cursos-inscricao/bulk-cascade-test-delete")
      .send({ ids: [20], confirmation: "123mudar" });

    expect(response.status).toBe(409);
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("preserves the batch when an event has CRM opportunity history", async () => {
    queryResults.set(opportunitiesTable, [{ id: 900 }]);

    const response = await request(app)
      .delete("/cursos-inscricao/bulk-cascade-test-delete")
      .send({ ids: [20], confirmation: "123mudar" });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("CRM");
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("requires the exact confirmation phrase before opening a transaction", async () => {
    const response = await request(app)
      .delete("/cursos-inscricao/bulk-cascade-test-delete")
      .send({ ids: [20], confirmation: "incorrect" });

    expect(response.status).toBe(400);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});
