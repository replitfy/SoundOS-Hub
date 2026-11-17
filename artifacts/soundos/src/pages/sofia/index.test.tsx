// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import { UserSessionProvider } from "@/contexts/user-session";
import SofiaChat from "./index";

vi.mock("@/contexts/access", async () => {
  const base = (await import("@/test/access-mock")).accessMock(() => true);
  // Só a área Conversas varia entre os testes; as demais continuam liberadas.
  return { useAccess: () => ({ ...base.useAccess(), can: (area: string) => area !== "conversas" || apiMocks.podeConversas }) };
});

const apiMocks = vi.hoisted(() => ({
  statuses: new Map<number, string>(),
  getConversation: vi.fn(),
  marcarVistos: vi.fn(),
  podeConversas: true,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  const conversationKey = (id: number) => ["/api/sofia/conversations", id];
  return {
    getGetConversationQueryKey: conversationKey,
    getListConversationDecisionRunsQueryKey: (id: number) => ["/api/sofia/conversations", id, "decision-runs"],
    useGetConversation: (id: number, options?: { query?: { enabled?: boolean } }) => useQuery({
      queryKey: conversationKey(id),
      queryFn: () => apiMocks.getConversation(id),
      enabled: options?.query?.enabled ?? !!id,
      initialData: id ? { id, status: apiMocks.statuses.get(id) ?? "ativa" } : undefined,
    }),
    getListConversationsQueryKey: () => ["/api/sofia/conversations"],
    getListConversationsAwaitingStaffQueryKey: () => ["/api/sofia/conversations/awaiting-staff"],
    markConversationAttachmentsSeen: (...args: unknown[]) => apiMocks.marcarVistos(...args),
    getAttachmentFile: async () => new Blob(["x"]),
    useRetryAttachmentCopy: () => ({ mutate: vi.fn(), isPending: false }),
    useListConversationDecisionRuns: () => ({
      data: [],
      isLoading: false,
      isError: false,
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <UserSessionProvider>
          <SofiaChat />
        </UserSessionProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

describe("Sofia new conversation reset", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: 1,
      name: "Equipe Teste",
      email: "equipe@example.com",
      sessionToken: "signed-test-token",
    }));
    apiMocks.statuses.clear();
    apiMocks.podeConversas = true;
    apiMocks.marcarVistos.mockReset();
    apiMocks.marcarVistos.mockResolvedValue(undefined);
    apiMocks.getConversation.mockImplementation(async (id: number) => ({
      id,
      status: apiMocks.statuses.get(id) ?? "ativa",
    }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/sofia/prompts")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ isActive: true, model: "gpt-5.4-mini", version: "teste" }],
        });
      }
      const messageMatch = url.match(/\/api\/sofia\/conversations\/(\d+)\/messages/);
      if (messageMatch) {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            id: Number(messageMatch[1]),
            role: "user",
            content: `Mensagem da conversa ${messageMatch[1]}`,
          }],
        });
      }
      if (url.startsWith("/api/pessoas/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            nome: "Pessoa",
            sobrenome: "Anterior",
            celular: "+55 11 98888-0001",
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["aguardando_humano", 101],
    ["atendimento_humano", 202],
  ])("clears %s locally and restores it when reopening the conversation", async (status, conversationId) => {
    apiMocks.statuses.set(conversationId, status);
    window.history.replaceState(null, "", `/sofia?pessoa=7&conv=${conversationId}`);
    renderChat();

    await screen.findByText(`Mensagem da conversa ${conversationId}`);
    expect(screen.getByTestId("sofia-handoff-banner")).toBeDefined();
    expect((screen.getByTestId("sofia-message-input") as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => {
      expect((screen.getByPlaceholderText("Ex.: Ana Souza") as HTMLInputElement).value).toBe("Pessoa Anterior");
    });

    fireEvent.click(screen.getByTestId("button-new-conversation"));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/sofia");
      expect(window.location.search).toBe("");
      expect(screen.queryByTestId("sofia-handoff-banner")).toBeNull();
      expect((screen.getByTestId("sofia-message-input") as HTMLInputElement).disabled).toBe(false);
      expect(screen.queryByText(`Mensagem da conversa ${conversationId}`)).toBeNull();
      expect((screen.getByPlaceholderText("Ex.: Ana Souza") as HTMLInputElement).value).toBe("");
      expect((screen.getByPlaceholderText("(DDD) 9XXXX-XXXX") as HTMLInputElement).value).toBe("");
    });

    window.history.pushState(null, "", `/sofia?pessoa=7&conv=${conversationId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));

    await screen.findByText(`Mensagem da conversa ${conversationId}`);
    expect(screen.getByTestId("sofia-handoff-banner")).toBeDefined();
    expect((screen.getByTestId("sofia-message-input") as HTMLInputElement).disabled).toBe(true);
  });

  it("sends no test identity when name and phone are empty", async () => {
    renderChat();
    fireEvent.change(screen.getByTestId("sofia-message-input"), { target: { value: "Qual o próximo evento?" } });
    fireEvent.keyDown(screen.getByTestId("sofia-message-input"), { key: "Enter" });

    await waitFor(() => {
      const chatCall = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/sofia/chat");
      expect(chatCall).toBeDefined();
      const body = JSON.parse(String((chatCall![1] as RequestInit).body));
      expect(body.message).toBe("Qual o próximo evento?");
      expect(body).not.toHaveProperty("pessoaNome");
      expect(body).not.toHaveProperty("pessoaCelular");
    });
  });

  it("ignores old status, history, and person responses that finish after reset", async () => {
    const conversationId = 303;
    apiMocks.statuses.set(conversationId, "aguardando_humano");
    const statusResponse = deferred<{ id: number; status: string }>();
    const historyResponse = deferred<{ ok: boolean; json: () => Promise<unknown[]> }>();
    const personResponse = deferred<{ ok: boolean; json: () => Promise<Record<string, string>> }>();
    apiMocks.getConversation.mockReturnValue(statusResponse.promise);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/sofia/prompts")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ isActive: true, model: "gpt-5.4-mini", version: "teste" }],
        });
      }
      if (url.includes(`/conversations/${conversationId}/messages`)) return historyResponse.promise;
      if (url === "/api/pessoas/7") return personResponse.promise;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
    window.history.replaceState(null, "", `/sofia?pessoa=7&conv=${conversationId}`);
    renderChat();

    expect(screen.getByTestId("sofia-handoff-banner")).toBeDefined();
    expect((screen.getByTestId("sofia-message-input") as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        `/api/sofia/conversations/${conversationId}/messages`,
        expect.any(Object),
      );
      expect(fetch).toHaveBeenCalledWith("/api/pessoas/7", expect.any(Object));
    });

    fireEvent.click(screen.getByTestId("button-new-conversation"));
    statusResponse.resolve({ id: conversationId, status: "aguardando_humano" });
    historyResponse.resolve({
      ok: true,
      json: async () => [{ id: 1, role: "user", content: "Mensagem antiga atrasada" }],
    });
    personResponse.resolve({
      ok: true,
      json: async () => ({
        nome: "Pessoa",
        sobrenome: "Atrasada",
        celular: "+55 11 99999-0000",
      }),
    });

    await waitFor(() => {
      expect(screen.queryByTestId("sofia-handoff-banner")).toBeNull();
      expect((screen.getByTestId("sofia-message-input") as HTMLInputElement).disabled).toBe(false);
      expect(screen.queryByText("Mensagem antiga atrasada")).toBeNull();
      expect((screen.getByPlaceholderText("Ex.: Ana Souza") as HTMLInputElement).value).toBe("");
      expect((screen.getByPlaceholderText("(DDD) 9XXXX-XXXX") as HTMLInputElement).value).toBe("");
    });
  });

  const historicoComArquivo = (naoVisto: boolean) => vi.fn().mockImplementation((url: string) => {
    if (url.startsWith("/api/sofia/prompts")) {
      return Promise.resolve({ ok: true, json: async () => [{ isActive: true, model: "gpt-5.4-mini", version: "teste" }] });
    }
    if (url.includes("/conversations/301/messages")) {
      return Promise.resolve({
        ok: true,
        json: async () => [
          {
            id: 1, role: "user", content: "Segue o comprovante", kind: "anexo",
            anexo: {
              id: 41, tipo: "document", direcao: "recebido", nome: "comprovante.pdf", mimeType: "application/pdf",
              tamanhoBytes: 4096, copia: "copiado", motivo: null, naoVisto, podeRecopiar: false,
            },
          },
          { id: 2, role: "assistant", content: "Recebi o arquivo, mas não consigo abrir anexos. Já avisei a equipe.", kind: "aviso_anexo" },
        ],
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });

  it("abrir a conversa mostra o arquivo com a legenda e a frase da Sofia, e dá os arquivos novos como vistos uma vez", async () => {
    vi.stubGlobal("fetch", historicoComArquivo(true));
    window.history.replaceState(null, "", "/sofia?conv=301");
    renderChat();

    await screen.findByText("Segue o comprovante");
    expect(screen.getByTestId("anexo-41")).toBeDefined();
    expect(screen.getByTestId("anexo-novo-41")).toBeDefined();
    expect(screen.getByText(/não consigo abrir anexos/)).toBeDefined();
    await waitFor(() => expect(apiMocks.marcarVistos).toHaveBeenCalledTimes(1));
    expect(apiMocks.marcarVistos).toHaveBeenCalledWith(301);
  });

  it("sem a área Conversas, ou sem arquivo novo, nada é dado como visto", async () => {
    vi.stubGlobal("fetch", historicoComArquivo(true));
    apiMocks.podeConversas = false;
    window.history.replaceState(null, "", "/sofia?conv=301");
    renderChat();
    await screen.findByText("Segue o comprovante");
    expect(apiMocks.marcarVistos).not.toHaveBeenCalled();
    cleanup();

    apiMocks.podeConversas = true;
    vi.stubGlobal("fetch", historicoComArquivo(false));
    renderChat();
    await screen.findByText("Segue o comprovante");
    expect(screen.queryByTestId("anexo-novo-41")).toBeNull();
    expect(apiMocks.marcarVistos).not.toHaveBeenCalled();
  });
});
