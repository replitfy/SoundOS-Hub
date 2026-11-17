// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { LanguageProvider, type Lang } from "@/contexts/language";
import { UserSessionProvider } from "@/contexts/user-session";
import EducationInteresse from "./interesse";

function renderPage(lang: Lang) {
  localStorage.setItem("soundos_lang", lang);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const location = memoryLocation({ path: "/education/interesse" });
  const view = render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <UserSessionProvider>
          <Router hook={location.hook}>
            <EducationInteresse />
          </Router>
        </UserSessionProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  sessionStorage.setItem("soundos_user_session", JSON.stringify({
    id: 1, name: "Teste", email: "teste@example.com", sessionToken: "token-teste",
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/education/event-summary")
      ? { rows: [{ eventId: 42, eventName: "Retiro de teste" }] }
      : { grupos: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe.each([
  { lang: "pt" as const, title: "Formulário de interesse", back: "Voltar para Eventos" },
  { lang: "fr" as const, title: "Formulaire d'intérêt", back: "Retour aux événements" },
])("página do formulário de interesse em $lang", ({ lang, title, back }) => {
  it("mostra o título, o gerador e o caminho de volta para Eventos", () => {
    renderPage(lang);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(screen.getByTestId("interesse-embed-card")).toBeTruthy();
    const voltar = screen.getByTestId("link-voltar-eventos");
    expect(voltar.textContent).toBe(back);
    expect(voltar.getAttribute("href")).toBe("/education/cursos");
  });

  it("carrega eventos ativos para o seletor opcional", async () => {
    const { client } = renderPage(lang);
    expect(screen.getByTestId("interesse-embed-evento")).toBeTruthy();
    await waitFor(() => {
      expect(client.getQueryData(["interest-form-event-options", "active"])).toEqual({
        rows: [{ eventId: 42, eventName: "Retiro de teste" }],
      });
    });
  });
});
