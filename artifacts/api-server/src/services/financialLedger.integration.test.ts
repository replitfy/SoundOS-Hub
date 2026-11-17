import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const tables = {
    snapshots: { name: "snapshots", key: "key", leaseUntil: "leaseUntil", leaseOwner: "leaseOwner" },
    titles: { name: "titles", base: "base", accountCode: "accountCode", referenceDate: "referenceDate", description: "description" },
    accounts: { name: "accounts", base: "base", description: "description" },
  };
  type State = {
    snapshot: Record<string, unknown> | null;
    titles: Array<Record<string, unknown>>;
    accounts: Array<Record<string, unknown>>;
  };
  let state: State = { snapshot: null, titles: [], accounts: [] };
  let balanceResults: Map<number, number | Error>;
  let failNextAccountsDelete: Error | null;

  function reset() {
    state.snapshot = null;
    state.titles = [];
    state.accounts = [];
    balanceResults = new Map();
    failNextAccountsDelete = null;
  }

  function selectFrom(source: { name: string }, target: State) {
    const rows = source.name === "snapshots"
      ? (target.snapshot ? [target.snapshot] : [])
      : source.name === "titles"
        ? target.titles
        : target.accounts;
    const promise = Promise.resolve(rows);
    const chain = {
      where: () => chain,
      orderBy: () => promise,
      limit: (count: number) => Promise.resolve(rows.slice(0, count)),
      then: promise.then.bind(promise),
    };
    return chain;
  }

  function database(target: State): any {
    return {
      select: () => ({ from: (source: { name: string }) => selectFrom(source, target) }),
      insert: (source: { name: string }) => ({
        values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
          const items = Array.isArray(values) ? values : [values];
          if (source.name === "snapshots" && !target.snapshot) {
            target.snapshot = { collectedAt: null, lastAttemptedAt: null, lastError: null, ...items[0] };
          } else if (source.name === "titles") {
            target.titles.push(...items);
          } else if (source.name === "accounts") {
            target.accounts.push(...items);
          }
          const promise = Promise.resolve();
          return {
            onConflictDoNothing: () => promise,
            onConflictDoUpdate: () => {
              if (source.name === "titles") {
                const unique = new Map<string, Record<string, unknown>>();
                for (const title of target.titles) {
                  unique.set(`${title.base}:${title.kind}:${title.omieId}`, title);
                }
                target.titles = [...unique.values()];
              }
              return promise;
            },
            then: promise.then.bind(promise),
          };
        },
      }),
      update: (source: { name: string }) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if (source.name === "snapshots" && target.snapshot) Object.assign(target.snapshot, values);
            const promise = Promise.resolve(target.snapshot ? [target.snapshot] : []);
            return {
              returning: () => promise,
              then: promise.then.bind(promise),
              catch: promise.catch.bind(promise),
            };
          },
        }),
      }),
      delete: (source: { name: string }) => {
        const perform = () => {
          if (source.name === "titles") target.titles = [];
          if (source.name === "accounts") {
            if (failNextAccountsDelete) {
              const error = failNextAccountsDelete;
              failNextAccountsDelete = null;
              throw error;
            }
            target.accounts = [];
          }
          return Promise.resolve();
        };
        const promise = source.name === "accounts" ? perform() : Promise.resolve();
        return {
          where: (condition: { values?: unknown[] }) => {
            if (source.name === "titles") {
              const values = condition?.values ?? [];
              const from = values.find(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value as string)) as string | undefined;
              const to = [...values].reverse().find(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value as string)) as string | undefined;
              if (from && to) {
                target.titles = target.titles.filter(title =>
                  typeof title.referenceDate !== "string"
                  || title.referenceDate < from
                  || title.referenceDate > to);
              }
              return Promise.resolve();
            }
            return perform();
          },
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
        };
      },
      execute: async () => ({
        rows: target.snapshot ? [{
          lease_owner: target.snapshot.leaseOwner,
          lease_until: target.snapshot.leaseUntil,
        }] : [],
      }),
      transaction: async <T>(callback: (tx: ReturnType<typeof database>) => Promise<T>) => {
        const draft = structuredClone(target);
        const result = await callback(database(draft));
        target.snapshot = draft.snapshot;
        target.titles = draft.titles;
        target.accounts = draft.accounts;
        return result;
      },
    };
  }

  reset();
  return {
    tables,
    db: database(state),
    reset,
    setBalances(results: Array<number | Error>) {
      balanceResults = new Map([
        [10, results[0] ?? new Error("Missing simulated balance")],
        [20, results[1] ?? new Error("Missing simulated balance")],
      ]);
    },
    setBalance(accountCode: number, balance: number | Error) {
      balanceResults.set(accountCode, balance);
    },
    failAccountsDeleteOnce(error: Error) {
      failNextAccountsDelete = error;
    },
    nextBalance(accountCode: number) {
      const result = balanceResults.get(accountCode);
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error("Missing simulated balance");
      return result;
    },
    persisted() {
      return structuredClone(state);
    },
  };
});


