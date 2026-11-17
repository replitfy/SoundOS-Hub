// @vitest-environment jsdom
// Histórico > Instrumentos: compras da loja aparecem ao lado dos registros manuais, somente leitura,
// e a falta de dados da loja nunca é confundida com "nenhum instrumento".
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/language";
import { UserSessionProvider } from "@/contexts/user-session";
import { TooltipProvider } from "@/components/ui/tooltip";
import PessoaDetail from "./[id]";
import type { LojaInstrumentosData } from "./instrumentos-loja";

vi.mock("@/contexts/access", async () => (await import("@/test/access-mock")).accessMock(() => true));

vi.mock("wouter", async () => {
  const actual = await vi.importActual("wouter");
  return {
    ...actual,
    useParams: () => ({ id: "1" }),
    useLocation: () => ["/pessoas/1", vi.fn()],
  };
});

const manual = [
  { id: 5, pessoaId: 1, item: "Handpan cadastrado à mão", dataCompra: "2025-01-10", valor: "R$ 4.000", obs: "Usado", createdAt: "2025-01-10T00:00:00Z" },
];

const loja: LojaInstrumentosData = {
  disponivel: true,
  coletadoEm: "2026-11-07T16:34:00.000Z",
  itens: [
    { id: "a:0", item: "Pakal Zen com Bag, Suporte e Baqueta", quantidade: 1, dataCompra: "2026-08-31", valor: 3080, pedido: "10250", ligadoPor: "both", semelhanca: null },
    { id: "b:0", item: "Diapasão 128Hz", quantidade: 2, dataCompra: "2026-03-10", valor: 180, pedido: "10001", ligadoPor: "name", semelhanca: 87 },
  ],
};

type LojaReply = { ok: boolean; body?: unknown };

function stubFetch(options: { manual?: unknown[]; loja: LojaReply }) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (/\/api\/pessoas\/1$/.test(url)) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 1, nome: "Debora", sobrenome: "Hayashi", ativo: true, email: "d@test.com" }),
      });
    }
    if (url.endsWith("/api/pessoas/1/instrumentos-loja")) {
      return Promise.resolve({ ok: options.loja.ok, json: async () => options.loja.body });
    }
    if (url.endsWith("/api/pessoas/1/instrumentos")) {
      return Promise.resolve({ ok: true, json: async () => options.manual ?? [] });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openInstrumentos(lang: "pt" | "fr" = "pt") {
  localStorage.setItem("soundos_lang", lang);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <UserSessionProvider>
          <TooltipProvider>
            <PessoaDetail />
          </TooltipProvider>
        </UserSessionProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText("Debora Hayashi")).toBeDefined());
  fireEvent.mouseDown(screen.getByRole("tab", { name: /Histórico/ }), { button: 0, ctrlKey: false });
  const title = lang === "pt" ? "Instrumentos" : "Instruments";
  const heading = await screen.findByText(title);
  return heading.closest(".shadow-sm") as HTMLElement;
}

describe("PessoaDetail - compras da loja em Instrumentos", () => {
  beforeEach(() => {
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: 1, name: "Teste", email: "teste@example.com", sessionToken: "signed-test-token",
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("mostra o instrumento comprado na loja com pedido, data e valor, sem ações de edição", async () => {
    stubFetch({ manual, loja: { ok: true, body: loja } });
    const card = await openInstrumentos();

    await waitFor(() => expect(within(card).getAllByTestId("instrumento-loja")).toHaveLength(2));
    const [pakal] = within(card).getAllByTestId("instrumento-loja") as [HTMLElement, HTMLElement];
    expect(within(pakal).getByText("Pakal Zen com Bag, Suporte e Baqueta")).toBeDefined();
    expect(within(pakal).getByText("31/08/2026")).toBeDefined();
    expect(within(pakal).getByText(/R\$\s*3\.080,00/)).toBeDefined();
    expect(within(pakal).getByText(/Loja · Pedido #10250/)).toBeDefined();
    expect(within(pakal).queryByText(/Ligado só pelo nome/)).toBeNull();
    expect(within(pakal).queryAllByRole("button")).toHaveLength(0);

    // O registro manual segue editável.
    expect(within(card).getByText("Handpan cadastrado à mão")).toBeDefined();
    expect(within(card).queryByText("Nenhum instrumento registrado")).toBeNull();
  });

  it("marca a ligação feita só pelo nome e mostra a quantidade quando passa de um", async () => {
    stubFetch({ loja: { ok: true, body: loja } });
    const card = await openInstrumentos();

    const rows = await waitFor(() => {
      const found = within(card).getAllByTestId("instrumento-loja");
      expect(found).toHaveLength(2);
      return found;
    });
    const diapasao = rows[1]!;
    expect(within(diapasao).getByText(/Loja · Pedido #10001 · 2 un\./)).toBeDefined();
    expect(within(diapasao).getByText(/Ligado só pelo nome \(87% de semelhança\)/)).toBeDefined();
  });

  it("mostra a data da última atualização do Painel Loja", async () => {
    stubFetch({ loja: { ok: true, body: loja } });
    const card = await openInstrumentos();
    await waitFor(() => expect(within(card).getByText(/conforme o Painel Loja de \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)).toBeDefined());
  });

  it("sem compras na loja e sem registros, mantém o aviso de lista vazia", async () => {
    stubFetch({ loja: { ok: true, body: { disponivel: true, coletadoEm: loja.coletadoEm, itens: [] } } });
    const card = await openInstrumentos();
    await waitFor(() => expect(within(card).getByText("Nenhum instrumento registrado")).toBeDefined());
    expect(within(card).queryAllByTestId("instrumento-loja")).toHaveLength(0);
  });

  it("Painel Loja ainda não carregado: avisa em vez de fingir que não há compras", async () => {
    stubFetch({ loja: { ok: true, body: { disponivel: false, coletadoEm: null, itens: [] } } });
    const card = await openInstrumentos();
    await waitFor(() => expect(within(card).getByText(/compras da loja ainda não foram carregadas/)).toBeDefined());
  });

  it("falha ao ler a loja aparece como erro e deixa tentar de novo", async () => {
    const fetchMock = stubFetch({ manual, loja: { ok: false, body: { error: "x" } } });
    const card = await openInstrumentos();
    await waitFor(() => expect(within(card).getByRole("alert").textContent).toMatch(/Não foi possível carregar as compras da loja/));
    // Registros manuais continuam visíveis.
    expect(within(card).getByText("Handpan cadastrado à mão")).toBeDefined();

    const before = fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/instrumentos-loja")).length;
    fireEvent.click(within(card).getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/instrumentos-loja")).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("resposta fora do formato também é erro, não lista vazia", async () => {
    stubFetch({ loja: { ok: true, body: [] } });
    const card = await openInstrumentos();
    await waitFor(() => expect(within(card).getByRole("alert")).toBeDefined());
  });

  it("em francês usa os textos traduzidos e o valor em reais", async () => {
    stubFetch({ loja: { ok: true, body: loja } });
    const card = await openInstrumentos("fr");
    const rows = await waitFor(() => {
      const found = within(card).getAllByTestId("instrumento-loja");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(within(rows[0]!).getByText(/Boutique · Commande #10250/)).toBeDefined();
    expect(within(rows[1]!).getByText(/Associé uniquement par le nom \(87% de similarité\)/)).toBeDefined();
  });
});
