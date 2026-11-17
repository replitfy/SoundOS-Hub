// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/language";
import Dashboard from "./dashboard";

const refreshDashboard = vi.fn().mockResolvedValue(undefined);
const snapshotMock = vi.hoisted(() => ({
  financeSummary: { omieStatus: "ok", leadGrowth: [] } as Record<string, unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetDashboardSnapshotQueryKey: () => ["/dashboard/snapshot"],
  useGetDashboardSnapshot: () => ({
    data: {
      status: "ready",
      schemaVersion: 4,
      collectedAt: "2026-09-15T12:00:00.000Z",
      lastAttemptedAt: "2026-09-15T12:00:00.000Z",
      lastError: null,
      data: {
        kpis: {
          newQualifiedContacts: 12,
          newContactsChange: 5,
          openConversations: 3,
          openConversationsChange: -2,
          storeOrdersCurrentMonth: 5,
          storeOrdersPreviousMonth: 4,
          storeOrdersCollectedAt: "2026-09-15T12:00:00.000Z",
        },
        financeSummary: snapshotMock.financeSummary,
        ordersChart: [],
        alerts: [],
        peopleAnalytics: {
          totalPeople: 100,
          sex: {
            totalCount: 100,
            filledCount: 60,
            missingCount: 40,
            missingPercentage: 40,
            items: [
              { label: "Feminino", count: 40, percentage: 66.7 },
              { label: "Masculino", count: 20, percentage: 33.3 },
            ],
          },
          cities: {
            totalCount: 100,
            filledCount: 50,
            missingCount: 50,
            missingPercentage: 50,
            items: [{ label: "São Paulo", count: 25, percentage: 50 }],
          },
          states: {
            totalCount: 100,
            filledCount: 50,
            missingCount: 50,
            missingPercentage: 50,
            items: [{ label: "SP", count: 25, percentage: 50 }],
          },
          referralSources: {
            totalCount: 100,
            filledCount: 40,
            missingCount: 60,
            missingPercentage: 60,
            items: [{ label: "Instagram", count: 20, percentage: 50 }],
          },
        },
      },
    },
    isLoading: false,
    isError: false,
  }),
  useRefreshDashboardSnapshot: () => ({
    isPending: false,
    isError: false,
    mutateAsync: refreshDashboard,
  }),
}));

describe("Dashboard people analytics", () => {
  beforeEach(() => {
    snapshotMock.financeSummary = { omieStatus: "ok", leadGrowth: [] };
    refreshDashboard.mockClear();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("explains the percentage basis and separates missing values", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <Dashboard />
        </LanguageProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Inteligência de Pessoas")).toBeDefined();
    expect(screen.getByText(/calculados somente sobre as fichas que possuem/)).toBeDefined();
    expect(screen.getByText("Pessoas por sexo")).toBeDefined();
    expect(screen.getByText("66,7%")).toBeDefined();
    expect(screen.getByText("Pedidos pagos no mês")).toBeDefined();
    expect(screen.getByTestId("dashboard-kpi-orders").textContent).toContain("5");
    expect(screen.getByTestId("dashboard-kpi-orders").textContent).toContain("4 no mês anterior");
    expect(screen.getByTestId("dashboard-kpi-active-people").textContent).toContain("Fichas ativas");
    expect(screen.getByTestId("dashboard-kpi-active-people").textContent).toContain("100");
    expect(screen.getByTestId("dashboard-kpi-active-people").textContent).toContain("Feminino");
    expect(screen.getByTestId("dashboard-kpi-active-people").textContent).toContain("Masculino");
    expect(screen.getByTestId("dashboard-kpi-active-people").textContent).toContain("Não informado");
    expect(screen.getAllByText("Não informado")).toHaveLength(5);
    expect(screen.queryByText("Novos Contatos Qualif.")).toBeNull();
    expect(screen.getByText("Crescimento de leads últimos 30 dias")).toBeDefined();
  });

  it("refreshes the snapshot automatically when the overview opens", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <Dashboard />
        </LanguageProvider>
      </QueryClientProvider>,
    );

    expect(refreshDashboard).toHaveBeenCalledTimes(1);
  });

  it("shows the notice about Omie titles left out of the totals only when there is one", () => {
    const renderDashboard = () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={client}>
          <LanguageProvider>
            <Dashboard />
          </LanguageProvider>
        </QueryClientProvider>,
      );
    };

    renderDashboard();
    expect(screen.queryByTestId("dashboard-aviso-titulos")).toBeNull();
    cleanup();

    snapshotMock.financeSummary = {
      omieStatus: "ok",
      leadGrowth: [],
      avisos: ['O Omie enviou títulos com um status que o sistema não conhece: contas a pagar com status "EM DISPUTA" (1 título, R$ 80,00).'],
    };
    renderDashboard();
    expect(screen.getByTestId("dashboard-aviso-titulos").textContent).toContain('status "EM DISPUTA"');
  });
});
