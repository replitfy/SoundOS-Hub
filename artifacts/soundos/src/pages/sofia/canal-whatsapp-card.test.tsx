// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";

const state = vi.hoisted(() => ({ canal: null as unknown, atualizar: vi.fn() }));

vi.mock("@workspace/api-client-react", async importOriginal => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...original,
    useGetCanalWhatsapp: () => ({ data: state.canal, isLoading: false, isError: false }),
    useListEventosCanalWhatsapp: () => ({ data: [], isLoading: false }),
    useVerificarCredenciaisHablla: () => ({ data: undefined, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
    useUpdateCanalWhatsapp: () => ({ mutate: state.atualizar, isPending: false }),
    useGerarTokenWebhookWhatsapp: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

// O Radix mede o interruptor com ResizeObserver, que o jsdom não traz.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

import { CanalWhatsappCard } from "./canal-whatsapp-card";

afterEach(() => { cleanup(); localStorage.clear(); });
beforeEach(() => { vi.clearAllMocks(); });

function canal(parcial: Record<string, unknown> = {}) {
  return {
    respondeAtivo: true, iniciaConversaAtivo: false, limiteIniciosPorHora: 20, limiteIniciosPorDia: 100,
    webhookUrl: null, tokenGeradoEm: null, tokenConfigurado: false, ...parcial,
  };
}

function renderar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <CanalWhatsappCard />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

describe("interruptor de início de conversa da Sofia no WhatsApp", () => {
  it("nasce desligado, mostra os limites e liga só por ação da pessoa", () => {
    state.canal = canal();
    renderar();
    const chave = screen.getByTestId("switch-whatsapp-inicia");
    expect(chave.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("text-whatsapp-inicia-limites").textContent).toMatch(/20.*100/);
    expect(state.atualizar).not.toHaveBeenCalled();
    fireEvent.click(chave);
    expect(state.atualizar).toHaveBeenCalledWith({ data: { iniciaConversaAtivo: true } });
  });

  it("com as respostas desligadas não deixa ligar o início e explica por quê", () => {
    state.canal = canal({ respondeAtivo: false });
    renderar();
    expect((screen.getByTestId("switch-whatsapp-inicia") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("box-whatsapp-inicia").textContent).toContain("a Sofia precisa estar respondendo no WhatsApp");
  });

  it("ligado, permite desligar", () => {
    state.canal = canal({ iniciaConversaAtivo: true });
    renderar();
    fireEvent.click(screen.getByTestId("switch-whatsapp-inicia"));
    expect(state.atualizar).toHaveBeenCalledWith({ data: { iniciaConversaAtivo: false } });
  });
});

describe("última falha de envio no cartão do WhatsApp", () => {
  const falha = (codigo: number | null) => ({ falhouEm: "2026-11-08T15:30:00.000Z", codigo });

  it("sem falha no envio mais recente, o aviso não aparece", () => {
    state.canal = canal({ ultimaFalhaDeEnvio: null });
    renderar();
    expect(screen.queryByTestId("box-whatsapp-ultima-falha")).toBeNull();
  });

  it("nome de exibição pendente (131037): mostra o motivo em português, a data e o que fazer", () => {
    state.canal = canal({ ultimaFalhaDeEnvio: falha(131037) });
    renderar();
    const caixa = screen.getByTestId("box-whatsapp-ultima-falha");
    expect(caixa.textContent).toContain("O envio mais recente pelo WhatsApp falhou");
    expect(screen.getByTestId("text-whatsapp-falha-motivo").textContent).toMatch(/nome de exibição.*ainda não foi aprovado pela Meta \(131037\)/);
    expect(screen.getByTestId("text-whatsapp-falha-quando").textContent).toMatch(/Falha registrada em .*08\/11\/2026/);
    expect(screen.getByTestId("text-whatsapp-falha-acao").textContent).toMatch(/aprovar o nome de exibição/);
  });

  it("token vencido (190): orienta renovar a conexão no Hablla", () => {
    state.canal = canal({ ultimaFalhaDeEnvio: falha(190) });
    renderar();
    expect(screen.getByTestId("text-whatsapp-falha-motivo").textContent).toMatch(/token de acesso da Meta/);
    expect(screen.getByTestId("text-whatsapp-falha-acao").textContent).toMatch(/renove a conexão do WhatsApp no Hablla/);
  });

  it("falha que se explica sozinha (fora da janela de 24h) não ganha orientação extra", () => {
    state.canal = canal({ ultimaFalhaDeEnvio: falha(131047) });
    renderar();
    expect(screen.getByTestId("text-whatsapp-falha-motivo").textContent).toMatch(/24h/);
    expect(screen.queryByTestId("text-whatsapp-falha-acao")).toBeNull();
  });

  it("código sem texto próprio mostra só o número; sem código, uma frase genérica", () => {
    state.canal = canal({ ultimaFalhaDeEnvio: falha(130429) });
    renderar();
    expect(screen.getByTestId("text-whatsapp-falha-motivo").textContent).toBe("Falha da Meta, código 130429.");
    cleanup();
    state.canal = canal({ ultimaFalhaDeEnvio: falha(null) });
    renderar();
    expect(screen.getByTestId("text-whatsapp-falha-motivo").textContent).toMatch(/não trouxe um código da Meta/);
  });

  it("em francês, o motivo e a orientação também são traduzidos", () => {
    localStorage.setItem("soundos_lang", "fr");
    state.canal = canal({ ultimaFalhaDeEnvio: falha(131037) });
    renderar();
    expect(screen.getByTestId("text-whatsapp-falha-motivo").textContent).toMatch(/nom d'affichage.*pas encore été approuvé par Meta \(131037\)/);
    expect(screen.getByTestId("text-whatsapp-falha-acao").textContent).toMatch(/approuver le nom d'affichage/);
    localStorage.clear();
  });
});

