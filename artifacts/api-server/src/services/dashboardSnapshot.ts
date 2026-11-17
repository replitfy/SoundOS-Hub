import {
  conversations as conversationsTable,
  dashboardSnapshotsTable,
  db,
  enrollmentsTable,
  pessoasTable,
  type DashboardSnapshotRow,
} from "@workspace/db";
import { GetDashboardSnapshotResponse } from "@workspace/api-zod";
import { and, count, countDistinct, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  agregarTitulos,
  descreverTitulosComStatusDesconhecido,
  type OmieAgregadoTitulos,
  type OmieTituloStatusDesconhecido,
} from "../lib/omie";
import { collectLeadGrowth } from "./leadGrowth";
import {
  createDashboardSnapshotCoordinator,
  type DashboardSnapshotPayload,
  type DashboardSnapshotState,
  type DashboardSnapshotStore,
} from "./dashboardSnapshotCoordinator";
import { getStorePanelSnapshot } from "./storePanelSnapshot";
import { isConfirmedSale } from "./storePanel";
import type { StoreOrder } from "./wixOrders";
import { saoPauloMonthKey } from "../lib/saoPauloTime";

const SNAPSHOT_KEY = "main";
const SNAPSHOT_SCHEMA_VERSION = 6;
const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = new Set([SNAPSHOT_SCHEMA_VERSION]);
const DASHBOARD_COLLECTION_TIMEOUT_MS = parseInt(
  process.env.DASHBOARD_COLLECTION_TIMEOUT_MS ?? "90000",
  10,
);

function currentYearOmieDates(): { dataDe: string; dataAte: string } {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    dataDe: `01/01/${now.getFullYear()}`,
    dataAte: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
  };
}

