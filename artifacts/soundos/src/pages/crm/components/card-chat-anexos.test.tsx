// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialChat, Message, MessageAttachment } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";

const state = vi.hoisted(() => ({
  chat: null as unknown,
  enviarArquivo: vi.fn(),
  marcarVistos: vi.fn(),
  recopiar: vi.fn(),
  baixar: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async importOriginal => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  const mutation = (mutate: ReturnType<typeof vi.fn>) => () => ({ mutate, mutateAsync: mutate, isPending: false });
  return {
    ...original,
    useGetCommercialOpportunityChat: () => ({ data: state.chat, isLoading: false, isError: false }),
    useSendCommercialOpportunityChatMessage: mutation(vi.fn()),
    useAssumeCommercialOpportunityChat: mutation(vi.fn()),
    useReturnCommercialOpportunityChat: mutation(vi.fn()),
    useLinkCommercialOpportunityConversation: mutation(vi.fn()),
    useGetCommercialOpportunityOpeningTemplate: () => ({ data: undefined, isLoading: false, isError: false }),
    useSendCommercialOpportunityOpeningTemplate: mutation(vi.fn()),
    useSendCommercialOpportunityChatAttachment: mutation(state.enviarArquivo),
    useMarkCommercialOpportunityChatSeen: mutation(state.marcarVistos),
    useRetryAttachmentCopy: mutation(state.recopiar),
    getAttachmentFile: (...args: unknown[]) => state.baixar(...args),
  };
});

import { CardChat } from "./card-chat";

beforeEach(() => {
  vi.clearAllMocks();
  state.baixar.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
  state.enviarArquivo.mockResolvedValue({ messageId: 1, anexoId: 1 });
  URL.createObjectURL = vi.fn(() => "blob:arquivo-falso");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); });

function anexo(parcial: Partial<MessageAttachment> & { id: number }): MessageAttachment {
  return {
    tipo: "image", direcao: "recebido", nome: "foto.png", mimeType: "image/png", tamanhoBytes: 2048,
    copia: "copiado", motivo: null, naoVisto: false, podeRecopiar: false, ...parcial,
  } as MessageAttachment;
}

function mensagem(parcial: Partial<Message> & { id: number }): Message {
  return { conversationId: 9, role: "user", content: "", kind: "anexo", createdAt: "2026-11-02T13:00:00.000Z", ...parcial } as Message;
}

function chat(parcial: Partial<CommercialChat> = {}): CommercialChat {
  return {
    pessoaId: 1,
    vinculo: { tipo: "vinculada", conversationId: 9 },
    conversa: { id: 9, status: "atendimento_humano" },
    mensagens: [],
    janelaAte: "2026-11-03T13:00:00.000Z",
    janelaAberta: true,
    contato: { autorizado: true, naoQuerReceber: false },
    podeEnviarTexto: true,
    bloqueiosDeTexto: [],
    ...parcial,
  } as CommercialChat;
}

function arvore(props: { closed?: boolean; ativa?: boolean } = {}) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LanguageProvider>
        <CardChat opportunityId={5} closed={props.closed ?? false} ativa={props.ativa} />
      </LanguageProvider>
    </QueryClientProvider>
  );
}

const arquivo = (nome: string, tipo: string, tamanho?: number) => {
  const f = new File(["conteudo"], nome, { type: tipo });
  if (tamanho !== undefined) Object.defineProperty(f, "size", { value: tamanho });
  return f;
};

function escolher(arquivos: File[]) {
  fireEvent.change(screen.getByTestId("crm-chat-arquivo-input"), { target: { files: arquivos } });
}

