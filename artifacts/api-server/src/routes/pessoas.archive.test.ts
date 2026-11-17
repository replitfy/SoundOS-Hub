import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, setMock, returningMock, captured, mutablePessoaRows } = vi.hoisted(() => {
  const captured: { payload: Record<string, unknown> | null } = { payload: null };
  const mutablePessoaRows: { value: Array<{ id: number; mergedIntoPessoaId: number | null }> } = {
    value: [{ id: 42, mergedIntoPessoaId: null }],
  };
  const returningMock = vi.fn();
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn((payload: Record<string, unknown>) => {
    captured.payload = payload;
    return { where: whereMock };
  });
  const groupByMock = vi.fn(() => ({
    as: vi.fn(() => ({ pessoaId: "pessoa_id", count: "count" })),
  }));
  const dbMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        groupBy: groupByMock,
        where: vi.fn(() => ({ limit: vi.fn(async () => mutablePessoaRows.value) })),
      })),
    })),
    update: vi.fn(() => ({ set: setMock })),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  return { dbMock, setMock, returningMock, captured, mutablePessoaRows };
});

vi.mock("@workspace/db", () => ({
  db: dbMock,
  pessoasTable: {
    id: "id", codigo: "codigo", ativo: "ativo", arquivadoEm: "arquivado_em",
    nome: "nome", updatedAt: "updated_at",
    mergedIntoPessoaId: "merged_into_pessoa_id",
  },
  conversations: { pessoaId: "pessoa_id", createdAt: "created_at" },
  pessoaServicos: {},
  pessoaParticipacoes: {},
  pessoaInstrumentos: {},
  pessoaEvidencias: {},
  decisionRuns: {},
}));

vi.mock("drizzle-orm", () => {
  const expression = vi.fn(() => ({}));
  const sql = Object.assign(vi.fn(() => ({ as: vi.fn(() => ({})) })), { raw: vi.fn() });
  return {
    eq: expression,
    ilike: expression,
    or: expression,
    and: expression,
    isNull: expression,
    isNotNull: expression,
    desc: expression,
    asc: expression,
    getTableColumns: vi.fn(() => ({})),
    sql,
  };
});

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.authedUser = { id: 1, role: "usuario" };
    next();
  },
  requireAdminRole: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/evidencias", () => ({
  registrarEdicaoHumana: vi.fn(),
  getStatusCampos: vi.fn(),
  withPessoaLock: vi.fn(),
  PessoaNotFoundError: class PessoaNotFoundError extends Error {},
}));

import express from "express";
import request from "supertest";
import pessoasRouter from "./pessoas";

const app = express();
app.use(express.json());
app.use("/", pessoasRouter);

describe("pessoa archive lifecycle routes", () => {
  beforeEach(() => {
    setMock.mockClear();
    returningMock.mockReset();
    captured.payload = null;
    mutablePessoaRows.value = [{ id: 42, mergedIntoPessoaId: null }];
  });

  it("archives without changing active status or deleting related history", async () => {
    returningMock.mockResolvedValue([{ id: 42, nome: "Ana", ativo: true, arquivadoEm: new Date() }]);

    const response = await request(app).patch("/pessoas/42/arquivar");

    expect(response.status).toBe(200);
    const payload = captured.payload!;
    expect(payload.arquivadoEm).toBeInstanceOf(Date);
    expect(payload).not.toHaveProperty("ativo");
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("restores without changing active status", async () => {
    returningMock.mockResolvedValue([{ id: 42, nome: "Ana", ativo: false, arquivadoEm: null }]);

    const response = await request(app).patch("/pessoas/42/restaurar");

    expect(response.status).toBe(200);
    const payload = captured.payload!;
    expect(payload.arquivadoEm).toBeNull();
    expect(payload).not.toHaveProperty("ativo");
  });

  it("returns 404 when the pessoa does not exist", async () => {
    mutablePessoaRows.value = [];
    returningMock.mockResolvedValue([]);

    const response = await request(app).patch("/pessoas/999/arquivar");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Pessoa not found");
  });

  it("rejects lifecycle changes to a merged tombstone", async () => {
    mutablePessoaRows.value = [{ id: 42, mergedIntoPessoaId: 7 }];

    const response = await request(app).patch("/pessoas/42/restaurar");

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Merged pessoas are immutable",
      mergedIntoPessoaId: 7,
    });
    expect(setMock).not.toHaveBeenCalled();
  });
});