// Rota das compras da loja na ficha: validação do id, formato da resposta e erro explícito.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const service = vi.hoisted(() => ({ listLojaInstrumentos: vi.fn() }));
vi.mock("../services/pessoaLojaInstrumentos", () => service);

const { default: router } = await import("./pessoas-loja");

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { log: { error: () => void } }).log = { error: () => {} };
  next();
});
app.use("/api", router);

describe("GET /pessoas/:id/instrumentos-loja", () => {
  beforeEach(() => {
    service.listLojaInstrumentos.mockReset();
  });

  it("recusa id que não é número inteiro", async () => {
    for (const id of ["abc", "1abc", "-3", "1.5", "99999999999999999999"]) {
      const res = await request(app).get(`/api/pessoas/${id}/instrumentos-loja`);
      expect(res.status, id).toBe(400);
    }
    expect(service.listLojaInstrumentos).not.toHaveBeenCalled();
  });

  it("devolve o resultado do serviço para a ficha pedida", async () => {
    const result = { disponivel: true, coletadoEm: "2026-11-07T16:34:19.670Z", itens: [] };
    service.listLojaInstrumentos.mockResolvedValue(result);
    const res = await request(app).get("/api/pessoas/24651/instrumentos-loja");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(service.listLojaInstrumentos).toHaveBeenCalledWith(24651);
  });

  it("falha do serviço vira erro 500 explícito, nunca lista vazia", async () => {
    service.listLojaInstrumentos.mockRejectedValue(new Error("db down"));
    const res = await request(app).get("/api/pessoas/1/instrumentos-loja");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Não foi possível carregar as compras da loja." });
  });
});
