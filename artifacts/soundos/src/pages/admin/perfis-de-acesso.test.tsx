// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ACCESS_AREAS } from "@workspace/access-areas";
import { LanguageProvider } from "@/contexts/language";
import PerfisDeAcesso from "./perfis-de-acesso";

const api = vi.hoisted(() => ({
  profiles: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>("@workspace/api-client-react");
  return {
    ...actual,
    useListAccessProfiles: () => ({ data: api.profiles, isLoading: false, isError: false, refetch: vi.fn() }),
    useCreateAccessProfile: () => ({ mutate: api.create, isPending: false }),
    useUpdateAccessProfile: () => ({ mutate: api.update, isPending: false }),
    useDeleteAccessProfile: () => ({ mutate: api.remove, isPending: false }),
  };
});

const ALL = ACCESS_AREAS.map(area => area.id);
const WORK = ACCESS_AREAS.filter(area => !area.adminOnly && area.id !== "visao-financeira").map(area => area.id);

function profile(overrides: Record<string, unknown>) {
  return {
    id: 1, systemKey: null, name: "Perfil", description: "", isAdmin: false, isSystem: false, locked: false,
    areas: [] as string[], userCount: 0, updatedAt: "2026-10-19T12:00:00.000Z", updatedByName: "Sistema", ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider><PerfisDeAcesso /></LanguageProvider>
    </QueryClientProvider>,
  );
}

const checkbox = (id: string) => screen.getByTestId(`checkbox-area-${id}`) as HTMLButtonElement;

describe("tela Perfis de acesso", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    api.create.mockReset();
    api.update.mockReset();
    api.remove.mockReset();
    api.profiles = [
      profile({ id: 1, systemKey: "admin_master", name: "Admin Master", isAdmin: true, isSystem: true, locked: true, areas: ALL, userCount: 3 }),
      profile({ id: 2, systemKey: "admin", name: "Admin", isAdmin: true, isSystem: true, areas: ALL, userCount: 14 }),
      profile({ id: 3, systemKey: "usuario", name: "Usuário", isSystem: true, areas: WORK, userCount: 8 }),
      profile({ id: 6, name: "Financeiro", areas: ["visao-financeira"], userCount: 1 }),
    ];
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("lista os perfis com contagem de áreas, usuários e protege os fixos contra exclusão", () => {
    renderPage();
    const master = screen.getByTestId("row-profile-1");
    expect(within(master).getByText("Fixo")).toBeTruthy();
    expect(within(master).getByText(`${ALL.length} de ${ALL.length} áreas`)).toBeTruthy();
    expect(screen.queryByTestId("button-delete-profile-1")).toBeNull();
    expect(screen.queryByTestId("button-delete-profile-3")).toBeNull();
    expect(screen.getByTestId("button-delete-profile-6")).toBeTruthy();
  });

  it("o Admin Master abre somente para leitura, com todas as áreas marcadas e sem botão de salvar", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-edit-profile-1"));
    for (const id of ALL) {
      expect(checkbox(id).disabled, id).toBe(true);
      expect(checkbox(id).getAttribute("data-state"), id).toBe("checked");
    }
    expect(screen.queryByTestId("button-save-profile")).toBeNull();
  });

  it("perfil novo: áreas só de administrador ficam travadas até marcar 'perfil administrador'", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-new-profile"));
    expect(screen.getByTestId("profile-empty-warning")).toBeTruthy();
    for (const id of ["usuarios", "perfis", "backup", "conduta"]) expect(checkbox(id).disabled, id).toBe(true);
    expect(checkbox("pessoas").disabled).toBe(false);

    fireEvent.click(screen.getByTestId("switch-profile-admin"));
    for (const id of ["usuarios", "perfis", "backup", "conduta"]) expect(checkbox(id).disabled, id).toBe(false);

    fireEvent.click(checkbox("backup"));
    expect(checkbox("backup").getAttribute("data-state")).toBe("checked");
    // Desligar administrador desmarca o que era exclusivo de administrador.
    fireEvent.click(screen.getByTestId("switch-profile-admin"));
    expect(checkbox("backup").getAttribute("data-state")).toBe("unchecked");
  });

  it("'Marcar todas' atua só na seção e respeita áreas travadas", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-new-profile"));
    fireEvent.click(screen.getByTestId("button-section-sofia"));
    for (const id of ["chat", "memoria", "prompt", "conversas", "videos", "videos-envios"]) {
      expect(checkbox(id).getAttribute("data-state"), id).toBe("checked");
    }
    expect(checkbox("conduta").getAttribute("data-state")).toBe("unchecked");
    expect(checkbox("pessoas").getAttribute("data-state")).toBe("unchecked");
    // Segundo clique desmarca a seção inteira.
    fireEvent.click(screen.getByTestId("button-section-sofia"));
    expect(checkbox("chat").getAttribute("data-state")).toBe("unchecked");
  });

  it("salva com as áreas marcadas na ordem do menu; nome curto é recusado antes de chamar o servidor", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-new-profile"));
    fireEvent.click(checkbox("crm"));
    fireEvent.click(checkbox("pessoas"));
    fireEvent.click(screen.getByTestId("button-save-profile"));
    expect(screen.getByTestId("profile-form-error").textContent).toContain("ao menos 2 letras");
    expect(api.create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Nome do perfil"), { target: { value: "Comercial" } });
    fireEvent.click(screen.getByTestId("button-save-profile"));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0][0]).toEqual({
      data: { name: "Comercial", description: "", isAdmin: false, areas: ["pessoas", "crm"] },
    });
  });

  it("perfil do sistema tem o nome travado, mas as áreas podem ser ajustadas", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-edit-profile-3"));
    expect((screen.getByLabelText("Nome do perfil") as HTMLInputElement).disabled).toBe(true);
    expect(checkbox("pessoas").disabled).toBe(false);
    expect(screen.getByTestId("button-save-profile")).toBeTruthy();
  });
});
