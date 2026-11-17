// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import { extractSofiaConversation } from "@/lib/formalizacao";
import { SofiaConversationBlock } from "./sofia-conversation-block";

afterEach(() => { cleanup(); });

const conversa = extractSofiaConversation({
  sofiaConversation: {
    conversationId: 3072,
    mensagens: ["Tenho interesse no Ciclo Água", "Quero saber como participar"],
    ficha: { cidade: "Campinas", servicoInteresse: "Sound Healing" },
  },
})!;

function renderBlock(props: Partial<React.ComponentProps<typeof SofiaConversationBlock>> = {}) {
  return render(
    <LanguageProvider>
      <SofiaConversationBlock conversation={conversa} eventId={9} pessoaId={77} canOpenConversation {...props} />
    </LanguageProvider>,
  );
}

describe("bloco Conversa com a Sofia no histórico do cartão", () => {
  it("mostra as mensagens da pessoa, só os campos preenchidos da ficha e o botão para a conversa completa", () => {
    renderBlock();
    expect(screen.getByText("Conversa com a Sofia")).toBeTruthy();
    expect(screen.getByText("Tenho interesse no Ciclo Água")).toBeTruthy();
    expect(screen.getByText("Quero saber como participar")).toBeTruthy();
    expect(screen.getByText("Campinas")).toBeTruthy();
    expect(screen.getByText("Sound Healing")).toBeTruthy();
    expect(screen.queryByText("Profissão")).toBeNull();
    expect(screen.queryByText("Objetivos")).toBeNull();
    const botao = screen.getByTestId("sofia-conversation-open-9");
    expect(botao.getAttribute("href")).toContain("/sofia?pessoa=77&conv=3072");
    expect(botao.textContent).toContain("Abrir conversa completa");
  });

  it("sem ficha preenchida não mostra o bloco 'O que já sabemos'", () => {
    renderBlock({ conversation: { conversationId: 5, mensagens: ["Quero participar"], ficha: [] } });
    expect(screen.queryByText("O que já sabemos")).toBeNull();
    expect(screen.getByText("Quero participar")).toBeTruthy();
  });

  it("esconde o botão para quem não tem a tela de conversa e quando não há conversa registrada", () => {
    renderBlock({ canOpenConversation: false });
    expect(screen.queryByTestId("sofia-conversation-open-9")).toBeNull();
    cleanup();
    renderBlock({ conversation: { conversationId: null, mensagens: [], ficha: [] } });
    expect(screen.queryByTestId("sofia-conversation-open-9")).toBeNull();
  });
});
