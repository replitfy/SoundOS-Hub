// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import OmiePage from "./omie";

const mocks = vi.hoisted(() => {
  const statuses = [
    { base: "education", name: "Education", connected: true, totalClientes: 3 },
    { base: "store", name: "Store", connected: true, totalClientes: 5 },
  ];
  const idle = () => ({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() });
  return {
    statuses,
    status: { current: idle() as Record<string, unknown> },
    receber: { current: idle() as Record<string, unknown> },
    pagar: { current: idle() as Record<string, unknown> },
    idle,
  };
});

vi.mock("@workspace/api-client-react", () => ({
  useGetOmieStatus: () => mocks.status.current,
  getGetOmieStatusQueryKey: () => ["/omie/status"],
  useListOmieClientes: () => ({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
  getListOmieClientesQueryKey: () => ["/omie/clientes"],
  useListOmieContasCorrentes: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  getListOmieContasCorrentesQueryKey: () => ["/omie/cc"],
  useGetOmieContasReceberResumo: () => mocks.receber.current,
  getGetOmieContasReceberResumoQueryKey: (base: string) => [`/omie/${base}/receber/resumo`],
  useGetOmieContasPagarResumo: () => mocks.pagar.current,
  getGetOmieContasPagarResumoQueryKey: (base: string) => [`/omie/${base}/pagar/resumo`],
}));

vi.mock("@/contexts/user-session", () => ({
  useUserSession: () => ({ user: { id: 1 }, authHeader: { Authorization: "Bearer foo" } }),
}));

function renderPage() {
  return render(
    <LanguageProvider>
      <OmiePage />
    </LanguageProvider>,
  );
}

describe("Página Omie ERP — totais de títulos", () => {
  beforeEach(() => {
    mocks.status.current = { ...mocks.idle(), data: mocks.statuses };
    mocks.receber.current = mocks.idle();
    mocks.pagar.current = mocks.idle();
  });

  afterEach(() => {
    cleanup();
  });

  it("mostra recebido/pago, a vencer e atrasado de receber e pagar", () => {
    mocks.receber.current = {
      ...mocks.idle(),
      data: { totalRecebido: 1000, totalAVencer: 250.5, totalAtrasado: 75, quantidade: 12, avisos: [] },
    };
    mocks.pagar.current = {
      ...mocks.idle(),
      data: { totalRecebido: 400, totalAVencer: 90, totalAtrasado: 10, quantidade: 4, avisos: [] },
    };

    renderPage();

    expect(screen.getByTestId("omie-resumo-receber-realizado").textContent).toContain("1.000,00");
    expect(screen.getByTestId("omie-resumo-receber-a-vencer").textContent).toContain("250,50");
    expect(screen.getByTestId("omie-resumo-receber-atrasado").textContent).toContain("75,00");
    expect(screen.getByTestId("omie-resumo-pagar-realizado").textContent).toContain("400,00");
    expect(screen.getByTestId("omie-resumo-pagar-a-vencer").textContent).toContain("90,00");
    expect(screen.getByTestId("omie-resumo-pagar-atrasado").textContent).toContain("10,00");
    expect(screen.getByTestId("omie-resumo-receber").textContent).toContain("Recebido");
    expect(screen.getByTestId("omie-resumo-pagar").textContent).toContain("Pago");
    expect(screen.queryByTestId("omie-aviso-titulos")).toBeNull();
  });

  it("mostra um aviso âmbar para cada texto de avisos devolvido pelo resumo", () => {
    mocks.receber.current = {
      ...mocks.idle(),
      data: {
        totalRecebido: 0,
        totalAVencer: 0,
        totalAtrasado: 0,
        quantidade: 0,
        avisos: ["1 título a receber com status desconhecido ficou fora dos totais."],
      },
    };
    mocks.pagar.current = {
      ...mocks.idle(),
      data: { totalRecebido: 0, totalAVencer: 0, totalAtrasado: 0, quantidade: 0, avisos: [] },
    };

    renderPage();

    const avisos = screen.getAllByTestId("omie-aviso-titulos");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].textContent).toContain("status desconhecido");
    expect(avisos[0].className).toContain("bg-amber-50");
  });

  it("mostra erro só na seção que falhou e mantém a outra", () => {
    mocks.receber.current = { ...mocks.idle(), error: new Error("502") };
    mocks.pagar.current = {
      ...mocks.idle(),
      data: { totalRecebido: 400, totalAVencer: 90, totalAtrasado: 10, quantidade: 4, avisos: [] },
    };

    renderPage();

    expect(screen.getByTestId("omie-resumo-receber-erro").textContent).toContain("contas a receber");
    expect(screen.queryByTestId("omie-resumo-receber-realizado")).toBeNull();
    expect(screen.getByTestId("omie-resumo-pagar-realizado").textContent).toContain("400,00");
  });

  it("mostra carregamento enquanto os totais são buscados", () => {
    mocks.receber.current = { ...mocks.idle(), isLoading: true };
    mocks.pagar.current = { ...mocks.idle(), isLoading: true };

    const { container } = renderPage();

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId("omie-resumo-receber-realizado")).toBeNull();
  });

  it("só carrega os totais ao clicar em Atualizar", async () => {
    const refetchReceber = vi.fn();
    const refetchPagar = vi.fn();
    const refetchStatus = vi.fn().mockResolvedValue({ data: mocks.statuses });
    mocks.status.current = { ...mocks.idle(), data: undefined, refetch: refetchStatus };
    mocks.receber.current = { ...mocks.idle(), refetch: refetchReceber };
    mocks.pagar.current = { ...mocks.idle(), refetch: refetchPagar };

    renderPage();

    expect(refetchReceber).not.toHaveBeenCalled();
    expect(refetchPagar).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));

    await waitFor(() => {
      expect(refetchReceber).toHaveBeenCalledTimes(1);
      expect(refetchPagar).toHaveBeenCalledTimes(1);
    });
  });
});
