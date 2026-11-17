import { describe, expect, it } from "vitest";
import {
  buildStoreOrderDetail,
  buildStorePanel,
  isConfirmedSale,
  periodStart,
  situationOf,
  STORE_ORDERS_PAGE_SIZE,
} from "./storePanel";
import type { StoreOrder } from "./wixOrders";

// 07/11/2026 12:00 em São Paulo.
const NOW = new Date("2026-11-07T15:00:00.000Z");

let sequence = 0;
function order(overrides: Partial<StoreOrder> & { item?: Partial<StoreOrder["items"][number]> } = {}): StoreOrder {
  sequence += 1;
  const { item, ...rest } = overrides;
  return {
    id: `o-${sequence}`,
    number: String(10_000 + sequence),
    createdAt: "2026-11-03T16:00:00.000Z",
    customerName: "Cliente",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    total: 100,
    shipping: 10,
    city: "São Paulo",
    region: "SP",
    country: "BR",
    items: [{ name: "Produto A", quantity: 1, value: 90, catalogId: "cat-a", ...item }],
    ...rest,
  };
}

describe("situação do pedido", () => {
  const cases: Array<[string, string, string, string]> = [
    // status, pagamento, entrega, situação esperada
    ["APPROVED", "PAID", "FULFILLED", "paid_delivered"],
    ["APPROVED", "PAID", "NOT_FULFILLED", "paid_to_ship"],
    ["APPROVED", "PAID", "PARTIALLY_FULFILLED", "paid_to_ship"],
    ["APPROVED", "NOT_PAID", "NOT_FULFILLED", "awaiting_payment"],
    ["APPROVED", "NOT_PAID", "FULFILLED", "awaiting_payment"],
    ["APPROVED", "PENDING", "NOT_FULFILLED", "awaiting_payment"],
    ["APPROVED", "DECLINED", "NOT_FULFILLED", "declined"],
    ["APPROVED", "DECLINED", "FULFILLED", "declined"],
    ["CANCELED", "FULLY_REFUNDED", "NOT_FULFILLED", "refunded"],
    ["APPROVED", "PARTIALLY_REFUNDED", "FULFILLED", "refunded"],
    ["CANCELED", "NOT_PAID", "NOT_FULFILLED", "cancelled"],
    // Pago e cancelado depois: não é venda confirmada.
    ["CANCELED", "PAID", "NOT_FULFILLED", "cancelled"],
    ["REJECTED", "NOT_PAID", "NOT_FULFILLED", "cancelled"],
    ["APPROVED", "CANCELED", "NOT_FULFILLED", "cancelled"],
  ];

  it.each(cases)("%s + %s + %s => %s", (status, paymentStatus, fulfillmentStatus, expected) => {
    expect(situationOf({ status, paymentStatus, fulfillmentStatus })).toBe(expected);
  });

  it("só pago, não cancelado e não reembolsado é venda confirmada", () => {
    expect(isConfirmedSale({ status: "APPROVED", paymentStatus: "PAID", fulfillmentStatus: "FULFILLED" })).toBe(true);
    expect(isConfirmedSale({ status: "APPROVED", paymentStatus: "PAID", fulfillmentStatus: "NOT_FULFILLED" })).toBe(true);
    expect(isConfirmedSale({ status: "CANCELED", paymentStatus: "PAID", fulfillmentStatus: "NOT_FULFILLED" })).toBe(false);
    expect(isConfirmedSale({ status: "APPROVED", paymentStatus: "FULLY_REFUNDED", fulfillmentStatus: "FULFILLED" })).toBe(false);
    expect(isConfirmedSale({ status: "APPROVED", paymentStatus: "NOT_PAID", fulfillmentStatus: "NOT_FULFILLED" })).toBe(false);
    expect(isConfirmedSale({ status: "APPROVED", paymentStatus: "DECLINED", fulfillmentStatus: "NOT_FULFILLED" })).toBe(false);
  });
});

