// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialChat, Message } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";

const state = vi.hoisted(() => ({
  chat: null as unknown,
  sendChat: vi.fn(),
  assume: vi.fn(),
  giveBack: vi.fn(),
  link: vi.fn(),
  isAdmin: false,
  areas: ["/pessoas"] as string[],
}));

vi.mock("@/contexts/access", () => ({
  useAccess: () => ({ isAdmin: state.isAdmin, canPath: (path: string) => state.areas.includes(path) }),
}));

vi.mock("@workspace/api-client-react", async importOriginal => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  const mutation = (mutate: ReturnType<typeof vi.fn>) => () => ({ mutate, mutateAsync: mutate, isPending: false });
  return {
    ...original,
    useGetCommercialOpportunityChat: () => ({ data: state.chat, isLoading: false, isError: false }),
    useSendCommercialOpportunityChatMessage: mutation(state.sendChat),
    useAssumeCommercialOpportunityChat: mutation(state.assume),
    useReturnCommercialOpportunityChat: mutation(state.giveBack),
    useLinkCommercialOpportunityConversation: mutation(state.link),
    useGetCommercialOpportunityOpeningTemplate: () => ({ data: undefined, isLoading: false, isError: false }),
    useSendCommercialOpportunityOpeningTemplate: mutation(vi.fn()),
  };
});

import { CardChat } from "./card-chat";

afterEach(() => { cleanup(); });
beforeEach(() => { vi.clearAllMocks(); state.isAdmin = false; state.areas = ["/pessoas"]; });

function mensagem(parcial: Partial<Message> & { id: number }): Message {
  return { conversationId: 9, role: "user", content: "", createdAt: "2026-11-02T13:00:00.000Z", ...parcial } as Message;
}

function chat(parcial: Partial<CommercialChat> = {}): CommercialChat {
  return {
    pessoaId: 1,
    vinculo: { tipo: "vinculada", conversationId: 9 },
    conversa: { id: 9, status: "ativa" },
    mensagens: [],
    janelaAte: "2026-11-03T13:00:00.000Z",
    janelaAberta: true,
    contato: { autorizado: true, naoQuerReceber: false },
    podeEnviarTexto: false,
    bloqueiosDeTexto: ["atendimento_nao_assumido"],
    ...parcial,
  } as CommercialChat;
}

