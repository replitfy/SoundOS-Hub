// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { LanguageProvider } from "@/contexts/language";
import InscricaoPage from "@/pages/inscricao/index";
import InteresseFormPage from "@/pages/inscricao/interesse";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const at = (path: string, el: React.ReactNode) =>
  render(<LanguageProvider><Router hook={memoryLocation({ path }).hook}>{el}</Router></LanguageProvider>);

describe("legacy registration links", () => {
  it("/inscricao shows payment notice with no form", () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    at("/inscricao/x", <InscricaoPage />);
    expect(screen.getByTestId("notice-payment-required")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("/interesse with COMPLETO shows notice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tipo: "COMPLETO", evento: { id: 1, nome: "Retiro", descricao: null, local: null, dataInicio: null, dataFim: null }, versao: { campos: [] } }), { status: 200 })));
    const { Route } = await import("wouter");
    at("/interesse/s", <Route path="/interesse/:slug" component={InteresseFormPage} />);
    expect(await screen.findByTestId("notice-payment-required")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
  });

  it("/interesse with INTERESSE still renders form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tipo: "INTERESSE", evento: { id: 1, nome: "Retiro", descricao: null, local: null, dataInicio: null, dataFim: null }, versao: { campos: [{ key: "nome", label: "Nome", type: "text", required: true }] } }), { status: 200 })));
    const { Route } = await import("wouter");
    at("/interesse/s", <Route path="/interesse/:slug" component={InteresseFormPage} />);
    await screen.findByText("Retiro", { selector: "p" });
    expect(document.querySelector("form")).not.toBeNull();
  });
});
