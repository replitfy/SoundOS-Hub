// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommercialOpportunity } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";

const state = vi.hoisted(() => ({ update: vi.fn(), claim: vi.fn(), canOpenPerson: true }));
vi.mock("@/contexts/access", () => ({
  useAccess: () => ({ canPath: (path: string) => path === "/pessoas" && state.canOpenPerson }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListCommercialOpportunityOwners: () => ({ data: [] }),
  useUpdateCommercialOpportunity: () => ({ mutate: state.update }),
  useCompleteCommercialOpportunityTask: () => ({ mutate: vi.fn() }),
}));
vi.mock("../use-card-refresh", () => ({ useCardRefresh: () => vi.fn() }));
vi.mock("../use-claim-opportunity", () => ({
  useClaimOpportunity: () => ({ claim: state.claim, isClaiming: false }),
}));
import { CardControles } from "./card-controles";

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); state.canOpenPerson = true; });

function renderControls(ownerSystem: "SOFIA" | null) {
  localStorage.setItem("soundos_lang", "pt");
  const opp = {
    id: 5, pessoaId: 42, ownerUserId: null, ownerSystem, version: 1,
    nextTaskType: "WHATSAPP", nextTaskText: "Retornar ao interesse",
    nextTaskAt: "2026-11-20T12:00:00.000Z", contactStatus: "NOT_STARTED",
  } as CommercialOpportunity;
  render(<LanguageProvider><CardControles opp={opp} closed={false} /></LanguageProvider>);
}

describe("responsabilidade da Sofia no cartão", () => {
  it("mostra Sofia sem aviso de responsável ausente e permite assumir", () => {
    renderControls("SOFIA");
    expect(screen.getByText("Sofia")).toBeTruthy();
    expect(screen.queryByTestId("crm-owner-required-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("crm-drawer-claim"));
    expect(state.claim).toHaveBeenCalledWith(5);
  });

  it("mantém o aviso para um cartão realmente sem responsável", () => {
    renderControls(null);
    expect(screen.getByTestId("crm-owner-required-hint")).toBeTruthy();
  });

  it("não exibe Próxima Ação e salva sem alterar os dados da ação existente", () => {
    renderControls("SOFIA");
    expect(screen.queryByText(/próxima ação/i)).toBeNull();
    expect(screen.queryByDisplayValue("Retornar ao interesse")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(state.update).toHaveBeenCalledWith({
      id: 5,
      data: { ownerUserId: null, expectedVersion: 1 },
    }, expect.anything());
  });

  it("remove o status de contato e oferece o link para a ficha correta", () => {
    renderControls("SOFIA");
    expect(screen.queryByText(/status de contato/i)).toBeNull();
    const link = screen.getByRole("link", { name: "Abrir ficha" });
    expect(link.getAttribute("href")).toBe("/pessoas/42");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("não oferece acesso à ficha sem permissão para Pessoas", () => {
    state.canOpenPerson = false;
    renderControls("SOFIA");
    expect(screen.queryByTestId("crm-card-abrir-ficha")).toBeNull();
  });
});
