import { describe, expect, it, vi } from "vitest";
import { fetchWixOrders, normalizeWixOrder, WixOrdersError } from "./wixOrders";

const config = { apiKey: "test-key", siteId: "test-site" };

function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    number: "10001",
    createdDate: "2026-11-03T16:50:25.976Z",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    currency: "BRL",
    priceSummary: {
      subtotal: { amount: "200.00" },
      shipping: { amount: "30.00" },
      tax: { amount: "0.00" },
      discount: { amount: "10.00" },
      total: { amount: "220.00" },
    },
    lineItems: [
      {
        productName: { original: "Tambor Oceânico" },
        quantity: 2,
        totalPriceAfterTax: { amount: "190.00" },
        catalogReference: { catalogItemId: "cat-1" },
      },
    ],
    billingInfo: {
      address: { country: "BR", subdivision: "BR-SP", city: "São Paulo", streetAddress: { name: "Rua Secreta" } },
      contactDetails: { firstName: "Ana", lastName: "Lima", phone: "+5511999990000" },
    },
    recipientInfo: {
      address: { country: "BR", subdivision: "BR-RJ", city: "Niterói", streetAddress: { name: "Rua Oculta" } },
      contactDetails: { firstName: "Bruno", lastName: "Souza", phone: "+5521999990000" },
    },
    buyerInfo: { email: "ana@example.test", contactId: "c1" },
    ...overrides,
  };
}

