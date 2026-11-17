// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpeningTemplatePreview } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";
import type { AberturaController } from "../abertura-hooks";
import { AberturaModeloDialog } from "./abertura-modelo-dialog";

afterEach(() => { cleanup(); });

function previa(parcial: Partial<OpeningTemplatePreview> = {}): OpeningTemplatePreview {
  return {
    podeEnviar: false,
    bloqueios: ["sem_telefone"],
    texto: "Olá, Marina!",
    vinculo: { tipo: "bloqueada", motivo: "sem_telefone" },
    celularInformadoNaoGravado: false,
    ...parcial,
  } as OpeningTemplatePreview;
}

function renderar(preview: OpeningTemplatePreview) {
  const controller: AberturaController = {
    preview, isLoading: false, isError: false,
    send: vi.fn(), sending: false, link: vi.fn(), linking: false,
  };
  render(
    <LanguageProvider>
      <AberturaModeloDialog open onOpenChange={() => {}} controller={controller} />
    </LanguageProvider>,
  );
}

describe("diálogo do modelo de abertura: ficha sem telefone", () => {
  it("mostra que a ficha não tem telefone cadastrado, e não que o telefone é inválido", () => {
    renderar(previa());
    const bloqueios = screen.getByTestId("crm-abertura-bloqueios").textContent ?? "";
    expect(bloqueios).toContain("A ficha não tem telefone cadastrado.");
    expect(bloqueios).not.toContain("não é válido");
    expect(screen.queryByTestId("crm-abertura-celular-nao-gravado")).toBeNull();
    expect((screen.getByTestId("crm-abertura-enviar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("com a nota de conferência explica que o telefone do formulário não foi gravado", () => {
    renderar(previa({ celularInformadoNaoGravado: true }));
    const explicacao = screen.getByTestId("crm-abertura-celular-nao-gravado").textContent ?? "";
    expect(explicacao).toContain("não foi gravado nesta ficha porque pertence a outras fichas");
    expect(explicacao).toContain("notas da ficha");
  });

  it("telefone inválido mantém a mensagem atual e não ganha a explicação", () => {
    renderar(previa({ bloqueios: ["telefone_invalido"], vinculo: { tipo: "bloqueada", motivo: "telefone_invalido" } }));
    const bloqueios = screen.getByTestId("crm-abertura-bloqueios").textContent ?? "";
    expect(bloqueios).toContain("O telefone não é válido para WhatsApp.");
    expect(bloqueios).not.toContain("não tem telefone cadastrado");
    expect(screen.queryByTestId("crm-abertura-celular-nao-gravado")).toBeNull();
  });

  it("em francês os dois textos existem", () => {
    localStorage.setItem("soundos_lang", "fr");
    try {
      renderar(previa({ celularInformadoNaoGravado: true }));
      expect(screen.getByTestId("crm-abertura-bloqueios").textContent).toContain("La fiche n'a pas de téléphone enregistré.");
      expect(screen.getByTestId("crm-abertura-celular-nao-gravado").textContent).toContain("n'a pas été enregistré dans cette fiche");
    } finally {
      localStorage.clear();
    }
  });
});
