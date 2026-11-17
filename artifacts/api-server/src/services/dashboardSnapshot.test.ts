import { describe, expect, it } from "vitest";
import type { DashboardSnapshotRow } from "@workspace/db";
import {
  countConfirmedOrdersForCurrentAndPreviousMonth,
  rowToState,
  snapshotNeedsLeadGrowth,
} from "./dashboardSnapshot";

const legacyPayload = {
  kpis: {
    totalRevenue: 100,
    totalRevenueEducation: 60,
    totalRevenueStore: 40,
    totalExpenses: 25,
    totalExpensesEducation: 15,
    totalExpensesStore: 10,
    totalRevenueChange: null,
    newQualifiedContacts: 4,
    newContactsChange: 10,
    openConversations: 2,
    openConversationsChange: -5,
    activeOffers: 1,
    storeOrdersCurrentMonth: 2,
    storeOrdersPreviousMonth: 1,
    storeOrdersCollectedAt: "2025-01-15T10:00:00.000Z",
  },
  ordersChart: [{
    month: "Jan",
    education: 10,
    store: 20,
    experiences: 3,
    creation: 2,
  }],
  alerts: [{
    id: 1,
    icon: "AlertTriangle",
    text: "Aviso",
    color: "#000000",
  }],
  financeSummary: {
    revenueNoShipping: 100,
    costPrice: 25,
    markup: 300,
    taxes: 12,
    saleRate: 0,
    profit: 75,
  },
  peopleAnalytics: {
    totalPeople: 10,
    sex: { totalCount: 10, filledCount: 6, missingCount: 4, missingPercentage: 40, items: [] },
    cities: { totalCount: 10, filledCount: 5, missingCount: 5, missingPercentage: 50, items: [] },
    states: { totalCount: 10, filledCount: 5, missingCount: 5, missingPercentage: 50, items: [] },
    referralSources: { totalCount: 10, filledCount: 4, missingCount: 6, missingPercentage: 60, items: [] },
  },
};

function row(overrides: Partial<DashboardSnapshotRow> = {}): DashboardSnapshotRow {
  return {
    key: "main",
    schemaVersion: 1,
    payload: legacyPayload,
    status: "ready",
    collectedAt: new Date("2025-01-15T10:30:00.000Z"),
    lastAttemptedAt: new Date("2025-01-15T10:30:00.000Z"),
    lastError: null,
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: new Date("2025-01-15T10:30:00.000Z"),
    ...overrides,
  };
}

describe("dashboard snapshot persisted row compatibility", () => {
  it("accepts a valid current payload and preserves its collectedAt", () => {
    const state = rowToState(row({ schemaVersion: 6 }));

    expect(state).toMatchObject({
      status: "ready",
      schemaVersion: 6,
      data: legacyPayload,
      collectedAt: "2025-01-15T10:30:00.000Z",
    });
    expect(state.data?.financeSummary).not.toHaveProperty("leadGrowth");
    expect(snapshotNeedsLeadGrowth(state)).toBe(true);
  });

  it("does not fetch lead growth again when the snapshot already contains it", () => {
    const state = rowToState(row({
      schemaVersion: 6,
      payload: {
        ...legacyPayload,
        financeSummary: {
          ...legacyPayload.financeSummary,
          leadGrowth: [
            { day: "2025-01-15", leads: 2 },
          ],
        },
      },
    }));

    expect(snapshotNeedsLeadGrowth(state)).toBe(false);
  });

  it("rejects an invalid payload even when its schema version is supported", () => {
    const state = rowToState(row({ schemaVersion: 6, payload: { financeSummary: {} } }));

    expect(state).toMatchObject({
      status: "empty",
      data: null,
      collectedAt: null,
    });
  });

  it("rejects payloads from a future schema version", () => {
    const state = rowToState(row({ schemaVersion: 7 }));

    expect(state).toMatchObject({
      status: "empty",
      data: null,
      collectedAt: null,
    });
  });
});

describe("contagem de pedidos confirmados do dashboard", () => {
  const order = (createdAt: string, paymentStatus = "PAID", status = "APPROVED") => ({
    id: `${createdAt}-${paymentStatus}-${status}`,
    number: "1",
    createdAt,
    customerName: null,
    status,
    paymentStatus,
    fulfillmentStatus: "NOT_FULFILLED",
    total: 10,
    shipping: 0,
    city: null,
    region: null,
    country: null,
    items: [],
  });

  it("conta vendas confirmadas nos meses civis de São Paulo e exclui canceladas e reembolsadas", () => {
    const result = countConfirmedOrdersForCurrentAndPreviousMonth([
      order("2026-11-02T12:00:00.000Z"),
      order("2026-11-03T12:00:00.000Z"),
      order("2026-10-30T12:00:00.000Z"),
      order("2026-10-31T12:00:00.000Z", "FULLY_REFUNDED"),
      order("2026-10-31T12:00:00.000Z", "PAID", "CANCELED"),
      order("2026-09-30T12:00:00.000Z"),
    ], new Date("2026-11-13T12:00:00.000Z"));

    expect(result).toEqual({ currentMonth: 2, previousMonth: 1 });
  });

  it("usa o mês civil de São Paulo, inclusive no limite da virada do mês em UTC", () => {
    const result = countConfirmedOrdersForCurrentAndPreviousMonth([
      order("2026-11-01T02:30:00.000Z"),
      order("2026-11-01T03:30:00.000Z"),
    ], new Date("2026-11-01T03:30:00.000Z"));

    expect(result).toEqual({ currentMonth: 1, previousMonth: 1 });
  });
});