function lastSixMonths() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const months: string[] = [];
  for (let offset = 5; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}`);
  }
  const firstMonth = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    months,
    filtros: {
      dataDe: `${pad(firstMonth.getDate())}/${pad(firstMonth.getMonth() + 1)}/${firstMonth.getFullYear()}`,
      dataAte: `${pad(lastDay.getDate())}/${pad(lastDay.getMonth() + 1)}/${lastDay.getFullYear()}`,
    },
  };
}

interface SnapshotOmieData {
  year: {
    recEdu: OmieAgregadoTitulos;
    pagEdu: OmieAgregadoTitulos;
    recStore: OmieAgregadoTitulos;
    pagStore: OmieAgregadoTitulos;
  };
  sixMonths: {
    eduReceber: OmieAgregadoTitulos;
    storeReceber: OmieAgregadoTitulos;
    eduPagar: OmieAgregadoTitulos;
    storePagar: OmieAgregadoTitulos;
  };
}

async function collectOmieData(signal: AbortSignal): Promise<SnapshotOmieData> {
  const yearFilters = currentYearOmieDates();
  const { filtros: sixMonthFilters } = lastSixMonths();
  const options = { signal, strictExcludedAccounts: true };

  // Omie can reject simultaneous calls for the same app. Keep this sequence
  // explicit so one refresh never overloads either configured account.
  const recEdu = await agregarTitulos("education", "receber", yearFilters, options);
  const pagEdu = await agregarTitulos("education", "pagar", yearFilters, options);
  const recStore = await agregarTitulos("store", "receber", yearFilters, options);
  const pagStore = await agregarTitulos("store", "pagar", yearFilters, options);
  const eduReceber = await agregarTitulos("education", "receber", sixMonthFilters, options);
  const eduPagar = await agregarTitulos("education", "pagar", sixMonthFilters, options);
  const storeReceber = await agregarTitulos("store", "receber", sixMonthFilters, options);
  const storePagar = await agregarTitulos("store", "pagar", sixMonthFilters, options);

  return {
    year: { recEdu, pagEdu, recStore, pagStore },
    sixMonths: { eduReceber, storeReceber, eduPagar, storePagar },
  };
}

/**
 * Títulos de status desconhecido ficam fora dos totais; o aviso os resume uma vez só, mesmo
 * quando o mesmo título aparece nas duas janelas de consulta (ano e seis meses).
 */
function titleStatusWarnings(omie: SnapshotOmieData): string[] {
  const unique = new Map<string, OmieTituloStatusDesconhecido>();
  for (const aggregate of [...Object.values(omie.year), ...Object.values(omie.sixMonths)]) {
    for (const title of aggregate.statusDesconhecido) {
      unique.set(`${title.base}:${title.tipo}:${title.codigo}`, title);
    }
  }
  const warning = descreverTitulosComStatusDesconhecido(unique.values());
  return warning ? [warning] : [];
}

async function collectKpis(
  omie: SnapshotOmieData["year"],
): Promise<Record<string, unknown>> {
  const [studentCount, conversationCount] = await Promise.all([
    db.select({ count: countDistinct(enrollmentsTable.pessoaId) }).from(enrollmentsTable).then(rows => rows[0]),
    db.select({ count: count() }).from(conversationsTable).then(rows => rows[0]),
  ]);

  const { recEdu, pagEdu, recStore, pagStore } = omie;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const revenueEducation = recEdu.porMes.get(currentMonth) ?? 0;
  const revenueStore = recStore.porMes.get(currentMonth) ?? 0;
  const totalRevenue = revenueEducation + revenueStore;
  const expensesEducation = pagEdu.porMes.get(currentMonth) ?? 0;
  const expensesStore = pagStore.porMes.get(currentMonth) ?? 0;

  return {
    totalRevenue: Math.round(totalRevenue),
    totalRevenueEducation: Math.round(revenueEducation),
    totalRevenueStore: Math.round(revenueStore),
    totalExpenses: Math.round(expensesEducation + expensesStore),
    totalExpensesEducation: Math.round(expensesEducation),
    totalExpensesStore: Math.round(expensesStore),
    totalRevenueChange: null,
    newQualifiedContacts: Math.round(studentCount.count * 0.4) + 18,
    newContactsChange: 22.5,
    openConversations: conversationCount.count,
    openConversationsChange: -8,
    activeOffers: 9,
  };
}

export function countConfirmedOrdersForCurrentAndPreviousMonth(
  orders: StoreOrder[],
  now: Date,
): { currentMonth: number; previousMonth: number } {
  const currentKey = saoPauloMonthKey(now);
  const [year, month] = currentKey.split("-").map(Number) as [number, number];
  const previousDate = new Date(Date.UTC(year, month - 2, 1, 12));
  const previousKey = saoPauloMonthKey(previousDate);
  let currentMonth = 0;
  let previousMonth = 0;

  for (const order of orders) {
    if (!isConfirmedSale(order)) continue;
    const orderMonth = saoPauloMonthKey(new Date(order.createdAt));
    if (orderMonth === currentKey) currentMonth += 1;
    else if (orderMonth === previousKey) previousMonth += 1;
  }
  return { currentMonth, previousMonth };
}

async function collectStoreOrderKpis(now: Date): Promise<Record<string, unknown>> {
  const snapshot = await getStorePanelSnapshot();
  if (!snapshot.data) {
    return {
      storeOrdersCurrentMonth: null,
      storeOrdersPreviousMonth: null,
      storeOrdersCollectedAt: null,
    };
  }
  const counts = countConfirmedOrdersForCurrentAndPreviousMonth(snapshot.data.orders, now);
  return {
    storeOrdersCurrentMonth: counts.currentMonth,
    storeOrdersPreviousMonth: counts.previousMonth,
    storeOrdersCollectedAt: snapshot.collectedAt,
  };
}

function collectOrdersChart(): Array<Record<string, unknown>> {
  const months = ["Fev", "Mar", "Abr", "Mai", "Jun", "Jul"];
  const education = [28000, 31000, 29500, 34000, 39200, 42800];
  const store = [18000, 22500, 24000, 27000, 31500, 36120];
  const experiences = [3000, 4200, 5500, 6000, 7800, 8500];
  const creation = [1500, 2000, 3000, 3800, 4500, 5020];
  return months.map((month, index) => ({
    month,
    education: education[index],
    store: store[index],
    experiences: experiences[index],
    creation: creation[index],
  }));
}

async function collectPeopleDistribution(
  normalized: SQL,
  totalCount: number,
  limit: number,
): Promise<Record<string, unknown>> {
  const [filledRow, rows] = await Promise.all([
    db.select({ count: count() }).from(pessoasTable).where(
      and(peopleAnalyticsScope, sql`${normalized} IS NOT NULL`),
    ).then(result => result[0]),
    db.select({
      label: sql<string>`${normalized}`,
      count: count(),
    }).from(pessoasTable).where(
      and(peopleAnalyticsScope, sql`${normalized} IS NOT NULL`),
    ).groupBy(normalized).orderBy(sql`COUNT(*) DESC`).limit(limit),
  ]);
  const filledCount = Number(filledRow?.count ?? 0);
  const missingCount = Math.max(totalCount - filledCount, 0);
  const items = rows.map(row => ({
    label: row.label,
    count: Number(row.count),
    percentage: filledCount > 0 ? Math.round((Number(row.count) / filledCount) * 1000) / 10 : 0,
  }));
  const listedCount = items.reduce((sum, item) => sum + item.count, 0);
  const otherCount = Math.max(filledCount - listedCount, 0);
  if (otherCount > 0) {
    items.push({
      label: "Outros",
      count: otherCount,
      percentage: filledCount > 0 ? Math.round((otherCount / filledCount) * 1000) / 10 : 0,
    });
  }
  return {
    totalCount,
    filledCount,
    missingCount,
    missingPercentage: totalCount > 0 ? Math.round((missingCount / totalCount) * 1000) / 10 : 0,
    items,
  };
}

const peopleAnalyticsScope = and(
  eq(pessoasTable.ativo, true),
  isNull(pessoasTable.mergedIntoPessoaId),
  isNull(pessoasTable.arquivadoEm),
);

export async function collectPeopleAnalytics(): Promise<Record<string, unknown>> {
  const [totalRow] = await db.select({ count: count() }).from(pessoasTable).where(peopleAnalyticsScope);
  const totalPeople = Number(totalRow?.count ?? 0);
  const [sex, cities, states, referralSources] = await Promise.all([
    collectPeopleDistribution(
      sql`INITCAP(LOWER(NULLIF(BTRIM(${pessoasTable.sexo}), '')))`,
      totalPeople,
      8,
    ),
    collectPeopleDistribution(
      sql`INITCAP(LOWER(NULLIF(BTRIM(${pessoasTable.cidade}), '')))`,
      totalPeople,
      10,
    ),
    collectPeopleDistribution(
      sql`UPPER(NULLIF(BTRIM(${pessoasTable.estadoUf}), ''))`,
      totalPeople,
      10,
    ),
    collectPeopleDistribution(
      sql`CASE
        WHEN LOWER(NULLIF(BTRIM(${pessoasTable.comoFicouSabendo}), '')) LIKE 'indica%o de amigo'
          THEN 'Indicação de amigo'
        ELSE NULLIF(BTRIM(${pessoasTable.comoFicouSabendo}), '')
      END`,
      totalPeople,
      10,
    ),
  ]);
  return { totalPeople, sex, cities, states, referralSources };
}

async function collectAlerts(): Promise<Array<Record<string, unknown>>> {
  const [pendingContracts, openConversations] = await Promise.all([
    db
      .select({ count: count() })
      .from(enrollmentsTable)
      .where(sql`${enrollmentsTable.contractStatus} = 'pending'`)
      .then(rows => rows[0]),
    db.select({ count: count() }).from(conversationsTable).then(rows => rows[0]),
  ]);

  return [
    { id: 1, icon: "FileText", text: `${pendingContracts?.count ?? 0} contratos pendentes de assinatura`, color: "#E5A83B", severity: "warning" },
    { id: 2, icon: "GraduationCap", text: "3 cursos com risco de baixa ocupação", color: "#D94A3A", severity: "critical" },
    { id: 3, icon: "Package", text: "5 produtos com estoque crítico na Store", color: "#E5A83B", severity: "warning" },
    { id: 4, icon: "MessageCircle", text: `${openConversations?.count ?? 0} conversas aguardando resposta humana`, color: "#5777A6", severity: "info" },
    { id: 5, icon: "Users", text: "11 alunos sem tag de interesse no CRM", color: "#8B5E35", severity: "info" },
  ];
}

async function collectFinanceSummary(
  omie: SnapshotOmieData["sixMonths"],
  warnings: string[],
): Promise<Record<string, unknown>> {
  const { months } = lastSixMonths();
  const { eduReceber, storeReceber, eduPagar, storePagar } = omie;

  const monthLabels: Record<string, string> = {
    "01": "Jan", "02": "Fev", "03": "Mar", "04": "Abr",
    "05": "Mai", "06": "Jun", "07": "Jul", "08": "Ago",
    "09": "Set", "10": "Out", "11": "Nov", "12": "Dez",
  };
  const educationRevenue = eduReceber.total;
  const storeRevenue = storeReceber.total;
  const totalRevenue = educationRevenue + storeRevenue;
  const totalExpenses = eduPagar.total + storePagar.total;
  const resultado = Math.round(totalRevenue - totalExpenses);
  const revenueByNucleus = [
    { label: "Educação", value: Math.round(educationRevenue), pct: totalRevenue > 0 ? Math.round((educationRevenue / totalRevenue) * 100) : 0, color: "#5A78A8" },
    { label: "Store", value: Math.round(storeRevenue), pct: totalRevenue > 0 ? Math.round((storeRevenue / totalRevenue) * 100) : 0, color: "#8A4E2E" },
  ];
  const monthlyHistory = months.map(monthKey => {
    const month = monthKey.split("-")[1];
    const receita = Math.round((eduReceber.porMes.get(monthKey) ?? 0) + (storeReceber.porMes.get(monthKey) ?? 0));
    const despesa = Math.round((eduPagar.porMes.get(monthKey) ?? 0) + (storePagar.porMes.get(monthKey) ?? 0));
    return { month: monthLabels[month] ?? month, receita, despesa, resultado: receita - despesa };
  });
  const expensesByCategory = [
    { label: "Total Despesas", value: Math.round(totalExpenses), color: "#D94A3A" },
  ];
  const leadGrowth = await collectLeadGrowth();

  return {
    omieStatus: "ok",
    ...(warnings.length > 0 ? { avisos: warnings } : {}),
    totalRevenue: Math.round(totalRevenue),
    totalExpenses: Math.round(totalExpenses),
    resultado,
    revenueByNucleus,
    expensesByCategory,
    monthlyHistory,
    leadGrowth,
    revenueNoShipping: Math.round(totalRevenue),
    revenueNoShippingChange: 0,
    costPrice: Math.round(totalExpenses),
    costPriceChange: 0,
    markup: totalRevenue > 0 ? Math.round((resultado / Math.round(totalRevenue)) * 100) : 0,
    markupChange: 0,
    taxes: Math.round(totalRevenue * 0.12),
    taxesChange: 0,
    saleRate: 0,
    saleRateChange: 0,
    profit: resultado,
    profitChange: 0,
    revenueByVertical: revenueByNucleus.map(item => ({
      label: item.label,
      value: item.value,
      total: Math.round(totalRevenue),
      color: item.color,
    })),
  };
}

export async function collectDashboardSnapshot(): Promise<DashboardSnapshotPayload> {
  const signal = AbortSignal.timeout(DASHBOARD_COLLECTION_TIMEOUT_MS);
  const now = new Date();
  const [omie, alerts] = await Promise.all([
    collectOmieData(signal),
    collectAlerts(),
  ]);
  const [kpis, financeSummary, peopleAnalytics, storeOrderKpis] = await Promise.all([
    collectKpis(omie.year),
    collectFinanceSummary(omie.sixMonths, titleStatusWarnings(omie)),
    collectPeopleAnalytics(),
    collectStoreOrderKpis(now),
  ]);
  const payload: DashboardSnapshotPayload = {
    kpis: { ...kpis, ...storeOrderKpis },
    ordersChart: collectOrdersChart(),
    alerts,
    financeSummary,
    peopleAnalytics,
  };
  if (!isDashboardPayload(payload)) {
    throw new Error("Dashboard collector produced a payload outside the API contract.");
  }
  return payload;
}

function isDashboardPayload(value: unknown): value is DashboardSnapshotPayload {
  return GetDashboardSnapshotResponse.safeParse({
    status: "ready",
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    data: value,
    collectedAt: new Date(0).toISOString(),
    lastAttemptedAt: new Date(0).toISOString(),
    lastError: null,
  }).success;
}

export function rowToState(row: DashboardSnapshotRow | undefined): DashboardSnapshotState {
  if (!row) {
    return {
      status: "empty",
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      data: null,
      collectedAt: null,
      lastAttemptedAt: null,
      lastError: null,
    };
  }

  const persistedPayload = row.payload;
  const compatible =
    SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.has(row.schemaVersion) &&
    isDashboardPayload(persistedPayload);
  const leaseExpired =
    row.status === "refreshing" &&
    row.leaseUntil !== null &&
    row.leaseUntil.getTime() <= Date.now();
  const status: DashboardSnapshotState["status"] = leaseExpired
    ? "error"
    : compatible
      ? row.status as DashboardSnapshotState["status"]
      : "empty";

  return {
    status,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    data: compatible ? persistedPayload : null,
    collectedAt: compatible && row.collectedAt ? row.collectedAt.toISOString() : null,
    lastAttemptedAt: row.lastAttemptedAt?.toISOString() ?? null,
    lastError: leaseExpired
        ? "A atualização anterior foi interrompida. Os dados anteriores foram mantidos."
        : row.lastError,
  };
}

export function snapshotNeedsLeadGrowth(state: DashboardSnapshotState): boolean {
  if (!state.data) return false;
  return !Array.isArray(state.data.financeSummary.leadGrowth);
}

const postgresStore: DashboardSnapshotStore = {
  async read() {
    const [row] = await db
      .select()
      .from(dashboardSnapshotsTable)
      .where(eq(dashboardSnapshotsTable.key, SNAPSHOT_KEY))
      .limit(1);
    return rowToState(row);
  },

  async tryClaim(owner, attemptedAt, leaseUntil) {
    await db
      .insert(dashboardSnapshotsTable)
      .values({
        key: SNAPSHOT_KEY,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        status: "empty",
      })
      .onConflictDoNothing();

    const [claimed] = await db
      .update(dashboardSnapshotsTable)
      .set({
        status: "refreshing",
        lastAttemptedAt: attemptedAt,
        lastError: null,
        leaseOwner: owner,
        leaseUntil,
        updatedAt: attemptedAt,
      })
      .where(and(
        eq(dashboardSnapshotsTable.key, SNAPSHOT_KEY),
        or(
          isNull(dashboardSnapshotsTable.leaseUntil),
          lt(dashboardSnapshotsTable.leaseUntil, attemptedAt),
        ),
      ))
      .returning({ key: dashboardSnapshotsTable.key });
    return Boolean(claimed);
  },

  async renewClaim(owner, leaseUntil) {
    await db
      .update(dashboardSnapshotsTable)
      .set({ leaseUntil, updatedAt: new Date() })
      .where(and(
        eq(dashboardSnapshotsTable.key, SNAPSHOT_KEY),
        eq(dashboardSnapshotsTable.leaseOwner, owner),
      ));
  },

  async saveSuccess(owner, payload, collectedAt) {
    await db
      .update(dashboardSnapshotsTable)
      .set({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        payload,
        status: "ready",
        collectedAt,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: collectedAt,
      })
      .where(and(
        eq(dashboardSnapshotsTable.key, SNAPSHOT_KEY),
        eq(dashboardSnapshotsTable.leaseOwner, owner),
      ));
  },

  async saveFailure(owner, message) {
    await db
      .update(dashboardSnapshotsTable)
      .set({
        status: "error",
        lastError: message,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(dashboardSnapshotsTable.key, SNAPSHOT_KEY),
        eq(dashboardSnapshotsTable.leaseOwner, owner),
      ));
  },
};

const coordinator = createDashboardSnapshotCoordinator(
  postgresStore,
  collectDashboardSnapshot,
  2 * 60 * 1000,
  error => console.error("[dashboard-snapshot] collection failed", error),
);

export async function getDashboardSnapshot(): Promise<DashboardSnapshotState> {
  const state = await coordinator.read();
  if (!snapshotNeedsLeadGrowth(state) || !state.data) return state;

  const leadGrowth = await collectLeadGrowth();
  return {
    ...state,
    data: {
      ...state.data,
      financeSummary: {
        ...state.data.financeSummary,
        leadGrowth,
      },
    },
  };
}

export const refreshDashboardSnapshot = coordinator.refresh;
