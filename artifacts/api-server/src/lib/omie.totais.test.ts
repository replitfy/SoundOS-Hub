import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agregarTitulos,
  descreverTitulosComStatusDesconhecido,
  resumirTitulos,
} from "./omie";

const EXCLUDED_ACCOUNT = 999;

interface TituloFake {
  id: number;
  status: string | undefined;
  valor: number;
  vencimento: string;
  conta?: number;
}

function titulo(
  id: number,
  status: string | undefined,
  valor: number,
  vencimento = "20/11/2026",
  conta = 11507725767,
): TituloFake {
  return { id, status, valor, vencimento, conta };
}

function titleRecord(item: TituloFake) {
  return {
    codigo_lancamento_omie: item.id,
    data_vencimento: item.vencimento,
    data_emissao: "01/10/2026",
    valor_documento: item.valor,
    ...(item.status === undefined ? {} : { status_titulo: item.status }),
    id_conta_corrente: item.conta,
  };
}

interface OmieFake {
  receber?: TituloFake[];
  pagar?: TituloFake[];
  /** Saldo em aberto devolvido pela pesquisa de lançamentos, por código do título. */
  saldos?: Record<number, number | undefined>;
}

function stubOmie({ receber = [], pagar = [], saldos = {} }: OmieFake) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { call, param } = JSON.parse(init.body as string) as { call: string; param: Array<Record<string, unknown>> };
    const params = param[0] ?? {};
    if (call === "ListarContasCorrentes") {
      return json({
        pagina: 1,
        total_de_paginas: 1,
        total_de_registros: 1,
        ListarContasCorrentes: [{ nCodCC: EXCLUDED_ACCOUNT, nao_resumo: "S", nao_fluxo: "S" }],
      });
    }
    if (call === "ListarContasReceber" || call === "ListarContasPagar") {
      const items = (call === "ListarContasReceber" ? receber : pagar).map(titleRecord);
      return json({
        pagina: 1,
        total_de_paginas: 1,
        registros: items.length,
        total_de_registros: items.length,
        [call === "ListarContasReceber" ? "conta_receber_cadastro" : "conta_pagar_cadastro"]: items,
      });
    }
    if (call === "PesquisarLancamentos") {
      const id = params["nCodTitulo"] as number;
      const open = saldos[id];
      return json({
        nPagina: 1,
        nTotPaginas: 1,
        nRegistros: 1,
        nTotRegistros: 1,
        titulosEncontrados: [{
          cabecTitulo: { nCodTitulo: id, cStatus: "PAGTO PARCIAL", nValorTitulo: 1000 },
          resumo: { nValAberto: open },
        }],
      });
    }
    throw new Error(`Chamada Omie inesperada no teste: ${call}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof stubOmie>, call: string) {
  return fetchMock.mock.calls
    .map(([, init]) => JSON.parse(init.body as string) as { call: string; param: Array<Record<string, unknown>> })
    .filter(body => body.call === call);
}

// Cada teste usa uma janela diferente: os totais ficam em cache por base, tipo e período.
let windowSeed = 0;
function uniqueWindow() {
  windowSeed += 1;
  return { dataDe: "01/01/2026", dataAte: `${String(windowSeed).padStart(2, "0")}/12/2026` };
}

describe("Totais de títulos do Omie ERP e da Visão Geral", () => {
  beforeEach(() => {
    process.env["OMIE_EDUCATION_APP_KEY"] = "test-key";
    process.env["OMIE_EDUCATION_APP_SECRET"] = "test-secret";
    // Só a data é simulada; as chamadas ao Omie continuam assíncronas normais.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("resumirTitulos", () => {
    it("splits a partial title: the paid part is recebido, the open balance is a vencer/atrasado by its due date", async () => {
      const fetchMock = stubOmie({
        receber: [
          titulo(101, "A VENCER", 200),
          titulo(102, "VENCE HOJE", 75, "10/11/2026"),
          titulo(103, "PAGTO PARCIAL", 440, "05/11/2026"),
          titulo(104, "PAGTO PARCIAL", 1000, "20/11/2026"),
          titulo(105, "ATRASADO", 50, "01/10/2026"),
          titulo(106, "RECEBIDO", 900, "03/10/2026"),
          titulo(107, "CANCELADO", 10),
        ],
        saldos: { 103: 140, 104: 300 },
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo).toEqual({
        // 900 recebido + parte já paga dos parciais: (440 − 140) + (1000 − 300)
        totalRecebido: 900 + 300 + 700,
        totalAVencer: 200 + 75 + 300,
        totalAtrasado: 50 + 140,
        quantidade: 6,
        avisos: [],
      });
      const lookups = callsTo(fetchMock, "PesquisarLancamentos");
      expect(lookups.map(body => body.param[0]?.["nCodTitulo"])).toEqual([103, 104]);
    });

    it("splits a partially paid payable the same way", async () => {
      stubOmie({
        pagar: [
          titulo(201, "PAGO", 300, "02/11/2026"),
          titulo(202, "PAGTO PARCIAL", 10415, "16/10/2026"),
          titulo(203, "PAGTO PARCIAL", 585, "28/11/2026"),
          titulo(204, "VENCE HOJE", 120, "10/11/2026"),
        ],
        saldos: { 202: 2667, 203: 40 },
      });

      const resumo = await resumirTitulos("education", "pagar", uniqueWindow());

      expect(resumo).toMatchObject({
        // 300 pago + (10415 − 2667) + (585 − 40)
        totalRecebido: 300 + 7748 + 545,
        totalAtrasado: 2667,
        totalAVencer: 40 + 120,
        quantidade: 4,
        avisos: [],
      });
    });

    it("keeps the totals of an account without partial payments and never asks for a balance", async () => {
      const fetchMock = stubOmie({
        receber: [
          titulo(301, "A VENCER", 100),
          titulo(302, "ATRASADO", 40, "01/10/2026"),
          titulo(303, "RECEBIDO", 700, "03/10/2026"),
        ],
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo).toEqual({ totalRecebido: 700, totalAVencer: 100, totalAtrasado: 40, quantidade: 3, avisos: [] });
      expect(callsTo(fetchMock, "PesquisarLancamentos")).toHaveLength(0);
    });

    it("leaves an unknown status out of the totals and reports it instead of failing", async () => {
      stubOmie({
        receber: [
          titulo(401, "A VENCER", 100),
          titulo(402, "EM DISPUTA", 80),
          titulo(403, "EM DISPUTA", 20.5),
          titulo(404, undefined, 5),
        ],
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo).toMatchObject({ totalAVencer: 100, totalRecebido: 0, totalAtrasado: 0, quantidade: 1 });
      expect(resumo.avisos).toHaveLength(1);
      expect(resumo.avisos[0]).toContain('contas a receber com status "EM DISPUTA" (2 títulos, R$');
      expect(resumo.avisos[0]).toContain("100,50");
      expect(resumo.avisos[0]).toContain('status "(sem status)" (1 título,');
    });

    it("does not look up the balance of a partial title that belongs to an excluded account", async () => {
      const fetchMock = stubOmie({
        receber: [
          titulo(501, "PAGTO PARCIAL", 440, "05/11/2026", EXCLUDED_ACCOUNT),
          titulo(502, "A VENCER", 60),
        ],
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo).toMatchObject({ totalAVencer: 60, totalAtrasado: 0, quantidade: 1 });
      expect(callsTo(fetchMock, "PesquisarLancamentos")).toHaveLength(0);
    });

    it("fails when the balance of a partial title is unavailable instead of counting the whole document", async () => {
      stubOmie({
        receber: [titulo(601, "PAGTO PARCIAL", 440, "05/11/2026")],
        saldos: { 601: undefined },
      });

      await expect(resumirTitulos("education", "receber", uniqueWindow()))
        .rejects.toThrow("Saldo em aberto indisponível");
    });

    it("never counts a partial title twice: recebido plus a vencer plus atrasado equals the document value", async () => {
      stubOmie({
        receber: [
          titulo(901, "PAGTO PARCIAL", 1400, "05/11/2026"),
          titulo(902, "PAGTO PARCIAL", 99.9, "25/11/2026"),
        ],
        saldos: { 901: 905, 902: 33.3 },
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo.totalRecebido).toBeCloseTo(495 + 66.6, 2);
      expect(resumo.totalAtrasado).toBe(905);
      expect(resumo.totalAVencer).toBe(33.3);
      expect(resumo.totalRecebido + resumo.totalAVencer + resumo.totalAtrasado).toBeCloseTo(1400 + 99.9, 2);
      expect(resumo.quantidade).toBe(2);
    });

    it("counts nothing as paid when the open balance equals the whole document, and never a negative amount", async () => {
      stubOmie({
        receber: [
          titulo(911, "PAGTO PARCIAL", 500, "20/11/2026"),
          titulo(912, "PAGTO PARCIAL", 500, "20/11/2026"),
        ],
        // 911: nada pago ainda; 912: saldo maior que o documento (juros) não vira "pago" negativo.
        saldos: { 911: 500, 912: 530 },
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo).toMatchObject({ totalRecebido: 0, totalAVencer: 1030, totalAtrasado: 0 });
    });

    it("fails when a partial title has no valid document value instead of undercounting the paid part", async () => {
      const fetchMock = stubOmie({
        receber: [titulo(921, "PAGTO PARCIAL", Number.NaN, "05/11/2026")],
        saldos: { 921: 100 },
      });

      await expect(resumirTitulos("education", "receber", uniqueWindow()))
        .rejects.toThrow("sem valor de documento válido");
      expect(callsTo(fetchMock, "PesquisarLancamentos")).toHaveLength(0);
    });

    it("decides overdue by the São Paulo calendar day", async () => {
      // 22:30 de 10/11/2026 em São Paulo ainda é dia 10, embora em UTC já seja 11/11.
      vi.setSystemTime(new Date("2026-11-11T01:30:00.000Z"));
      stubOmie({
        receber: [
          titulo(701, "PAGTO PARCIAL", 440, "10/11/2026"),
          titulo(702, "PAGTO PARCIAL", 500, "09/11/2026"),
        ],
        saldos: { 701: 100, 702: 200 },
      });

      const resumo = await resumirTitulos("education", "receber", uniqueWindow());

      expect(resumo).toMatchObject({ totalAVencer: 100, totalAtrasado: 200 });
    });
  });

  describe("agregarTitulos", () => {
    it("counts the whole document of a partial title (paid part plus open balance) in its due month and keeps the other totals", async () => {
      stubOmie({
        receber: [
          titulo(801, "A VENCER", 200, "15/11/2026"),
          titulo(802, "VENCE HOJE", 75, "10/11/2026"),
          titulo(803, "RECEBIDO", 900, "03/10/2026"),
          titulo(804, "PAGTO PARCIAL", 440, "05/10/2026"),
          titulo(805, "CANCELADO", 10, "05/11/2026"),
        ],
        saldos: { 804: 140 },
      });

      const result = await agregarTitulos("education", "receber", uniqueWindow());

      // O parcial entra pelo documento inteiro (440): 300 já pagos + 140 em aberto.
      expect(result.total).toBe(200 + 75 + 900 + 440);
      expect(result.quantidade).toBe(4);
      expect(Object.fromEntries(result.porMes)).toEqual({ "2026-11": 275, "2026-10": 1340 });
      expect(result.statusDesconhecido).toEqual([]);
    });

    it("does not ask for any balance when there is no partial title", async () => {
      const fetchMock = stubOmie({ pagar: [titulo(811, "A VENCER", 50), titulo(812, "PAGO", 25)] });

      const result = await agregarTitulos("education", "pagar", uniqueWindow());

      expect(result).toMatchObject({ total: 75, quantidade: 2, statusDesconhecido: [] });
      expect(callsTo(fetchMock, "PesquisarLancamentos")).toHaveLength(0);
    });

    it("leaves an unknown status out of the total and returns it for the notice", async () => {
      stubOmie({
        pagar: [titulo(821, "A VENCER", 50), titulo(822, "EM DISPUTA", 80, "20/11/2026")],
      });

      const result = await agregarTitulos("education", "pagar", uniqueWindow());

      expect(result).toMatchObject({ total: 50, quantidade: 1 });
      expect(result.statusDesconhecido).toEqual([
        { base: "education", tipo: "pagar", codigo: 822, status: "EM DISPUTA", valor: 80 },
      ]);
    });

    it("fails when the balance of a partial title is unavailable", async () => {
      stubOmie({
        pagar: [titulo(831, "PAGTO PARCIAL", 1000, "05/11/2026")],
        saldos: { 831: undefined },
      });

      await expect(agregarTitulos("education", "pagar", uniqueWindow()))
        .rejects.toThrow("Saldo em aberto indisponível");
    });
  });

  describe("descreverTitulosComStatusDesconhecido", () => {
    it("returns nothing when no title was left out", () => {
      expect(descreverTitulosComStatusDesconhecido([])).toBeNull();
    });

    it("groups by kind and status with count and amount", () => {
      const text = descreverTitulosComStatusDesconhecido([
        { base: "education", tipo: "pagar", codigo: 1, status: "X", valor: 10 },
        { base: "store", tipo: "pagar", codigo: 2, status: "X", valor: 5.5 },
        { base: "store", tipo: "receber", codigo: 3, status: "Y", valor: 1 },
      ]);

      expect(text).toContain('contas a pagar com status "X" (2 títulos,');
      expect(text).toContain("15,50");
      expect(text).toContain('contas a receber com status "Y" (1 título,');
    });
  });
});
