// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import { INTERVALO_DO_AVISO_MS, useConversasAguardandoEquipe } from "./use-conversas-aguardando";

const state = vi.hoisted(() => ({
  areas: ["conversas"] as string[],
  resposta: { total: 0, respostasNaoEntregues: 0, oldestWaitingSince: null, conversations: [] } as {
    total: number; respostasNaoEntregues: number; oldestWaitingSince: string | null;
    conversations: Array<{ id: number; title: string; canal: string; canalUsuario: string | null; waitingSince: string }>;
  },
  consultas: 0,
  opcoes: null as null | { query?: Record<string, unknown> },
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { warning: state.toast } }));

vi.mock("@/contexts/access", () => ({
  useAccess: () => ({ status: "ready", areas: state.areas, can: (id: string) => state.areas.includes(id) }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    getListConversationsQueryKey: () => ["/api/sofia/conversations"],
    getListConversationsAwaitingStaffQueryKey: () => ["/api/sofia/conversations/awaiting-staff"],
    useListConversationsAwaitingStaff: (options?: { query?: Record<string, unknown> }) => {
      state.opcoes = options ?? null;
      return useQuery({
        queryKey: ["/api/sofia/conversations/awaiting-staff"],
        queryFn: async () => { state.consultas += 1; return structuredClone(state.resposta); },
        enabled: options?.query?.enabled as boolean | undefined,
      });
    },
  };
});

const conversa = (id: number, title: string) => ({ id, title, canal: "whatsapp", canalUsuario: "5511999990001", waitingSince: new Date().toISOString() });
const definir = (conversations: ReturnType<typeof conversa>[], total = conversations.length) => {
  state.resposta = { total, respostasNaoEntregues: state.resposta.respostasNaoEntregues, oldestWaitingSince: conversations.length ? new Date().toISOString() : null, conversations };
};

let queryClient: QueryClient;
const abrir = vi.fn();

function Sonda() {
  const { aguardando, naoEntregues } = useConversasAguardandoEquipe(abrir);
  return <><span data-testid="total">{aguardando}</span><span data-testid="nao-entregues">{naoEntregues}</span></>;
}

function montar() {
  return render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider><Sonda /></LanguageProvider>
    </QueryClientProvider>,
  );
}
/** Espera a primeira resposta chegar ao hook (e o efeito registrar o que já era conhecido). */
const primeiraLeitura = () => act(async () => {
  await waitFor(() => expect(queryClient.getQueryState(["/api/sofia/conversations/awaiting-staff"])?.status).toBe("success"));
  await new Promise(resolve => setTimeout(resolve, 10));
});
const atualizar = () => act(async () => { await queryClient.invalidateQueries({ queryKey: ["/api/sofia/conversations/awaiting-staff"] }); });

describe("aviso de conversas aguardando a equipe", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    state.areas = ["conversas"];
    definir([]);
    state.resposta.respostasNaoEntregues = 0;
    state.consultas = 0;
    state.opcoes = null;
    state.toast.mockReset();
    abrir.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it("consulta a cada 15 segundos, também com a aba em segundo plano", async () => {
    montar();
    await waitFor(() => expect(state.consultas).toBe(1));
    expect(INTERVALO_DO_AVISO_MS).toBe(15_000);
    expect(state.opcoes?.query).toMatchObject({ enabled: true, refetchInterval: 15_000, refetchIntervalInBackground: true, refetchOnWindowFocus: "always" });
  });

  it("sem a área Conversas não consulta nada e a contagem é zero", async () => {
    state.areas = ["chat"];
    definir([conversa(1, "WhatsApp +55 11 99999-0001")]);
    montar();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(state.consultas).toBe(0);
    expect(screen.getByTestId("total").textContent).toBe("0");
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("a primeira leitura só mostra a contagem, sem aviso na tela", async () => {
    definir([conversa(1, "WhatsApp +55 11 99999-0001"), conversa(2, "Instagram @maria")]);
    montar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("2"));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("conversa nova avisa na tela com o contato e um atalho para Conversas, e atualiza a lista", async () => {
    montar();
    await primeiraLeitura();
    const invalidar = vi.spyOn(queryClient, "invalidateQueries");

    definir([conversa(7, "WhatsApp +55 11 99999-0007")]);
    await atualizar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("1"));
    expect(state.toast).toHaveBeenCalledTimes(1);
    const [titulo, opcoes] = state.toast.mock.calls[0]!;
    expect(titulo).toBe("Cliente aguardando a equipe");
    expect(opcoes).toMatchObject({ description: "WhatsApp +55 11 99999-0007", action: { label: "Abrir Conversas" } });
    opcoes.action.onClick();
    expect(abrir).toHaveBeenCalledTimes(1);
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ["/api/sofia/conversations"] });

    // A mesma conversa em outra conferência não avisa de novo.
    await atualizar();
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  it("várias conversas novas de uma vez viram um aviso só, com o número", async () => {
    montar();
    await primeiraLeitura();
    definir([conversa(1, "WhatsApp A"), conversa(2, "Instagram B"), conversa(3, "WhatsApp C")]);
    await atualizar();
    await waitFor(() => expect(state.toast).toHaveBeenCalledTimes(1));
    expect(state.toast.mock.calls[0]![0]).toBe("3 clientes aguardando a equipe");
    expect(state.toast.mock.calls[0]![1].description).toBeUndefined();
  });

  it("quando alguém assume ou resolve, a contagem cai e a lista é atualizada, sem aviso na tela", async () => {
    definir([conversa(1, "WhatsApp A"), conversa(2, "Instagram B")]);
    montar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("2"));
    const invalidar = vi.spyOn(queryClient, "invalidateQueries");

    definir([conversa(2, "Instagram B")]);
    await atualizar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("1"));
    definir([]);
    await atualizar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("0"));
    expect(state.toast).not.toHaveBeenCalled();
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ["/api/sofia/conversations"] });
  });

  it("o total vem do servidor mesmo quando a lista traz só as mais recentes", async () => {
    definir([conversa(1, "WhatsApp A")], 37);
    montar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("37"));
  });

  it("respostas não entregues vêm separadas da contagem aguardando a equipe e não geram aviso na tela", async () => {
    state.resposta = { total: 1, respostasNaoEntregues: 4, oldestWaitingSince: new Date().toISOString(), conversations: [conversa(1, "WhatsApp A")] };
    montar();
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("1"));
    expect(screen.getByTestId("nao-entregues").textContent).toBe("4");

    state.resposta = { ...state.resposta, respostasNaoEntregues: 5 };
    await atualizar();
    await waitFor(() => expect(screen.getByTestId("nao-entregues").textContent).toBe("5"));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("sem a área Conversas as duas contagens são zero", async () => {
    state.areas = ["chat"];
    state.resposta = { total: 2, respostasNaoEntregues: 3, oldestWaitingSince: null, conversations: [] };
    montar();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(screen.getByTestId("total").textContent).toBe("0");
    expect(screen.getByTestId("nao-entregues").textContent).toBe("0");
  });
});
