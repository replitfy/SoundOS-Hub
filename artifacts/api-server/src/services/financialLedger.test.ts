import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinancialTitleRow } from "@workspace/db";
import { listarTodosTitulos } from "../lib/omie";
import {
  buildFinancialSummary,
  describeExcludedPlannedTitles,
  effectiveFinancialWindow,
  financialCollectionRequest,
  isFinancialFilterCovered,
  isWithinFinancialWindow,
  mergeFinancialWindows,
  mergePersistedPlannedTitles,
  missingFinancialWindows,
  normalizeFinancialFilters,
  planTitle,
  rollingNinetyDayWindow,
  splitFinancialWindows,
  type FinancialBalanceAnchor,
  type PersistedFinancialAccount,
  type PersistedPlannedTitle,
} from "./financialLedger";

function title(overrides: Partial<FinancialTitleRow>): FinancialTitleRow {
  return {
    base: "education",
    kind: "receber",
    omieId: 1,
    accountCode: 10,
    issueDate: "2026-09-10",
    dueDate: "2026-09-15",
    referenceDate: "2026-09-15",
    amount: 100,
    status: "BAXR",
    loadedAt: new Date("2026-09-15T12:00:00Z"),
    ...overrides,
  };
}

const accounts: PersistedFinancialAccount[] = [
  {
    base: "education",
    codigo: 10,
    descricao: "Principal",
    excluida: false,
    ativa: true,
    saldo: 0,
    emiteBoleto: false,
  },
  {
    base: "education",
    codigo: 20,
    descricao: "Não considerada",
    excluida: true,
    ativa: true,
    saldo: 0,
    emiteBoleto: false,
  },
];

