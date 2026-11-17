import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listarTodosMovimentosFinanceiros,
  listarTodosTitulos,
  obterSaldoAtualContaCorrente,
} from "./omie";

function lancamentoPagar(
  id: number,
  head: Record<string, unknown> = {},
  summary: Record<string, unknown> = {},
) {
  return {
    cabecTitulo: {
      nCodTitulo: id,
      nCodCC: 11507725767,
      nCodCliente: 11508638157,
      cNatureza: "P",
      cNumDocFiscal: "58",
      cNumParcela: "003/009",
      dDtEmissao: "29/04/2026",
      dDtVenc: "05/01/2027",
      nValorTitulo: 4400,
      cStatus: "A VENCER",
      ...head,
    },
    resumo: { cLiquidado: "N", nValPago: 0, nValAberto: 4400, ...summary },
  };
}

function lancamentosPage(
  items: unknown[],
  page = 1,
  totalPages = 1,
  totalRecords = items.length,
) {
  return new Response(JSON.stringify({
    nPagina: page,
    nTotPaginas: totalPages,
    nRegistros: items.length,
    nTotRegistros: totalRecords,
    titulosEncontrados: items,
  }), { status: 200 });
}

describe("Omie financial pagination", () => {
  beforeEach(() => {
    process.env["OMIE_EDUCATION_APP_KEY"] = "test-key";
    process.env["OMIE_EDUCATION_APP_SECRET"] = "test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects every page only when pagination metadata stays consistent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagina: 1,
        total_de_paginas: 2,
        registros: 1,
        total_de_registros: 2,
        conta_receber_cadastro: [{
          codigo_lancamento_omie: 101,
          data_vencimento: "10/09/2026",
          valor_documento: 100,
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagina: 2,
        total_de_paginas: 2,
        registros: 1,
        total_de_registros: 2,
        conta_receber_cadastro: [{
          codigo_lancamento_omie: 102,
          data_vencimento: "11/09/2026",
          valor_documento: 200,
        }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listarTodosTitulos("education", "receber", {
      dataDe: "16/09/2025",
      dataAte: "15/09/2026",
    });

    expect(result.map(title => title.codigo_lancamento_omie)).toEqual([101, 102]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty intermediate page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 1,
        nTotPaginas: 3,
        nRegistros: 1,
        nTotRegistros: 2,
        titulosEncontrados: [lancamentoPagar(201)],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 2,
        nTotPaginas: 3,
        nRegistros: 0,
        nTotRegistros: 2,
        titulosEncontrados: [],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listarTodosTitulos("education", "pagar", {}))
      .rejects.toThrow("Página vazia antes do fim");
  });

  it("rejects totals that change between pages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagina: 1,
        total_de_paginas: 2,
        registros: 1,
        total_de_registros: 2,
        conta_receber_cadastro: [{
          codigo_lancamento_omie: 301,
          data_vencimento: "10/09/2026",
          valor_documento: 100,
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagina: 2,
        total_de_paginas: 2,
        registros: 1,
        total_de_registros: 3,
        conta_receber_cadastro: [{
          codigo_lancamento_omie: 302,
          data_vencimento: "11/09/2026",
          valor_documento: 200,
        }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listarTodosTitulos("education", "receber", {}))
      .rejects.toThrow("Totais mudaram");
  });

  it("collects all cash-movement pages with the confirmed Omie request shape", async () => {
    const movement = (id: number) => ({
      detalhes: {
        cNatureza: "R",
        cOrigem: "BAXR",
        dDtPagamento: "15/09/2026",
        nCodCC: 10,
        nCodMovCC: id,
        nValorMovCC: 100,
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 1,
        nTotPaginas: 2,
        nRegistros: 1,
        nTotRegistros: 2,
        movimentos: [movement(401)],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nPagina: 2,
        nTotPaginas: 2,
        nRegistros: 1,
        nTotRegistros: 2,
        movimentos: [movement(402)],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listarTodosMovimentosFinanceiros("education", {
      dataDe: "01/01/2026",
      dataAte: "15/09/2026",
    });

    expect(result.map(item => item.detalhes?.nCodMovCC)).toEqual([401, 402]);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.param[0]).toMatchObject({
      nPagina: 1,
      nRegPorPagina: 500,
      cTpLancamento: "CC",
      dDtPagtoDe: "01/01/2026",
      dDtPagtoAte: "15/09/2026",
      lDadosCad: false,
    });
  });

  describe("payable titles read from the launch search", () => {
    const window = { dataDe: "08/07/2026", dataAte: "06/10/2026" };

    it("requests the confirmed launch-search shape and maps titles to the payable fields", async () => {
      const fetchMock = vi.fn().mockResolvedValue(lancamentosPage([
        lancamentoPagar(11510028273),
        lancamentoPagar(11510024332, { dDtVenc: "05/05/2026", cStatus: "PAGO" }, { nValAberto: 0 }),
      ]));
      vi.stubGlobal("fetch", fetchMock);

      const result = await listarTodosTitulos("education", "pagar", window);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/financas/pesquisartitulos/");
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.call).toBe("PesquisarLancamentos");
      expect(body.param[0]).toEqual({
        nPagina: 1,
        nRegPorPagina: 100,
        cNatureza: "P",
        dDtVencDe: "08/07/2026",
        dDtVencAte: "06/10/2026",
      });
      expect(result[0]).toMatchObject({
        codigo_lancamento_omie: 11510028273,
        nCodCC: 11507725767,
        data_vencimento: "05/01/2027",
        valor_documento: 4400,
        status_titulo: "A VENCER",
      });
      expect(result[1]).toMatchObject({ status_titulo: "PAGO", valor_documento: 4400 });
    });

    it("never calls the payable list that can answer Client-1013", async () => {
      const fetchMock = vi.fn().mockResolvedValue(lancamentosPage([lancamentoPagar(1)]));
      vi.stubGlobal("fetch", fetchMock);

      await listarTodosTitulos("education", "pagar", window);

      const calls = fetchMock.mock.calls.map(call => JSON.parse(call[1]?.body as string).call);
      expect(calls).not.toContain("ListarContasPagar");
    });

    it("treats a title due today as open and plans only the amount still to be paid", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(lancamentosPage([
        lancamentoPagar(1, { cStatus: "VENCE HOJE" }),
        lancamentoPagar(2, { cStatus: "ATRASADO" }, { nValAberto: 1000 }),
      ])));
      const titles = await listarTodosTitulos("education", "pagar", window);
      expect(titles.map(item => [item.status_titulo, item.valor_documento]))
        .toEqual([["A VENCER", 4400], ["ATRASADO", 1000]]);
    });

    it("collects every page of the launch search", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(lancamentosPage([lancamentoPagar(1)], 1, 2, 2))
        .mockResolvedValueOnce(lancamentosPage([lancamentoPagar(2)], 2, 2, 2));
      vi.stubGlobal("fetch", fetchMock);

      const result = await listarTodosTitulos("education", "pagar", window);

      expect(result.map(item => item.codigo_lancamento_omie)).toEqual([1, 2]);
      expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string).param[0].nPagina).toBe(2);
    });

    it("returns an empty list only for the zeroed totals Omie sends when nothing matches", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        nPagina: 0,
        nTotPaginas: 0,
        nRegistros: 0,
        nTotRegistros: 0,
        titulosEncontrados: [],
      }), { status: 200 })));

      await expect(listarTodosTitulos("education", "pagar", window)).resolves.toEqual([]);
    });

    it("rejects the Omie fault instead of reading it as an empty list", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        faultstring: "ERROR: Dados do WebService não foram encontrados!",
        faultcode: "SOAP-ENV:Client-1013",
      }), { status: 500 })));

      await expect(listarTodosTitulos("education", "pagar", window))
        .rejects.toThrow("Dados do WebService não foram encontrados");
    });

    it.each([
      ["a response without the list", { nPagina: 0, nTotPaginas: 0, nRegistros: 0, nTotRegistros: 0 }],
      ["zero pages with a record total", {
        nPagina: 0, nTotPaginas: 0, nRegistros: 0, nTotRegistros: 3, titulosEncontrados: [],
      }],
      ["zero pages with the first page number", {
        nPagina: 1, nTotPaginas: 0, nRegistros: 0, nTotRegistros: 0, titulosEncontrados: [],
      }],
      ["zero pages with titles", {
        nPagina: 0, nTotPaginas: 0, nRegistros: 1, nTotRegistros: 1, titulosEncontrados: [lancamentoPagar(1)],
      }],
      ["a page count that does not match the rows", {
        nPagina: 1, nTotPaginas: 1, nRegistros: 2, nTotRegistros: 1, titulosEncontrados: [lancamentoPagar(1)],
      }],
      ["a missing total", {
        nPagina: 1, nTotPaginas: 1, nRegistros: 1, titulosEncontrados: [lancamentoPagar(1)],
      }],
    ])("rejects %s", async (_label, payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));

      await expect(listarTodosTitulos("education", "pagar", window)).rejects.toThrow("Página inesperada");
    });

    it("rejects a repeated title id", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        lancamentosPage([lancamentoPagar(7), lancamentoPagar(7)]),
      ));

      await expect(listarTodosTitulos("education", "pagar", window)).rejects.toThrow("Título duplicado");
    });

    it("rejects totals that change between pages", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(lancamentosPage([lancamentoPagar(1)], 1, 2, 2))
        .mockResolvedValueOnce(lancamentosPage([lancamentoPagar(2)], 2, 2, 3)));

      await expect(listarTodosTitulos("education", "pagar", window)).rejects.toThrow("Totais mudaram");
    });

    it("rejects a title that is missing its identifier", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        lancamentosPage([lancamentoPagar(1, { nCodTitulo: undefined })]),
      ));

      await expect(listarTodosTitulos("education", "pagar", window))
        .rejects.toThrow("Título sem identificador válido");
    });

    it("plans a partially paid title with the balance still open, not the document value", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(lancamentosPage([
        lancamentoPagar(1, { cStatus: "PAGTO PARCIAL", nValorTitulo: 1400 }, { nValPago: 495, nValAberto: 905 }),
      ])));

      const titles = await listarTodosTitulos("education", "pagar", window);

      expect(titles).toHaveLength(1);
      expect(titles[0]).toMatchObject({
        codigo_lancamento_omie: 1,
        status_titulo: "PAGTO PARCIAL",
        valor_documento: 905,
        data_vencimento: "05/01/2027",
      });
    });

    it("rejects a partially paid title without the balance still open", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(lancamentosPage([
        lancamentoPagar(1, { cStatus: "PAGTO PARCIAL" }, { nValAberto: undefined }),
      ])));

      await expect(listarTodosTitulos("education", "pagar", window)).rejects.toThrow("sem valor válido");
    });

    it("hands a status it does not know to the planner instead of aborting the listing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(lancamentosPage([
        lancamentoPagar(1, { cStatus: "PARCIAL" }, { nValAberto: 321.5 }),
        lancamentoPagar(2, { cStatus: "SUSPENSO", nValorTitulo: 80 }, { nValAberto: undefined }),
        lancamentoPagar(3),
      ])));

      const titles = await listarTodosTitulos("education", "pagar", window);

      expect(titles.map(item => [item.codigo_lancamento_omie, item.status_titulo, item.valor_documento]))
        .toEqual([[1, "PARCIAL", 321.5], [2, "SUSPENSO", 80], [3, "A VENCER", 4400]]);
    });

    it("rejects an open title without the amount still to be paid", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        lancamentosPage([lancamentoPagar(1, {}, { nValAberto: undefined })]),
      ));

      await expect(listarTodosTitulos("education", "pagar", window))
        .rejects.toThrow("sem valor válido");
    });

    it("rejects filters the launch search does not apply", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(listarTodosTitulos("education", "pagar", { ...window, status: "ATRASADO" }))
        .rejects.toThrow("apenas filtro por período de vencimento");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("receivable titles paid in part", () => {
    const window = { dataDe: "08/07/2026", dataAte: "06/10/2026" };
    const receivable = (id: number, status: string, amount: number) => ({
      codigo_lancamento_omie: id,
      data_vencimento: "17/07/2026",
      valor_documento: amount,
      status_titulo: status,
      id_conta_corrente: 11507725767,
    });
    const listPage = (items: unknown[]) => new Response(JSON.stringify({
      pagina: 1,
      total_de_paginas: 1,
      registros: items.length,
      total_de_registros: items.length,
      conta_receber_cadastro: items,
    }), { status: 200 });
    const balanceLookup = (id: number, open: number | undefined, status = "PAGTO PARCIAL") =>
      lancamentosPage([lancamentoPagar(id, { cStatus: status, nValorTitulo: 440 }, { nValAberto: open })]);

    it("replaces the document value of a partial title with the balance still open, asking only about it", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(listPage([
          receivable(11, "A VENCER", 200),
          receivable(12, "PAGTO PARCIAL", 440),
          receivable(13, "VENCE HOJE", 75),
        ]))
        .mockResolvedValueOnce(balanceLookup(12, 140));
      vi.stubGlobal("fetch", fetchMock);

      const titles = await listarTodosTitulos("education", "receber", window);

      expect(titles.map(item => [item.codigo_lancamento_omie, item.status_titulo, item.valor_documento]))
        .toEqual([[11, "A VENCER", 200], [12, "PAGTO PARCIAL", 140], [13, "VENCE HOJE", 75]]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const lookup = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/financas/pesquisartitulos/");
      expect(lookup.call).toBe("PesquisarLancamentos");
      expect(lookup.param[0]).toMatchObject({ nCodTitulo: 12 });
    });

    it("does not call the launch search when no title was paid in part", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(listPage([receivable(11, "A VENCER", 200)]));
      vi.stubGlobal("fetch", fetchMock);

      await listarTodosTitulos("education", "receber", window);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["no record for the title", lancamentosPage([])],
      ["a record of another title", balanceLookup(99, 140)],
      ["a record without the open balance", balanceLookup(12, undefined)],
    ])("cancels the listing when the launch search answers with %s", async (_label, answer) => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(listPage([receivable(12, "PAGTO PARCIAL", 440)]))
        .mockResolvedValueOnce(answer));

      await expect(listarTodosTitulos("education", "receber", window)).rejects.toThrow("Saldo em aberto indisponível");
    });

    it("cancels the listing when the balance lookup fails", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(listPage([receivable(12, "PAGTO PARCIAL", 440)]))
        .mockResolvedValueOnce(new Response("{}", { status: 500 })));

      await expect(listarTodosTitulos("education", "receber", window)).rejects.toThrow();
    });
  });

  describe("payments split across several titles", () => {
    const row = (
      movementId: number,
      settlementId: number,
      overrides: Record<string, unknown> = {},
      paid = 0,
    ) => ({
      detalhes: {
        cNatureza: "R",
        cOrigem: "BAXR",
        dDtPagamento: "15/08/2026",
        nCodCC: 10,
        nCodMovCC: movementId,
        nCodBaixa: settlementId,
        nCodTitulo: settlementId + 1000,
        nValorMovCC: 290,
        ...overrides,
      },
      resumo: { nValPago: paid },
    });
    const respond = (rows: unknown[], page = 1, pages = 1, total = rows.length) =>
      new Response(JSON.stringify({
        nPagina: page,
        nTotPaginas: pages,
        nRegistros: rows.length,
        nTotRegistros: total,
        movimentos: rows,
      }), { status: 200 });
    const list = () => listarTodosMovimentosFinanceiros("education", {
      dataDe: "01/08/2026",
      dataAte: "31/08/2026",
    });

    it("counts a payment split in two titles once, with the full movement amount", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond([
        row(6806274928, 1, {}, 240),
        row(6806274928, 2, {}, 50),
        row(777, 3, { nValorMovCC: 100 }, 100),
      ])));

      const result = await list();

      expect(result.map(item => [item.detalhes?.nCodMovCC, item.detalhes?.nValorMovCC])).toEqual([
        [6806274928, 290],
        [777, 100],
      ]);
    });

    it("counts a payment split in three titles once", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond([
        row(6779723955, 1, { nValorMovCC: 5000 }, 3350),
        row(6779723955, 2, { nValorMovCC: 5000 }, 1080),
        row(6779723955, 3, { nValorMovCC: 5000 }, 570),
      ])));

      const result = await list();

      expect(result).toHaveLength(1);
      expect(result[0]?.detalhes?.nValorMovCC).toBe(5000);
    });

    it("merges rows of the same movement that arrive on different pages", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(respond([row(900, 1, {}, 240)], 1, 2, 2))
        .mockResolvedValueOnce(respond([row(900, 2, {}, 50)], 2, 2, 2)));

      const result = await list();

      expect(result).toHaveLength(1);
    });

    it("still compares the number of received rows with the total reported by Omie", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond([
        row(6806274928, 1, {}, 240),
        row(6806274928, 2, {}, 50),
      ], 1, 1, 3)));

      await expect(list()).rejects.toThrow("Listagem incompleta");
    });

    it("rejects the same settlement listed twice", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond([
        row(6806274928, 1, {}, 240),
        row(6806274928, 1, {}, 240),
      ])));

      await expect(list()).rejects.toThrow("Movimento duplicado");
    });

    it("rejects a repeated movement when the settlement code is missing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond([
        row(6806274928, 1, {}, 240),
        row(6806274928, 2, { nCodBaixa: undefined }, 50),
      ])));

      await expect(list()).rejects.toThrow("Movimento duplicado");
    });

    it.each([
      ["conta", { nCodCC: 20 }],
      ["data de pagamento", { dDtPagamento: "16/08/2026" }],
      ["natureza", { cNatureza: "P" }],
      ["origem", { cOrigem: "EXTR" }],
      ["valor", { nValorMovCC: 50 }],
    ])("rejects rows of the same movement with a different %s", async (label, override) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond([
        row(6806274928, 1, {}, 240),
        row(6806274928, 2, override, 50),
      ])));

      await expect(list()).rejects.toThrow(`com ${label} diferente`);
    });
  });

  it("rejects contradictory zero-page movement metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      nPagina: 1,
      nTotPaginas: 0,
      nRegistros: 1,
      nTotRegistros: 1,
      movimentos: [{
        detalhes: {
          nCodMovCC: 501,
        },
      }],
    }), { status: 200 })));

    await expect(listarTodosMovimentosFinanceiros("education", {
      dataDe: "01/01/2026",
      dataAte: "15/09/2026",
    })).rejects.toThrow("Página inesperada");
  });

  it("reads the realized balance from the account statement at the cutoff date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      nCodCC: 11508604939,
      dPeriodoInicial: "15/09/2026",
      dPeriodoFinal: "15/09/2026",
      nSaldoAnterior: 102000,
      nSaldoAtual: 103426.39,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(obterSaldoAtualContaCorrente(
      "education",
      11508604939,
      "15/09/2026",
    )).resolves.toBe(103426.39);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.call).toBe("ListarExtrato");
    expect(body.param[0]).toEqual({
      nCodCC: 11508604939,
      cCodIntCC: "",
      dPeriodoInicial: "15/09/2026",
      dPeriodoFinal: "15/09/2026",
      cExibirApenasSaldo: "S",
    });
  });

  it("rejects an account statement whose balance or identity is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      nCodCC: 999,
      dPeriodoInicial: "15/09/2026",
      dPeriodoFinal: "15/09/2026",
      nSaldoAtual: null,
    }), { status: 200 })));

    await expect(obterSaldoAtualContaCorrente(
      "education",
      11508604939,
      "15/09/2026",
    )).rejects.toThrow("Extrato inválido");
  });
});