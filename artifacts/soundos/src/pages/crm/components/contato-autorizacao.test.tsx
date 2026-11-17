// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactState } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";
import { ContatoAutorizacao } from "./contato-autorizacao";

afterEach(() => { cleanup(); });

const semRegistro: ContactState = { autorizado: false, naoQuerReceber: false, registros: [] };

function renderar(estado: ContactState | undefined, onRegister = vi.fn().mockResolvedValue(undefined), readOnly = false) {
  render(
    <LanguageProvider>
      <ContatoAutorizacao estado={estado} onRegister={onRegister} pending={false} readOnly={readOnly} />
    </LanguageProvider>,
  );
  return onRegister;
}

describe("autorização de contato por WhatsApp", () => {
  it("sem registro oferece registrar a autorização, e o envio só acontece depois de confirmar", async () => {
    const onRegister = renderar(semRegistro);
    expect(screen.getByTestId("crm-contato-estado").textContent).toContain("Sem autorização registrada");
    fireEvent.click(screen.getByTestId("crm-contato-autorizar"));
    expect(onRegister).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("crm-contato-confirmar"));
    await waitFor(() => expect(onRegister).toHaveBeenCalledWith({ kind: "AUTORIZOU", origem: "CONVERSA_WHATSAPP", origemTexto: null }));
  });

  it("'não quer receber' prevalece sobre a autorização e permite desfazer", async () => {
    const onRegister = renderar({
      autorizado: true,
      naoQuerReceber: true,
      registros: [],
    });
    expect(screen.getByTestId("crm-contato-estado").textContent).toContain("prevalece");
    expect(screen.queryByTestId("crm-contato-nao-quer")).toBeNull();
    fireEvent.click(screen.getByTestId("crm-contato-desfazer"));
    fireEvent.click(screen.getByTestId("crm-contato-confirmar"));
    await waitFor(() => expect(onRegister).toHaveBeenCalledWith({ kind: "NAO_QUER_RECEBER_DESFEITO" }));
  });

  it("cartão encerrado: mostra o estado mas não oferece registrar nada", () => {
    renderar(semRegistro, undefined, true);
    expect(screen.getByTestId("crm-contato-estado")).toBeTruthy();
    expect(screen.queryByTestId("crm-contato-autorizar")).toBeNull();
    expect(screen.queryByTestId("crm-contato-nao-quer")).toBeNull();
  });
});