describe("arquivos recebidos no chat do cartão", () => {
  it("imagem copiada é buscada com a sessão e aparece com a legenda", async () => {
    state.chat = chat({ mensagens: [mensagem({ id: 1, content: "Segue o comprovante", anexo: anexo({ id: 11 }) })] });
    render(arvore());
    await waitFor(() => expect(screen.getByAltText("Imagem da conversa").getAttribute("src")).toBe("blob:arquivo-falso"));
    expect(state.baixar).toHaveBeenCalledWith(11);
    expect(screen.getByTestId("crm-chat-msg-1").textContent).toContain("Segue o comprovante");
  });

  it("vídeo só é baixado quando a pessoa pede; documento baixa por botão", async () => {
    state.chat = chat({
      mensagens: [
        mensagem({ id: 1, anexo: anexo({ id: 12, tipo: "video", nome: "aula.mp4" }) }),
        mensagem({ id: 2, anexo: anexo({ id: 13, tipo: "document", nome: "contrato.pdf" }) }),
      ],
    });
    render(arvore());
    expect(state.baixar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("anexo-carregar-12"));
    await waitFor(() => expect(screen.getByTestId("anexo-video-12")).toBeTruthy());
    expect(state.baixar).toHaveBeenCalledWith(12);
    expect(screen.getByTestId("anexo-baixar-13")).toBeTruthy();
  });

  it("estados da cópia: pendente, indisponível (com nova tentativa) e recusado (com motivo, sem tentativa)", () => {
    state.chat = chat({
      mensagens: [
        mensagem({ id: 1, anexo: anexo({ id: 21, copia: "pendente" }) }),
        mensagem({ id: 2, anexo: anexo({ id: 22, copia: "indisponivel", motivo: "download_falhou", podeRecopiar: true }) }),
        mensagem({ id: 3, anexo: anexo({ id: 23, copia: "recusado", motivo: "tipo_nao_permitido" }) }),
      ],
    });
    render(arvore());
    expect(screen.getByTestId("anexo-21").textContent).toContain("Copiando o arquivo");
    expect(screen.getByTestId("anexo-estado-22").textContent).toContain("Arquivo indisponível");
    expect(screen.getByTestId("anexo-motivo-22").textContent).toContain("não foi possível baixar o arquivo");
    expect(screen.getByTestId("anexo-estado-23").textContent).toContain("Arquivo recusado");
    expect(screen.getByTestId("anexo-motivo-23").textContent).toContain("tipo de arquivo não permitido");
    expect(screen.queryByTestId("anexo-recopiar-23")).toBeNull();
    expect(state.baixar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("anexo-recopiar-22"));
    expect(state.recopiar).toHaveBeenCalledWith({ id: 22 }, expect.anything());
  });

  it("arquivo não visto fica realçado e é dado como visto uma vez, só com a aba da conversa à vista", async () => {
    state.chat = chat({ mensagens: [mensagem({ id: 1, anexo: anexo({ id: 31, naoVisto: true }) })] });
    const { rerender } = render(arvore({ ativa: false }));
    expect(screen.getByTestId("anexo-novo-31")).toBeTruthy();
    expect(state.marcarVistos).not.toHaveBeenCalled();

    rerender(arvore({ ativa: true }));
    await waitFor(() => expect(state.marcarVistos).toHaveBeenCalledTimes(1));
    expect(state.marcarVistos).toHaveBeenCalledWith({ id: 5 }, expect.anything());

    // Depois de visto no servidor, o realce continua enquanto o cartão está aberto, sem pedir de novo.
    state.chat = chat({ mensagens: [mensagem({ id: 1, anexo: anexo({ id: 31, naoVisto: false }) })] });
    rerender(arvore({ ativa: true }));
    expect(screen.getByTestId("anexo-novo-31")).toBeTruthy();
    expect(state.marcarVistos).toHaveBeenCalledTimes(1);
  });

  it("sem arquivos novos não marca nada como visto", () => {
    state.chat = chat({ mensagens: [mensagem({ id: 1, anexo: anexo({ id: 32 }) })] });
    render(arvore());
    expect(state.marcarVistos).not.toHaveBeenCalled();
    expect(screen.queryByTestId("anexo-novo-32")).toBeNull();
  });
});

