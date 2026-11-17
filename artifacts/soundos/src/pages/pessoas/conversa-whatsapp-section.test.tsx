// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";

const state = vi.hoisted(() => ({
  resposta: { data: undefined as unknown, isLoading: false, isError: false },
  refetch: vi.fn(),
  marcarVistos: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async importOriginal => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...original,
    useGetPessoaWhatsappConversation: () => ({ ...state.resposta, refetch: state.refetch }),
    useMarkCommercialOpportunityChatSeen: () => ({ mutate: state.marcarVistos, isPending: false }),
    markConversationAttachmentsSeen: state.marcarVistos,
    getAttachmentFile: async () => new Blob(["x"]),
    useRetryAttachmentCopy: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { ConversaWhatsappDaFicha } from "./conversa-whatsapp-section";

function renderizar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LanguageProvider><ConversaWhatsappDaFicha pessoaId={3} /></LanguageProvider>
    </QueryClientProvider>,
  );
}

const resposta = (parcial: Record<string, unknown>) => ({
  pessoaId: 3,
  vinculo: { tipo: "vinculada", conversationId: 9 },
  conversa: { id: 9, status: "atendimento_humano" },
  mensagens: [],
  ...parcial,
});

beforeEach(() => {
  localStorage.setItem("soundos_lang", "pt");
  vi.clearAllMocks();
  state.resposta = { data: undefined, isLoading: false, isError: false };
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe("conversa de WhatsApp na ficha da pessoa", () => {
  it("mostra a conversa inteira só para leitura, com arquivos e legenda, sem dar nada como visto", () => {
    state.resposta.data = resposta({
      mensagens: [
        { id: 1, conversationId: 9, role: "user", content: "Olá", kind: null, createdAt: "2026-11-02T13:00:00.000Z" },
        {
          id: 2, conversationId: 9, role: "user", content: "Comprovante", kind: "anexo", createdAt: "2026-11-02T13:01:00.000Z",
          anexo: {
            id: 51, tipo: "document", direcao: "recebido", nome: "comprovante.pdf", mimeType: "application/pdf",
            tamanhoBytes: 1024, copia: "copiado", motivo: null, naoVisto: true, podeRecopiar: false,
          },
        },
      ],
    });
    renderizar();
    const lista = screen.getByTestId("pessoa-conversa-mensagens");
    expect(lista.textContent).toContain("Olá");
    expect(lista.textContent).toContain("Comprovante");
    expect(screen.getByTestId("anexo-51")).toBeDefined();
    expect(screen.getByTestId("anexo-novo-51")).toBeDefined();
    expect(screen.queryByTestId("crm-chat-texto")).toBeNull();
    expect(screen.queryByTestId("crm-chat-anexar")).toBeNull();
    expect(state.marcarVistos).not.toHaveBeenCalled();
  });

  it.each([
    ["nenhuma", "pessoa-conversa-sem-vinculo"],
    ["a_confirmar", "pessoa-conversa-a-confirmar"],
  ])("vínculo %s mostra só o aviso, sem mensagens", (tipo, testid) => {
    state.resposta.data = resposta({ vinculo: { tipo, motivo: "telefone_em_varias_fichas" }, conversa: null });
    renderizar();
    expect(screen.getByTestId(testid)).toBeDefined();
    expect(screen.queryByTestId("pessoa-conversa-mensagens")).toBeNull();
  });

  it("erro ao carregar mostra o aviso de erro", () => {
    state.resposta = { data: undefined, isLoading: false, isError: true };
    renderizar();
    expect(screen.getByTestId("pessoa-conversa-erro")).toBeDefined();
  });
});
