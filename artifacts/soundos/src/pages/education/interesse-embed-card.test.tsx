// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider, type Lang } from "@/contexts/language";
import { InteresseEmbedCard } from "./interesse-embed-card";

const GROUPS = [
  { slug: "agua", label: "Água", cor: "#2BA8E0" },
  { slug: "terra", label: "Terra", cor: "#8CC63F" },
];

function renderCard(lang: Lang) {
  localStorage.setItem("soundos_lang", lang);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <InteresseEmbedCard />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/public/interesse/formulario") {
      return new Response(JSON.stringify({ grupos: GROUPS }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const link = () => (screen.getByTestId("interesse-embed-link") as HTMLInputElement).value;
const iframeCode = () => (screen.getByTestId("interesse-embed-iframe") as HTMLTextAreaElement).value;

describe.each([
  { lang: "pt" as const, color: "Cor (opcional)", invalid: "Use 6 caracteres hexadecimais, ex.: 2BA8E0." },
  { lang: "fr" as const, color: "Couleur (optionnel)", invalid: "Utilisez 6 caractères hexadécimaux, ex. 2BA8E0." },
])("gerador do formulário de interesse em $lang", ({ lang, color, invalid }) => {
  it("começa sem grupo, com link e iframe do formulário genérico", async () => {
    renderCard(lang);
    expect(screen.getByText(color)).toBeTruthy();
    expect(link()).toMatch(/\/interesse$/);
    expect(iframeCode()).toContain('<iframe src="');
    expect(iframeCode()).toContain("/interesse?embed=1\"");
    expect(iframeCode()).toContain('height="460"');
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/public/interesse/formulario"));
  });

  it("aplica a cor no link e no iframe, sem o #", () => {
    renderCard(lang);
    fireEvent.change(screen.getByTestId("interesse-embed-cor"), { target: { value: "#2ba8e0" } });
    expect(link()).toMatch(/\/interesse\?cor=2BA8E0$/);
    expect(iframeCode()).toContain("embed=1&cor=2BA8E0");
    expect(screen.queryByText(invalid)).toBeNull();
  });

  it("avisa quando a cor é inválida e a ignora no código", () => {
    renderCard(lang);
    fireEvent.change(screen.getByTestId("interesse-embed-cor"), { target: { value: "azul" } });
    expect(screen.getByText(invalid)).toBeTruthy();
    expect(link()).toMatch(/\/interesse$/);
  });

  it("prévia usa o endereço de embed", () => {
    const { container } = renderCard(lang);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toMatch(/\/interesse\?embed=1$/);
    expect(frame?.getAttribute("height")).toBe("460");
  });
});