describe("período (America/Sao_Paulo)", () => {
  it("30 e 90 dias são dias corridos contando hoje; 12 meses são meses civis; todo o período não tem início", () => {
    expect(periodStart("30d", NOW)?.toISOString()).toBe("2026-10-09T03:00:00.000Z");
    expect(periodStart("90d", NOW)?.toISOString()).toBe("2026-08-10T03:00:00.000Z");
    expect(periodStart("12m", NOW)?.toISOString()).toBe("2025-12-01T03:00:00.000Z");
    expect(periodStart("all", NOW)).toBeNull();
  });

  it("a virada do dia é a meia-noite de São Paulo, não a de UTC", () => {
    // 03:30Z já é 00:30 de 08/11 em São Paulo; 02:30Z ainda é 23:30 de 07/11.
    const afterMidnightSp = new Date("2026-11-08T03:30:00.000Z");
    expect(periodStart("30d", afterMidnightSp)?.toISOString()).toBe("2026-10-10T03:00:00.000Z");
    const beforeMidnightSp = new Date("2026-11-08T02:30:00.000Z");
    expect(periodStart("30d", beforeMidnightSp)?.toISOString()).toBe("2026-10-09T03:00:00.000Z");
  });

  it("pedido do último segundo antes do início fica de fora; o primeiro segundo entra", () => {
    const outside = order({ createdAt: "2025-12-01T02:59:59.000Z" });
    const inside = order({ createdAt: "2025-12-01T03:00:00.000Z" });
    const view = buildStorePanel([outside, inside], { period: "12m", now: NOW });
    expect(view.kpis.orders).toBe(1);
    expect(view.orders.rows.map(row => row.id)).toEqual([inside.id]);
    expect(buildStorePanel([outside, inside], { period: "all", now: NOW }).kpis.orders).toBe(2);
  });

  it("o período vale para o painel inteiro", () => {
    const old = order({ createdAt: "2026-01-10T12:00:00.000Z", city: "Curitiba", region: "PR", total: 500 });
    const recent = order({ createdAt: "2026-11-05T12:00:00.000Z", total: 100 });
    const month = buildStorePanel([old, recent], { period: "30d", now: NOW });
    expect(month.kpis.revenue).toBe(100);
    expect(month.situations.reduce((sum, s) => sum + s.orders, 0)).toBe(1);
    expect(month.cities.rows.map(row => row.city)).toEqual(["São Paulo"]);
    expect(month.products.totalValue).toBe(90);
    expect(month.monthly.every(entry => entry.month >= "2026-10")).toBe(true);
    expect(buildStorePanel([old, recent], { period: "12m", now: NOW }).kpis.revenue).toBe(600);
  });
});

describe("filtros de data e produto", () => {
  it("inclui as datas inicial e final inteiras no fuso de São Paulo", () => {
    const before = order({ id: "before", createdAt: "2026-11-04T02:59:59.000Z" });
    const first = order({ id: "first", createdAt: "2026-11-04T03:00:00.000Z" });
    const last = order({ id: "last", createdAt: "2026-11-05T02:59:59.000Z" });
    const after = order({ id: "after", createdAt: "2026-11-05T03:00:00.000Z" });
    const view = buildStorePanel([before, first, last, after], {
      period: "all",
      dataDe: "2026-11-04",
      dataAte: "2026-11-04",
      now: NOW,
    });
    expect(view.orders.rows.map(row => row.id).sort()).toEqual(["first", "last"]);
    expect(view.monthly.map(item => item.month)).toEqual(["2026-11"]);
  });

  it("produto restringe pedidos e indicadores, mas o gráfico de produtos soma só o produto selecionado", () => {
    const target = order({
      id: "target",
      total: 150,
      items: [
        { name: "Produto A", quantity: 2, value: 90, catalogId: "cat-a" },
        { name: "Produto B", quantity: 1, value: 50, catalogId: "cat-b" },
      ],
    });
    const unrelated = order({
      id: "unrelated",
      total: 300,
      items: [{ name: "Produto B", quantity: 3, value: 270, catalogId: "cat-b" }],
    });
    const view = buildStorePanel([target, unrelated], { period: "all", productKey: "id:cat-a", now: NOW });
    expect(view.kpis).toMatchObject({ orders: 1, revenue: 150, confirmedOrders: 1 });
    expect(view.orders.rows.map(row => row.id)).toEqual(["target"]);
    expect(view.products.rows).toEqual([{ kind: "product", name: "Produto A", quantity: 2, value: 90 }]);
    expect(view.productOptions).toEqual([
      { key: "id:cat-a", name: "Produto A" },
      { key: "id:cat-b", name: "Produto B" },
    ]);
  });
});

