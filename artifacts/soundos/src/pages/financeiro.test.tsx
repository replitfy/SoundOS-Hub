// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/language";
import Financeiro from "./financeiro";

vi.mock("@workspace/api-client-react", () => ({
  getGetOmieResumoFinanceiroQueryKey: () => ["/financeiro/snapshot"],
  useGetOmieResumoFinanceiro: () => ({
    data: {
      status: "ready",
      availableFrom: "2025-01-01",
      availableTo: "2026-09-18",
      data: {
        receitaTotal: 50000,
        despesaTotal: 30000,
        resultado: 20000,
        receitaPlanejadaTotal: 60000,
        despesaPlanejadaTotal: 35000,
        resultadoPlanejado: 25000,
        saldoInicial: 10000,
        ajustes: 500,
        saldoFinal: 30500,
        meses: [],
        porBase: [],
        contas: [],
      }
    },
    isLoading: false,
    isError: false,
  }),
  useRefreshOmieResumoFinanceiro: () => ({
    isPending: false,
    isError: false,
    mutateAsync: vi.fn(),
  }),
  useListPersistedFinancialAccounts: () => ({
    data: { contas: [] },
    isLoading: false,
    isFetching: false,
  }),
  getListPersistedFinancialAccountsQueryKey: () => ["/financeiro/accounts"],
}));

vi.mock("@/contexts/user-session", () => ({
  useUserSession: () => ({ authHeader: { Authorization: "Bearer foo" } }),
}));

describe("Financeiro KPI figures", () => {
  beforeEach(() => {
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

  it("hides financial values by default and reveals them from the eye button", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <Financeiro />
        </LanguageProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("text-fin-receita-realizada").textContent).toContain("R$ ••••••");
    expect(screen.getByTestId("text-fin-receita-realizada").textContent).not.toContain("50.000,00");
    expect(screen.getByTestId("text-fin-periodo-disponivel").textContent).toContain("01/01/2025");

    fireEvent.click(screen.getByTestId("button-toggle-financial-values"));

    expect(screen.getByTestId("text-fin-receita-realizada").textContent).toContain("50.000,00");
    expect(screen.getByTestId("text-fin-despesa-realizada").textContent).toContain("30.000,00");
    expect(screen.getByTestId("text-fin-resultado-realizado").textContent).toContain("20.000");

    expect(screen.getByTestId("text-fin-receita-planejada").textContent).toContain("60.000,00");
    expect(screen.getByTestId("text-fin-despesa-planejada").textContent).toContain("35.000,00");
    expect(screen.getByTestId("text-fin-resultado-planejado").textContent).toContain("25.000");
  });
});
