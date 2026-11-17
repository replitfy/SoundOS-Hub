// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/language";
import { UserSessionProvider } from "@/contexts/user-session";
import { TooltipProvider } from "@/components/ui/tooltip";
import PessoasList from "./index";

describe("PessoasList", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: 1,
      name: "Teste",
      email: "teste@example.com",
      sessionToken: "signed-test-token",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [],
        total: 0,
        grandTotal: 13,
        limit: 100,
        offset: 0,
      }),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("selects Ativos and filters the first request accordingly", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <UserSessionProvider>
            <TooltipProvider>
              <PessoasList />
            </TooltipProvider>
          </UserSessionProvider>
        </LanguageProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("combobox").textContent).toContain("Ativos");
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/pessoas\?.*ativo=true/),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer signed-test-token" }),
        }),
      );
    });
  });

  it("handles list select-visible, bulk archive and reset", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes("/api/pessoas?")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { id: 1, nome: "Alice", ativo: true, arquivadoEm: null, createdAt: "2023-01-01" },
              { id: 2, nome: "Bob", ativo: true, arquivadoEm: "2023-02-01", createdAt: "2023-01-01" }, // Archived, should not be selectable
              { id: 3, nome: "Charlie", ativo: true, arquivadoEm: null, createdAt: "2023-01-01" }
            ],
            total: 3,
            grandTotal: 3,
            limit: 100,
            offset: 0,
          }),
        });
      }
      if (url.includes("/api/pessoas/batch/archive")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ archivedCount: 2, ids: [1, 3] })
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <UserSessionProvider>
            <TooltipProvider>
              <PessoasList />
            </TooltipProvider>
          </UserSessionProvider>
        </LanguageProvider>
      </QueryClientProvider>,
    );

    // Wait for the table to render
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeDefined();
      expect(screen.getByText("Bob")).toBeDefined();
      expect(screen.getByText("Charlie")).toBeDefined();
    });

    // Select all visible
    const selectAllCheckbox = screen.getByTestId("checkbox-select-all");
    fireEvent.click(selectAllCheckbox);

    // Only unarchived items should be selected. We have 2 of them.
    await waitFor(() => {
      expect(screen.getByText("2 pessoas selecionadas")).toBeDefined();
    });

    // Verify individual checkboxes
    const c1 = screen.getByTestId("checkbox-select-pessoa-1");
    const c2 = screen.getByTestId("checkbox-select-pessoa-2");
    const c3 = screen.getByTestId("checkbox-select-pessoa-3");

    expect((c1 as HTMLButtonElement).dataset.state).toBe("checked");
    expect((c2 as HTMLButtonElement).disabled).toBe(true); // ArquivadoEm is set
    expect((c3 as HTMLButtonElement).dataset.state).toBe("checked");

    // Click bulk archive
    fireEvent.click(screen.getByText("Arquivar selecionadas"));

    // Confirm dialog appears
    await waitFor(() => {
      expect(screen.getByText("Tem certeza que deseja arquivar as 2 pessoas selecionadas?")).toBeDefined();
    });

    // Confirm
    fireEvent.click(screen.getByTestId("button-confirm-bulk-archive"));

    // Verify endpoint called
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/pessoas\/batch\/archive$/),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ids: [1, 3] })
        })
      );
    });

    // Action bar should disappear and selection should be reset (our component resets on filter/search change, but onSuccess also resets selectedIds and invalidates queries)
    await waitFor(() => {
      expect(screen.queryByText("2 pessoas selecionadas")).toBeNull();
    });
  });
});