describe("indicadores", () => {
  const orders = [
    order({ total: 100 }),
    order({ total: 300, fulfillmentStatus: "NOT_FULFILLED" }),
    order({ total: 50, paymentStatus: "NOT_PAID", fulfillmentStatus: "NOT_FULFILLED" }),
    order({ total: 70, paymentStatus: "DECLINED", fulfillmentStatus: "NOT_FULFILLED" }),
    order({ total: 80, paymentStatus: "FULLY_REFUNDED", status: "CANCELED" }),
    order({ total: 900, status: "CANCELED", fulfillmentStatus: "NOT_FULFILLED" }),
  ];

  it("faturamento soma só vendas confirmadas e o ticket médio divide por elas", () => {
    const { kpis } = buildStorePanel(orders, { period: "12m", now: NOW });
    expect(kpis.orders).toBe(6);
    expect(kpis.confirmedOrders).toBe(2);
    expect(kpis.revenue).toBe(400);
    expect(kpis.avgTicket).toBe(200);
    expect(kpis.awaitingPayment).toEqual({ orders: 1, value: 50 });
    expect(kpis.paidToShip).toEqual({ orders: 1, value: 300 });
  });

  it("mostra as seis situações, sempre na mesma ordem, e elas somam todos os pedidos", () => {
    const { situations, kpis } = buildStorePanel(orders, { period: "12m", now: NOW });
    expect(situations.map(entry => entry.situation)).toEqual([
      "paid_delivered", "paid_to_ship", "awaiting_payment", "declined", "refunded", "cancelled",
    ]);
    expect(situations.map(entry => entry.orders)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(situations.reduce((sum, entry) => sum + entry.orders, 0)).toBe(kpis.orders);
    expect(situations.map(entry => entry.value)).toEqual([100, 300, 50, 70, 80, 900]);
  });

  it("sem pedidos: zeros, ticket médio vazio e nenhum mês", () => {
    const view = buildStorePanel([], { period: "all", now: NOW });
    expect(view.kpis).toMatchObject({ orders: 0, revenue: 0, avgTicket: null, confirmedOrders: 0 });
    expect(view.situations.every(entry => entry.orders === 0)).toBe(true);
    expect(view.orders).toMatchObject({ total: 0, totalPages: 1, page: 1, rows: [] });
    expect(view.monthly).toEqual([]);
    expect(view.cities.rows).toEqual([]);
    expect(view.products.rows).toEqual([]);
  });

  it("soma em centavos: 0,1 + 0,2 fecha em 0,3", () => {
    const view = buildStorePanel([order({ total: 0.1 }), order({ total: 0.2 })], { period: "12m", now: NOW });
    expect(view.kpis.revenue).toBe(0.3);
  });
});

describe("lista de pedidos", () => {
  const many = Array.from({ length: 45 }, (_, index) =>
    order({
      id: `many-${String(index).padStart(2, "0")}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
      paymentStatus: index % 3 === 0 ? "NOT_PAID" : "PAID",
      fulfillmentStatus: index % 3 === 0 ? "NOT_FULFILLED" : "FULFILLED",
    }),
  );

  it("mais recentes primeiro, em páginas de 20", () => {
    const first = buildStorePanel(many, { period: "12m", now: NOW });
    expect(first.orders).toMatchObject({ page: 1, pageSize: STORE_ORDERS_PAGE_SIZE, totalPages: 3, total: 45 });
    expect(first.orders.rows).toHaveLength(20);
    expect(first.orders.rows[0]!.id).toBe("many-44");
    const third = buildStorePanel(many, { period: "12m", page: 3, now: NOW });
    expect(third.orders.rows).toHaveLength(5);
    expect(third.orders.rows.at(-1)!.id).toBe("many-00");
  });

  it("filtra por situação e a paginação acompanha o filtro", () => {
    const view = buildStorePanel(many, { period: "12m", situation: "awaiting_payment", now: NOW });
    expect(view.orders.total).toBe(15);
    expect(view.orders.totalPages).toBe(1);
    expect(view.orders.situation).toBe("awaiting_payment");
    expect(view.orders.rows.every(row => row.situation === "awaiting_payment")).toBe(true);
    // O filtro só muda a lista; os totais do período continuam completos.
    expect(view.kpis.orders).toBe(45);
  });

  it("página fora do intervalo vai para a última página válida", () => {
    expect(buildStorePanel(many, { period: "12m", page: 99, now: NOW }).orders.page).toBe(3);
    expect(buildStorePanel(many, { period: "12m", page: 0, now: NOW }).orders.page).toBe(1);
  });

  it("cada linha traz cliente, itens, cidade, valor, pagamento e entrega", () => {
    const toShip = order({ fulfillmentStatus: "NOT_FULFILLED", customerName: null, city: null, region: null });
    const [row] = buildStorePanel([toShip], { period: "12m", now: NOW }).orders.rows;
    expect(row).toMatchObject({
      number: toShip.number,
      customerName: null,
      city: null,
      total: 100,
      situation: "paid_to_ship",
      payment: "paid",
      delivery: "to_ship",
      items: [{ name: "Produto A", quantity: 1 }],
    });
    const [declined] = buildStorePanel([order({ paymentStatus: "DECLINED", fulfillmentStatus: "NOT_FULFILLED" })], {
      period: "12m",
      now: NOW,
    }).orders.rows;
    expect(declined).toMatchObject({ payment: "declined", delivery: "none" });
  });
});

describe("análise por produto", () => {
  it("conta só vendas confirmadas e o valor dos itens não inclui frete", () => {
    const view = buildStorePanel(
      [
        order({ total: 100, shipping: 10, items: [{ name: "Produto A", quantity: 2, value: 90, catalogId: "cat-a" }] }),
        order({ total: 500, status: "CANCELED", paymentStatus: "NOT_PAID", items: [{ name: "Produto A", quantity: 9, value: 490, catalogId: "cat-a" }] }),
      ],
      { period: "12m", now: NOW },
    );
    expect(view.products.rows).toEqual([{ kind: "product", name: "Produto A", quantity: 2, value: 90 }]);
    expect(view.products.totalValue).toBe(90);
    expect(view.kpis.revenue).toBe(100);
  });

  it("itens personalizados entram pelo nome, sem diferenciar acento, caixa ou espaços", () => {
    const custom = (name: string, value: number) =>
      order({ items: [{ name, quantity: 1, value, catalogId: null }] });
    const view = buildStorePanel(
      [custom("Frete Combinado", 10), custom("frete  combinado ", 20), custom("Freté combinado", 5), custom("Outro item", 1)],
      { period: "12m", now: NOW },
    );
    expect(view.products.rows).toEqual([
      { kind: "product", name: expect.stringMatching(/combinado/i), quantity: 3, value: 35 },
      { kind: "product", name: "Outro item", quantity: 1, value: 1 },
    ]);
  });

  it("produto renomeado na Wix conta junto, com o nome do pedido mais recente", () => {
    const view = buildStorePanel(
      [
        order({ createdAt: "2026-02-01T12:00:00.000Z", items: [{ name: "Mama Cocha - 5 Minutos", quantity: 1, value: 40, catalogId: "mc" }] }),
        order({ createdAt: "2026-06-01T12:00:00.000Z", items: [{ name: "Mama Cocha - Bastão de Chuva - 5min", quantity: 2, value: 80, catalogId: "mc" }] }),
      ],
      { period: "12m", now: NOW },
    );
    expect(view.products.rows).toEqual([
      { kind: "product", name: "Mama Cocha - Bastão de Chuva - 5min", quantity: 3, value: 120 },
    ]);
  });

  it("mostra os 10 maiores por valor e agrupa o resto em Outros, sem perder nada", () => {
    const orders = Array.from({ length: 13 }, (_, index) =>
      order({ items: [{ name: `Produto ${index}`, quantity: index + 1, value: (index + 1) * 10, catalogId: `p-${index}` }] }),
    );
    const view = buildStorePanel(orders, { period: "12m", now: NOW });
    expect(view.products.rows).toHaveLength(11);
    expect(view.products.rows[0]).toMatchObject({ name: "Produto 12", value: 130 });
    const others = view.products.rows.at(-1)!;
    expect(others).toMatchObject({ kind: "others", name: null, quantity: 1 + 2 + 3, value: 10 + 20 + 30 });
    expect(view.products.rows.reduce((sum, row) => sum + row.value, 0)).toBe(view.products.totalValue);
    expect(view.products.rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(view.products.totalQuantity);
  });
});

describe("análise por cidade", () => {
  it("agrupa grafias da mesma cidade sem diferenciar acento, caixa e espaços, e usa a grafia mais comum", () => {
    const view = buildStorePanel(
      [
        order({ city: "São Paulo", total: 100 }),
        order({ city: "Sao Paulo", total: 50 }),
        order({ city: "são paulo ", total: 30 }),
        order({ city: "SAO  PAULO", total: 20 }),
        order({ city: "São Paulo", total: 10 }),
      ],
      { period: "12m", now: NOW },
    );
    expect(view.cities.rows).toEqual([
      { kind: "city", city: "São Paulo", region: "SP", orders: 5, value: 210, avgTicket: 42 },
    ]);
  });

  it("cidades com o mesmo nome em estados diferentes ficam separadas", () => {
    const view = buildStorePanel(
      [
        order({ city: "Santa Maria", region: "RS", total: 100 }),
        order({ city: "Santa Maria", region: "PE", total: 60 }),
      ],
      { period: "12m", now: NOW },
    );
    expect(view.cities.rows.map(row => `${row.city}/${row.region}`)).toEqual(["Santa Maria/RS", "Santa Maria/PE"]);
  });

  it("pedidos sem cidade vão para uma linha própria e a soma fecha com o total", () => {
    const view = buildStorePanel(
      [
        order({ city: "Curitiba", region: "PR", total: 100 }),
        order({ city: null, region: null, total: 40 }),
        order({ city: "  ", region: null, total: 60 }),
      ],
      { period: "12m", now: NOW },
    );
    expect(view.cities.rows).toEqual([
      { kind: "city", city: "Curitiba", region: "PR", orders: 1, value: 100, avgTicket: 100 },
      { kind: "unknown", city: null, region: null, orders: 2, value: 100, avgTicket: 50 },
    ]);
    expect(view.cities.totalOrders).toBe(3);
    expect(view.cities.rows.reduce((sum, row) => sum + row.orders, 0)).toBe(view.kpis.confirmedOrders);
    expect(view.cities.rows.reduce((sum, row) => sum + row.value, 0)).toBe(view.kpis.revenue);
  });

  it("só 10 cidades aparecem; o resto vira Outras cidades e a soma continua fechando", () => {
    const orders = Array.from({ length: 14 }, (_, index) =>
      order({ city: `Cidade ${String.fromCharCode(65 + index)}`, region: "SP", total: (index + 1) * 10 }),
    );
    orders.push(order({ city: null, region: null, total: 7 }));
    const view = buildStorePanel(orders, { period: "12m", now: NOW });
    expect(view.cities.rows.map(row => row.kind)).toEqual([...Array(10).fill("city"), "others", "unknown"]);
    expect(view.cities.rows[0]).toMatchObject({ city: "Cidade N", value: 140 });
    expect(view.cities.rows[10]).toMatchObject({ kind: "others", orders: 4, value: 10 + 20 + 30 + 40 });
    expect(view.cities.rows.reduce((sum, row) => sum + row.orders, 0)).toBe(15);
    expect(view.cities.rows.reduce((sum, row) => sum + row.value, 0)).toBe(view.kpis.revenue);
  });

  it("não conta cancelados, reembolsados nem aguardando pagamento", () => {
    const view = buildStorePanel(
      [
        order({ city: "Recife", region: "PE", total: 100 }),
        order({ city: "Recife", region: "PE", total: 900, paymentStatus: "NOT_PAID", fulfillmentStatus: "NOT_FULFILLED" }),
        order({ city: "Recife", region: "PE", total: 800, paymentStatus: "FULLY_REFUNDED", status: "CANCELED" }),
      ],
      { period: "12m", now: NOW },
    );
    expect(view.cities.rows).toEqual([{ kind: "city", city: "Recife", region: "PE", orders: 1, value: 100, avgTicket: 100 }]);
  });
});

describe("faturamento por mês", () => {
  it("mostra todos os meses do período, inclusive os sem venda, e usa o mês de São Paulo", () => {
    const view = buildStorePanel(
      [
        order({ createdAt: "2026-08-15T12:00:00.000Z", total: 100 }),
        // 01/11 02:30 UTC ainda é 31/10 em São Paulo.
        order({ createdAt: "2026-11-01T02:30:00.000Z", total: 40 }),
        order({ createdAt: "2026-11-05T12:00:00.000Z", total: 60 }),
        order({ createdAt: "2026-11-06T12:00:00.000Z", total: 500, paymentStatus: "NOT_PAID" }),
      ],
      { period: "90d", now: NOW },
    );
    expect(view.monthly).toEqual([
      { month: "2026-08", orders: 1, revenue: 100 },
      { month: "2026-09", orders: 0, revenue: 0 },
      { month: "2026-10", orders: 1, revenue: 40 },
      { month: "2026-11", orders: 1, revenue: 60 },
    ]);
  });

  it("12 meses cobrem de dezembro do ano anterior até o mês atual", () => {
    const view = buildStorePanel([order({ createdAt: "2026-03-10T12:00:00.000Z" })], { period: "12m", now: NOW });
    expect(view.monthly).toHaveLength(12);
    expect(view.monthly[0]!.month).toBe("2025-12");
    expect(view.monthly.at(-1)!.month).toBe("2026-11");
  });

  it("todo o período começa no primeiro mês com venda confirmada", () => {
    const view = buildStorePanel([order({ createdAt: "2026-09-10T12:00:00.000Z" })], { period: "all", now: NOW });
    expect(view.monthly.map(entry => entry.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });
});

describe("ficha do pedido", () => {
  it("monta cliente, itens, valores e situação só com o que está no retrato salvo", () => {
    const detail = buildStoreOrderDetail(
      order({
        customerName: "Ana Lima",
        email: "ana@example.test",
        phone: "+5511999990000",
        subtotal: 200,
        discount: 10,
        tax: 5,
        shipping: 30,
        shippingMethod: "Correios PAC",
        total: 225,
        paymentStatus: "PAID",
        fulfillmentStatus: "NOT_FULFILLED",
        items: [{ name: "Tambor", quantity: 2, value: 190, catalogId: "cat-1" }],
      }),
    );
    expect(detail).toMatchObject({
      situation: "paid_to_ship",
      payment: "paid",
      delivery: "to_ship",
      confirmedSale: true,
      contactAvailable: true,
      customer: { name: "Ana Lima", email: "ana@example.test", phone: "+5511999990000", city: "São Paulo", region: "SP" },
      items: [{ name: "Tambor", quantity: 2, value: 190 }],
      amounts: { subtotal: 200, discount: 10, tax: 5, shipping: 30, shippingMethod: "Correios PAC", total: 225 },
    });
    expect(JSON.stringify(detail)).not.toContain("cat-1");
  });

  it("pedido cancelado depois de pago não conta como venda confirmada", () => {
    const detail = buildStoreOrderDetail(order({ status: "CANCELED", paymentStatus: "PAID" }));
    expect(detail).toMatchObject({ situation: "cancelled", confirmedSale: false });
  });

  it("pedido de retrato antigo (sem e-mail, telefone e valores novos) marca o contato como indisponível", () => {
    const detail = buildStoreOrderDetail(order());
    expect(detail.contactAvailable).toBe(false);
    expect(detail.customer).toMatchObject({ email: null, phone: null });
    expect(detail.amounts).toMatchObject({ subtotal: null, discount: null, tax: null, shippingMethod: null, shipping: 10 });
  });

  it("pedido novo sem e-mail e telefone na Wix tem contato disponível, porém vazio", () => {
    const detail = buildStoreOrderDetail(order({ email: null, phone: null }));
    expect(detail.contactAvailable).toBe(true);
  });
});
