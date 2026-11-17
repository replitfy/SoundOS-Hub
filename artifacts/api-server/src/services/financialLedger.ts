import { randomUUID } from "node:crypto";
import {
  db,
  financialAccountsTable,
  financialSnapshotsTable,
  financialTitlesTable,
  type FinancialAccountRow,
  type FinancialTitleInsert,
  type FinancialTitleRow,
} from "@workspace/db";
import { GetOmieResumoFinanceiroResponse } from "@workspace/api-zod";
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  listarContasCorrentesDiag,
  listarTodosTitulos,
  listarTodosMovimentosFinanceiros,
  obterSaldosContaCorrente,
  OMIE_BASE_NAMES,
  STATUS_PAGAMENTO_PARCIAL,
  type OmieBase,
  type OmieContaCorrenteDiag,
  type OmieMovimentoFinanceiroRaw,
} from "../lib/omie";
import { logger } from "../lib/logger";

const SNAPSHOT_KEY = "main";
const SCHEMA_VERSION = 7;
const LEASE_MS = 2 * 60 * 1000;
const COLLECTION_TIMEOUT_MS = 4 * 60 * 1000;
const BASES: OmieBase[] = ["education", "store"];
const KNOWN_MOVEMENT_ORIGINS = new Set([
  "ADCR",
  "ADVP",
  "APBP",
  "BAXP",
  "BAXR",
  "COMP",
  "EXTP",
  "EXTR",
  "TRAP",
  "TRAR",
]);
const OPERATING_MOVEMENT_ORIGINS = new Set(["APBP", "BAXP", "BAXR", "EXTP", "EXTR"]);

export interface FinancialSnapshotFilters {
  dataDe?: string;
  dataAte?: string;
  accountKeys?: string[];
  base?: OmieBase;
  excludeNonConsidered?: boolean;
}

interface FinancialSummary {
  receitaTotal: number;
  despesaTotal: number;
  resultado: number;
  receitaPlanejadaTotal: number;
  despesaPlanejadaTotal: number;
  resultadoPlanejado: number;
  saldoInicial: number;
  ajustes: number;
  saldoFinal: number;
  porBase: Array<{
    base: OmieBase;
    nome: string;
    receita: number;
    despesa: number;
    resultado: number;
    receitaPlanejada: number;
    despesaPlanejada: number;
    resultadoPlanejado: number;
    saldoInicial: number;
    ajustes: number;
    saldoFinal: number;
  }>;
  meses: Array<{
    mes: string;
    receita: number;
    despesa: number;
    resultado: number;
    receitaPlanejada: number;
    despesaPlanejada: number;
    resultadoPlanejado: number;
    saldoInicial: number;
    ajustes: number;
    saldoFinal: number;
  }>;
  contas: Array<{
    base: OmieBase;
    codigo: number;
    nome: string;
    tipo: string | null;
    receita: number;
    despesa: number;
    resultado: number;
    receitaPlanejada: number;
    despesaPlanejada: number;
    resultadoPlanejado: number;
    saldoInicial: number;
    ajustes: number;
    saldoFinal: number;
  }>;
}

export interface FinancialSnapshotState {
  status: "empty" | "ready" | "refreshing" | "error";
  schemaVersion: number;
  data: FinancialSummary | null;
  collectedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
  availableFrom: string | null;
  availableTo: string | null;
}

export interface PersistedFinancialAccount extends OmieContaCorrenteDiag {
  base: OmieBase;
}

export interface FinancialBalanceAnchor {
  base: OmieBase;
  accountCode: number;
  date: string;
  previousBalance: number;
  currentBalance: number;
}

export interface PersistedPlannedTitle {
  base: OmieBase;
  kind: "receber" | "pagar";
  omieId: number;
  accountCode: number;
  dueDate: string;
  amount: number;
  status: "A VENCER" | "ATRASADO";
}

interface LoadCandidate {
  titles: FinancialTitleInsert[];
  accounts: PersistedFinancialAccount[];
  anchors: FinancialBalanceAnchor[];
  plannedTitles: PersistedPlannedTitle[];
  /** Aviso sobre títulos planejados deixados de fora por status desconhecido; null quando nada ficou de fora. */
  plannedWarning: string | null;
  windows: Array<{ dataDe: string; dataAte: string }>;
}

let activeRefresh: Promise<void> | null = null;

export function normalizeFinancialFilters(filters: FinancialSnapshotFilters): FinancialSnapshotFilters {
  const accountKeys = filters.accountKeys
    ? [...new Set(filters.accountKeys)].sort()
    : undefined;
  return {
    ...(filters.dataDe ? { dataDe: filters.dataDe } : {}),
    ...(filters.dataAte ? { dataAte: filters.dataAte } : {}),
    ...(accountKeys?.length ? { accountKeys } : {}),
    ...(filters.base ? { base: filters.base } : {}),
    ...(filters.excludeNonConsidered === false ? { excludeNonConsidered: false } : {}),
  };
}

export function rollingNinetyDayWindow(referenceDate: Date): { dataDe: string; dataAte: string } {
  const end = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 89);
  return { dataDe: isoDate(start), dataAte: isoDate(end) };
}

export function financialCollectionRequest(referenceDate: Date): {
  window: { dataDe: string; dataAte: string };
  omieFilters: { dataDe: string; dataAte: string };
} {
  const window = rollingNinetyDayWindow(referenceDate);
  return {
    window,
    omieFilters: {
      dataDe: toOmieDate(window.dataDe),
      dataAte: toOmieDate(window.dataAte),
    },
  };
}

