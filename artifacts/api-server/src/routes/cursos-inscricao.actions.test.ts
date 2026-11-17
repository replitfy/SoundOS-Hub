import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, updateMock, selectResult } = vi.hoisted(() => {
  const selectResult: { rows: unknown[] } = { rows: [] };
  const limit = vi.fn(async () => selectResult.rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const updateMock = vi.fn();
  return {
    selectResult,
    updateMock,
    dbMock: {
      select: vi.fn(() => ({ from })),
      update: updateMock,
      insert: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

vi.mock("@workspace/db", () => ({
  db: dbMock,
  OPPORTUNITY_NUCLEI: ["EDUCATION", "EXPERIENCES"],
  cursosInscricao: {
    id: "id", slug: "slug", nome: "nome", descricao: "descricao", local: "local",
    dataInicio: "data_inicio", dataFim: "data_fim", observacoes: "observacoes",
    ativo: "ativo", nucleo: "nucleo", tipoEvento: "tipo_evento", courseId: "course_id",
    classId: "class_id", createdAt: "created_at", updatedAt: "updated_at",
  },
  pessoasTable: {},
  pessoaServicos: { pessoaId: "pessoa_id", cursosInscricaoId: "cursos_inscricao_id", servicoNome: "servico_nome", obs: "obs" },
}));

vi.mock("drizzle-orm", () => {
  const expression = vi.fn(() => ({}));
  return { eq: expression, desc: expression, ilike: expression, sql: Object.assign(vi.fn(() => ({ as: vi.fn(() => ({})) })), { raw: vi.fn() }) };
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

describe("proteção dos eventos geridos por turma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResult.rows = [{ classId: 77 }];
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 20, classId: 77 }]),
        })),
      })),
    });
  });

  it("permite edição, arquivamento e restauração via PATCH", async () => {
    for (const body of [{ nome: "Alterado" }, { ativo: false }, { ativo: true }]) {
      const response = await request(app).patch("/cursos-inscricao/20").send(body);
      expect(response.status).toBe(200);
    }
    expect(updateMock).toHaveBeenCalledTimes(3);
  });

  it("recusa o endpoint legado de arquivamento", async () => {
    const response = await request(app).delete("/cursos-inscricao/20");
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("turma");
    expect(updateMock).not.toHaveBeenCalled();
  });
});