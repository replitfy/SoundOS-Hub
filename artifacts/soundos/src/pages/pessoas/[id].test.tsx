// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/language";
import { UserSessionProvider } from "@/contexts/user-session";
import { TooltipProvider } from "@/components/ui/tooltip";
import PessoaDetail from "./[id]";

vi.mock("@/contexts/access", async () => (await import("@/test/access-mock")).accessMock(() => true));

// Mock wouter
vi.mock("wouter", async () => {
  const actual = await vi.importActual("wouter");
  return {
    ...actual,
    useParams: () => ({ id: "1" }),
    useLocation: () => ["/pessoas/1", vi.fn()],
  };
});

describe("PessoaDetail - Merge functionality", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: 1,
      name: "Teste",
      email: "teste@example.com",
      sessionToken: "signed-test-token",
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("handles merge dialog search, preview, and submission", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      // 1. Fetch person 1
      if (url.match(/\/api\/pessoas\/1$/)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 1, nome: "Target", sobrenome: "Person", ativo: true, email: "target@test.com"
          }),
        });
      }
      
      // Secondary queries for PessoaDetail
      if (url.includes("/conversations") || url.includes("/campos-status") || url.includes("/notes") || url.includes("/servicos") || url.includes("/instrumentos") || url.includes("/participacoes")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      // 2. Search merge source
      if (url.includes("/api/pessoas/merge-candidates?search=Source")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 2,
              codigo: "SRC-2",
              nome: "Source",
              sobrenome: "Person",
              ativo: false,
              arquivadoEm: "2026-01-02T00:00:00.000Z",
              mergedIntoPessoaId: null,
              email: "source@test.com",
            },
          ],
        });
      }

      // 3. Merge preview
      if (url.includes("/api/pessoas/1/merge-preview?sourceId=2")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            target: { id: 1, nome: "Target", sobrenome: "Person", email: "target@test.com" },
            source: { id: 2, nome: "Source", sobrenome: "Person", email: "source@test.com" },
            defaults: { nameFrom: "target", emailFrom: "source", phoneFrom: "target" },
            relationshipCounts: { target: { notas: 1 }, source: { participacoes: 2 } },
            collisionCounts: { enrollments: 1 },
            fieldConflicts: [],
            secondaryContacts: [{ type: "email", value: "target@test.com", sourcePersonId: 1 }]
          }),
        });
      }

      // 4. Submit merge
      if (url.includes("/api/pessoas/1/merge") && options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ targetId: 1, sourceId: 2, merged: true, idempotent: false })
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
              <PessoaDetail />
            </TooltipProvider>
          </UserSessionProvider>
        </LanguageProvider>
      </QueryClientProvider>,
    );

    // Wait for the detail to load
    await waitFor(() => {
      expect(screen.getByText("Target Person")).toBeDefined();
    });

    // Click "Fundir ficha"
    const mergeBtn = screen.getByText("Fundir ficha");
    fireEvent.click(mergeBtn);

    // Wait for dialog
    await waitFor(() => {
      expect(screen.getByText("Fundir fichas")).toBeDefined();
    });

    // Search for source
    const searchInput = screen.getByPlaceholderText(/Buscar pessoa por nome/);
    fireEvent.change(searchInput, { target: { value: "Source" } });

    // Select source from dropdown
    await waitFor(() => {
      expect(screen.getByText("Source Person")).toBeDefined();
      expect(screen.getByText(/Arquivada/)).toBeDefined();
    });
    fireEvent.click(screen.getByText("Source Person"));

    // Preview should load
    await waitFor(() => {
      expect(screen.getByText("Pré-visualização da Mesclagem")).toBeDefined();
      // Should show the collision text
      expect(screen.getByText("Colisões de dados a revisar:")).toBeDefined();
      // Verify defaults were set: target name, source email
      const targetNameRadio = screen.getAllByRole("radio", { name: /Target Person/ })[0] as HTMLInputElement;
      expect(targetNameRadio.checked).toBe(true);

      const sourceEmailRadio = screen.getByRole("radio", { name: /source@test\.com/ }) as HTMLInputElement;
      expect(sourceEmailRadio.checked).toBe(true);
    });

    // Fill reason
    const textarea = screen.getByRole("textbox", { name: "Motivo da mesclagem (obrigatório)" });
    fireEvent.change(textarea, { target: { value: "Duplicate entry" } });

    // Confirm merge
    fireEvent.click(screen.getByText("Confirmar mesclagem destrutiva"));

    // Verify request
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => c[0].endsWith("/api/pessoas/1/merge"));
      expect(call).toBeDefined();
      if (!call) throw new Error("Merge request was not sent");
      const body = JSON.parse(String(call[1]?.body));
      expect(body).toEqual({
        sourceId: 2,
        nameFrom: "target",
        emailFrom: "source", // the default from preview
        phoneFrom: "target",
        fieldChoices: {},
        reason: "Duplicate entry"
      });
    });
  });
  it("abre a fusão já com a ficha duplicada escolhida quando o link traz ?fundir=", async () => {
    window.history.pushState({}, "", "/pessoas/1?fundir=2");
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.match(/\/api\/pessoas\/1$/)) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 1, nome: "Target", sobrenome: "Person", ativo: true, email: "target@test.com" }) });
      }
      if (url.includes("/api/pessoas/1/merge-preview?sourceId=2")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            target: { id: 1, nome: "Target", sobrenome: "Person", email: "target@test.com" },
            source: { id: 2, nome: "Source", sobrenome: "Person", email: "source@test.com" },
            defaults: { nameFrom: "target", emailFrom: "target", phoneFrom: "target" },
            relationshipCounts: { target: {}, source: {} },
            collisionCounts: {},
            fieldConflicts: [],
            secondaryContacts: [],
          }),
        });
      }
      if (url.includes("/conversations") || url.includes("/campos-status") || url.includes("/notes") || url.includes("/servicos") || url.includes("/instrumentos") || url.includes("/participacoes")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    try {
      render(
        <QueryClientProvider client={client}>
          <LanguageProvider>
            <UserSessionProvider>
              <TooltipProvider>
                <PessoaDetail />
              </TooltipProvider>
            </UserSessionProvider>
          </LanguageProvider>
        </QueryClientProvider>,
      );

      await waitFor(() => expect(screen.getByText("Fundir fichas")).toBeDefined());
      await waitFor(() => expect(screen.getByText("Pré-visualização da Mesclagem")).toBeDefined());
      expect(screen.getByText(/Id: 2/)).toBeDefined();
      expect(screen.queryByPlaceholderText(/Buscar pessoa por nome/)).toBeNull();

      fireEvent.click(screen.getAllByRole("button", { name: "Cancelar" })[0]!);
      fireEvent.click(screen.getByText("Fundir ficha"));
      await waitFor(() => expect(screen.getByPlaceholderText(/Buscar pessoa por nome/)).toBeDefined());
    } finally {
      window.history.pushState({}, "", "/");
    }
  });
});