describe("financial incremental window", () => {
  it("collects exactly 90 calendar days including the reference day", () => {
    expect(rollingNinetyDayWindow(new Date("2026-09-15T18:00:00Z"))).toEqual({
      dataDe: "2026-06-18",
      dataAte: "2026-09-15",
    });
  });

  it("uses the exact 90-day bounds for every Omie collection request", () => {
    expect(financialCollectionRequest(new Date("2026-09-15T18:00:00Z"))).toEqual({
      window: {
        dataDe: "2026-06-18",
        dataAte: "2026-09-15",
      },
      omieFilters: {
        dataDe: "18/06/2026",
        dataAte: "15/09/2026",
      },
    });
  });

  it("keeps 90 days across a year boundary", () => {
    expect(rollingNinetyDayWindow(new Date("2026-01-15T12:00:00Z"))).toEqual({
      dataDe: "2025-10-18",
      dataAte: "2026-01-15",
    });
  });

  it("keeps 90 days across February in a leap year", () => {
    expect(rollingNinetyDayWindow(new Date("2024-03-01T12:00:00Z"))).toEqual({
      dataDe: "2023-12-03",
      dataAte: "2024-03-01",
    });
  });

  it("collects only the missing edges around the persisted period", () => {
    expect(missingFinancialWindows(
      { dataDe: "2025-01-01", dataAte: "2026-09-18" },
      { dataDe: "2026-06-18", dataAte: "2026-09-17" },
    )).toEqual([
      { dataDe: "2025-01-01", dataAte: "2026-06-17" },
      { dataDe: "2026-09-18", dataAte: "2026-09-18" },
    ]);
  });

  it("splits long history into bounded Omie requests without gaps", () => {
    expect(splitFinancialWindows([
      { dataDe: "2025-01-01", dataAte: "2025-07-01" },
    ])).toEqual([
      { dataDe: "2025-01-01", dataAte: "2025-03-31" },
      { dataDe: "2025-04-01", dataAte: "2025-06-29" },
      { dataDe: "2025-06-30", dataAte: "2025-07-01" },
    ]);
  });

  it("merges the rolling reconciliation window with missing history", () => {
    expect(mergeFinancialWindows([
      { dataDe: "2025-01-01", dataAte: "2026-06-17" },
      { dataDe: "2026-06-18", dataAte: "2026-09-15" },
    ])).toEqual([
      { dataDe: "2025-01-01", dataAte: "2026-06-17" },
      { dataDe: "2026-06-18", dataAte: "2026-09-15" },
    ]);
  });

  it("keeps only titles whose reference date intersects the persisted window", () => {
    const window = { dataDe: "2025-09-16", dataAte: "2026-09-15" };
    expect(isWithinFinancialWindow("2025-09-16", window)).toBe(true);
    expect(isWithinFinancialWindow("2026-09-15", window)).toBe(true);
    expect(isWithinFinancialWindow("2026-09-16", window)).toBe(false);
    expect(isWithinFinancialWindow(null, window)).toBe(false);
  });

  it("rejects requested periods outside or inverted within the persisted window", () => {
    const stored = { dataDe: "2025-09-16", dataAte: "2026-09-15" };
    expect(isFinancialFilterCovered({}, stored)).toBe(true);
    expect(isFinancialFilterCovered({ dataDe: "2026-01-01", dataAte: "2026-09-15" }, stored)).toBe(true);
    expect(isFinancialFilterCovered({ dataAte: "2025-09-15" }, stored)).toBe(false);
    expect(isFinancialFilterCovered({ dataDe: "2026-09-16" }, stored)).toBe(false);
    expect(isFinancialFilterCovered({ dataDe: "2026-08-01", dataAte: "2026-07-31" }, stored)).toBe(false);
  });

  it("uses the available overlap instead of leaving a partially covered period empty", () => {
    const stored = { dataDe: "2025-09-17", dataAte: "2026-09-16" };
    expect(effectiveFinancialWindow({
      dataDe: "2026-01-01",
      dataAte: "2026-12-31",
    }, stored)).toEqual({
      dataDe: "2026-01-01",
      dataAte: "2026-09-16",
      adjusted: true,
    });
  });

  it("falls back to all saved data when the requested period has no overlap", () => {
    const stored = { dataDe: "2025-09-17", dataAte: "2026-09-16" };
    expect(effectiveFinancialWindow({
      dataDe: "2027-01-01",
      dataAte: "2027-12-31",
    }, stored)).toEqual({
      ...stored,
      adjusted: true,
    });
  });
});

