import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  usersTable: { id: "id", email: "email", name: "name" },
  accessProfilesTable: { id: "id", systemKey: "system_key" },
  coursesTable: { id: "id" },
  classesTable: { id: "id" },
  enrollmentsTable: { id: "id" },
  knowledgeItemsTable: { id: "id" },
  promptsTable: { id: "id" },
  conversations: { id: "id" },
  messages: { id: "id" },
  servicosCatalogo: { nome: "nome" },
  instrumentosCatalogo: { nome: "nome" },
}));

// As tabelas simuladas não têm colunas reais: só a lista de colunas é substituída.
vi.mock("drizzle-orm", async importOriginal => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, getTableColumns: () => ({ id: { name: "id" }, name: { name: "name" } }) };
});

vi.mock("../services/accessProfiles", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/accessProfiles")>();
  const { profileMaps } = await import("./testing/accessProfileFixtures");
  return { ...actual, loadProfileSummaries: vi.fn(async () => profileMaps()) };
});

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminRole: (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = { id: 1, role: "admin", name: "Admin", email: "admin@example.com" };
    next();
  },
}));

import express from "express";
import request from "supertest";
import { db } from "@workspace/db";
import adminRouter from "./admin";

const app = express();
app.use(express.json());
app.use("/", adminRouter);

const dbMock = db as unknown as {
  insert: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

/** Registra se cada transação foi confirmada ou desfeita (a de fora vem depois das de dentro). */
let outcomes: string[] = [];

function managersAround(before: number, after?: number) {
  dbMock.execute
    .mockResolvedValueOnce({ rows: [] }) // trava
    .mockResolvedValueOnce({ rows: [{ n: before }] });
  if (after !== undefined) dbMock.execute.mockResolvedValueOnce({ rows: [{ n: after }] });
}

const backup = {
  _meta: { version: "1.0" },
  access_profiles: [{ id: 2, name: "Admin" }],
  users: [{ id: 5, name: "Maria" }],
  courses: [{ id: 7, name: "Curso" }],
};

describe("restauração de backup e quem gerencia o acesso", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outcomes = [];
    dbMock.transaction.mockImplementation(async (callback: (tx: typeof dbMock) => unknown) => {
      try {
        const value = await callback(dbMock);
        outcomes.push("commit");
        return value;
      } catch (err) {
        outcomes.push("rollback");
        throw err;
      }
    });
    dbMock.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
    });
  });

  it("desfaz perfis e usuários quando a restauração deixaria a plataforma sem gestor, mas segue com as demais tabelas", async () => {
    managersAround(1, 0);

    const response = await request(app).post("/admin/restore").send(backup);

    expect(response.status).toBe(200);
    const byTable = Object.fromEntries(response.body.results.map((r: { table: string }) => [r.table, r]));
    expect(byTable.access_profiles).toMatchObject({ status: "error", rows: 0, code: "LAST_MANAGER" });
    expect(byTable.users).toMatchObject({ status: "error", rows: 0, code: "LAST_MANAGER" });
    expect(byTable.access_profiles.error).toMatch(/sem nenhum usuário ativo/i);
    expect(byTable.courses).toMatchObject({ status: "ok", rows: 1 });
    // Duas tabelas restauradas dentro da transação e a transação de fora desfeita.
    expect(outcomes.slice(0, 3)).toEqual(["commit", "commit", "rollback"]);
  });

  it("confirma perfis e usuários, sob a trava de gestão, quando continua havendo gestor", async () => {
    managersAround(2, 1);

    const response = await request(app).post("/admin/restore").send(backup);

    expect(response.status).toBe(200);
    expect(response.body.results.map((r: { table: string; status: string }) => [r.table, r.status])).toEqual([
      ["access_profiles", "ok"],
      ["users", "ok"],
      ["courses", "ok"],
    ]);
    expect(outcomes.slice(0, 3)).toEqual(["commit", "commit", "commit"]);
    expect(dbMock.execute).toHaveBeenCalledTimes(3); // trava + contagem antes + contagem depois
  });

  it("não impede a restauração que conserta uma plataforma que já estava sem gestor", async () => {
    managersAround(0);

    const response = await request(app).post("/admin/restore").send(backup);

    expect(response.status).toBe(200);
    expect(response.body.results.every((r: { status: string }) => r.status === "ok")).toBe(true);
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });

  it("não usa a trava nem a contagem quando o arquivo não traz perfis nem usuários", async () => {
    const response = await request(app)
      .post("/admin/restore")
      .send({ _meta: { version: "1.0" }, courses: backup.courses });

    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([{ table: "courses", rows: 1, status: "ok" }]);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("mantém o erro de uma tabela isolado das outras e ainda confere quem gerencia", async () => {
    managersAround(1, 1);
    dbMock.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("violação de chave")) }),
      });

    const response = await request(app).post("/admin/restore").send(backup);

    expect(response.status).toBe(200);
    const byTable = Object.fromEntries(response.body.results.map((r: { table: string }) => [r.table, r]));
    expect(byTable.access_profiles).toMatchObject({ status: "error", error: "violação de chave" });
    expect(byTable.users).toMatchObject({ status: "ok", rows: 1 });
    expect(byTable.courses).toMatchObject({ status: "ok", rows: 1 });
    expect(dbMock.execute).toHaveBeenCalledTimes(3);
  });
});