vi.mock("@workspace/db", () => ({
  db: harness.db,
  financialSnapshotsTable: harness.tables.snapshots,
  financialTitlesTable: harness.tables.titles,
  financialAccountsTable: harness.tables.accounts,
}));

vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => ({ values: values.flatMap(value =>
    value && typeof value === "object" && "values" in value
      ? (value as { values: unknown[] }).values
      : [value]) }),
  asc: (value: unknown) => value,
  eq: (...values: unknown[]) => values,
  gte: (...values: unknown[]) => ({ values }),
  isNull: (value: unknown) => value,
  lt: (...values: unknown[]) => values,
  lte: (...values: unknown[]) => ({ values }),
  or: (...values: unknown[]) => values,
  sql: Object.assign((parts: TemplateStringsArray) => parts.join("?"), {
    raw: (value: string) => value,
  }),
}));

vi.mock("../lib/omie", () => ({
  OMIE_BASE_NAMES: { education: "Education", store: "Store" },
  STATUS_PAGAMENTO_PARCIAL: "PAGTO PARCIAL",
  listarContasCorrentesDiag: vi.fn(async (base: string) => base === "education" ? [
    { codigo: 10, descricao: "Principal", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
    { codigo: 20, descricao: "Reserva", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
  ] : []),
  obterSaldosContaCorrente: vi.fn(async (_base: string, accountCode: number) => {
    const balance = harness.nextBalance(accountCode);
    return { saldoAnterior: balance, saldoAtual: balance };
  }),
  listarTodosMovimentosFinanceiros: vi.fn(async (
    _base: string,
    filters: { dataDe: string; dataAte: string },
  ) => {
    const toIso = (value: string) => {
      const [day, month, year] = value.split("/");
      return `${year}-${month}-${day}`;
    };
    return [
      { date: "2025-02-15", id: 50, amount: 75 },
      { date: "2026-09-15", id: 101, amount: 125 },
    ].filter(item => item.date >= toIso(filters.dataDe) && item.date <= toIso(filters.dataAte))
      .map(item => ({
        detalhes: {
          cNatureza: "R" as const,
          cOrigem: "BAXR",
          dDtPagamento: item.date.split("-").reverse().join("/"),
          nCodCC: 10,
          nCodMovCC: item.id,
          nValorMovCC: item.amount,
        },
      }));
  }),
  listarTodosTitulos: vi.fn(async () => []),
}));

import { listarContasCorrentesDiag, listarTodosMovimentosFinanceiros, listarTodosTitulos } from "../lib/omie";
import { getFinancialSnapshot, refreshFinancialSnapshot } from "./financialLedger";

describe("financial ledger publication", () => {
  beforeEach(() => {
    harness.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes a payment split across several titles as one movement with the full amount", async () => {
    const actualOmie = await vi.importActual<typeof import("../lib/omie")>("../lib/omie");
    const listMovements = vi.mocked(listarTodosMovimentosFinanceiros);
    const originalImplementation = listMovements.getMockImplementation();
    process.env["OMIE_EDUCATION_APP_KEY"] = "test-key";
    process.env["OMIE_EDUCATION_APP_SECRET"] = "test-secret";
    const splitRow = (settlementId: number, paid: number) => ({
      detalhes: {
        cNatureza: "R",
        cOrigem: "BAXR",
        dDtPagamento: "15/09/2026",
        nCodCC: 10,
        nCodMovCC: 6806274928,
        nCodBaixa: settlementId,
        nValorMovCC: 290,
      },
      resumo: { nValPago: paid },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      nPagina: 1,
      nTotPaginas: 1,
      nRegistros: 2,
      nTotRegistros: 2,
      movimentos: [splitRow(1, 240), splitRow(2, 50)],
    }), { status: 200 })));
    listMovements.mockImplementation((base, filters, options) =>
      base === "education"
        ? actualOmie.listarTodosMovimentosFinanceiros(base, filters, options)
        : Promise.resolve([]));

    try {
      harness.setBalances([1_000, 500]);
      const published = await refreshFinancialSnapshot({}, {
        referenceDate: new Date("2026-09-15T12:00:00Z"),
      });

      expect(published).toMatchObject({ status: "ready", data: { receitaTotal: 290 } });
      expect(harness.persisted().titles).toEqual([
        expect.objectContaining({ omieId: 6806274928, amount: 290 }),
      ]);
    } finally {
      if (originalImplementation) listMovements.mockImplementation(originalImplementation);
    }
  });

  it("keeps the last complete snapshot when one account returns an invalid statement balance", async () => {
    harness.setBalances([1_000, 500]);
    const published = await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });
    expect(published).toMatchObject({
      status: "ready",
      collectedAt: expect.any(String),
      data: { saldoFinal: 1_500, receitaTotal: 125 },
    });
    const beforeFailure = harness.persisted();

    harness.setBalances([1_100, new Error("Extrato inválido para a conta 20.")]);
    const failed = await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-16T12:00:00Z"),
    });
    const afterFailure = harness.persisted();

    expect(failed).toMatchObject({
      status: "error",
      collectedAt: published.collectedAt,
      lastError: expect.stringContaining("dados anteriores foram mantidos"),
      data: published.data,
    });
    expect(afterFailure.titles).toEqual(beforeFailure.titles);
    expect(afterFailure.accounts).toEqual(beforeFailure.accounts);
    expect(afterFailure.snapshot?.filters).toEqual(beforeFailure.snapshot?.filters);
    expect(afterFailure.snapshot?.payload).toEqual(beforeFailure.snapshot?.payload);
    expect(afterFailure.snapshot?.collectedAt).toEqual(beforeFailure.snapshot?.collectedAt);
    expect(afterFailure.snapshot).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("dados anteriores foram mantidos"),
    });
  });

  it("rolls back movements, accounts, and metadata when the database fails during publication", async () => {
    harness.setBalances([1_000, 500]);
    const published = await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });
    expect(published).toMatchObject({
      status: "ready",
      collectedAt: expect.any(String),
      data: { saldoFinal: 1_500, receitaTotal: 125 },
    });
    const beforeFailure = harness.persisted();

    harness.setBalances([1_100, 600]);
    harness.failAccountsDeleteOnce(new Error("Simulated database write failure"));
    const failed = await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-16T12:00:00Z"),
    });
    const afterFailure = harness.persisted();

    expect(failed).toMatchObject({
      status: "error",
      collectedAt: published.collectedAt,
      lastError: expect.stringContaining("dados anteriores foram mantidos"),
      data: published.data,
    });
    expect(afterFailure.titles).toEqual(beforeFailure.titles);
    expect(afterFailure.accounts).toEqual(beforeFailure.accounts);
    expect(afterFailure.snapshot?.filters).toEqual(beforeFailure.snapshot?.filters);
    expect(afterFailure.snapshot?.payload).toEqual(beforeFailure.snapshot?.payload);
    expect(afterFailure.snapshot?.collectedAt).toEqual(beforeFailure.snapshot?.collectedAt);
    expect(afterFailure.snapshot).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("dados anteriores foram mantidos"),
    });
  });

  it("returns populated data and the effective overlap for a partially covered period", async () => {
    harness.setBalances([1_000, 500]);
    await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });

    const snapshot = await getFinancialSnapshot({
      dataDe: "2026-01-01",
      dataAte: "2026-12-31",
    });

    expect(snapshot).toMatchObject({
      status: "ready",
      data: {
        receitaTotal: 125,
        saldoFinal: 1_500,
        contas: expect.arrayContaining([
          expect.objectContaining({ codigo: 10, receita: 125 }),
        ]),
      },
      lastError: expect.stringContaining(
        "Exibindo os dados disponíveis de 2026-06-18 a 2026-09-15",
      ),
    });
  });

  it("returns all populated saved data and its effective period when the request has no overlap", async () => {
    harness.setBalances([1_000, 500]);
    await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });

    const snapshot = await getFinancialSnapshot({
      dataDe: "2027-01-01",
      dataAte: "2027-12-31",
    });

    expect(snapshot).toMatchObject({
      status: "ready",
      data: {
        receitaTotal: 125,
        saldoFinal: 1_500,
        meses: expect.arrayContaining([
          expect.objectContaining({ mes: "2026-09", receita: 125 }),
        ]),
      },
      lastError: expect.stringContaining(
        "Exibindo os dados disponíveis de 2026-06-18 a 2026-09-15",
      ),
    });
  });

  it("extends the persisted period backwards when an administrator requests older history", async () => {
    harness.setBalances([1_000, 500]);
    await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });

    harness.setBalances([1_000, 500]);
    const expanded = await refreshFinancialSnapshot({
      dataDe: "2025-01-01",
      dataAte: "2026-09-15",
    }, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });

    expect(expanded).toMatchObject({
      status: "ready",
      availableFrom: "2025-01-01",
      availableTo: "2026-09-15",
      lastError: null,
    });
    expect(harness.persisted().snapshot?.filters).toEqual({
      dataDe: "2025-01-01",
      dataAte: "2026-09-15",
    });

    harness.setBalances([1_000, 500]);
    await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });
    expect(new Set(harness.persisted().titles.map(title => title.omieId))).toEqual(new Set([50, 101]));
  });

  it("collects the earlier balances of an account created after the last load so old periods still open", async () => {
    harness.setBalances([1_000, 500]);
    await refreshFinancialSnapshot({}, { referenceDate: new Date("2026-09-15T12:00:00Z") });

    const listAccounts = vi.mocked(listarContasCorrentesDiag);
    const originalImplementation = listAccounts.getMockImplementation();
    listAccounts.mockImplementation(async (base: string) => base === "education"
      ? [
          { codigo: 10, descricao: "Principal", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
          { codigo: 20, descricao: "Reserva", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
          { codigo: 30, descricao: "Nova", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
        ]
      : []);
    try {
      harness.setBalances([1_000, 500]);
      harness.setBalance(30, 0);
      const refreshed = await refreshFinancialSnapshot({}, {
        referenceDate: new Date("2026-09-16T12:00:00Z"),
      });

      expect(refreshed).toMatchObject({ status: "ready", lastError: null });
      const anchors = (harness.persisted().snapshot?.payload as {
        anchors: Array<{ accountCode: number; date: string }>;
      }).anchors;
      const datesOf = (code: number) => anchors
        .filter(anchor => anchor.accountCode === code)
        .map(anchor => anchor.date)
        .sort();
      expect(datesOf(30)).toEqual(datesOf(10));
      expect(datesOf(30)).toContain("2026-06-18");

      const oldest = await getFinancialSnapshot({ dataDe: "2026-06-18", dataAte: "2026-09-16" });
      expect(oldest.data?.contas.map(account => account.codigo)).toContain(30);
    } finally {
      if (originalImplementation) listAccounts.mockImplementation(originalImplementation);
    }
  });

  it("keeps the previous data when the earlier balances of a new account cannot be collected", async () => {
    harness.setBalances([1_000, 500]);
    const published = await refreshFinancialSnapshot({}, {
      referenceDate: new Date("2026-09-15T12:00:00Z"),
    });
    const before = harness.persisted();

    const listAccounts = vi.mocked(listarContasCorrentesDiag);
    const originalImplementation = listAccounts.getMockImplementation();
    listAccounts.mockImplementation(async (base: string) => base === "education"
      ? [
          { codigo: 10, descricao: "Principal", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
          { codigo: 20, descricao: "Reserva", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
          { codigo: 30, descricao: "Nova", excluida: false, ativa: true, saldo: 0, emiteBoleto: false },
        ]
      : []);
    try {
      harness.setBalances([1_000, 500]);
      harness.setBalance(30, new Error("Extrato inválido para a conta 30."));
      const failed = await refreshFinancialSnapshot({}, {
        referenceDate: new Date("2026-09-16T12:00:00Z"),
      });

      expect(failed).toMatchObject({
        status: "error",
        collectedAt: published.collectedAt,
        data: published.data,
      });
      expect(harness.persisted().snapshot?.payload).toEqual(before.snapshot?.payload);
      expect(harness.persisted().accounts).toEqual(before.accounts);
    } finally {
      if (originalImplementation) listAccounts.mockImplementation(originalImplementation);
    }
  });
  describe("planned titles with a status the system does not know", () => {
    const payable = (id: number, status: string, due: string, amount: number) => ({
      codigo_lancamento_omie: id,
      nCodCC: 10,
      data_vencimento: due,
      valor_documento: amount,
      status_titulo: status,
    });

    it("finishes the refresh, leaves the title out and tells the team what was left out", async () => {
      const listTitles = vi.mocked(listarTodosTitulos);
      const originalImplementation = listTitles.getMockImplementation();
      listTitles.mockImplementation(async (base: string, kind: string) => base === "education" && kind === "pagar"
        ? [
            payable(1, "A VENCER", "30/09/2026", 100),
            payable(2, "PAGTO PARCIAL", "10/09/2026", 905),
            payable(3, "PAGTO PARCIAL", "20/09/2026", 40),
            payable(4, "EM NEGOCIACAO", "25/09/2026", 300),
            payable(5, "EM NEGOCIACAO", "26/09/2026", 200.5),
          ]
        : []);
      try {
        harness.setBalances([1_000, 500]);
        const published = await refreshFinancialSnapshot({}, {
          referenceDate: new Date("2026-09-15T12:00:00Z"),
        });

        expect(published.status).toBe("ready");
        expect(published.lastError).toContain('contas a pagar com status "EM NEGOCIACAO" (2 títulos, R$');
        expect(published.lastError).toContain("500,50");
        const planned = (harness.persisted().snapshot?.payload as {
          plannedTitles: Array<{ omieId: number; amount: number; status: string }>;
        }).plannedTitles;
        expect(planned.map(item => [item.omieId, item.amount, item.status])).toEqual([
          [1, 100, "A VENCER"],
          [2, 905, "ATRASADO"],
          [3, 40, "A VENCER"],
        ]);
        // O resumo mostra o período coletado (até 15/09): só o parcial vencido em 10/09 entra, com o saldo em aberto.
        expect(published.data).toMatchObject({ despesaPlanejadaTotal: 905 });

        // A leitura posterior do que foi gravado continua válida e mantém o aviso.
        const reread = await getFinancialSnapshot({});
        expect(reread.lastError).toBe(published.lastError);

        // Quando o status desconhecido some do Omie, o aviso some junto.
        listTitles.mockImplementation(async () => []);
        harness.setBalances([1_000, 500]);
        const clean = await refreshFinancialSnapshot({}, {
          referenceDate: new Date("2026-09-16T12:00:00Z"),
        });
        expect(clean).toMatchObject({ status: "ready", lastError: null });
      } finally {
        if (originalImplementation) listTitles.mockImplementation(originalImplementation);
      }
    });

    it("still cancels the refresh when a cash movement has an unknown origin", async () => {
      harness.setBalances([1_000, 500]);
      const published = await refreshFinancialSnapshot({}, {
        referenceDate: new Date("2026-09-15T12:00:00Z"),
      });
      const before = harness.persisted();

      const listMovements = vi.mocked(listarTodosMovimentosFinanceiros);
      const originalImplementation = listMovements.getMockImplementation();
      listMovements.mockImplementation(async () => [{
        detalhes: {
          cNatureza: "R" as const,
          cOrigem: "ORIGEM_NOVA",
          dDtPagamento: "16/09/2026",
          nCodCC: 10,
          nCodMovCC: 999,
          nValorMovCC: 10,
        },
      }]);
      try {
        harness.setBalances([1_000, 500]);
        const failed = await refreshFinancialSnapshot({}, {
          referenceDate: new Date("2026-09-16T12:00:00Z"),
        });

        expect(failed).toMatchObject({
          status: "error",
          collectedAt: published.collectedAt,
          lastError: expect.stringContaining("dados anteriores foram mantidos"),
        });
        expect(harness.persisted().titles).toEqual(before.titles);
      } finally {
        if (originalImplementation) listMovements.mockImplementation(originalImplementation);
      }
    });
  });
});
