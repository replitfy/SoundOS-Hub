import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  usersTable: {
    id: "id",
    email: "email",
    name: "name",
    role: "role",
    profileId: "profile_id",
    passwordHash: "password_hash",
    passwordMustReset: "password_must_reset",
    active: "active",
    lastLogin: "last_login",
  },
  accessProfilesTable: { id: "id", systemKey: "system_key" },
  coursesTable: {},
  classesTable: {},
  enrollmentsTable: {},
  knowledgeItemsTable: {},
  promptsTable: {},
  conversations: {},
  messages: {},
  servicosCatalogo: { nome: "nome" },
  instrumentosCatalogo: { nome: "nome" },
}));

// Só a leitura dos perfis é simulada: a contagem de quem gerencia e a regra de
// "nunca ficar sem ninguém" rodam de verdade, sobre db.execute.
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
import { profileIdFor } from "./testing/accessProfileFixtures";

const app = express();
app.use(express.json());
app.use("/", adminRouter);

const dbMock = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

function selectResult(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit, orderBy });
  return { from: vi.fn().mockReturnValue({ where, orderBy }) };
}

/** db.execute é usado pela trava da transação e pela contagem de quem gerencia (antes e depois). */
function managersAround(before: number, after: number) {
  dbMock.execute
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ n: before }] })
    .mockResolvedValueOnce({ rows: [{ n: after }] });
}

function updatedUser(user: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([user]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  dbMock.update.mockReturnValue({ set });
  return set;
}

describe("admin user soft deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.transaction.mockImplementation(async (callback: (tx: typeof dbMock) => unknown) => callback(dbMock));
  });

  it("lista somente os usuários ativos retornados pela consulta filtrada", async () => {
    const activeUser = {
      id: 2, name: "Ativo", email: "ativo@example.com", role: "usuario", profileId: profileIdFor("usuario"),
      active: true, passwordMustReset: false, lastLogin: null,
    };
    dbMock.select.mockReturnValue(selectResult([activeUser]));

    const response = await request(app).get("/admin/users");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ id: 2, active: true, profileName: "Usuário", isAdmin: false }),
    ]);
    expect(response.body[0]).not.toHaveProperty("role");
  });

  it("impede que o administrador exclua a própria conta sem alterar o banco", async () => {
    const response = await request(app).delete("/admin/users/1");

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/própria conta/i);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("impede excluir o último administrador ativo", async () => {
    const target = {
      id: 2, name: "Último Admin", email: "ultimo@example.com", role: "admin_master",
      active: true, passwordMustReset: false, lastLogin: null,
    };
    dbMock.select.mockReturnValueOnce(selectResult([target]));
    updatedUser({ ...target, active: false });
    managersAround(1, 0);

    const response = await request(app).delete("/admin/users/2");

    // A alteração é desfeita pela transação ao lançar o erro: nada é confirmado.
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/último administrador ativo/i);
    expect(response.body.code).toBe("LAST_MANAGER");
  });

  it("desativa sem excluir o registro quando há outro administrador ativo", async () => {
    const target = {
      id: 2, name: "Admin Dois", email: "dois@example.com", role: "admin",
      active: true, passwordMustReset: false, lastLogin: null,
    };
    dbMock.select.mockReturnValueOnce(selectResult([target]));
    const set = updatedUser({ ...target, active: false });
    managersAround(2, 1);

    const response = await request(app).delete("/admin/users/2");

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);
    expect(set).toHaveBeenCalledWith({ active: false });
  });

  it("impede rebaixar o último administrador ativo", async () => {
    const target = {
      id: 2, name: "Último Admin", email: "ultimo@example.com", role: "admin",
      active: true, passwordMustReset: false, lastLogin: null,
    };
    dbMock.select
      .mockReturnValueOnce(selectResult([target]))
      .mockReturnValueOnce(selectResult([{ id: profileIdFor("usuario"), systemKey: "usuario", isAdmin: false }]));
    updatedUser({ ...target, role: "usuario", profileId: profileIdFor("usuario") });
    managersAround(1, 0);

    const response = await request(app)
      .put("/admin/users/2")
      .send({ profileId: profileIdFor("usuario") });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/último administrador ativo/i);
    expect(response.body.code).toBe("LAST_MANAGER");
  });
});