function renderar(closed = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <CardChat opportunityId={5} closed={closed} />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

describe("conversa de WhatsApp no cartão", () => {
  it("antes de assumir: texto bloqueado com o motivo, botão de assumir e Sofia continua identificada", () => {
    state.chat = chat({
      mensagens: [
        mensagem({ id: 1, role: "user", content: "Oi, quero saber do curso" }),
        mensagem({ id: 2, role: "assistant", content: "Olá! Sou a Sofia.", envioStatus: "entregue" }),
      ],
    });
    renderar();
    expect((screen.getByTestId("crm-chat-texto") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("crm-chat-enviar") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("crm-chat-bloqueios").textContent).toContain("Assuma o atendimento");
    fireEvent.click(screen.getByTestId("crm-chat-assumir"));
    expect(state.assume).toHaveBeenCalledWith({ id: 5 }, expect.anything());
    expect(screen.getByTestId("crm-chat-msg-2").getAttribute("data-autor")).toBe("sofia");
    expect(screen.getByTestId("crm-chat-msg-1").getAttribute("data-autor")).toBe("pessoa");
  });

  it("mensagens da equipe e o modelo de abertura aparecem com o nome de quem enviou, diferentes da Sofia", () => {
    state.chat = chat({
      mensagens: [
        mensagem({ id: 3, role: "assistant", kind: "modelo_abertura", content: "Olá, Ana! Aqui é da Soundfulness.", authorName: "Marina Souza", envioStatus: "aceito" }),
        mensagem({ id: 4, role: "staff", content: "Posso ajudar?", authorName: "Paulo Lima", envioStatus: "falhou" }),
      ],
    });
    renderar();
    const abertura = screen.getByTestId("crm-chat-msg-3");
    expect(abertura.getAttribute("data-autor")).toBe("equipe");
    expect(abertura.textContent).toContain("Modelo de abertura (equipe) · Marina Souza");
    expect(abertura.textContent).toContain("Na fila do WhatsApp (ainda não entregue)");
    const staff = screen.getByTestId("crm-chat-msg-4");
    expect(staff.getAttribute("data-autor")).toBe("equipe");
    expect(staff.textContent).toContain("Equipe · Paulo Lima");
    expect(staff.textContent).toContain("Falhou — não foi reenviada");
  });

  it("modelo enviado pelo primeiro contato automático aparece como da Sofia, e a falha traz o motivo traduzido", () => {
    state.chat = chat({
      mensagens: [
        mensagem({ id: 6, role: "assistant", kind: "modelo_abertura", content: "Olá, Marina!", authorName: undefined, envioStatus: "entregue" }),
        mensagem({
          id: 7, role: "staff", kind: "modelo_abertura", content: "Olá, Joana!", authorName: undefined, envioStatus: "falhou",
          envioErro: "Número fora da lista de teste da Meta (131030): cadastre o telefone como destinatário no painel da Meta.",
        }),
      ],
    });
    renderar();
    expect(screen.getByTestId("crm-chat-msg-6").textContent).toContain("Modelo de abertura (equipe) · Sofia");
    const falha = screen.getByTestId("crm-chat-msg-7");
    expect(falha.textContent).toContain("Modelo de abertura (equipe) · Sofia");
    expect(falha.textContent).not.toContain("Equipe · ");
    expect(screen.getByTestId("crm-chat-msg-erro-7").textContent).toContain("lista de teste da Meta (131030)");
  });

  it("com o atendimento assumido e a janela aberta, envia o texto uma vez (Ctrl+Enter também) e permite devolver", () => {
    state.chat = chat({ conversa: { id: 9, status: "atendimento_humano" }, podeEnviarTexto: true, bloqueiosDeTexto: [] });
    renderar();
    const campo = screen.getByTestId("crm-chat-texto") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "  Olá, posso ajudar?  " } });
    fireEvent.click(screen.getByTestId("crm-chat-enviar"));
    expect(state.sendChat).toHaveBeenCalledTimes(1);
    expect(state.sendChat).toHaveBeenCalledWith({ id: 5, data: { texto: "Olá, posso ajudar?" } }, expect.anything());
    fireEvent.keyDown(campo, { key: "Enter", ctrlKey: true });
    expect(state.sendChat).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("crm-chat-assumir")).toBeNull();
    fireEvent.click(screen.getByTestId("crm-chat-devolver"));
    expect(state.giveBack).toHaveBeenCalled();
  });

  it("janela fechada: não deixa escrever texto livre e orienta a usar o modelo de abertura", () => {
    state.chat = chat({
      conversa: { id: 9, status: "atendimento_humano" },
      janelaAberta: false,
      janelaAte: "2026-11-01T10:00:00.000Z",
      podeEnviarTexto: false,
      bloqueiosDeTexto: ["janela_fechada"],
    });
    renderar();
    expect((screen.getByTestId("crm-chat-texto") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByTestId("crm-chat-bloqueios").textContent).toContain("modelo de abertura");
    expect(screen.getByTestId("crm-chat-janela").textContent).toContain("Janela de 24 horas fechada desde");
    expect(screen.getByTestId("crm-chat-abertura")).toBeTruthy();
  });

  it("sem conversa não mostra caixa de texto; vínculo a confirmar pede confirmação da equipe", () => {
    state.chat = chat({ vinculo: { tipo: "nenhuma" }, conversa: null, janelaAte: null, janelaAberta: false, bloqueiosDeTexto: ["sem_conversa"] });
    renderar();
    expect(screen.queryByTestId("crm-chat-texto")).toBeNull();
    expect(screen.getByText(/ainda não tem conversa de WhatsApp/)).toBeTruthy();
    cleanup();

    state.chat = chat({ vinculo: { tipo: "a_confirmar", conversationId: 12 }, conversa: null, bloqueiosDeTexto: ["vinculo_a_confirmar"] });
    renderar();
    expect(screen.queryByTestId("crm-chat-texto")).toBeNull();
    fireEvent.click(screen.getByTestId("crm-chat-vincular"));
    expect(state.link).toHaveBeenCalledWith({ id: 5 }, expect.anything());
  });

  it("cartão encerrado: sem assumir, devolver nem modelo de abertura", () => {
    state.chat = chat({ conversa: { id: 9, status: "atendimento_humano" }, bloqueiosDeTexto: ["cartao_encerrado"] });
    renderar(true);
    expect(screen.queryByTestId("crm-chat-assumir")).toBeNull();
    expect(screen.queryByTestId("crm-chat-devolver")).toBeNull();
    expect(screen.queryByTestId("crm-chat-abertura")).toBeNull();
    expect((screen.getByTestId("crm-chat-texto") as HTMLTextAreaElement).disabled).toBe(true);
  });
  describe("telefone em mais de uma ficha ativa", () => {
    const fichas = [
      { id: 1, codigo: "P-0001", nome: "Marina", sobrenome: "Souza", email: "marina@example.test", celular: "(11) 95677-8360" },
      { id: 2, codigo: "P-0002", nome: "Marina", sobrenome: null, email: null, celular: "11-95677-8360" },
    ];
    const bloqueado = (parcial: Partial<CommercialChat> = {}) => chat({
      vinculo: { tipo: "bloqueada", motivo: "telefone_em_varias_fichas" },
      conversa: null,
      janelaAte: null,
      janelaAberta: false,
      bloqueiosDeTexto: ["conversa_bloqueada"],
      fichasComMesmoTelefone: fichas,
      ...parcial,
    });

    it("mostra as fichas com os dados que diferenciam uma da outra e marca a deste cartão", () => {
      state.chat = bloqueado();
      renderar();

      expect(screen.getByText(/está em mais de uma ficha ativa/)).toBeTruthy();
      const primeira = screen.getByTestId("crm-chat-ficha-1");
      expect(primeira.textContent).toContain("Marina Souza");
      expect(primeira.textContent).toContain("P-0001");
      expect(primeira.textContent).toContain("marina@example.test");
      expect(primeira.querySelector("[data-testid=crm-chat-ficha-do-cartao]")).not.toBeNull();
      const segunda = screen.getByTestId("crm-chat-ficha-2");
      expect(segunda.textContent).toContain("Sem e-mail");
      expect(segunda.querySelector("[data-testid=crm-chat-ficha-do-cartao]")).toBeNull();
    });

    it("cada ficha abre em outra aba; só administrador vê a união com a ficha do cartão", () => {
      state.chat = bloqueado();
      renderar();
      expect(screen.getByTestId("crm-chat-ficha-abrir-1").getAttribute("href")).toBe("/pessoas/1");
      expect(screen.getByTestId("crm-chat-ficha-abrir-2").getAttribute("href")).toBe("/pessoas/2");
      expect(screen.getByTestId("crm-chat-ficha-abrir-2").getAttribute("target")).toBe("_blank");
      expect(screen.queryByTestId("crm-chat-ficha-unir-2")).toBeNull();
      cleanup();

      state.isAdmin = true;
      renderar();
      expect(screen.getByTestId("crm-chat-ficha-unir-2").getAttribute("href")).toBe("/pessoas/1?fundir=2");
      expect(screen.queryByTestId("crm-chat-ficha-unir-1")).toBeNull();
    });

    it("sem acesso a Pessoas as fichas aparecem, mas sem links", () => {
      state.chat = bloqueado();
      state.areas = [];
      state.isAdmin = true;
      renderar();
      expect(screen.getByTestId("crm-chat-ficha-2")).toBeTruthy();
      expect(screen.queryByTestId("crm-chat-ficha-abrir-2")).toBeNull();
      expect(screen.queryByTestId("crm-chat-ficha-unir-2")).toBeNull();
    });

    it("outros bloqueios mostram só o aviso, sem lista", () => {
      state.chat = bloqueado({ vinculo: { tipo: "bloqueada", motivo: "conversa_de_outra_ficha" }, fichasComMesmoTelefone: [] });
      renderar();
      expect(screen.getByText(/já pertence a outra ficha/)).toBeTruthy();
      expect(screen.queryByTestId("crm-chat-fichas")).toBeNull();
    });
  });
  describe("ficha sem telefone", () => {
    const semTelefone = (parcial: Partial<CommercialChat> = {}) => chat({
      vinculo: { tipo: "bloqueada", motivo: "sem_telefone" },
      conversa: null,
      janelaAte: null,
      janelaAberta: false,
      bloqueiosDeTexto: ["conversa_bloqueada"],
      fichasComMesmoTelefone: [],
      celularInformadoNaoGravado: false,
      ...parcial,
    });

    it("diz que a ficha não tem telefone cadastrado, sem chamar o telefone de inválido", () => {
      state.chat = semTelefone();
      renderar();
      expect(screen.getByText(/não tem telefone cadastrado/)).toBeTruthy();
      expect(screen.queryByText(/não é válido para WhatsApp/)).toBeNull();
      expect(screen.queryByTestId("crm-chat-celular-nao-gravado")).toBeNull();
    });

    it("com a nota de conferência explica que o telefone do formulário não foi gravado e onde achá-lo", () => {
      state.chat = semTelefone({ celularInformadoNaoGravado: true });
      renderar();
      expect(screen.getByText(/não tem telefone cadastrado/)).toBeTruthy();
      const explicacao = screen.getByTestId("crm-chat-celular-nao-gravado").textContent ?? "";
      expect(explicacao).toContain("não foi gravado nesta ficha porque pertence a outras fichas");
      expect(explicacao).toContain("notas da ficha");
      expect(explicacao).toContain("fichas relacionadas");
    });

    it("telefone preenchido inválido ou estrangeiro mantém a mensagem atual", () => {
      state.chat = semTelefone({ vinculo: { tipo: "bloqueada", motivo: "telefone_invalido" }, celularInformadoNaoGravado: false });
      renderar();
      expect(screen.getByText(/não é válido para WhatsApp/)).toBeTruthy();
      expect(screen.queryByText(/não tem telefone cadastrado/)).toBeNull();
      cleanup();

      state.chat = semTelefone({ vinculo: { tipo: "bloqueada", motivo: "telefone_estrangeiro" } });
      renderar();
      expect(screen.getByText(/só está disponível para telefones do Brasil/)).toBeTruthy();
      expect(screen.queryByText(/não tem telefone cadastrado/)).toBeNull();
    });
  });
});