function page(orders: unknown[], next?: string) {
  return {
    orders,
    metadata: { count: orders.length, hasNext: Boolean(next), cursors: next ? { next } : {} },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("leitura dos pedidos da Wix", () => {
  it("lê todas as páginas seguindo o cursor, ordena só na primeira e não repete pedidos", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(page([rawOrder({ id: "a" }), rawOrder({ id: "b" })], "cursor-2")))
      .mockResolvedValueOnce(jsonResponse(page([rawOrder({ id: "b" }), rawOrder({ id: "c" })], "cursor-3")))
      .mockResolvedValueOnce(jsonResponse(page([rawOrder({ id: "d" })])));

    const orders = await fetchWixOrders({ fetchImpl, config, pageSize: 2 });

    expect(orders.map(order => order.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0]).toEqual({
      search: { cursorPaging: { limit: 2 }, sort: [{ fieldName: "createdDate", order: "DESC" }] },
    });
    expect(bodies[1]).toEqual({ search: { cursorPaging: { cursor: "cursor-2" } } });
    expect(bodies[2]).toEqual({ search: { cursorPaging: { cursor: "cursor-3" } } });
  });

  it("usa só leitura: um POST de busca por página, com a credencial no cabeçalho e nada além disso", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(page([])));
    await fetchWixOrders({ fetchImpl, config });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://www.wixapis.com/ecom/v1/orders/search");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "test-key", "wix-site-id": "test-site" });
  });

  it("falha por inteiro se uma página do meio falha, em vez de devolver a lista cortada", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(page([rawOrder({ id: "a" })], "cursor-2")))
      .mockResolvedValueOnce(jsonResponse({ message: "boom" }, 503));
    await expect(fetchWixOrders({ fetchImpl, config })).rejects.toMatchObject({ code: "wix_unavailable" });
  });

  it("distingue credencial recusada, Wix fora do ar, falta de configuração e resposta inesperada", async () => {
    await expect(
      fetchWixOrders({ fetchImpl: async () => jsonResponse({}, 401), config }),
    ).rejects.toMatchObject({ code: "credential_refused" });
    await expect(
      fetchWixOrders({ fetchImpl: async () => jsonResponse({}, 403), config }),
    ).rejects.toMatchObject({ code: "credential_refused" });
    await expect(
      fetchWixOrders({ fetchImpl: async () => jsonResponse({}, 500), config }),
    ).rejects.toMatchObject({ code: "wix_unavailable" });
    await expect(
      fetchWixOrders({
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
        config,
      }),
    ).rejects.toMatchObject({ code: "wix_unavailable" });
    await expect(
      fetchWixOrders({ fetchImpl: async () => jsonResponse({ nope: true }), config }),
    ).rejects.toMatchObject({ code: "unexpected_response" });
    await expect(
      fetchWixOrders({ fetchImpl: async () => new Response("<html>", { status: 200 }), config }),
    ).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("sem WIX_API_KEY/WIX_SITE_ID falha com erro de configuração, sem chamar a Wix", async () => {
    const previous = { key: process.env["WIX_API_KEY"], site: process.env["WIX_SITE_ID"] };
    delete process.env["WIX_API_KEY"];
    delete process.env["WIX_SITE_ID"];
    try {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(fetchWixOrders({ fetchImpl })).rejects.toMatchObject({ code: "not_configured" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previous.key !== undefined) process.env["WIX_API_KEY"] = previous.key;
      if (previous.site !== undefined) process.env["WIX_SITE_ID"] = previous.site;
    }
  });

  it("recusa ler além do limite de páginas e cursor vazio com mais páginas", async () => {
    const endless = async () => jsonResponse(page([rawOrder({ id: crypto.randomUUID() })], "next"));
    await expect(fetchWixOrders({ fetchImpl: endless, config, maxPages: 3 })).rejects.toMatchObject({
      code: "too_many_orders",
    });
    const brokenCursor = async () =>
      jsonResponse({ orders: [rawOrder()], metadata: { hasNext: true, cursors: {} } });
    await expect(fetchWixOrders({ fetchImpl: brokenCursor, config })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("devolve erro tipado com mensagem própria, nunca com a credencial", async () => {
    try {
      await fetchWixOrders({ fetchImpl: async () => jsonResponse({}, 401), config });
      throw new Error("deveria falhar");
    } catch (error) {
      expect(error).toBeInstanceOf(WixOrdersError);
      expect((error as Error).message).not.toContain("test-key");
    }
  });
});

describe("normalização de um pedido", () => {
  it("guarda nome, e-mail e telefone para ligar à ficha, mas nunca rua, CPF, dados de pagamento nem o id do contato", () => {
    const order = normalizeWixOrder(
      rawOrder({
        buyerInfo: { email: "  Ana@Example.test ", contactId: "c1" },
        billingInfo: {
          address: { country: "BR", subdivision: "BR-SP", city: "São Paulo", streetAddress: { name: "Rua Secreta" } },
          contactDetails: { firstName: "Ana", lastName: "Lima", phone: "+5511999990000", vatId: { id: "12345678900" } },
        },
        paymentInfo: { cardLastDigits: "4242" },
      }),
    );
    expect(order).toMatchObject({ customerName: "Ana Lima", email: "Ana@Example.test", phone: "+5511999990000" });
    const serialized = JSON.stringify(order);
    for (const secret of ["Rua Secreta", "Rua Oculta", "c1", "12345678900", "4242", "+5521999990000"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("e-mail e telefone ausentes na Wix viram nulo (e não 'campo que nunca existiu')", () => {
    const order = normalizeWixOrder(
      rawOrder({ buyerInfo: undefined, billingInfo: undefined, recipientInfo: undefined }),
    );
    expect(order.email).toBeNull();
    expect(order.phone).toBeNull();
  });

  it("o telefone da entrega entra só quando a cobrança não tem telefone", () => {
    const order = normalizeWixOrder(
      rawOrder({ billingInfo: { contactDetails: { firstName: "Ana", lastName: "Lima" } } }),
    );
    expect(order.phone).toBe("+5521999990000");
  });

  it("traz subtotal, desconto, impostos e a forma de entrega para a ficha do pedido", () => {
    const order = normalizeWixOrder(
      rawOrder({
        priceSummary: {
          subtotal: { amount: "200.00" },
          shipping: { amount: "30.00" },
          tax: { amount: "5.50" },
          discount: { amount: "10.00" },
          total: { amount: "225.50" },
        },
        shippingInfo: { title: "  Correios  PAC " },
      }),
    );
    expect(order).toMatchObject({ subtotal: 200, discount: 10, tax: 5.5, shipping: 30, total: 225.5, shippingMethod: "Correios PAC" });
  });

  it("valores e forma de entrega que a Wix não informou ficam nulos, sem inventar zero", () => {
    const order = normalizeWixOrder(rawOrder({ priceSummary: { total: { amount: "50.00" } }, shippingInfo: undefined }));
    expect(order).toMatchObject({ subtotal: null, discount: null, tax: null, shipping: 0, shippingMethod: null });
  });

  it("converte valores, itens, frete e a UF sem o prefixo do país", () => {
    const order = normalizeWixOrder(rawOrder());
    expect(order).toMatchObject({
      id: "order-1",
      number: "10001",
      createdAt: "2026-11-03T16:50:25.976Z",
      total: 220,
      shipping: 30,
      status: "APPROVED",
      paymentStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      city: "Niterói",
      region: "RJ",
      country: "BR",
    });
    expect(order.items).toEqual([{ name: "Tambor Oceânico", quantity: 2, value: 190, catalogId: "cat-1" }]);
  });

  it("usa a cidade de cobrança só quando não há cidade de entrega, e o nome de entrega se não há de cobrança", () => {
    const billingOnly = normalizeWixOrder(
      rawOrder({ recipientInfo: { contactDetails: { firstName: "Bruno", lastName: "Souza" } }, billingInfo: undefined }),
    );
    expect(billingOnly.city).toBeNull();
    expect(billingOnly.customerName).toBe("Bruno Souza");

    const onlyBilling = normalizeWixOrder(rawOrder({ recipientInfo: undefined }));
    expect(onlyBilling).toMatchObject({ city: "São Paulo", region: "SP", customerName: "Ana Lima" });
  });

  it("aceita itens personalizados, sem id de catálogo", () => {
    const order = normalizeWixOrder(
      rawOrder({
        lineItems: [
          {
            productName: { original: "Item combinado por WhatsApp" },
            quantity: 1,
            totalPriceAfterTax: { amount: "50.00" },
            catalogReference: { appId: "custom" },
            customLineItem: true,
          },
        ],
      }),
    );
    expect(order.items).toEqual([{ name: "Item combinado por WhatsApp", quantity: 1, value: 50, catalogId: null }]);
  });

  it("endereço no exterior usa o código do país como região", () => {
    const order = normalizeWixOrder(
      rawOrder({ recipientInfo: { address: { country: "PT", subdivision: "PT-11", city: "Lisboa" } } }),
    );
    expect(order).toMatchObject({ city: "Lisboa", region: "PT", country: "PT" });
  });

  it("recusa pedido sem id, sem data válida, sem total ou em outra moeda", () => {
    expect(() => normalizeWixOrder(rawOrder({ id: undefined }))).toThrowError(WixOrdersError);
    expect(() => normalizeWixOrder(rawOrder({ createdDate: "ontem" }))).toThrowError(WixOrdersError);
    expect(() => normalizeWixOrder(rawOrder({ priceSummary: { shipping: { amount: "1" } } }))).toThrowError(
      WixOrdersError,
    );
    expect(() => normalizeWixOrder(rawOrder({ currency: "USD" }))).toThrowError(
      expect.objectContaining({ code: "unsupported_currency" }),
    );
  });
});