describe("envio de arquivo pela equipe", () => {
  it("mostra os limites por tipo e deixa anexar com o atendimento assumido", () => {
    state.chat = chat();
    render(arvore());
    expect(screen.getByTestId("crm-chat-limites").textContent).toContain("imagem até 5 MB");
    expect(screen.getByTestId("crm-chat-limites").textContent).toContain("documento até 100 MB");
    expect((screen.getByTestId("crm-chat-anexar") as HTMLButtonElement).disabled).toBe(false);
  });

  it("antes de assumir, com a janela fechada ou com o cartão encerrado, não deixa anexar", () => {
    state.chat = chat({ conversa: { id: 9, status: "ativa" }, podeEnviarTexto: false, bloqueiosDeTexto: ["atendimento_nao_assumido"] });
    render(arvore());
    expect((screen.getByTestId("crm-chat-anexar") as HTMLButtonElement).disabled).toBe(true);
    escolher([arquivo("a.pdf", "application/pdf")]);
    expect(screen.queryByTestId("crm-chat-fila")).toBeNull();
    cleanup();

    state.chat = chat();
    render(arvore({ closed: true }));
    expect((screen.getByTestId("crm-chat-anexar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("escolhe um arquivo, escreve a legenda e envia uma vez; ao aceitar, sai da fila", async () => {
    state.chat = chat();
    render(arvore());
    const pdf = arquivo("contrato.pdf", "application/pdf");
    escolher([pdf]);
    const item = screen.getByTestId("crm-chat-fila").querySelector("li")!;
    expect(item.textContent).toContain("contrato.pdf");
    fireEvent.change(item.querySelector("input")!, { target: { value: "  Contrato assinado  " } });
    fireEvent.click(screen.getByTestId("crm-chat-enviar-arquivos"));
    await waitFor(() => expect(state.enviarArquivo).toHaveBeenCalledTimes(1));
    expect(state.enviarArquivo).toHaveBeenCalledWith({ id: 5, data: { arquivo: pdf, legenda: "Contrato assinado" } });
    await waitFor(() => expect(screen.queryByTestId("crm-chat-fila")).toBeNull());
  });

  it("áudio não aceita legenda e vai sem ela", async () => {
    state.chat = chat();
    render(arvore());
    const audio = arquivo("voz.ogg", "audio/ogg");
    escolher([audio]);
    const item = screen.getByTestId("crm-chat-fila").querySelector("li")!;
    expect(item.querySelector("input")).toBeNull();
    expect(item.textContent).toContain("Áudio não aceita legenda");
    fireEvent.click(screen.getByTestId("crm-chat-enviar-arquivos"));
    await waitFor(() => expect(state.enviarArquivo).toHaveBeenCalledWith({ id: 5, data: { arquivo: audio } }));
  });

  it("arquivo acima do limite do tipo mostra o erro e bloqueia o envio, sem chamar o servidor", () => {
    state.chat = chat();
    render(arvore());
    escolher([arquivo("grande.png", "image/png", 6 * 1024 * 1024)]);
    expect(screen.getByTestId("crm-chat-fila").textContent).toContain("Imagem acima de 5 MB.");
    expect((screen.getByTestId("crm-chat-enviar-arquivos") as HTMLButtonElement).disabled).toBe(true);
    expect(state.enviarArquivo).not.toHaveBeenCalled();
  });

  it("vários arquivos vão um por mensagem, na ordem; ao primeiro que falha, os outros ficam sem tentativa", async () => {
    state.chat = chat();
    state.enviarArquivo.mockRejectedValueOnce(new Error("falhou"));
    render(arvore());
    const a = arquivo("a.pdf", "application/pdf");
    const b = arquivo("b.pdf", "application/pdf");
    escolher([a, b]);
    expect(screen.getByTestId("crm-chat-fila").querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("crm-chat-enviar-arquivos"));
    await waitFor(() => expect(state.enviarArquivo).toHaveBeenCalledTimes(1));
    expect(state.enviarArquivo).toHaveBeenCalledWith({ id: 5, data: { arquivo: a } });
    await waitFor(() => expect(screen.getByTestId("crm-chat-fila").querySelectorAll("li")).toHaveLength(2));
    expect(state.enviarArquivo).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("crm-chat-fila").textContent).toContain("Não foi possível concluir a ação");
  });

  it("colar e arrastar arquivos entram na fila; remover tira da fila", () => {
    state.chat = chat();
    render(arvore());
    const imagem = arquivo("print.png", "image/png");
    fireEvent.paste(screen.getByTestId("crm-chat-texto"), { clipboardData: { files: [imagem], types: ["Files"] } });
    expect(screen.getByTestId("crm-chat-fila").querySelectorAll("li")).toHaveLength(1);

    const compositor = screen.getByTestId("crm-chat-compositor");
    const doc = arquivo("lista.xlsx", "application/vnd.ms-excel");
    fireEvent.dragEnter(compositor, { dataTransfer: { types: ["Files"], files: [doc] } });
    expect(screen.getByTestId("crm-chat-soltar").textContent).toContain("Solte o arquivo aqui");
    fireEvent.drop(compositor, { dataTransfer: { types: ["Files"], files: [doc] } });
    expect(screen.getByTestId("crm-chat-fila").querySelectorAll("li")).toHaveLength(2);
    expect(screen.queryByTestId("crm-chat-soltar")).toBeNull();

    const remover = screen.getByTestId("crm-chat-fila").querySelector("button")!;
    act(() => { fireEvent.click(remover); });
    expect(screen.getByTestId("crm-chat-fila").querySelectorAll("li")).toHaveLength(1);
  });

  it("em francês, os textos de anexo saem traduzidos", () => {
    localStorage.setItem("soundos_lang", "fr");
    state.chat = chat();
    render(arvore());
    expect(screen.getByTestId("crm-chat-anexar").textContent).toContain("Joindre un fichier");
    expect(screen.getByTestId("crm-chat-limites").textContent).toContain("image jusqu'à 5 Mo");
    localStorage.clear();
  });
});
