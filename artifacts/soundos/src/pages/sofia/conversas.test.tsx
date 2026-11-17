// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import Conversas from "./conversas";

type Conv = {
  id: number; title: string; model: string; status: string; createdAt: string; canal: string; canalUsuario: string | null;
  handoffTriggeredAt?: string | null; firstMessage?: string | null; pessoaId?: number | null; pessoaNome?: string | null;
  arquivosNaoVistos?: number; primeiroArquivoNaoVistoEm?: string | null; cartaoAbertoId?: number | null; primeiraMensagemEhArquivo?: boolean;
  hidden?: boolean;
};

const state = vi.hoisted(() => ({
  areas: ["conversas", "crm"] as string[],
  conversas: [] as unknown[],
  assumir: vi.fn(),
  visibilidade: vi.fn(),
  listar: vi.fn(),
  opcoesAssumir: null as null | { mutation?: { onSuccess?: () => void } },
  opcoesResolver: null as null | { mutation?: { onSuccess?: () => void } },
}));

vi.mock("@/contexts/access", () => ({
  useAccess: () => ({ status: "ready", can: (area: string) => state.areas.includes(area) }),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListConversationsQueryKey: () => ["/api/sofia/conversations"],
  getListConversationsAwaitingStaffQueryKey: () => ["/api/sofia/conversations/awaiting-staff"],
  useListConversations: (params: unknown) => {
    state.listar(params);
    return { data: state.conversas, isLoading: false, error: null };
  },
  useUpdateConversationVisibility: () => ({ mutate: state.visibilidade, isPending: false }),
  useAssumeConversationHandoff: (options: typeof state.opcoesAssumir) => {
    state.opcoesAssumir = options;
    return { mutate: state.assumir, isPending: false };
  },
  useResolveConversationHandoff: (options: typeof state.opcoesResolver) => {
    state.opcoesResolver = options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

const AGORA = new Date("2026-10-31T12:00:00.000Z");
const minutosAtras = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();
const conv = (id: number, extra: Partial<Conv>): Conv => ({
  id, title: `Conversa ${id}`, model: "m", status: "ativa", createdAt: minutosAtras(600 + id), canal: "whatsapp", canalUsuario: "5511999990000", ...extra,
});

let queryClient: QueryClient;
function renderPagina() {
  const location = memoryLocation({ path: "/sofia/conversas", record: true });
  return render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <Router hook={location.hook}><Conversas /></Router>
      </LanguageProvider>
    </QueryClientProvider>,
  );
}
const linhas = () => screen.getAllByRole("row").slice(1);

describe("Conversas — aviso de clientes aguardando a equipe", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(AGORA);
    localStorage.setItem("soundos_lang", "pt");
    state.assumir.mockReset();
    state.visibilidade.mockReset();
    state.listar.mockReset();
    state.areas = ["conversas", "crm"];
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

  it("esconde as ocultas por padrão e permite mostrá-las e restaurá-las", () => {
    state.conversas = [conv(1, {}), conv(2, { hidden: true, status: "aguardando_humano" })];
    renderPagina();
    expect(state.listar).toHaveBeenLastCalledWith({ includeHidden: "false" });
    expect(screen.getByText("Conversa 1")).toBeTruthy();
    expect(screen.queryByText("Conversa 2")).toBeNull();
    expect(screen.queryByTestId("banner-conversas-aguardando")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Mostrar conversas ocultas" }));
    expect(state.listar).toHaveBeenLastCalledWith({ includeHidden: "true" });
    expect(screen.getByText("Conversa 2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("visibilidade-conversa-2"));
    expect(state.visibilidade).toHaveBeenCalledWith({ id: 2, data: { hidden: false } });
    fireEvent.click(screen.getByTestId("visibilidade-conversa-1"));
    expect(state.visibilidade).toHaveBeenCalledWith({ id: 1, data: { hidden: true } });
  });

  it("sem ninguém aguardando, não mostra aviso nem destaque", () => {
    state.conversas = [conv(1, {}), conv(2, { canal: "instagram", status: "atendimento_humano", handoffTriggeredAt: minutosAtras(30) })];
    renderPagina();
    expect(screen.queryByTestId("banner-conversas-aguardando")).toBeNull();
    expect(document.querySelector("[data-aguardando-equipe]")).toBeNull();
  });

  it("mostra quantos aguardam e há quanto tempo espera o mais antigo", () => {
    state.conversas = [
      conv(1, { status: "aguardando_humano", handoffTriggeredAt: minutosAtras(5) }),
      conv(2, { canal: "instagram", canalUsuario: "maria", status: "aguardando_humano", handoffTriggeredAt: minutosAtras(42) }),
    ];
    renderPagina();
    const banner = screen.getByTestId("banner-conversas-aguardando");
    expect(banner.textContent).toContain("2 conversas aguardando a equipe");
    expect(banner.textContent).toContain("A mais antiga espera há 42 minutos.");
  });

  it("no singular, e com o texto em francês quando o idioma é francês", () => {
    state.conversas = [conv(1, { status: "aguardando_humano", handoffTriggeredAt: minutosAtras(3) })];
    renderPagina();
    expect(screen.getByTestId("banner-conversas-aguardando").textContent).toContain("1 conversa aguardando a equipe");
    cleanup();
    localStorage.setItem("soundos_lang", "fr");
    renderPagina();
    const banner = screen.getByTestId("banner-conversas-aguardando");
    expect(banner.textContent).toContain("1 conversation en attente de l'équipe");
    expect(banner.textContent).toContain("La plus ancienne attend depuis 3 minutes.");
  });

  it("quem espera vem primeiro (o mais antigo no topo), destacado e com o tempo de espera, mesmo que a conversa seja velha", () => {
    state.conversas = [
      conv(1, {}),
      conv(2, { status: "atendimento_humano", handoffTriggeredAt: minutosAtras(90) }),
      conv(3, { status: "aguardando_humano", handoffTriggeredAt: minutosAtras(7) }),
      conv(4, { canal: "instagram", canalUsuario: "ana", status: "aguardando_humano", handoffTriggeredAt: minutosAtras(61) }),
    ];
    renderPagina();
    const ordem = linhas().map(l => l.textContent ?? "");
    expect(ordem[0]).toContain("Conversa 4");
    expect(ordem[1]).toContain("Conversa 3");
    expect(ordem[2]).toContain("Conversa 1");
    expect(ordem[3]).toContain("Conversa 2");

    const destacadas = Array.from(document.querySelectorAll("[data-aguardando-equipe]")).map(l => l.textContent ?? "");
    expect(destacadas).toHaveLength(2);
    expect(screen.getByTestId("espera-4").textContent).toBe("há 1 hora");
    expect(screen.getByTestId("espera-3").textContent).toBe("há 7 minutos");
    expect(screen.queryByTestId("espera-1")).toBeNull();
  });

  it("o chat interno aguardando não entra no aviso nem no destaque (só o selo de status de sempre)", () => {
    state.conversas = [
      conv(1, { canal: "interno", canalUsuario: null, status: "aguardando_humano", handoffTriggeredAt: minutosAtras(20) }),
    ];
    renderPagina();
    expect(screen.queryByTestId("banner-conversas-aguardando")).toBeNull();
    expect(document.querySelector("[data-aguardando-equipe]")).toBeNull();
    expect(within(linhas()[0]!).getByText("Aguardando humano")).toBeTruthy();
  });

  it("o tempo de espera acompanha o relógio sem nova consulta", () => {
    state.conversas = [conv(1, { status: "aguardando_humano", handoffTriggeredAt: minutosAtras(10) })];
    renderPagina();
    expect(screen.getByTestId("espera-1").textContent).toBe("há 10 minutos");
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(screen.getByTestId("espera-1").textContent).toBe("há 15 minutos");
  });

  it("assumir ou resolver atualiza a lista e o aviso do menu na hora", () => {
    state.conversas = [conv(1, { status: "aguardando_humano", handoffTriggeredAt: minutosAtras(10) })];
    renderPagina();
    fireEvent.click(within(linhas()[0]!).getByRole("button", { name: "Assumir" }));
    expect(state.assumir).toHaveBeenCalledWith({ id: 1 });

    const invalidar = vi.spyOn(queryClient, "invalidateQueries");
    state.opcoesAssumir!.mutation!.onSuccess!();
    state.opcoesResolver!.mutation!.onSuccess!();
    const chaves = invalidar.mock.calls.map(([filtro]) => (filtro as { queryKey: unknown[] }).queryKey[0]);
    expect(chaves.filter(k => k === "/api/sofia/conversations")).toHaveLength(2);
    expect(chaves.filter(k => k === "/api/sofia/conversations/awaiting-staff")).toHaveLength(2);
  });
});

describe("Conversas — arquivos recebidos ainda não vistos", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(AGORA);
    localStorage.setItem("soundos_lang", "pt");
    state.areas = ["conversas", "crm"];
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

  it("arquivo não visto no WhatsApp entra no aviso mesmo com a Sofia atendendo, com selo e atalho para o cartão", () => {
    state.conversas = [
      conv(1, { arquivosNaoVistos: 1, primeiroArquivoNaoVistoEm: minutosAtras(12), cartaoAbertoId: 77, primeiraMensagemEhArquivo: true }),
      conv(2, {}),
    ];
    renderPagina();
    expect(screen.getByTestId("banner-conversas-aguardando").textContent).toContain("1 conversa aguardando a equipe");
    expect(screen.getByTestId("banner-conversas-aguardando").textContent).toContain("há 12 minutos");
    expect(screen.getByTestId("badge-arquivo-novo-1").textContent).toContain("Arquivo novo");
    expect(screen.queryByTestId("badge-arquivo-novo-2")).toBeNull();
    expect(screen.getByTestId("espera-1").textContent).toBe("há 12 minutos");
    expect(linhas()[0]!.textContent).toContain("Arquivo");
  });

  it("a mesma conversa aguardando a equipe e com arquivo novo conta uma vez, desde o mais antigo dos dois", () => {
    state.conversas = [conv(1, {
      status: "aguardando_humano", handoffTriggeredAt: minutosAtras(5),
      arquivosNaoVistos: 2, primeiroArquivoNaoVistoEm: minutosAtras(30),
    })];
    renderPagina();
    const banner = screen.getByTestId("banner-conversas-aguardando");
    expect(banner.textContent).toContain("1 conversa aguardando a equipe");
    expect(banner.textContent).toContain("há 30 minutos");
    expect(screen.getByTestId("badge-arquivo-novo-1").textContent).toContain("2 arquivos novos");
  });

  it("conversa com todos os arquivos vistos volta ao normal; chat interno e Instagram nunca ganham o selo", () => {
    state.conversas = [
      conv(1, { arquivosNaoVistos: 0 }),
      conv(2, { canal: "interno", canalUsuario: null, arquivosNaoVistos: 3 }),
      conv(3, { canal: "instagram", canalUsuario: "ana", arquivosNaoVistos: 1 }),
    ];
    renderPagina();
    expect(screen.queryByTestId("banner-conversas-aguardando")).toBeNull();
    expect(document.querySelector("[data-testid^='badge-arquivo-novo']")).toBeNull();
  });

  it("o atalho abre o cartão da pessoa; sem cartão aberto ou sem a área CRM ele não aparece", () => {
    state.conversas = [
      conv(1, { arquivosNaoVistos: 1, primeiroArquivoNaoVistoEm: minutosAtras(3), cartaoAbertoId: 77 }),
      conv(2, { arquivosNaoVistos: 1, primeiroArquivoNaoVistoEm: minutosAtras(2), cartaoAbertoId: null }),
    ];
    renderPagina();
    expect(screen.queryByTestId("abrir-cartao-2")).toBeNull();
    expect(screen.getByTestId("abrir-cartao-1").textContent).toBe("Abrir cartão");
    cleanup();
    state.areas = ["conversas"];
    renderPagina();
    expect(screen.queryByTestId("abrir-cartao-1")).toBeNull();
  });

  it("em francês, o selo e o atalho saem traduzidos", () => {
    localStorage.setItem("soundos_lang", "fr");
    state.conversas = [conv(1, { arquivosNaoVistos: 1, primeiroArquivoNaoVistoEm: minutosAtras(3), cartaoAbertoId: 9 })];
    renderPagina();
    expect(screen.getByTestId("badge-arquivo-novo-1").textContent).toContain("Nouveau fichier");
    expect(screen.getByTestId("abrir-cartao-1").textContent).toBe("Ouvrir la fiche");
  });
});
