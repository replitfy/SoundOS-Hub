// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import { UnsavedChangesProvider } from "@/hooks/use-unsaved-guard";
import { AppLayout } from "./layout";

const state = vi.hoisted(() => ({ aguardando: 0, naoEntregues: 0, abrir: null as null | (() => void) }));

vi.mock("@/hooks/use-conversas-aguardando", async importOriginal => ({
  ...(await importOriginal<typeof import("@/hooks/use-conversas-aguardando")>()),
  useConversasAguardandoEquipe: (abrir: () => void) => { state.abrir = abrir; return { aguardando: state.aguardando, naoEntregues: state.naoEntregues }; },
}));

vi.mock("@/contexts/access", () => ({
  useAccess: () => ({ status: "ready", areas: [], isAdmin: true, profileName: "Admin", can: () => true, canPath: () => true, homeHref: "/", retry: () => {} }),
}));

vi.mock("@/contexts/user-session", () => ({
  useUserSession: () => ({ user: { id: "1", name: "Equipe Teste" }, logout: () => {} }),
}));

const location = memoryLocation({ path: "/pessoas", record: true });
function renderLayout() {
  return render(
    <LanguageProvider>
      <Router hook={location.hook}><UnsavedChangesProvider><AppLayout><div>conteúdo</div></AppLayout></UnsavedChangesProvider></Router>
    </LanguageProvider>,
  );
}

describe("menu — contador de conversas aguardando a equipe", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    state.aguardando = 0;
    state.naoEntregues = 0;
    state.abrir = null;
    location.navigate("/pessoas");
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it("sem conversas aguardando, nenhum contador aparece", () => {
    renderLayout();
    expect(screen.queryByTestId("badge-conversas-aguardando")).toBeNull();
  });

  it("o contador aparece ao lado de Conversas, com texto acessível, e some quando zera", () => {
    state.aguardando = 3;
    const { rerender } = renderLayout();
    const item = screen.getByTestId("nav-conversas");
    const contador = within(item).getByTestId("badge-conversas-aguardando");
    expect(contador.textContent).toBe("3");
    expect(contador.getAttribute("aria-label")).toBe("3 conversas aguardando a equipe");
    expect(screen.getAllByTestId("badge-conversas-aguardando")).toHaveLength(1);

    state.aguardando = 1;
    rerender(
      <LanguageProvider>
        <Router hook={location.hook}><UnsavedChangesProvider><AppLayout><div>conteúdo</div></AppLayout></UnsavedChangesProvider></Router>
      </LanguageProvider>,
    );
    expect(within(screen.getByTestId("nav-conversas")).getByTestId("badge-conversas-aguardando").getAttribute("aria-label")).toBe("1 conversa aguardando a equipe");

    state.aguardando = 0;
    rerender(
      <LanguageProvider>
        <Router hook={location.hook}><UnsavedChangesProvider><AppLayout><div>conteúdo</div></AppLayout></UnsavedChangesProvider></Router>
      </LanguageProvider>,
    );
    expect(screen.queryByTestId("badge-conversas-aguardando")).toBeNull();
  });

  it("com a seção Sofia recolhida, o contador sobe para o título da seção", () => {
    state.aguardando = 2;
    renderLayout();
    fireEvent.click(screen.getByTestId("section-sofia"));
    expect(screen.queryByTestId("nav-conversas")).toBeNull();
    const secao = screen.getByTestId("section-sofia");
    expect(within(secao).getByTestId("badge-conversas-aguardando").textContent).toBe("2");
  });

  it("com o menu lateral recolhido, o contador fica no ícone da seção e no item do submenu", () => {
    state.aguardando = 120;
    renderLayout();
    fireEvent.click(screen.getByTestId("button-toggle-sidebar"));
    const contadores = screen.getAllByTestId("badge-conversas-aguardando");
    expect(contadores).toHaveLength(2);
    expect(contadores.map(c => c.textContent)).toEqual(["99+", "99+"]);
  });

  it("o atalho do aviso na tela leva a Conversas", () => {
    renderLayout();
    act(() => { state.abrir!(); });
    expect(location.history?.at(-1)).toBe("/sofia/conversas");
  });

  it("respostas não entregues têm contador e texto próprios, separados do aviso de aguardando a equipe", () => {
    state.aguardando = 2;
    state.naoEntregues = 3;
    renderLayout();
    const item = screen.getByTestId("nav-conversas");
    const aguardando = within(item).getByTestId("badge-conversas-aguardando");
    const naoEntregues = within(item).getByTestId("badge-respostas-nao-entregues");
    expect(aguardando.textContent).toBe("2");
    expect(aguardando.getAttribute("aria-label")).toBe("2 conversas aguardando a equipe");
    expect(naoEntregues.textContent).toBe("3");
    expect(naoEntregues.getAttribute("aria-label")).toBe("3 respostas da Sofia não foram entregues");
  });

  it("só com respostas não entregues, o aviso de aguardando a equipe não aparece (e o singular é usado)", () => {
    state.naoEntregues = 1;
    renderLayout();
    expect(screen.queryByTestId("badge-conversas-aguardando")).toBeNull();
    expect(within(screen.getByTestId("nav-conversas")).getByTestId("badge-respostas-nao-entregues").getAttribute("aria-label")).toBe("1 resposta da Sofia não foi entregue");
  });

  it("com a seção Sofia recolhida, o contador de não entregues sobe para o título da seção", () => {
    state.naoEntregues = 2;
    renderLayout();
    fireEvent.click(screen.getByTestId("section-sofia"));
    expect(within(screen.getByTestId("section-sofia")).getByTestId("badge-respostas-nao-entregues").textContent).toBe("2");
  });

  it("em francês, o contador de não entregues tem texto próprio", () => {
    localStorage.setItem("soundos_lang", "fr");
    state.naoEntregues = 2;
    renderLayout();
    expect(within(screen.getByTestId("nav-conversas")).getByTestId("badge-respostas-nao-entregues").getAttribute("aria-label")).toBe("2 réponses de Sofia n'ont pas été remises");
  });
});
