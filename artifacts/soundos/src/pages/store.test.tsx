// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/language";
import StorePanel from "./store";

type Meta = {
  status: "empty" | "ready" | "refreshing" | "error";
  schemaVersion: number;
  collectedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
};

const state = vi.hoisted(() => ({
  response: null as unknown,
  afterRefresh: null as unknown,
  refreshCalls: [] as Array<{ params?: { trigger?: string } }>,
  panelParams: [] as unknown[],
  refreshDelayMs: 0,
  areas: ["painel-loja", "pessoas"] as string[],
  orderRequests: [] as string[],
  orders: {} as Record<string, unknown>,
}));

// O perfil do usuário vem de um provider com chamada ao servidor; aqui só interessa quais áreas ele tem.
vi.mock("@/contexts/access", () => ({
  useAccess: () => ({ can: (areaId: string) => state.areas.includes(areaId) }),
}));

// O Select do Radix leva ~20 s por abertura no jsdom; aqui ele vira uma lista simples com a mesma API.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Context = React.createContext<{ label: string; onValueChange: (value: string) => void; disabled: boolean }>({
    label: "",
    onValueChange: () => {},
    disabled: false,
  });
  const Trigger = ({ "aria-label": label }: { "aria-label"?: string }) => <span>{label}</span>;
  return {
    Select: ({ children, onValueChange, disabled }: { children: React.ReactNode; onValueChange: (value: string) => void; disabled?: boolean }) => {
      const trigger = React.Children.toArray(children).find(
        (child): child is React.ReactElement<{ "aria-label"?: string }> => React.isValidElement(child) && child.type === Trigger,
      );
      return (
        <Context.Provider value={{ label: trigger?.props["aria-label"] ?? "", onValueChange, disabled: Boolean(disabled) }}>
          {children}
        </Context.Provider>
      );
    },
    SelectTrigger: Trigger,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const context = React.useContext(Context);
      return (
        <button type="button" data-testid={`${context.label}:${value}`} disabled={context.disabled} onClick={() => context.onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

vi.mock("recharts", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div data-testid="chart">{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Box,
    BarChart: Box,
    Bar: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
    CartesianGrid: Nothing,
    Tooltip: Nothing,
  };
});

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>("@workspace/api-client-react");
  return {
    ...actual,
    getGetStorePanelQueryKey: (params?: unknown) => ["/api/store/panel", ...(params ? [params] : [])],
    useGetStorePanel: (params: unknown, options: { query: Record<string, unknown> }) => {
      state.panelParams.push(params);
      return useQuery({
        ...(options.query as object),
        queryKey: options.query.queryKey as readonly unknown[],
        queryFn: async () => structuredClone(state.response),
      });
    },
    getGetStorePanelOrderQueryKey: (orderId: string) => [`/api/store/panel/orders/${orderId}`],
    useGetStorePanelOrder: (orderId: string, options: { query: Record<string, unknown> }) => {
      state.orderRequests.push(orderId);
      return useQuery({
        ...(options.query as object),
        queryKey: options.query.queryKey as readonly unknown[],
        queryFn: async () => {
          const result = state.orders[orderId];
          if (result instanceof Error) throw result;
          return structuredClone(result);
        },
      });
    },
    useRefreshStorePanel: (options: { mutation: { onSettled: () => void } }) =>
      useMutation({
        mutationFn: async (variables: { params?: { trigger?: string } }) => {
          state.refreshCalls.push(variables);
          if (state.refreshDelayMs) await new Promise(resolve => setTimeout(resolve, state.refreshDelayMs));
          if (state.afterRefresh) state.response = state.afterRefresh;
          return state.response;
        },
        onSettled: options.mutation.onSettled,
      }),
  };
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

const order = (number: string, overrides: Record<string, unknown> = {}) => ({
  id: `id-${number}`,
  number,
  createdAt: "2026-11-03T16:00:00.000Z",
  customerName: "Ana Lima",
  items: [{ name: "Bastão de Chuva", quantity: 2 }],
  city: "São Paulo",
  region: "SP",
  total: 1200,
  situation: "paid_delivered",
  payment: "paid",
  delivery: "delivered",
  pessoaLink: null as { mode: string; similarity: number | null } | null,
  ...overrides,
});

function panelData(page = 1) {
  return {
    period: "12m",
    periodStart: "2025-11-01T03:00:00.000Z",
    productOptions: [
      { key: "id:cat-a", name: "Bastão de Chuva" },
      { key: "id:cat-b", name: "Kit de Sons" },
    ],
    kpis: {
      orders: 3,
      confirmedOrders: 2,
      revenue: 2400,
      avgTicket: 1200,
      awaitingPayment: { orders: 1, value: 300 },
      paidToShip: { orders: 0, value: 0 },
    },
    situations: [
      { situation: "paid_delivered", orders: 2, value: 2400 },
      { situation: "paid_to_ship", orders: 0, value: 0 },
      { situation: "awaiting_payment", orders: 1, value: 300 },
      { situation: "declined", orders: 0, value: 0 },
      { situation: "refunded", orders: 0, value: 0 },
      { situation: "cancelled", orders: 0, value: 0 },
    ],
    orders: {
      situation: null,
      page,
      pageSize: 20,
      totalPages: 2,
      total: 3,
      rows: [order("1001"), order("1002", { situation: "awaiting_payment", payment: "awaiting", delivery: "none", total: 300 })],
    },
    products: {
      totalQuantity: 4,
      totalValue: 2200,
      rows: [{ kind: "product", name: "Bastão de Chuva", quantity: 4, value: 2200 }],
    },
    cities: {
      totalOrders: 2,
      totalValue: 2400,
      rows: [
        { kind: "city", city: "São Paulo", region: "SP", orders: 1, value: 1200, avgTicket: 1200 },
        { kind: "unknown", city: null, region: null, orders: 1, value: 1200, avgTicket: 1200 },
      ],
    },
    monthly: [{ month: "2026-11", orders: 2, revenue: 2400 }],
  };
}

const meta = (overrides: Partial<Meta> = {}): Meta => ({
  status: "ready",
  schemaVersion: 1,
  collectedAt: "2026-11-07T15:00:00.000Z",
  lastAttemptedAt: new Date().toISOString(),
  lastError: null,
  lastErrorCode: null,
  ...overrides,
});

const loaded = (overrides: Partial<Meta> = {}) => ({ ...meta(overrides), data: panelData() });
const neverLoaded = (overrides: Partial<Meta> = {}) => ({
  ...meta({ status: "empty", collectedAt: null, lastAttemptedAt: null, ...overrides }),
  data: null,
});

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <StorePanel />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

describe("Painel Loja", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    state.response = loaded();
    state.afterRefresh = null;
    state.refreshCalls = [];
    state.panelParams = [];
    state.refreshDelayMs = 0;
    state.areas = ["painel-loja", "pessoas"];
    state.orderRequests = [];
    state.orders = {};
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it("mostra os números reais, a regra de venda confirmada e não a tela em construção", async () => {
    mount();
    await screen.findByTestId("store-panel-kpis");
    expect(screen.queryByText(/Em Construção/i)).toBeNull();
    expect(screen.getByTestId("store-panel-kpis").textContent).toContain("R$");
    expect(screen.getByTestId("store-panel-kpis").textContent).toContain("Vendas confirmadas: 2");
    expect(screen.getByTestId("situation-awaiting_payment").textContent).toContain("Aguardando pagamento");
    expect(screen.getByTestId("order-1001").textContent).toContain("Ana Lima");
    expect(screen.getByTestId("order-1001").textContent).toContain("03/11/2026");
    expect(screen.getByTestId("order-1001").textContent).toContain("2× Bastão de Chuva");
    expect(screen.getByTestId("store-panel-cities").textContent).toContain("Sem cidade informada");
    expect(screen.getByTestId("store-panel-note").textContent).toContain("Venda confirmada");
    expect(screen.getByTestId("store-panel-updated-at").textContent).toMatch(/^Atualizado em 07\/11\/2026 \d{2}:\d{2}$/);
  });

  it("já houve tentativa hoje: não chama a atualização automática", async () => {
    mount();
    await screen.findByTestId("store-panel-kpis");
    await settle();
    expect(state.refreshCalls).toEqual([]);
  });

  it("primeira abertura do dia: chama a atualização automática uma única vez", async () => {
    state.response = loaded({ lastAttemptedAt: hoursAgo(36) });
    state.afterRefresh = loaded({ lastAttemptedAt: new Date().toISOString() });
    const view = mount();
    await screen.findByTestId("store-panel-kpis");
    await waitFor(() => expect(state.refreshCalls).toHaveLength(1));
    expect(state.refreshCalls[0]).toEqual({ params: { trigger: "automatic" } });

    view.rerender(<div />);
    await settle();
    expect(state.refreshCalls).toHaveLength(1);
  });

  it("nunca carregado: mostra o estado vazio e tenta a automática", async () => {
    state.response = neverLoaded();
    state.afterRefresh = neverLoaded({ status: "error", lastAttemptedAt: new Date().toISOString(), lastError: "x", lastErrorCode: "wix_unavailable" });
    mount();
    await waitFor(() => expect(state.refreshCalls).toHaveLength(1));
    // A tentativa falhou: continua sem dados, mostra o motivo e o botão segue disponível.
    await screen.findByTestId("store-panel-error");
    expect(screen.getByTestId("store-panel-empty").textContent).toContain("ainda não foram carregados");
    expect(screen.getByTestId("store-panel-error").textContent).toContain("A Wix não respondeu agora");
    expect((screen.getByRole("button", { name: /Atualizar/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("store-panel-updated-at")).toBeNull();
  });

  it("atualização que falha mantém os dados anteriores e explica o motivo", async () => {
    state.response = loaded({ status: "error", lastError: "texto do servidor", lastErrorCode: "credential_refused" });
    mount();
    await screen.findByTestId("store-panel-kpis");
    const banner = screen.getByTestId("store-panel-error").textContent ?? "";
    expect(banner).toContain("A última atualização falhou.");
    expect(banner).toContain("A Wix recusou a credencial");
    expect(banner).toContain("Os dados abaixo são de 07/11/2026");
    expect(screen.getByTestId("order-1001")).toBeTruthy();
    expect(screen.getByTestId("store-panel-updated-at")).toBeTruthy();
  });

  it("o botão Atualizar roda a atualização manual e fica desabilitado enquanto espera", async () => {
    state.refreshDelayMs = 80;
    state.afterRefresh = loaded({ collectedAt: "2026-11-07T18:30:00.000Z" });
    mount();
    await screen.findByTestId("store-panel-kpis");
    const button = screen.getByRole("button", { name: /Atualizar/ }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(state.refreshCalls).toEqual([{ params: { trigger: "manual" } }]);
    await waitFor(() => expect(button.disabled).toBe(false));
    await waitFor(() => expect(screen.getByTestId("store-panel-updated-at").textContent).toContain("07/11/2026"));
  });

  it("outra pessoa atualizando: avisa que está atualizando e não dispara outra", async () => {
    state.response = loaded({ status: "refreshing", lastAttemptedAt: hoursAgo(36) });
    mount();
    await screen.findByTestId("store-panel-refreshing");
    await settle();
    expect(state.refreshCalls).toEqual([]);
    expect(screen.getByTestId("order-1001")).toBeTruthy();
  });

  it("textos em francês, inclusive a mensagem de erro", async () => {
    localStorage.setItem("soundos_lang", "fr");
    state.response = loaded({ status: "error", lastError: "pt", lastErrorCode: "wix_unavailable" });
    mount();
    await screen.findByTestId("store-panel-kpis");
    expect(screen.getByTestId("store-panel-error").textContent).toContain("La dernière actualisation a échoué.");
    expect(screen.getByTestId("store-panel-error").textContent).toContain("Wix n'a pas répondu");
    expect(screen.getByRole("button", { name: /Actualiser/ })).toBeTruthy();
    expect(screen.getByTestId("store-panel-note").textContent).toContain("vente confirmée");
    expect(screen.getByTestId("store-panel-cities").textContent).toContain("Ville non renseignée");
  });

  it("trocar o período e a situação refaz a consulta do painel inteiro, voltando para a primeira página", async () => {
    mount();
    await screen.findByTestId("store-panel-orders");
    fireEvent.click(screen.getByRole("button", { name: /Próxima/ }));
    await waitFor(() => expect(state.panelParams.at(-1)).toMatchObject({ page: 2 }));

    fireEvent.click(screen.getByTestId("Período:30d"));
    await waitFor(() => expect(state.panelParams.at(-1)).toMatchObject({ period: "30d", page: 1 }));

    fireEvent.click(screen.getByTestId("Situação:awaiting_payment"));
    await waitFor(() =>
      expect(state.panelParams.at(-1)).toMatchObject({ period: "30d", situation: "awaiting_payment", page: 1 }),
    );
    expect(screen.getAllByTestId(/^Período:/).map(item => item.getAttribute("data-testid"))).toEqual([
      "Período:30d",
      "Período:90d",
      "Período:12m",
      "Período:all",
    ]);
  });

  it("filtra por datas inicial e final e por produto no painel inteiro", async () => {
    mount();
    await screen.findByTestId("store-panel-orders");

    fireEvent.change(screen.getByTestId("store-panel-date-start"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByTestId("store-panel-date-end"), { target: { value: "2026-10-31" } });
    fireEvent.change(screen.getByTestId("store-panel-product-search"), { target: { value: "Chuva" } });
    expect(screen.getByTestId("Produto:id:cat-a")).toBeTruthy();
    expect(screen.queryByTestId("Produto:id:cat-b")).toBeNull();
    fireEvent.click(screen.getByTestId("Produto:id:cat-a"));

    await waitFor(() =>
      expect(state.panelParams.at(-1)).toMatchObject({
        period: "all",
        dataDe: "2026-10-01",
        dataAte: "2026-10-31",
        product: "id:cat-a",
        page: 1,
      }),
    );
    expect(screen.getByTestId("store-panel-date-start")).toHaveProperty("value", "2026-10-01");
    expect(screen.getByTestId("store-panel-date-end")).toHaveProperty("value", "2026-10-31");
  });

  it("paginação pede a página seguinte ao servidor", async () => {
    mount();
    await screen.findByTestId("store-panel-orders");
    expect(screen.getByTestId("store-panel-page").textContent).toBe("Página 1 de 2");
    fireEvent.click(screen.getByRole("button", { name: /Próxima/ }));
    await waitFor(() => expect(state.panelParams.at(-1)).toMatchObject({ period: "12m", page: 2 }));
    expect(state.panelParams.at(-1)).not.toHaveProperty("situation");
  });

  describe("ficha do pedido", () => {
    const detail = (overrides: Record<string, unknown> = {}) => ({
      id: "id-1001",
      number: "1001",
      createdAt: "2026-11-03T16:50:00.000Z",
      situation: "paid_to_ship",
      payment: "paid",
      delivery: "to_ship",
      confirmedSale: true,
      contactAvailable: true,
      customer: { name: "Ana Lima", email: "ana@example.test", phone: "+5511999990000", city: "São Paulo", region: "SP" },
      items: [
        { name: "Bastão de Chuva", quantity: 2, value: 1100 },
        { name: "Pakal", quantity: 1, value: 100 },
      ],
      amounts: { subtotal: 1200, discount: 50, shipping: 150, shippingMethod: "Correios PAC", tax: 0, total: 1300 },
      pessoa: { state: "none" },
      ...overrides,
    });
    const person = { id: 7, codigo: "P-0007", nome: "Ana Paula Lima" };

    async function openFirst(via: "click" | "enter" | "space" = "click") {
      mount();
      const row = await screen.findByTestId("order-1001");
      if (via === "click") fireEvent.click(row);
      else fireEvent.keyDown(row, via === "enter" ? { key: "Enter" } : { key: " " });
      return row;
    }

    it("clique na linha abre a ficha com situação, cliente, itens e valores, sem chamar a Wix", async () => {
      state.orders["id-1001"] = detail();
      await openFirst();
      const sheet = await screen.findByTestId("store-panel-order-sheet");
      await screen.findByTestId("order-sheet-detail");
      expect(screen.getByRole("dialog").textContent).toContain("Pedido #1001");
      const summary = screen.getByTestId("order-sheet-summary").textContent ?? "";
      expect(summary).toContain("03/11/2026 13:50");
      expect(summary).toContain("Pago, a enviar");
      expect(summary).toContain("Pago");
      expect(summary).toContain("A enviar");
      expect(screen.getByTestId("order-sheet-confirmed").textContent).toBe("Sim, entra nos totais do painel");
      const customer = screen.getByTestId("order-sheet-customer").textContent ?? "";
      expect(customer).toContain("Ana Lima");
      expect(customer).toContain("ana@example.test");
      expect(customer).toContain("(11) 99999-0000");
      expect(customer).toContain("São Paulo/SP");
      const items = screen.getByTestId("order-sheet-items").textContent ?? "";
      expect(items).toContain("2× Bastão de Chuva");
      expect(items).toContain("1× Pakal");
      const amounts = screen.getByTestId("order-sheet-amounts").textContent ?? "";
      expect(amounts).toMatch(/Subtotal\s*R\$\s*1\.200,00/);
      expect(amounts).toMatch(/Desconto\s*−\s*R\$\s*50,00/);
      expect(amounts).toContain("Correios PAC");
      expect(amounts).toMatch(/Frete.*R\$\s*150,00/);
      expect(amounts).toMatch(/Impostos\s*R\$\s*0,00/);
      expect(screen.getByTestId("order-sheet-total").textContent).toMatch(/R\$\s*1\.300,00/);
      expect(sheet).toBeTruthy();
      expect(state.orderRequests.every(id => id === "id-1001")).toBe(true);
      expect(state.refreshCalls).toEqual([]);
    });

    it("Enter e Espaço na linha também abrem a ficha, e Esc fecha devolvendo o foco à linha", async () => {
      state.orders["id-1001"] = detail();
      const row = await openFirst("enter");
      await screen.findByTestId("order-sheet-detail");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("store-panel-order-sheet")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(row));

      fireEvent.keyDown(screen.getByTestId("order-1002"), { key: " " });
      await screen.findByTestId("store-panel-order-sheet");
      expect(screen.getByRole("dialog").textContent).toContain("Pedido #1002");
    });

    it("o botão fechar fecha a ficha", async () => {
      state.orders["id-1001"] = detail();
      await openFirst();
      await screen.findByTestId("order-sheet-detail");
      fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
      await waitFor(() => expect(screen.queryByTestId("store-panel-order-sheet")).toBeNull());
    });

    it("mostra carregando enquanto o detalhe não chegou", async () => {
      state.orders["id-1001"] = detail();
      await openFirst();
      expect(screen.getByTestId("order-sheet-loading").textContent).toContain("Carregando o pedido");
      await screen.findByTestId("order-sheet-detail");
    });

    it("pedido que não está mais salvo mostra a mensagem de não encontrado, sem botão de tentar de novo", async () => {
      state.orders["id-1001"] = Object.assign(new Error("not found"), { status: 404 });
      await openFirst();
      const message = await screen.findByTestId("order-sheet-not-found");
      expect(message.textContent).toContain("Pedido não encontrado");
      expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    });

    it("falha ao carregar mostra erro com opção de tentar de novo", async () => {
      state.orders["id-1001"] = Object.assign(new Error("boom"), { status: 500 });
      await openFirst();
      await screen.findByTestId("order-sheet-error");
      state.orders["id-1001"] = detail();
      fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
      await screen.findByTestId("order-sheet-detail");
    });

    it("ficha achada por e-mail, telefone ou os dois mostra nome, código, como foi achada e o link, sem aviso de nome", async () => {
      for (const [mode, text] of [
        ["email", "Achada pelo e-mail do pedido"],
        ["phone", "Achada pelo telefone do pedido"],
        ["both", "Achada pelo e-mail e pelo telefone do pedido"],
      ] as const) {
        state.orders["id-1001"] = detail({ pessoa: { state: "linked", mode, person, similarity: null } });
        await openFirst();
        const linked = await screen.findByTestId("order-pessoa-linked");
        expect(linked.getAttribute("data-mode")).toBe(mode);
        expect(linked.textContent).toContain("Ana Paula Lima");
        expect(linked.textContent).toContain("P-0007");
        expect(linked.textContent).toContain(text);
        expect(screen.getByRole("link", { name: "Abrir ficha" }).getAttribute("href")).toBe("/pessoas/7");
        expect(screen.queryByTestId("order-pessoa-name-notice")).toBeNull();
        cleanup();
      }
    });

    it("ficha ligada pelo nome mostra o aviso discreto com o percentual e os dois nomes lado a lado", async () => {
      state.orders["id-1001"] = detail({
        customer: { name: "Ana P. Lima", email: null, phone: null, city: null, region: null },
        pessoa: { state: "linked", mode: "name", person, similarity: 87 },
      });
      await openFirst();
      const notice = await screen.findByTestId("order-pessoa-name-notice");
      expect(notice.textContent).toContain("Ligado pelo nome (87% de semelhança). Confira se é a mesma pessoa.");
      expect(notice.textContent).toContain("Nome no pedido: Ana P. Lima");
      expect(notice.textContent).toContain("Nome na ficha: Ana Paula Lima");
      expect(screen.getByRole("link", { name: "Abrir ficha" }).getAttribute("href")).toBe("/pessoas/7");
    });

    it("conferência por contato lista as fichas possíveis com link e sem percentual", async () => {
      state.orders["id-1001"] = detail({
        pessoa: {
          state: "review",
          source: "contact",
          reason: "ambiguous",
          candidates: [
            { id: 7, codigo: "P-0007", nome: "Ana Paula Lima", similarity: null },
            { id: 9, codigo: "P-0009", nome: "Ana Lima", similarity: null },
          ],
        },
      });
      await openFirst();
      const review = await screen.findByTestId("order-pessoa-review");
      expect(review.textContent).toContain("Mais de uma ficha combina com este comprador");
      expect(review.textContent).toContain("Nenhuma foi ligada automaticamente");
      expect(review.textContent).not.toContain("semelhança");
      expect(screen.getByTestId("order-pessoa-candidate-9").querySelector("a")?.getAttribute("href")).toBe("/pessoas/9");
      expect(screen.getAllByRole("link", { name: "Abrir ficha" })).toHaveLength(2);
    });

    it("e-mail e telefone apontando para fichas diferentes é explicado como contradição", async () => {
      state.orders["id-1001"] = detail({
        pessoa: {
          state: "review",
          source: "contact",
          reason: "contradictory",
          candidates: [{ id: 7, codigo: "P-0007", nome: "Ana Paula Lima", similarity: null }],
        },
      });
      await openFirst();
      expect((await screen.findByTestId("order-pessoa-review")).textContent).toContain("apontam para fichas diferentes");
    });

    it("conferência por nome mostra o percentual de cada candidata", async () => {
      state.orders["id-1001"] = detail({
        pessoa: {
          state: "review",
          source: "name",
          reason: "ambiguous",
          candidates: [
            { id: 7, codigo: "P-0007", nome: "Ana Paula Lima", similarity: 91 },
            { id: 9, codigo: "P-0009", nome: "Ana Paula Lima Souza", similarity: 78 },
          ],
        },
      });
      await openFirst();
      const review = await screen.findByTestId("order-pessoa-review");
      expect(review.textContent).toContain("nome parecido");
      expect(screen.getByTestId("order-pessoa-candidate-7").textContent).toContain("91% de semelhança");
      expect(screen.getByTestId("order-pessoa-candidate-9").textContent).toContain("78% de semelhança");
    });

    it("sem ficha e sem como identificar o comprador têm mensagens próprias", async () => {
      state.orders["id-1001"] = detail({ pessoa: { state: "none" } });
      await openFirst();
      expect((await screen.findByTestId("order-pessoa-none")).textContent).toBe("Nenhuma ficha encontrada para este comprador.");
      cleanup();

      state.orders["id-1001"] = detail({ pessoa: { state: "unidentifiable" } });
      await openFirst();
      expect((await screen.findByTestId("order-pessoa-unidentifiable")).textContent).toContain("não há como identificar o comprador");
    });

    it("pedido de retrato antigo avisa que e-mail, telefone e ficha ficam disponíveis após a próxima atualização", async () => {
      state.orders["id-1001"] = detail({
        contactAvailable: false,
        customer: { name: "Ana Lima", email: null, phone: null, city: "São Paulo", region: "SP" },
        amounts: { subtotal: null, discount: null, shipping: 150, shippingMethod: null, tax: null, total: 1300 },
        pessoa: { state: "contact_pending" },
      });
      await openFirst();
      await screen.findByTestId("order-sheet-detail");
      const customer = screen.getByTestId("order-sheet-customer").textContent ?? "";
      expect(customer.match(/Disponível após a próxima atualização do painel/g)).toHaveLength(2);
      expect(screen.getByTestId("order-pessoa-pending").textContent).toContain("Disponível após a próxima atualização do painel");
      expect(screen.getByTestId("order-sheet-amounts").textContent).toMatch(/Subtotal\s*—/);
    });

    it("e-mail e telefone que a Wix não informou aparecem como não informado", async () => {
      state.orders["id-1001"] = detail({ customer: { name: "Ana Lima", email: null, phone: null, city: null, region: null } });
      await openFirst();
      await screen.findByTestId("order-sheet-detail");
      expect((screen.getByTestId("order-sheet-customer").textContent ?? "").match(/Não informado/g)).toHaveLength(3);
    });

    it("quem não tem a área Pessoas não vê a seção da ficha nem o marcador, mesmo que os dados cheguem", async () => {
      state.areas = ["painel-loja"];
      state.response = loaded();
      (state.response as { data: ReturnType<typeof panelData> }).data.orders.rows[0]!.pessoaLink = { mode: "email", similarity: null };
      state.orders["id-1001"] = detail({ pessoa: { state: "linked", mode: "email", person, similarity: null } });
      await openFirst();
      await screen.findByTestId("order-sheet-detail");
      expect(screen.queryByTestId("order-sheet-pessoa")).toBeNull();
      expect(screen.queryByRole("link", { name: "Abrir ficha" })).toBeNull();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("store-panel-order-sheet")).toBeNull());
      expect(screen.queryByTestId("order-link-1001")).toBeNull();
    });

    it("a lista marca discretamente os pedidos ligados; o marcador de nome é mais claro e mostra o percentual", async () => {
      const data = panelData();
      data.orders.rows[0]!.pessoaLink = { mode: "email", similarity: null };
      data.orders.rows[1]!.pessoaLink = { mode: "name", similarity: 87 };
      state.response = { ...meta(), data };
      mount();
      const strong = await screen.findByTestId("order-link-1001");
      const light = screen.getByTestId("order-link-1002");
      expect(strong.getAttribute("data-mode")).toBe("email");
      expect(strong.getAttribute("title")).toBe("Ligado à ficha da pessoa, pelo e-mail");
      expect(light.getAttribute("data-mode")).toBe("name");
      expect(light.getAttribute("title")).toBe("Ligado à ficha da pessoa pelo nome (87% de semelhança)");
      expect(strong.className).not.toBe(light.className);
    });

    it("pedido sem ligação não tem marcador", async () => {
      mount();
      await screen.findByTestId("order-1001");
      expect(screen.queryByTestId("order-link-1001")).toBeNull();
    });

    it("textos da ficha em francês", async () => {
      localStorage.setItem("soundos_lang", "fr");
      state.orders["id-1001"] = detail({ pessoa: { state: "linked", mode: "name", person, similarity: 87 } });
      await openFirst();
      const notice = await screen.findByTestId("order-pessoa-name-notice");
      expect(notice.textContent).toContain("Lié par le nom (87 % de similarité). Vérifiez s'il s'agit de la même personne.");
      expect(screen.getByRole("dialog").textContent).toContain("Commande #1001");
      expect(screen.getByRole("link", { name: "Ouvrir la fiche" })).toBeTruthy();
      expect(screen.getByTestId("order-sheet-confirmed").textContent).toBe("Oui, comptée dans les totaux du panneau");
      expect(screen.getByRole("button", { name: "Fermer" })).toBeTruthy();
    });
  });
});
