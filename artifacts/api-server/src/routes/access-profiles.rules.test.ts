import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_PROFILE_ROWS, profileIdFor } from "./testing/accessProfileFixtures";

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  accessProfilesTable: { id: "id", systemKey: "system_key", name: "name" },
}));

vi.mock("../middlewares/roleAuth", () => {
  const inject = (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = {
      id: 1, role: "admin_master", name: "Admin Teste", email: "a@example.test",
      profileId: 1, profileName: "Admin Master", isAdmin: true, areas: [],
    };
    next();
  };
  return { requireAuth: inject, requireArea: () => inject };
});

import express from "express";
import request from "supertest";
import { db } from "@workspace/db";
import router from "./access-profiles";

const app = express();
app.use(express.json());
app.use("/", router);

const dbMock = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

function currentProfile(row: Record<string, unknown> | undefined) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  dbMock.select.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
}

const row = (key: string) => SYSTEM_PROFILE_ROWS.find(profile => profile.systemKey === key)!;

describe("rotas de perfis de acesso — regras de proteção", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.execute.mockResolvedValue({ rows: [] });
    dbMock.transaction.mockImplementation(async (callback: (tx: typeof dbMock) => unknown) => callback(dbMock));
  });

  it("o Admin Master é fixo: não aceita edição", async () => {
    currentProfile(row("admin_master"));
    const response = await request(app).put(`/admin/access-profiles/${profileIdFor("admin_master")}`).send({ areas: ["pessoas"] });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LOCKED_PROFILE");
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("perfis do sistema não podem ser renomeados nem excluídos", async () => {
    currentProfile(row("usuario"));
    const rename = await request(app).put(`/admin/access-profiles/${profileIdFor("usuario")}`).send({ name: "Outro" });
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe("SYSTEM_PROFILE_NAME");

    const remove = await request(app).delete(`/admin/access-profiles/${profileIdFor("usuario")}`);
    expect(remove.status).toBe(409);
    expect(remove.body.code).toBe("SYSTEM_PROFILE");
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("não exclui um perfil em uso e informa quantos usuários o usam", async () => {
    currentProfile({ ...row("usuario"), id: 50, systemKey: null, name: "Financeiro" });
    dbMock.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 3, active: 3 }] });
    const response = await request(app).delete("/admin/access-profiles/50");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "PROFILE_IN_USE", userCount: 3 });
    expect(response.body.error).toMatch(/3 usuários/);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("recusa área desconhecida e áreas só de administrador em perfil comum", async () => {
    const unknown = await request(app).post("/admin/access-profiles").send({ name: "Teste", areas: ["nada"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("INVALID_AREA");

    const adminOnly = await request(app)
      .post("/admin/access-profiles")
      .send({ name: "Teste", isAdmin: false, areas: ["pessoas", "backup", "usuarios"] });
    expect(adminOnly.status).toBe(400);
    expect(adminOnly.body.code).toBe("ADMIN_ONLY_AREAS");
    expect(adminOnly.body.areas).toEqual(["usuarios", "backup"]);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("não deixa tirar a marca de administrador de um perfil que ainda tem telas de administrador", async () => {
    currentProfile(row("admin"));
    const response = await request(app).put(`/admin/access-profiles/${profileIdFor("admin")}`).send({ isAdmin: false });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("ADMIN_ONLY_AREAS");
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("desfaz a edição que deixaria o sistema sem quem gerencie perfis e usuários", async () => {
    currentProfile({ ...row("admin") });
    const returning = vi.fn().mockResolvedValue([{ ...row("admin"), areas: ["pessoas"], updatedAt: new Date() }]);
    dbMock.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }) });
    dbMock.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] });

    const response = await request(app)
      .put(`/admin/access-profiles/${profileIdFor("admin")}`)
      .send({ areas: ["pessoas"] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LAST_MANAGER");
  });
});