export function missingFinancialWindows(
  requested: { dataDe: string; dataAte: string },
  stored?: { dataDe: string; dataAte: string },
): Array<{ dataDe: string; dataAte: string }> {
  if (!stored) return [requested];
  const windows: Array<{ dataDe: string; dataAte: string }> = [];
  if (requested.dataDe < stored.dataDe) {
    windows.push({ dataDe: requested.dataDe, dataAte: previousDay(stored.dataDe) });
  }
  if (requested.dataAte > stored.dataAte) {
    const start = new Date(`${stored.dataAte}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    windows.push({ dataDe: isoDate(start), dataAte: requested.dataAte });
  }
  return windows;
}

export function splitFinancialWindows(
  windows: Array<{ dataDe: string; dataAte: string }>,
  daysPerWindow = 90,
): Array<{ dataDe: string; dataAte: string }> {
  return windows.flatMap(window => {
    const chunks: Array<{ dataDe: string; dataAte: string }> = [];
    let dataDe = window.dataDe;
    while (dataDe <= window.dataAte) {
      const end = new Date(`${dataDe}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + daysPerWindow - 1);
      const dataAte = isoDate(end) < window.dataAte ? isoDate(end) : window.dataAte;
      chunks.push({ dataDe, dataAte });
      const next = new Date(`${dataAte}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      dataDe = isoDate(next);
    }
    return chunks;
  });
}

export function mergeFinancialWindows(
  windows: Array<{ dataDe: string; dataAte: string }>,
): Array<{ dataDe: string; dataAte: string }> {
  const sorted = [...windows].sort((a, b) => a.dataDe.localeCompare(b.dataDe));
  const merged: Array<{ dataDe: string; dataAte: string }> = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...window });
      continue;
    }
    if (window.dataDe <= previous.dataAte) {
      if (window.dataAte > previous.dataAte) previous.dataAte = window.dataAte;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

export function mergePersistedPlannedTitles(
  persisted: PersistedPlannedTitle[],
  collected: PersistedPlannedTitle[],
  refreshedWindows: Array<{ dataDe: string; dataAte: string }>,
): PersistedPlannedTitle[] {
  return [
    ...persisted.filter(title => !refreshedWindows.some(window =>
      title.dueDate >= window.dataDe && title.dueDate <= window.dataAte)),
    ...collected,
  ];
}

export function isWithinFinancialWindow(
  referenceDate: string | null | undefined,
  window: { dataDe: string; dataAte: string },
): boolean {
  return referenceDate != null
    && referenceDate >= window.dataDe
    && referenceDate <= window.dataAte;
}

export function isFinancialFilterCovered(
  filters: FinancialSnapshotFilters,
  storedWindow: { dataDe: string; dataAte: string },
): boolean {
  const requestedFrom = filters.dataDe ?? storedWindow.dataDe;
  const requestedTo = filters.dataAte ?? storedWindow.dataAte;
  return requestedFrom >= storedWindow.dataDe
    && requestedTo <= storedWindow.dataAte
    && requestedFrom <= requestedTo;
}

export function effectiveFinancialWindow(
  filters: FinancialSnapshotFilters,
  storedWindow: { dataDe: string; dataAte: string },
): { dataDe: string; dataAte: string; adjusted: boolean } {
  const requestedFrom = filters.dataDe ?? storedWindow.dataDe;
  const requestedTo = filters.dataAte ?? storedWindow.dataAte;
  const overlapFrom = requestedFrom > storedWindow.dataDe ? requestedFrom : storedWindow.dataDe;
  const overlapTo = requestedTo < storedWindow.dataAte ? requestedTo : storedWindow.dataAte;

  if (requestedFrom <= requestedTo && overlapFrom <= overlapTo) {
    return {
      dataDe: overlapFrom,
      dataAte: overlapTo,
      adjusted: overlapFrom !== requestedFrom || overlapTo !== requestedTo,
    };
  }

  return {
    ...storedWindow,
    adjusted: true,
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toOmieDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function nextMonthStart(value: string): string {
  const date = new Date(`${monthStart(value)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return isoDate(date);
}

function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return isoDate(date);
}

function monthKeysBetween(from: string, to: string): string[] {
  const result: string[] = [];
  let cursor = monthStart(from);
  const last = monthStart(to);
  while (cursor <= last) {
    result.push(cursor.slice(0, 7));
    cursor = nextMonthStart(cursor);
  }
  return result;
}

function anchorDatesForWindow(window: { dataDe: string; dataAte: string }): string[] {
  const dates = monthKeysBetween(window.dataDe, window.dataAte).map((month, index) =>
    index === 0 ? window.dataDe : `${month}-01`
  );
  if (!dates.includes(window.dataAte)) dates.push(window.dataAte);
  return dates;
}

function fromOmieDate(value?: string): string | null {
  if (!value) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || isoDate(date) !== iso ? null : iso;
}

function mapMovement(
  base: OmieBase,
  movement: OmieMovimentoFinanceiroRaw,
  loadedAt: Date,
): FinancialTitleInsert {
  const details = movement.detalhes;
  const referenceDate = fromOmieDate(details?.dDtPagamento);
  const id = details?.nCodMovCC;
  const accountCode = details?.nCodCC;
  const origin = details?.cOrigem;
  const kind = details?.cNatureza === "R"
    ? "receber"
    : details?.cNatureza === "P"
      ? "pagar"
      : null;
  if (!Number.isInteger(id) || !id || id <= 0) {
    throw new Error(`Movimento sem identificador válido na base ${OMIE_BASE_NAMES[base]}.`);
  }
  if (!Number.isInteger(accountCode) || !accountCode || accountCode <= 0) {
    throw new Error(`Movimento ${id} da base ${OMIE_BASE_NAMES[base]} não possui conta corrente.`);
  }
  if (!kind) {
    throw new Error(`Movimento ${id} da base ${OMIE_BASE_NAMES[base]} não possui natureza válida.`);
  }
  if (!origin || !KNOWN_MOVEMENT_ORIGINS.has(origin)) {
    throw new Error(
      `Movimento ${id} da base ${OMIE_BASE_NAMES[base]} possui origem desconhecida: ${origin ?? "(vazia)"}.`,
    );
  }
  if (!referenceDate) {
    throw new Error(
      `Movimento ${id} da base ${OMIE_BASE_NAMES[base]} não possui data de pagamento válida.`,
    );
  }
  const amount = details?.nValorMovCC;
  if (amount === undefined || !Number.isFinite(amount)) {
    throw new Error(
      `Movimento ${id} da base ${OMIE_BASE_NAMES[base]} não possui valor válido.`,
    );
  }
  return {
    base,
    kind,
    omieId: id,
    accountCode,
    issueDate: null,
    dueDate: null,
    referenceDate,
    amount: Math.abs(amount),
    status: origin,
    loadedAt,
  };
}

// Status do planejado: "VENCE HOJE" ainda não venceu, e "PAGTO PARCIAL" não diz se o saldo está
// atrasado (quem decide é o vencimento). Qualquer outro status é registrado e avisado, nunca descartado em silêncio.
const PLANNED_OPEN_STATUS = new Map<string, "A VENCER" | "ATRASADO">([
  ["A VENCER", "A VENCER"],
  ["VENCE HOJE", "A VENCER"],
  ["ATRASADO", "ATRASADO"],
]);
const PLANNED_CLOSED_STATUS = new Set(["RECEBIDO", "PAGO", "CANCELADO"]);

export type PlannedTitleOutcome =
  | { outcome: "planned"; title: PersistedPlannedTitle }
  | { outcome: "closed" }
  | { outcome: "unknown"; status: string; amount: number };

/**
 * Decide o que fazer com um título do Omie no planejado. `referenceDate` (AAAA-MM-DD) é o dia da atualização
 * e separa atrasado de a vencer nos pagamentos parciais.
 */
export function planTitle(
  base: OmieBase,
  kind: "receber" | "pagar",
  raw: Awaited<ReturnType<typeof listarTodosTitulos>>[number],
  referenceDate: string,
): PlannedTitleOutcome {
  const rawStatus = raw.status_titulo ?? "";
  if (PLANNED_CLOSED_STATUS.has(rawStatus)) return { outcome: "closed" };
  const fixedStatus = PLANNED_OPEN_STATUS.get(rawStatus);
  if (!fixedStatus && rawStatus !== STATUS_PAGAMENTO_PARCIAL) {
    const value = raw.valor_documento;
    return {
      outcome: "unknown",
      status: rawStatus || "(sem status)",
      amount: typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0,
    };
  }
  const id = raw.codigo_lancamento_omie;
  const accountCode = raw.id_conta_corrente ?? raw.nCodCC;
  const dueDate = fromOmieDate(raw.data_vencimento);
  const amount = raw.valor_documento;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Título sem identificador válido na base ${OMIE_BASE_NAMES[base]}.`);
  }
  if (typeof accountCode !== "number" || !Number.isSafeInteger(accountCode) || accountCode <= 0) {
    throw new Error(`Título ${id} da base ${OMIE_BASE_NAMES[base]} não possui conta corrente.`);
  }
  if (!dueDate) {
    throw new Error(`Título ${id} da base ${OMIE_BASE_NAMES[base]} não possui vencimento válido.`);
  }
  if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
    throw new Error(`Título ${id} da base ${OMIE_BASE_NAMES[base]} não possui valor válido.`);
  }
  const status = fixedStatus ?? (dueDate < referenceDate ? "ATRASADO" : "A VENCER");
  return { outcome: "planned", title: { base, kind, omieId: id, accountCode, dueDate, amount, status } };
}

interface ExcludedPlannedTitle {
  kind: "receber" | "pagar";
  status: string;
  amount: number;
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Texto mostrado na tela quando há títulos planejados que ficaram de fora; null quando nenhum ficou. */
export function describeExcludedPlannedTitles(excluded: Iterable<ExcludedPlannedTitle>): string | null {
  const groups = new Map<string, { kind: "receber" | "pagar"; status: string; count: number; amount: number }>();
  for (const item of excluded) {
    const key = `${item.kind}:${item.status}`;
    const group = groups.get(key) ?? { kind: item.kind, status: item.status, count: 0, amount: 0 };
    group.count += 1;
    group.amount += item.amount;
    groups.set(key, group);
  }
  if (groups.size === 0) return null;
  const parts = [...groups.values()].map(group => {
    const nature = group.kind === "pagar" ? "contas a pagar" : "contas a receber";
    const titles = group.count === 1 ? "1 título" : `${group.count} títulos`;
    return `${nature} com status "${group.status}" (${titles}, ${brl.format(Math.round(group.amount * 100) / 100)})`;
  });
  return `Atualizado, mas o Omie enviou títulos com um status que o sistema não conhece. Eles ficaram fora do planejado, que está incompleto: ${parts.join("; ")}.`;
}

async function collectCandidate(
  windows: Array<{ dataDe: string; dataAte: string }>,
  balanceDate: string,
  savedAnchors: FinancialBalanceAnchor[] = [],
): Promise<LoadCandidate> {
  const signal = AbortSignal.timeout(COLLECTION_TIMEOUT_MS);
  const loadedAt = new Date();
  const titles: FinancialTitleInsert[] = [];
  const plannedTitles: PersistedPlannedTitle[] = [];
  const excludedPlanned = new Map<string, ExcludedPlannedTitle>();
  const accounts: PersistedFinancialAccount[] = [];
  const anchors: FinancialBalanceAnchor[] = [];
  const anchorDates = [...new Set([...windows.flatMap(anchorDatesForWindow), balanceDate])].sort();
  const savedAnchorDates = [...new Set(savedAnchors.map(anchor => anchor.date))];

  for (const base of BASES) {
    const baseAccounts = await listarContasCorrentesDiag(base, {
      signal,
      validateComplete: true,
    });
    for (const account of baseAccounts) {
      let cutoffBalance: number | null = null;
      // Uma conta criada depois da última carga (ou com falhas nas âncoras salvas) não tem os
      // saldos dos meses anteriores; sem eles os períodos antigos não podem ser calculados.
      const savedForAccount = new Set(
        savedAnchors
          .filter(anchor => anchor.base === base && anchor.accountCode === account.codigo)
          .map(anchor => anchor.date),
      );
      const accountAnchorDates = [...new Set([
        ...anchorDates,
        ...savedAnchorDates.filter(date => !savedForAccount.has(date)),
      ])].sort();
      for (const date of accountAnchorDates) {
        const balances = await obterSaldosContaCorrente(
          base,
          account.codigo,
          toOmieDate(date),
          signal,
        );
        anchors.push({
          base,
          accountCode: account.codigo,
          date,
          previousBalance: balances.saldoAnterior,
          currentBalance: balances.saldoAtual,
        });
        if (date === balanceDate) cutoffBalance = balances.saldoAtual;
      }
      if (cutoffBalance === null) {
        throw new Error(`Saldo de corte ausente para a conta ${account.codigo} de ${OMIE_BASE_NAMES[base]}.`);
      }
      accounts.push({ ...account, base, saldo: cutoffBalance });
    }
    for (const window of windows) {
      const omieFilters = { dataDe: toOmieDate(window.dataDe), dataAte: toOmieDate(window.dataAte) };
      const rawMovements = await listarTodosMovimentosFinanceiros(base, omieFilters, { signal });
      const mapped = rawMovements.map(movement => mapMovement(base, movement, loadedAt));
      titles.push(...mapped);
      for (const kind of ["receber", "pagar"] as const) {
        const rawTitles = await listarTodosTitulos(base, kind, omieFilters, { signal });
        for (const raw of rawTitles) {
          const planned = planTitle(base, kind, raw, balanceDate);
          if (planned.outcome === "planned") {
            plannedTitles.push(planned.title);
          } else if (planned.outcome === "unknown") {
            // Um mesmo título pode vir em mais de uma janela; conta uma vez só.
            excludedPlanned.set(`${base}:${kind}:${raw.codigo_lancamento_omie}`, {
              kind,
              status: planned.status,
              amount: planned.amount,
            });
          }
        }
      }
    }
  }
  const plannedWarning = describeExcludedPlannedTitles(excludedPlanned.values());
  if (plannedWarning) logger.warn({ excluded: excludedPlanned.size }, plannedWarning);
  return { titles, accounts, anchors, plannedTitles, plannedWarning, windows };
}

function accountToApi(row: FinancialAccountRow): PersistedFinancialAccount {
  if (row.base !== "education" && row.base !== "store") {
    throw new Error(`Base financeira persistida inválida: ${row.base}`);
  }
  return {
    base: row.base,
    codigo: row.code,
    descricao: row.description,
    excluida: row.excluded,
    tipo: row.type ?? undefined,
    banco: row.bank ?? undefined,
    ativa: row.active,
    agencia: row.branch ?? undefined,
    numeroConta: row.accountNumber ?? undefined,
    saldo: row.openingBalance,
    emiteBoleto: row.issuesInvoice,
  };
}

function mergeFinancialAnchors(
  saved: FinancialBalanceAnchor[],
  collected: FinancialBalanceAnchor[],
): FinancialBalanceAnchor[] {
  return [
    ...saved.filter(anchor => !collected.some(item =>
      item.base === anchor.base
      && item.accountCode === anchor.accountCode
      && item.date === anchor.date)),
    ...collected,
  ];
}

// Um snapshot cujas contas não têm todos os saldos de referência não consegue abrir os
// períodos antigos; é preferível manter os dados anteriores a publicá-lo.
function assertAnchorsCoverAccounts(
  accounts: PersistedFinancialAccount[],
  anchors: FinancialBalanceAnchor[],
): void {
  const present = new Set(anchors.map(anchor => `${anchor.base}:${anchor.accountCode}:${anchor.date}`));
  const dates = [...new Set(anchors.map(anchor => anchor.date))].sort();
  for (const account of accounts) {
    const missing = dates.find(date => !present.has(`${account.base}:${account.codigo}:${date}`));
    if (missing) {
      throw new Error(
        `Saldo de referência ausente para a conta ${account.base}:${account.codigo} em ${missing}.`,
      );
    }
  }
}

function parseFinancialBalanceAnchors(payload: unknown): FinancialBalanceAnchor[] {
  if (!payload || typeof payload !== "object" || !("anchors" in payload)) {
    throw new Error("Snapshot financeiro sem âncoras mensais.");
  }
  const anchors = (payload as { anchors?: unknown }).anchors;
  if (!Array.isArray(anchors)) throw new Error("Âncoras mensais inválidas no snapshot financeiro.");
  return anchors.map(anchor => {
    if (
      !anchor
      || typeof anchor !== "object"
      || ((anchor as { base?: unknown }).base !== "education"
        && (anchor as { base?: unknown }).base !== "store")
      || !Number.isSafeInteger((anchor as { accountCode?: unknown }).accountCode)
      || typeof (anchor as { date?: unknown }).date !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test((anchor as { date: string }).date)
      || typeof (anchor as { previousBalance?: unknown }).previousBalance !== "number"
      || !Number.isFinite((anchor as { previousBalance: number }).previousBalance)
      || typeof (anchor as { currentBalance?: unknown }).currentBalance !== "number"
      || !Number.isFinite((anchor as { currentBalance: number }).currentBalance)
    ) {
      throw new Error("Âncora mensal inválida no snapshot financeiro.");
    }
    return anchor as FinancialBalanceAnchor;
  });
}

function parsePersistedPlannedTitles(payload: unknown): PersistedPlannedTitle[] {
  if (!payload || typeof payload !== "object") throw new Error("Snapshot financeiro sem títulos planejados.");
  const values = (payload as { plannedTitles?: unknown }).plannedTitles;
  if (!Array.isArray(values)) throw new Error("Títulos planejados inválidos no snapshot financeiro.");
  return values.map(value => {
    if (!value || typeof value !== "object") throw new Error("Título planejado inválido no snapshot financeiro.");
    const item = value as Record<string, unknown>;
    if ((item.base !== "education" && item.base !== "store")
      || (item.kind !== "receber" && item.kind !== "pagar")
      || !Number.isSafeInteger(item.omieId) || (item.omieId as number) <= 0
      || !Number.isSafeInteger(item.accountCode) || (item.accountCode as number) <= 0
      || typeof item.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)
      || (item.status !== "A VENCER" && item.status !== "ATRASADO")
      || typeof item.amount !== "number" || !Number.isFinite(item.amount) || item.amount < 0) {
      throw new Error("Título planejado inválido no snapshot financeiro.");
    }
    return item as unknown as PersistedPlannedTitle;
  });
}

export async function listPersistedFinancialAccounts(
  base?: OmieBase,
): Promise<PersistedFinancialAccount[]> {
  const rows = await db
    .select()
    .from(financialAccountsTable)
    .where(base ? eq(financialAccountsTable.base, base) : undefined)
    .orderBy(asc(financialAccountsTable.description));
  return rows.map(accountToApi);
}

export function buildFinancialSummary(
  rows: FinancialTitleRow[],
  accounts: PersistedFinancialAccount[],
  filters: FinancialSnapshotFilters,
  balanceDate?: string,
  anchors?: FinancialBalanceAnchor[],
  plannedTitles: PersistedPlannedTitle[] = [],
): FinancialSummary {
  const explicitAccounts = filters.accountKeys?.length ? new Set(filters.accountKeys) : null;
  const excluded = new Set(
    accounts.filter(account => account.excluida).map(account => `${account.base}:${account.codigo}`),
  );
  type Reconciliation = {
    receita: number;
    despesa: number;
    ajustes: number;
    saldoInicial: number;
    saldoFinal: number;
    receitaPlanejada: number;
    despesaPlanejada: number;
  };
  const empty = (): Reconciliation => ({
    receita: 0, despesa: 0, ajustes: 0, saldoInicial: 0, saldoFinal: 0,
    receitaPlanejada: 0, despesaPlanejada: 0,
  });
  const selectedAccounts = accounts.filter(account => {
    const key = `${account.base}:${account.codigo}`;
    return (!filters.base || account.base === filters.base)
      && (!explicitAccounts || explicitAccounts.has(key))
      && (filters.excludeNonConsidered === false || !excluded.has(key));
  });
  const accountTotals = new Map<string, Reconciliation>(
    selectedAccounts.map(account => [`${account.base}:${account.codigo}`, {
      ...empty(),
      saldoFinal: account.saldo,
    }]),
  );
  const months = new Map<string, Reconciliation>();
  const requestedFrom = filters.dataDe ?? (balanceDate ? monthStart(balanceDate) : undefined);
  const requestedTo = filters.dataAte ?? balanceDate;

  for (const row of rows) {
    if (row.base !== "education" && row.base !== "store") continue;
    const accountKey = row.accountCode === null ? null : `${row.base}:${row.accountCode}`;
    if (explicitAccounts) {
      if (accountKey === null || !explicitAccounts.has(accountKey)) continue;
    }
    if (
      filters.excludeNonConsidered !== false
      && accountKey !== null
      && excluded.has(accountKey)
    ) {
      continue;
    }
    if (!accountKey || !row.referenceDate || !row.status) continue;
    const accountTotal = accountTotals.get(accountKey);
    if (!accountTotal) continue;
    const signedAmount = row.kind === "receber" ? row.amount : row.kind === "pagar" ? -row.amount : 0;
    if (balanceDate && row.referenceDate > (filters.dataAte ?? balanceDate) && row.referenceDate <= balanceDate) {
      accountTotal.saldoFinal -= signedAmount;
      continue;
    }
    if ((filters.dataDe && row.referenceDate < filters.dataDe)
      || (filters.dataAte && row.referenceDate > filters.dataAte)) continue;
    const month = row.referenceDate.slice(0, 7);
    const monthTotal = months.get(month) ?? empty();
    if (OPERATING_MOVEMENT_ORIGINS.has(row.status)) {
      if (row.kind === "receber") {
        accountTotal.receita += row.amount;
        monthTotal.receita += row.amount;
      } else {
        accountTotal.despesa += row.amount;
        monthTotal.despesa += row.amount;
      }
    } else {
      accountTotal.ajustes += signedAmount;
      monthTotal.ajustes += signedAmount;
    }
    months.set(month, monthTotal);
  }

  for (const title of plannedTitles) {
    const accountKey = `${title.base}:${title.accountCode}`;
    if (filters.base && title.base !== filters.base) continue;
    if (explicitAccounts && !explicitAccounts.has(accountKey)) continue;
    if (filters.excludeNonConsidered !== false && excluded.has(accountKey)) continue;
    if ((filters.dataDe && title.dueDate < filters.dataDe)
      || (filters.dataAte && title.dueDate > filters.dataAte)) continue;
    const accountTotal = accountTotals.get(accountKey);
    if (!accountTotal) continue;
    const month = title.dueDate.slice(0, 7);
    const monthTotal = months.get(month) ?? empty();
    if (title.kind === "receber") {
      accountTotal.receitaPlanejada += title.amount;
      monthTotal.receitaPlanejada += title.amount;
    } else {
      accountTotal.despesaPlanejada += title.amount;
      monthTotal.despesaPlanejada += title.amount;
    }
    months.set(month, monthTotal);
  }

  if (anchors?.length && requestedFrom && requestedTo) {
    const selectedKeys = new Set(accountTotals.keys());
    const anchorMap = new Map(
      anchors
        .filter(anchor => selectedKeys.has(`${anchor.base}:${anchor.accountCode}`))
        .map(anchor => [`${anchor.base}:${anchor.accountCode}:${anchor.date}`, anchor]),
    );
    const signedMovement = (row: FinancialTitleRow) =>
      row.kind === "receber" ? row.amount : row.kind === "pagar" ? -row.amount : 0;
    const balanceAtStart = (accountKey: string, date: string): number => {
      const exact = anchorMap.get(`${accountKey}:${date}`);
      if (exact) return exact.previousBalance;
      const anchor = anchors
        .filter(item => `${item.base}:${item.accountCode}` === accountKey && item.date < date)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!anchor) throw new Error(`Âncora anterior ausente para ${accountKey} em ${date}.`);
      return anchor.previousBalance + rows.reduce((sum, row) => {
        const key = row.accountCode === null ? null : `${row.base}:${row.accountCode}`;
        return key === accountKey && row.referenceDate && row.referenceDate >= anchor.date && row.referenceDate < date
          ? sum + signedMovement(row)
          : sum;
      }, 0);
    };
    const balanceAtEnd = (accountKey: string, date: string): number => {
      const exact = anchorMap.get(`${accountKey}:${date}`);
      if (exact && date === balanceDate) return exact.currentBalance;
      const nextStart = nextMonthStart(date);
      if (date === previousDay(nextStart)) {
        const nextAnchor = anchorMap.get(`${accountKey}:${nextStart}`);
        if (nextAnchor) return nextAnchor.previousBalance;
      }
      const anchor = anchors
        .filter(item => `${item.base}:${item.accountCode}` === accountKey && item.date <= date)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!anchor) throw new Error(`Âncora anterior ausente para ${accountKey} em ${date}.`);
      return anchor.previousBalance + rows.reduce((sum, row) => {
        const key = row.accountCode === null ? null : `${row.base}:${row.accountCode}`;
        return key === accountKey && row.referenceDate && row.referenceDate >= anchor.date && row.referenceDate <= date
          ? sum + signedMovement(row)
          : sum;
      }, 0);
    };

    for (const [accountKey, values] of accountTotals) {
      values.saldoInicial = balanceAtStart(accountKey, requestedFrom);
      values.saldoFinal = balanceAtEnd(accountKey, requestedTo);
      values.ajustes = values.saldoFinal - values.saldoInicial - (values.receita - values.despesa);
    }
    for (const month of monthKeysBetween(requestedFrom, requestedTo)) {
      const values = months.get(month) ?? empty();
      const from = requestedFrom > `${month}-01` ? requestedFrom : `${month}-01`;
      const monthEnd = previousDay(nextMonthStart(`${month}-01`));
      const to = requestedTo < monthEnd ? requestedTo : monthEnd;
      values.saldoInicial = [...selectedKeys].reduce(
        (sum, accountKey) => sum + balanceAtStart(accountKey, from),
        0,
      );
      values.saldoFinal = [...selectedKeys].reduce(
        (sum, accountKey) => sum + balanceAtEnd(accountKey, to),
        0,
      );
      values.ajustes = values.saldoFinal - values.saldoInicial - (values.receita - values.despesa);
      months.set(month, values);
    }
  } else {
    for (const values of accountTotals.values()) {
      values.saldoInicial = values.saldoFinal - (values.receita - values.despesa) - values.ajustes;
    }
  }
  const contas = selectedAccounts.map(account => {
    const values = accountTotals.get(`${account.base}:${account.codigo}`)!;
    return {
      base: account.base,
      codigo: account.codigo,
      nome: account.descricao,
      tipo: account.tipo ?? null,
      ...values,
      resultado: values.receita - values.despesa,
      resultadoPlanejado: values.receitaPlanejada - values.despesaPlanejada,
    };
  });
  const porBase = BASES
    .filter(base => !filters.base || filters.base === base)
    .map(base => {
      const baseAccounts = contas.filter(account => account.base === base);
      const values = baseAccounts.reduce((sum, account) => ({
        receita: sum.receita + account.receita,
        despesa: sum.despesa + account.despesa,
        receitaPlanejada: sum.receitaPlanejada + account.receitaPlanejada,
        despesaPlanejada: sum.despesaPlanejada + account.despesaPlanejada,
        ajustes: sum.ajustes + account.ajustes,
        saldoInicial: sum.saldoInicial + account.saldoInicial,
        saldoFinal: sum.saldoFinal + account.saldoFinal,
      }), empty());
      return {
        base,
        nome: OMIE_BASE_NAMES[base],
        ...values,
        resultado: values.receita - values.despesa,
        resultadoPlanejado: values.receitaPlanejada - values.despesaPlanejada,
      };
    });
  const receitaTotal = porBase.reduce((sum, item) => sum + item.receita, 0);
  const despesaTotal = porBase.reduce((sum, item) => sum + item.despesa, 0);
  const receitaPlanejadaTotal = porBase.reduce((sum, item) => sum + item.receitaPlanejada, 0);
  const despesaPlanejadaTotal = porBase.reduce((sum, item) => sum + item.despesaPlanejada, 0);
  const saldoInicial = porBase.reduce((sum, item) => sum + item.saldoInicial, 0);
  const ajustes = porBase.reduce((sum, item) => sum + item.ajustes, 0);
  const saldoFinal = porBase.reduce((sum, item) => sum + item.saldoFinal, 0);
  let runningBalance = saldoInicial;
  const monthly = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mes, values]) => {
    const resultado = values.receita - values.despesa;
    if (!anchors?.length) {
      const monthOpening = runningBalance;
      runningBalance += resultado + values.ajustes;
      return {
        mes,
        ...values,
        resultado,
        resultadoPlanejado: values.receitaPlanejada - values.despesaPlanejada,
        saldoInicial: monthOpening,
        saldoFinal: runningBalance,
      };
    }
    return {
      mes,
      ...values,
      resultado,
      resultadoPlanejado: values.receitaPlanejada - values.despesaPlanejada,
    };
  });
  return {
    receitaTotal,
    despesaTotal,
    resultado: receitaTotal - despesaTotal,
    receitaPlanejadaTotal,
    despesaPlanejadaTotal,
    resultadoPlanejado: receitaPlanejadaTotal - despesaPlanejadaTotal,
    saldoInicial,
    ajustes,
    saldoFinal,
    porBase,
    meses: monthly,
    contas,
  };
}

export async function getFinancialSnapshot(
  input: FinancialSnapshotFilters,
): Promise<FinancialSnapshotState> {
  const filters = normalizeFinancialFilters(input);
  return db.transaction(async tx => {
  const [row] = await tx
    .select()
    .from(financialSnapshotsTable)
    .where(eq(financialSnapshotsTable.key, SNAPSHOT_KEY))
    .limit(1);
  const leaseExpired = row?.status === "refreshing"
    && row.leaseUntil !== null
    && row.leaseUntil.getTime() <= Date.now();
  const state = row ? {
    status: leaseExpired ? "error" as const : row.status as FinancialSnapshotState["status"],
    schemaVersion: row.schemaVersion,
    collectedAt: row.collectedAt,
    lastAttemptedAt: row.lastAttemptedAt,
    lastError: leaseExpired
      ? "A atualização anterior foi interrompida. Os dados anteriores foram mantidos."
      : row.lastError,
  } : {
    status: "empty" as const,
    schemaVersion: SCHEMA_VERSION,
    collectedAt: null,
    lastAttemptedAt: null,
    lastError: null,
  };
  if (!state.collectedAt) {
    return {
      status: state.status,
      schemaVersion: state.schemaVersion,
      data: null,
      collectedAt: null,
      lastAttemptedAt: state.lastAttemptedAt?.toISOString() ?? null,
      lastError: state.lastError,
      availableFrom: null,
      availableTo: null,
    };
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return {
      status: state.status === "refreshing" ? "refreshing" : "error",
      schemaVersion: state.schemaVersion,
      data: null,
      collectedAt: state.collectedAt.toISOString(),
      lastAttemptedAt: state.lastAttemptedAt?.toISOString() ?? null,
      lastError: "Os dados financeiros salvos usam um formato antigo. Clique em Atualizar.",
      availableFrom: null,
      availableTo: null,
    };
  }
  const storedWindow = row?.filters as { dataDe?: unknown; dataAte?: unknown } | null;
  const storedFrom = typeof storedWindow?.dataDe === "string" ? storedWindow.dataDe : null;
  const storedTo = typeof storedWindow?.dataAte === "string" ? storedWindow.dataAte : null;
  if (!storedFrom || !storedTo) {
    return {
      status: "ready",
      schemaVersion: state.schemaVersion,
      data: null,
      collectedAt: state.collectedAt.toISOString(),
      lastAttemptedAt: state.lastAttemptedAt?.toISOString() ?? null,
      lastError: `Os dados salvos cobrem somente ${storedFrom ?? "?"} a ${storedTo ?? "?"}.`,
      availableFrom: storedFrom,
      availableTo: storedTo,
    };
  }
  const effectiveWindow = effectiveFinancialWindow(filters, {
    dataDe: storedFrom,
    dataAte: storedTo,
  });

  const conditions = [];
  if (filters.base) conditions.push(eq(financialTitlesTable.base, filters.base));
  if (filters.accountKeys?.length) {
    const accountConditions = filters.accountKeys.map(key => {
      const [base, code] = key.split(":");
      return and(
        eq(financialTitlesTable.base, base),
        eq(financialTitlesTable.accountCode, Number(code)),
      );
    });
    conditions.push(or(...accountConditions)!);
  }
  const [titles, accounts] = await Promise.all([
    tx.select().from(financialTitlesTable).where(conditions.length ? and(...conditions) : undefined),
    tx.select().from(financialAccountsTable)
      .where(filters.base ? eq(financialAccountsTable.base, filters.base) : undefined)
      .orderBy(asc(financialAccountsTable.description))
      .then(rows => rows.map(accountToApi)),
  ]);
  const effectiveFilters: FinancialSnapshotFilters = {
    ...filters,
    dataDe: effectiveWindow.dataDe,
    dataAte: effectiveWindow.dataAte,
  };
  const anchors = parseFinancialBalanceAnchors(row?.payload);
  const plannedTitles = parsePersistedPlannedTitles(row?.payload);
  const data = buildFinancialSummary(titles, accounts, effectiveFilters, storedTo, anchors, plannedTitles);
  const lastError = effectiveWindow.adjusted
    ? [
        state.lastError,
        `Exibindo os dados disponíveis de ${effectiveWindow.dataDe} a ${effectiveWindow.dataAte}; o período solicitado não está totalmente salvo.`,
      ].filter(Boolean).join(" ")
    : state.lastError;
  if (!GetOmieResumoFinanceiroResponse.safeParse({
    status: state.status,
    schemaVersion: state.schemaVersion,
    data,
    collectedAt: state.collectedAt.toISOString(),
    lastAttemptedAt: state.lastAttemptedAt?.toISOString() ?? null,
    lastError,
    availableFrom: storedFrom,
    availableTo: storedTo,
  }).success) {
    throw new Error("Persisted financial data produced an invalid API response.");
  }
  return {
    status: state.status,
    schemaVersion: SCHEMA_VERSION,
    data,
    collectedAt: state.collectedAt.toISOString(),
    lastAttemptedAt: state.lastAttemptedAt?.toISOString() ?? null,
    lastError,
    availableFrom: storedFrom,
    availableTo: storedTo,
  };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function refreshFinancialSnapshot(
  filters: FinancialSnapshotFilters,
  options?: { referenceDate?: Date },
): Promise<FinancialSnapshotState> {
  if (activeRefresh) {
    await activeRefresh;
    return getFinancialSnapshot(filters);
  }
  activeRefresh = (async () => {
    const attemptedAt = new Date();
    const owner = randomUUID();
    await db.insert(financialSnapshotsTable).values({
      key: SNAPSHOT_KEY,
      filters: {},
      schemaVersion: SCHEMA_VERSION,
      status: "empty",
    }).onConflictDoNothing();
    const [claimed] = await db.update(financialSnapshotsTable).set({
      status: "refreshing",
      lastAttemptedAt: attemptedAt,
      lastError: null,
      leaseOwner: owner,
      leaseUntil: new Date(attemptedAt.getTime() + LEASE_MS),
      updatedAt: attemptedAt,
    }).where(and(
      eq(financialSnapshotsTable.key, SNAPSHOT_KEY),
      or(isNull(financialSnapshotsTable.leaseUntil), lt(financialSnapshotsTable.leaseUntil, attemptedAt)),
    )).returning({ key: financialSnapshotsTable.key });
    if (!claimed) return;

    const heartbeat = setInterval(() => {
      void db.update(financialSnapshotsTable).set({
        leaseUntil: new Date(Date.now() + LEASE_MS),
        updatedAt: new Date(),
      }).where(and(
        eq(financialSnapshotsTable.key, SNAPSHOT_KEY),
        eq(financialSnapshotsTable.leaseOwner, owner),
      )).catch(error => logger.error({ err: error }, "financial ledger lease renewal failed"));
    }, Math.floor(LEASE_MS / 3));
    heartbeat.unref?.();

    try {
      const referenceDate = options?.referenceDate ?? new Date();
      const rolling = rollingNinetyDayWindow(referenceDate);
      const [persisted] = await db.select().from(financialSnapshotsTable)
        .where(eq(financialSnapshotsTable.key, SNAPSHOT_KEY)).limit(1);
      const persistedWindow = persisted?.schemaVersion === SCHEMA_VERSION
        && persisted.filters && typeof persisted.filters === "object"
        && typeof (persisted.filters as { dataDe?: unknown }).dataDe === "string"
        && typeof (persisted.filters as { dataAte?: unknown }).dataAte === "string"
        ? persisted.filters as { dataDe: string; dataAte: string }
        : undefined;
      const requested = {
        dataDe: filters.dataDe && filters.dataDe < rolling.dataDe ? filters.dataDe : rolling.dataDe,
        dataAte: filters.dataAte && filters.dataAte > rolling.dataAte ? filters.dataAte : rolling.dataAte,
      };
      const collectionWindows = mergeFinancialWindows([
        ...missingFinancialWindows(requested, persistedWindow),
        rolling,
      ]);
      const chunkedWindows = splitFinancialWindows(collectionWindows);
      const savedAnchors = persistedWindow ? parseFinancialBalanceAnchors(persisted?.payload) : [];
      const candidate = await collectCandidate(
        chunkedWindows,
        referenceDate.toISOString().slice(0, 10),
        savedAnchors,
      );
      const publishedAnchors = mergeFinancialAnchors(savedAnchors, candidate.anchors);
      assertAnchorsCoverAccounts(candidate.accounts, publishedAnchors);
      const nextWindow = {
        dataDe: persistedWindow && persistedWindow.dataDe < requested.dataDe ? persistedWindow.dataDe : requested.dataDe,
        dataAte: persistedWindow && persistedWindow.dataAte > requested.dataAte ? persistedWindow.dataAte : requested.dataAte,
      };
      const collectedAt = new Date();
      await db.transaction(async tx => {
        const leaseRows = await tx.execute(sql`
          SELECT lease_owner, lease_until
          FROM financial_snapshots
          WHERE key = ${SNAPSHOT_KEY}
          FOR UPDATE
        `);
        const lease = leaseRows.rows[0] as { lease_owner?: string; lease_until?: Date | string } | undefined;
        const leaseUntil = lease?.lease_until ? new Date(lease.lease_until) : null;
        if (lease?.lease_owner !== owner || !leaseUntil || leaseUntil.getTime() <= Date.now()) {
          throw new Error("A posse da atualização financeira expirou antes da publicação.");
        }
        for (const window of candidate.windows) {
          await tx.delete(financialTitlesTable).where(and(
            gte(financialTitlesTable.referenceDate, window.dataDe),
            lte(financialTitlesTable.referenceDate, window.dataAte),
          ));
        }
        for (let index = 0; index < candidate.titles.length; index += 500) {
          await tx.insert(financialTitlesTable).values(candidate.titles.slice(index, index + 500))
            .onConflictDoUpdate({
              target: [
                financialTitlesTable.base,
                financialTitlesTable.kind,
                financialTitlesTable.omieId,
              ],
              set: {
                accountCode: sql`excluded.account_code`,
                issueDate: sql`excluded.issue_date`,
                dueDate: sql`excluded.due_date`,
                referenceDate: sql`excluded.reference_date`,
                amount: sql`excluded.amount`,
                status: sql`excluded.status`,
                loadedAt: sql`excluded.loaded_at`,
              },
            });
        }
        await tx.delete(financialAccountsTable);
        if (candidate.accounts.length) {
          await tx.insert(financialAccountsTable).values(candidate.accounts.map(account => ({
            base: account.base,
            code: account.codigo,
            description: account.descricao,
            excluded: account.excluida,
            type: account.tipo ?? null,
            bank: account.banco ?? null,
            active: account.ativa,
            branch: account.agencia ?? null,
            accountNumber: account.numeroConta ?? null,
            openingBalance: account.saldo,
            issuesInvoice: account.emiteBoleto,
            loadedAt: collectedAt,
          })));
        }
        await tx.update(financialSnapshotsTable).set({
          schemaVersion: SCHEMA_VERSION,
          filters: nextWindow,
          payload: {
            anchors: publishedAnchors,
            plannedTitles: mergePersistedPlannedTitles(
              persistedWindow ? parsePersistedPlannedTitles(persisted?.payload) : [],
              candidate.plannedTitles,
              candidate.windows,
            ),
          },
          status: "ready",
          collectedAt,
          lastAttemptedAt: attemptedAt,
          lastError: candidate.plannedWarning,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: collectedAt,
        }).where(and(
          eq(financialSnapshotsTable.key, SNAPSHOT_KEY),
          eq(financialSnapshotsTable.leaseOwner, owner),
        ));
      });
    } catch (error) {
       logger.error({ err: error }, "financial incremental load failed");
      await db.update(financialSnapshotsTable).set({
        status: "error",
        lastError: "Não foi possível atualizar a Visão Financeira. Os dados anteriores foram mantidos.",
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      }).where(and(
        eq(financialSnapshotsTable.key, SNAPSHOT_KEY),
        eq(financialSnapshotsTable.leaseOwner, owner),
      ));
    } finally {
      clearInterval(heartbeat);
    }
  })();
  try {
    await activeRefresh;
    return await getFinancialSnapshot(filters);
  } finally {
    activeRefresh = null;
  }
}