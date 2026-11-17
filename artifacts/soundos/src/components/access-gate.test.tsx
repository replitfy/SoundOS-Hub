// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { canAccessPath, firstAllowedHref } from "@workspace/access-areas";
import { LanguageProvider } from "@/contexts/language";
import { AccessGate } from "./access-gate";

const state = vi.hoisted(() => ({
  status: "ready" as "loading" | "ready" | "error",
  areas: [] as string[],
  retry: vi.fn(),
}));

vi.mock("@/contexts/access", async () => {
  const lib = await import("@workspace/access-areas");
  return {
    useAccess: () => ({
      status: state.status,
      areas: state.areas,
      isAdmin: false,
      profileName: "Teste",
      can: (id: string) => state.areas.includes(id),
      canPath: (path: string) => lib.canAccessPath(path, state.areas),
      homeHref: lib.firstAllowedHref(state.areas),
      retry: state.retry,
    }),
  };
});

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  const view = render(
    <LanguageProvider>
      <Router hook={location.hook}>
        <AccessGate><div data-testid="content">conteúdo restrito</div></AccessGate>
      </Router>
    </LanguageProvider>,
  );
  return { ...view, location };
}

describe("AccessGate", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    state.status = "ready";
    state.areas = ["pessoas", "crm"];
    state.retry.mockReset();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("fail-closed: enquanto o perfil carrega, nada restrito aparece", () => {
    state.status = "loading";
    renderAt("/pessoas");
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.getByTestId("access-loading")).toBeTruthy();
  });

  it("fail-closed: se o perfil não pôde ser verificado, mostra erro com nova tentativa", () => {
    state.status = "error";
    renderAt("/pessoas");
    expect(screen.queryByTestId("content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it("mostra o conteúdo quando a área está no perfil", () => {
    renderAt("/pessoas/12");
    expect(screen.getByTestId("content")).toBeTruthy();
  });

  it("endereço digitado de uma área não liberada mostra a mensagem de acesso negado", () => {
    renderAt("/admin/usuarios");
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.getByText("Você não tem acesso a esta área")).toBeTruthy();
  });

  it("a mensagem de acesso negado aparece em francês quando o idioma é francês", () => {
    localStorage.setItem("soundos_lang", "fr");
    renderAt("/admin/usuarios");
    expect(screen.getByText("Vous n'avez pas accès à cette zone")).toBeTruthy();
  });

  it("a página inicial sem Visão Geral leva à primeira tela permitida", () => {
    const { location } = renderAt("/");
    expect(canAccessPath("/", state.areas)).toBe(false);
    expect(location.history.at(-1)).toBe(firstAllowedHref(state.areas));
    expect(location.history.at(-1)).toBe("/pessoas");
  });

  it("perfil sem nenhuma área mostra o aviso de perfil vazio, mas deixa abrir Meu perfil", () => {
    state.areas = [];
    const first = renderAt("/");
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.getByTestId("access-empty-profile")).toBeTruthy();
    first.unmount();
    renderAt("/meu-perfil");
    expect(screen.getByTestId("content")).toBeTruthy();
  });
});
