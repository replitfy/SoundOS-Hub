// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicForm, type DynamicFormField } from "./dynamic-form";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// O Radix mede o tamanho da caixa com ResizeObserver, que o jsdom não traz.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

afterEach(() => { cleanup(); });

const campos: DynamicFormField[] = [{ key: "nome", label: "Nome", type: "text", required: true }];
const TEXTO = "Aceito receber mensagens da Soundfulness pelo WhatsApp";

async function enviar(onSubmit: ReturnType<typeof vi.fn>) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Marina" } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
}

describe("consentimento do WhatsApp no formulário dinâmico", () => {
  it("sem o texto do servidor não mostra a caixa e nunca consente", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<DynamicForm fields={campos} onSubmit={onSubmit} />);
    expect(screen.queryByTestId("input-consentimento")).toBeNull();
    await enviar(onSubmit);
    expect(onSubmit).toHaveBeenCalledWith({ nome: "Marina" }, false);
  });

  it("a caixa nasce desmarcada, mostra o texto exato e só consente quando a pessoa marca", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<DynamicForm fields={campos} onSubmit={onSubmit} consentimento={{ texto: TEXTO }} />);
    const caixa = screen.getByTestId("input-consentimento");
    expect(caixa.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(TEXTO)).toBeTruthy();
    await enviar(onSubmit);
    expect(onSubmit).toHaveBeenLastCalledWith({ nome: "Marina" }, false);

    cleanup();
    const marcado = vi.fn(async () => {});
    render(<DynamicForm fields={campos} onSubmit={marcado} consentimento={{ texto: TEXTO }} />);
    fireEvent.click(screen.getByTestId("input-consentimento"));
    expect(screen.getByTestId("input-consentimento").getAttribute("aria-checked")).toBe("true");
    await enviar(marcado);
    expect(marcado).toHaveBeenLastCalledWith({ nome: "Marina" }, true);
  });
});
