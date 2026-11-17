import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listarTodaPosicaoEstoque } from "./omie";

describe("Omie stock pagination", () => {
  beforeEach(() => {
    process.env["OMIE_STORE_APP_KEY"] = "test-key";
    process.env["OMIE_STORE_APP_SECRET"] = "test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads all ListarPosEstoque pages using the real pagination keys", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 1,
        nTotPaginas: 2,
        nRegistros: 1,
        nTotRegistros: 2,
        produtos: [{ cCodigo: "SKU-1", nSaldo: 2 }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 2,
        nTotPaginas: 2,
        nRegistros: 1,
        nTotRegistros: 2,
        produtos: [{ cCodigo: "SKU-2", nSaldo: 3 }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await listarTodaPosicaoEstoque("store", "27/08/2026", 50);

    expect(rows.map(row => row.cCodigo)).toEqual(["SKU-1", "SKU-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).param[0]).toMatchObject({
      nPagina: 1,
      nRegPorPagina: 50,
      dDataPosicao: "27/08/2026",
      cExibeTodos: "S",
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).param[0].nPagina).toBe(2);
  });

  it("rejects a response without complete pagination metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      nPagina: 1,
      nRegistros: 1,
      produtos: [{ cCodigo: "SKU-1", nSaldo: 2 }],
    }), { status: 200 })));

    await expect(listarTodaPosicaoEstoque("store", "27/08/2026", 50))
      .rejects.toThrow("metadados incompletos");
  });

  it("rejects an empty intermediate page instead of accepting a partial snapshot", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 1,
        nTotPaginas: 3,
        nRegistros: 1,
        nTotRegistros: 2,
        produtos: [{ cCodigo: "SKU-1", nSaldo: 2 }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 2,
        nTotPaginas: 3,
        nRegistros: 0,
        nTotRegistros: 2,
        produtos: [],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listarTodaPosicaoEstoque("store", "27/08/2026", 50))
      .rejects.toThrow("página intermediária vazia");
  });
});