describe("persisted financial summary", () => {
  it("removes an overdue planned title when it disappears from a refreshed recent window", () => {
    const overdue: PersistedPlannedTitle = {
      base: "education",
      kind: "receber",
      omieId: 99,
      accountCode: 10,
      dueDate: "2026-09-14",
      amount: 500,
      status: "ATRASADO",
    };
    expect(mergePersistedPlannedTitles(
      [overdue],
      [],
      [{ dataDe: "2026-06-18", dataAte: "2026-09-15" }],
    )).toEqual([]);
  });

  describe("planning Omie titles", () => {
    const today = "2026-11-10";
    const raw = (overrides: Record<string, unknown> = {}) => ({
      codigo_lancamento_omie: 10,
      id_conta_corrente: 20,
      data_vencimento: "30/11/2026",
      valor_documento: 150,
      status_titulo: "A VENCER",
      ...overrides,
    });

    it("plans open titles and ignores the ones already settled", () => {
      expect(planTitle("education", "receber", raw(), today)).toEqual({
        outcome: "planned",
        title: {
          base: "education",
          kind: "receber",
          omieId: 10,
          accountCode: 20,
          dueDate: "2026-11-30",
          amount: 150,
          status: "A VENCER",
        },
      });
      expect(planTitle("education", "receber", raw({
        status_titulo: "RECEBIDO",
        data_vencimento: undefined,
      }), today)).toEqual({ outcome: "closed" });
      expect(planTitle("education", "pagar", raw({ status_titulo: "CANCELADO" }), today))
        .toEqual({ outcome: "closed" });
      expect(planTitle("education", "pagar", raw({ status_titulo: "PAGO" }), today))
        .toEqual({ outcome: "closed" });
    });

    it("plans a receivable that is due today as upcoming instead of dropping it", () => {
      expect(planTitle("store", "receber", raw({
        status_titulo: "VENCE HOJE",
        data_vencimento: "10/11/2026",
      }), today)).toMatchObject({
        outcome: "planned",
        title: { dueDate: "2026-11-10", amount: 150, status: "A VENCER" },
      });
    });

    it.each(["receber", "pagar"] as const)(
      "plans a partially paid %s title with its open balance, overdue or upcoming by its due date",
      kind => {
        expect(planTitle("education", kind, raw({
          status_titulo: "PAGTO PARCIAL",
          data_vencimento: "05/11/2026",
          valor_documento: 905,
        }), today)).toMatchObject({ outcome: "planned", title: { amount: 905, status: "ATRASADO" } });
        expect(planTitle("education", kind, raw({
          status_titulo: "PAGTO PARCIAL",
          data_vencimento: "10/11/2026",
          valor_documento: 40,
        }), today)).toMatchObject({ outcome: "planned", title: { amount: 40, status: "A VENCER" } });
        expect(planTitle("education", kind, raw({
          status_titulo: "PAGTO PARCIAL",
          data_vencimento: "16/12/2026",
          valor_documento: 1100,
        }), today)).toMatchObject({ outcome: "planned", title: { dueDate: "2026-12-16", status: "A VENCER" } });
      },
    );

    it("reports a status it does not know, with its value, instead of dropping it silently", () => {
      expect(planTitle("education", "receber", raw({ status_titulo: "EM NEGOCIACAO" }), today))
        .toEqual({ outcome: "unknown", status: "EM NEGOCIACAO", amount: 150 });
      expect(planTitle("education", "receber", raw({ status_titulo: undefined, valor_documento: undefined }), today))
        .toEqual({ outcome: "unknown", status: "(sem status)", amount: 0 });
    });

    it("still rejects a known open title that has no usable data", () => {
      expect(() => planTitle("education", "pagar", raw({ id_conta_corrente: undefined }), today))
        .toThrow("não possui conta corrente");
      expect(() => planTitle("education", "pagar", raw({ data_vencimento: "31/02/2026" }), today))
        .toThrow("vencimento válido");
      expect(() => planTitle("education", "pagar", raw({ valor_documento: undefined }), today))
        .toThrow("valor válido");
    });

    it("describes what was left out by nature and status, or nothing when nothing was", () => {
      expect(describeExcludedPlannedTitles([])).toBeNull();
      const text = describeExcludedPlannedTitles([
        { kind: "pagar", status: "PARCIAL X", amount: 100.1 },
        { kind: "pagar", status: "PARCIAL X", amount: 200.2 },
        { kind: "receber", status: "OUTRO", amount: 50 },
      ]);
      expect(text).toContain('contas a pagar com status "PARCIAL X" (2 títulos, R$');
      expect(text).toContain("300,30");
      expect(text).toContain('contas a receber com status "OUTRO" (1 título, R$');
      expect(text).toContain("fora do planejado");
    });
  });

  describe("payables read from the Omie launch search", () => {
    beforeEach(() => {
      process.env["OMIE_EDUCATION_APP_KEY"] = "test-key";
      process.env["OMIE_EDUCATION_APP_SECRET"] = "test-secret";
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const launch = (id: number, status: string, due: string, openAmount: number) => ({
      cabecTitulo: {
        nCodTitulo: id,
        nCodCC: 11507725767,
        dDtVenc: due,
        nValorTitulo: 4400,
        cStatus: status,
      },
      resumo: { nValAberto: openAmount },
    });

    it("plans open payables with the same fields and ignores paid or cancelled ones", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        nPagina: 1,
        nTotPaginas: 1,
        nRegistros: 7,
        nTotRegistros: 7,
        titulosEncontrados: [
          launch(11510028273, "A VENCER", "05/01/2027", 4400),
          launch(11510536251, "ATRASADO", "01/10/2026", 69.9),
          launch(11510024332, "PAGO", "05/05/2026", 0),
          launch(11510024333, "CANCELADO", "05/06/2026", 4400),
          launch(11510024334, "VENCE HOJE", "06/10/2026", 120),
          launch(11510024335, "PAGTO PARCIAL", "05/10/2026", 905),
          launch(11510024336, "PAGTO PARCIAL", "16/12/2026", 1100),
        ],
      }), { status: 200 })));

      const raw = await listarTodosTitulos("education", "pagar", {
        dataDe: "01/10/2026",
        dataAte: "31/01/2027",
      });
      const planned = raw
        .map(item => planTitle("education", "pagar", item, "2026-10-06"))
        .flatMap(item => item.outcome === "planned" ? [item.title] : []);

      expect(planned).toEqual([
        {
          base: "education",
          kind: "pagar",
          omieId: 11510028273,
          accountCode: 11507725767,
          dueDate: "2027-01-05",
          amount: 4400,
          status: "A VENCER",
        },
        {
          base: "education",
          kind: "pagar",
          omieId: 11510536251,
          accountCode: 11507725767,
          dueDate: "2026-10-01",
          amount: 69.9,
          status: "ATRASADO",
        },
        {
          base: "education",
          kind: "pagar",
          omieId: 11510024334,
          accountCode: 11507725767,
          dueDate: "2026-10-06",
          amount: 120,
          status: "A VENCER",
        },
        {
          base: "education",
          kind: "pagar",
          omieId: 11510024335,
          accountCode: 11507725767,
          dueDate: "2026-10-05",
          amount: 905,
          status: "ATRASADO",
        },
        {
          base: "education",
          kind: "pagar",
          omieId: 11510024336,
          accountCode: 11507725767,
          dueDate: "2026-12-16",
          amount: 1100,
          status: "A VENCER",
        },
      ]);
    });
  });

  it("keeps realized movements separate from open and overdue planned titles", () => {
    const rows = [
      title({ omieId: 1, kind: "receber", amount: 100 }),
      title({ omieId: 2, kind: "pagar", amount: 40, status: "BAXP" }),
    ];
    const planned: PersistedPlannedTitle[] = [
      {
        base: "education",
        kind: "receber",
        omieId: 1,
        accountCode: 10,
        dueDate: "2026-09-15",
        amount: 250,
        status: "A VENCER",
      },
      {
        base: "education",
        kind: "pagar",
        omieId: 2,
        accountCode: 10,
        dueDate: "2026-09-20",
        amount: 80,
        status: "ATRASADO",
      },
    ];

    expect(buildFinancialSummary(rows, accounts, {
      dataDe: "2026-09-01",
      dataAte: "2026-09-30",
    }, undefined, undefined, planned)).toMatchObject({
      receitaTotal: 100,
      despesaTotal: 40,
      resultado: 60,
      receitaPlanejadaTotal: 250,
      despesaPlanejadaTotal: 80,
      resultadoPlanejado: 170,
      meses: [{
        mes: "2026-09",
        receita: 100,
        despesa: 40,
        receitaPlanejada: 250,
        despesaPlanejada: 80,
      }],
    });
  });

  it("applies account and date filters to planned titles", () => {
    const planned: PersistedPlannedTitle[] = [
      { base: "education", kind: "receber", omieId: 1, accountCode: 10, dueDate: "2026-09-15", amount: 100, status: "A VENCER" },
      { base: "education", kind: "pagar", omieId: 2, accountCode: 20, dueDate: "2026-09-15", amount: 200, status: "ATRASADO" },
      { base: "education", kind: "receber", omieId: 3, accountCode: 10, dueDate: "2026-10-01", amount: 300, status: "A VENCER" },
    ];

    const summary = buildFinancialSummary([], accounts, {
      dataDe: "2026-09-01",
      dataAte: "2026-09-30",
      accountKeys: ["education:10"],
    }, undefined, undefined, planned);

    expect(summary.receitaPlanejadaTotal).toBe(100);
    expect(summary.despesaPlanejadaTotal).toBe(0);
  });

  it("keeps excluded accounts out by default and includes them only when requested", () => {
    const rows = [
      title({ omieId: 1, accountCode: 10, amount: 100 }),
      title({ omieId: 2, accountCode: 20, amount: 300 }),
    ];
    expect(buildFinancialSummary(rows, accounts, {}).receitaTotal).toBe(100);
    expect(buildFinancialSummary(rows, accounts, {
      accountKeys: ["education:20"],
    }).receitaTotal).toBe(0);
    expect(buildFinancialSummary(rows, accounts, {
      excludeNonConsidered: false,
    }).receitaTotal).toBe(400);
    expect(buildFinancialSummary(rows, accounts, {
      accountKeys: ["education:20"],
      excludeNonConsidered: false,
    }).receitaTotal).toBe(300);
  });

  it("groups persisted titles by exact reference month and nature", () => {
    const rows = [
      title({ omieId: 1, amount: 100, referenceDate: "2026-08-31" }),
      title({ omieId: 2, kind: "pagar", amount: 40, referenceDate: "2026-09-01" }),
      title({ omieId: 3, amount: 999, status: "TRAR" }),
    ];
    expect(buildFinancialSummary(rows, accounts, {})).toMatchObject({
      receitaTotal: 100,
      despesaTotal: 40,
      resultado: 60,
      meses: [
        { mes: "2026-08", receita: 100, despesa: 0, resultado: 100 },
        { mes: "2026-09", receita: 0, despesa: 40, resultado: -40 },
      ],
    });
  });

  it("normalizes repeated account codes", () => {
    expect(normalizeFinancialFilters({
      accountKeys: ["store:30", "education:10", "store:30"],
    }).accountKeys).toEqual(["education:10", "store:30"]);
  });

  it("keeps account identity scoped to its Omie base", () => {
    const scopedAccounts: PersistedFinancialAccount[] = [
      ...accounts,
      {
        base: "store",
        codigo: 10,
        descricao: "Principal Store",
        excluida: false,
        ativa: true,
        saldo: 0,
        emiteBoleto: false,
      },
    ];
    const rows = [
      title({ omieId: 1, base: "education", accountCode: 10, amount: 100 }),
      title({ omieId: 2, base: "store", accountCode: 10, amount: 200 }),
    ];
    expect(buildFinancialSummary(rows, scopedAccounts, {
      accountKeys: ["store:10"],
    })).toMatchObject({
      receitaTotal: 200,
      porBase: [
        { base: "education", receita: 0 },
        { base: "store", receita: 200 },
      ],
    });
  });

  it("excludes transfers and advances from operating cash flow", () => {
    const rows = [
      title({ omieId: 1, kind: "receber", status: "BAXR", amount: 100 }),
      title({ omieId: 2, kind: "pagar", status: "BAXP", amount: 40 }),
      title({ omieId: 3, kind: "receber", status: "EXTR", amount: 20 }),
      title({ omieId: 4, kind: "pagar", status: "EXTP", amount: 10 }),
      title({ omieId: 5, kind: "receber", status: "TRAR", amount: 500 }),
      title({ omieId: 6, kind: "pagar", status: "TRAP", amount: 500 }),
      title({ omieId: 7, kind: "receber", status: "ADCR", amount: 300 }),
      title({ omieId: 8, kind: "pagar", status: "ADVP", amount: 300 }),
    ];
    expect(buildFinancialSummary(rows, accounts, {})).toMatchObject({
      receitaTotal: 120,
      despesaTotal: 50,
      resultado: 70,
      ajustes: 0,
    });
  });

  it("reconciles monthly opening, operating result, adjustments and closing balance", () => {
    const reconciledAccounts: PersistedFinancialAccount[] = [{
      ...accounts[0],
      saldo: 178_888.29,
    }];
    const monthly = [
      ["2026-04", 2_822.50, 28_493, 88_556.13],
      ["2026-05", 84_526.81, 139_650.50, 17_078.76],
      ["2026-06", 86_051.92, 165_027.26, 7_998],
      ["2026-07", 398_242.37, 242_172.71, 43_895.50],
      ["2026-08", 168_132.47, 182_342.83, 13_805],
      ["2026-09", 63_212.06, 143_820.14, 17_080.26],
    ] as const;
    const rows = monthly.flatMap(([month, receita, despesa, adjustment], index) => [
      title({ omieId: index * 3 + 1, referenceDate: `${month}-15`, kind: "receber", status: "BAXR", amount: receita }),
      title({ omieId: index * 3 + 2, referenceDate: `${month}-15`, kind: "pagar", status: "BAXP", amount: despesa }),
      title({
        omieId: index * 3 + 3,
        referenceDate: `${month}-15`,
        kind: "receber",
        status: "ADCR",
        amount: adjustment,
      }),
    ]);
    const summary = buildFinancialSummary(rows, reconciledAccounts, {
      dataDe: "2026-04-01",
      dataAte: "2026-09-30",
    }, "2026-09-30");
    expect(summary.saldoFinal).toBeCloseTo(178_888.29, 2);
    expect(summary.porBase.reduce((sum, base) => sum + base.saldoFinal, 0)).toBeCloseTo(178_888.29, 2);
    expect(summary.meses.at(-1)).toMatchObject({
      mes: "2026-09",
      saldoInicial: expect.closeTo(242_416.11, 2),
      receita: 63_212.06,
      despesa: 143_820.14,
      ajustes: 17_080.26,
      saldoFinal: expect.closeTo(178_888.29, 2),
    });
  });

  it("reconstructs a historical closing balance by reversing later persisted movements", () => {
    const anchoredAccounts: PersistedFinancialAccount[] = [{
      ...accounts[0],
      saldo: 1_000,
    }];
    const summary = buildFinancialSummary([
      title({
        omieId: 1,
        referenceDate: "2026-08-15",
        kind: "receber",
        status: "BAXR",
        amount: 100,
      }),
      title({
        omieId: 2,
        referenceDate: "2026-09-10",
        kind: "receber",
        status: "BAXR",
        amount: 200,
      }),
    ], anchoredAccounts, {
      dataDe: "2026-08-01",
      dataAte: "2026-08-31",
    }, "2026-09-15");

    expect(summary).toMatchObject({
      saldoInicial: 700,
      receitaTotal: 100,
      saldoFinal: 800,
      meses: [{
        mes: "2026-08",
        saldoInicial: 700,
        receita: 100,
        saldoFinal: 800,
      }],
    });
  });

  it("shows both sides of an internal transfer by account without double counting the total", () => {
    const transferAccounts: PersistedFinancialAccount[] = [
      { ...accounts[0], saldo: 400 },
      { ...accounts[0], codigo: 30, descricao: "Reserva", saldo: 600 },
    ];
    const summary = buildFinancialSummary([
      title({ omieId: 1, accountCode: 10, kind: "pagar", status: "TRAP", amount: 250 }),
      title({ omieId: 2, accountCode: 30, kind: "receber", status: "TRAR", amount: 250 }),
    ], transferAccounts, {
      dataDe: "2026-09-01",
      dataAte: "2026-09-30",
    }, "2026-09-30");
    expect(summary.ajustes).toBe(0);
    expect(summary.saldoFinal).toBe(1_000);
    expect(summary.contas).toMatchObject([
      { codigo: 10, ajustes: -250, saldoFinal: 400 },
      { codigo: 30, ajustes: 250, saldoFinal: 600 },
    ]);
  });

  it("reproduces the Jan-Sep 2026 realized cash-flow reference totals", () => {
    const monthly = [
      ["2026-01", 2_950, 0],
      ["2026-02", 0, 0],
      ["2026-03", 0, 4_940],
      ["2026-04", 2_822.50, 28_493],
      ["2026-05", 84_526.81, 139_650.50],
      ["2026-06", 86_051.92, 165_027.26],
      ["2026-07", 398_242.37, 242_172.71],
      ["2026-08", 168_132.47, 182_342.83],
      ["2026-09", 63_212.06, 143_820.14],
    ] as const;
    const rows = monthly.flatMap(([month, receita, despesa], index) => [
      title({
        omieId: index * 2 + 1,
        referenceDate: `${month}-15`,
        kind: "receber",
        status: "BAXR",
        amount: receita,
      }),
      title({
        omieId: index * 2 + 2,
        referenceDate: `${month}-15`,
        kind: "pagar",
        status: "BAXP",
        amount: despesa,
      }),
    ]);
    const summary = buildFinancialSummary(rows, accounts, {});
    expect(summary.receitaTotal).toBeCloseTo(805_938.13, 2);
    expect(summary.despesaTotal).toBeCloseTo(906_446.44, 2);
    expect(summary.resultado).toBeCloseTo(-100_508.31, 2);
    expect(summary.meses).toHaveLength(9);
  });

  it("uses dated Omie anchors for each monthly opening and accumulated result", () => {
    const monthly = [
      ["2026-01", 2_950, 0],
      ["2026-02", 0, 0],
      ["2026-03", 0, 4_940],
      ["2026-04", 2_822.50, 28_493],
      ["2026-05", 84_526.81, 139_650.50],
      ["2026-06", 86_051.92, 165_027.26],
      ["2026-07", 398_242.37, 242_172.71],
      ["2026-08", 168_132.47, 182_342.83],
      ["2026-09", 63_212.06, 143_820.14],
    ] as const;
    const rows = monthly.flatMap(([month, receita, despesa], index) => [
      title({
        omieId: index * 2 + 1,
        referenceDate: `${month}-15`,
        kind: "receber",
        status: "BAXR",
        amount: receita,
      }),
      title({
        omieId: index * 2 + 2,
        referenceDate: `${month}-15`,
        kind: "pagar",
        status: "BAXP",
        amount: despesa,
      }),
    ]);
    const openings = [
      ["2026-01-01", 0],
      ["2026-02-01", 0],
      ["2026-03-01", 0],
      ["2026-04-01", 88_992.95],
      ["2026-05-01", 151_878.58],
      ["2026-06-01", 113_833.65],
      ["2026-07-01", 42_856.31],
      ["2026-08-01", 242_821.47],
      ["2026-09-01", 242_416.11],
    ] as const;
    const anchors: FinancialBalanceAnchor[] = openings.map(([date, balance]) => ({
      base: "education",
      accountCode: 10,
      date,
      previousBalance: balance,
      currentBalance: balance,
    }));
    anchors.push({
      base: "education",
      accountCode: 10,
      date: "2026-09-15",
      previousBalance: 242_416.11,
      currentBalance: 178_888.29,
    });

    const summary = buildFinancialSummary(rows, [{
      ...accounts[0],
      saldo: 178_888.29,
    }], {
      dataDe: "2026-01-01",
      dataAte: "2026-09-15",
    }, "2026-09-15", anchors);

    expect(summary.saldoInicial).toBe(0);
    expect(summary.saldoFinal).toBeCloseTo(178_888.29, 2);
    expect(summary.meses.map(month => ({
      mes: month.mes,
      saldoInicial: month.saldoInicial,
      saldoFinal: month.saldoFinal,
    }))).toEqual([
      { mes: "2026-01", saldoInicial: 0, saldoFinal: 0 },
      { mes: "2026-02", saldoInicial: 0, saldoFinal: 0 },
      { mes: "2026-03", saldoInicial: 0, saldoFinal: 88_992.95 },
      { mes: "2026-04", saldoInicial: 88_992.95, saldoFinal: 151_878.58 },
      { mes: "2026-05", saldoInicial: 151_878.58, saldoFinal: 113_833.65 },
      { mes: "2026-06", saldoInicial: 113_833.65, saldoFinal: 42_856.31 },
      { mes: "2026-07", saldoInicial: 42_856.31, saldoFinal: 242_821.47 },
      { mes: "2026-08", saldoInicial: 242_821.47, saldoFinal: 242_416.11 },
      { mes: "2026-09", saldoInicial: 242_416.11, saldoFinal: 178_888.29 },
    ]);
  });

  it("uses pre-period movements to derive a mid-month opening without reporting them as revenue", () => {
    const anchors: FinancialBalanceAnchor[] = [
      {
        base: "education",
        accountCode: 10,
        date: "2026-09-01",
        previousBalance: 100,
        currentBalance: 100,
      },
      {
        base: "education",
        accountCode: 10,
        date: "2026-09-30",
        previousBalance: 100,
        currentBalance: 250,
      },
    ];
    const summary = buildFinancialSummary([
      title({ omieId: 1, referenceDate: "2026-09-10", amount: 50 }),
      title({ omieId: 2, referenceDate: "2026-09-20", amount: 100 }),
    ], [{
      ...accounts[0],
      saldo: 250,
    }], {
      dataDe: "2026-09-16",
      dataAte: "2026-09-30",
    }, "2026-09-30", anchors);

    expect(summary).toMatchObject({
      saldoInicial: 150,
      receitaTotal: 100,
      ajustes: 0,
      saldoFinal: 250,
      meses: [{
        mes: "2026-09",
        saldoInicial: 150,
        receita: 100,
        ajustes: 0,
        saldoFinal: 250,
      }],
    });
  });

  it("reconciles a partial first month from an exact 90-day boundary anchor", () => {
    const anchors: FinancialBalanceAnchor[] = [
      {
        base: "education",
        accountCode: 10,
        date: "2026-06-18",
        previousBalance: 100,
        currentBalance: 100,
      },
      {
        base: "education",
        accountCode: 10,
        date: "2026-07-01",
        previousBalance: 150,
        currentBalance: 150,
      },
      {
        base: "education",
        accountCode: 10,
        date: "2026-08-01",
        previousBalance: 150,
        currentBalance: 150,
      },
      {
        base: "education",
        accountCode: 10,
        date: "2026-09-01",
        previousBalance: 150,
        currentBalance: 150,
      },
      {
        base: "education",
        accountCode: 10,
        date: "2026-09-15",
        previousBalance: 150,
        currentBalance: 200,
      },
    ];
    const summary = buildFinancialSummary([
      title({ omieId: 1, referenceDate: "2026-06-18", amount: 50 }),
      title({ omieId: 2, referenceDate: "2026-09-15", amount: 50 }),
    ], [{
      ...accounts[0],
      saldo: 200,
    }], {
      dataDe: "2026-06-18",
      dataAte: "2026-09-15",
    }, "2026-09-15", anchors);

    expect(summary).toMatchObject({
      saldoInicial: 100,
      receitaTotal: 100,
      ajustes: 0,
      saldoFinal: 200,
      meses: [
        { mes: "2026-06", saldoInicial: 100, receita: 50, saldoFinal: 150 },
        { mes: "2026-07", saldoInicial: 150, saldoFinal: 150 },
        { mes: "2026-08", saldoInicial: 150, saldoFinal: 150 },
        { mes: "2026-09", saldoInicial: 150, receita: 50, saldoFinal: 200 },
      ],
    });
  });
});