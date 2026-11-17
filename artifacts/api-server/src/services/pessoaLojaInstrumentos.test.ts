// Compras da loja na ficha: filtro de vendas confirmadas, ordem, dia em São Paulo e fim de linha
// quando o Painel Loja ainda não carregou. Snapshot e ligação com fichas são simulados; as regras de
// ligação têm testes próprios em storeOrderPessoa.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreOrder } from "./wixOrders";

const mocks = vi.hoisted(() => ({
  getStorePanelSnapshot: vi.fn(),
  findOrdersOfPessoa: vi.fn(),
}));

vi.mock("./storePanelSnapshot", () => ({ getStorePanelSnapshot: mocks.getStorePanelSnapshot }));
vi.mock("./storeOrderPessoa", () => ({ findOrdersOfPessoa: mocks.findOrdersOfPessoa }));

const { listLojaInstrumentos } = await import("./pessoaLojaInstrumentos");

function order(id: string, overrides: Partial<StoreOrder> = {}): StoreOrder {
  return {
    id,
    number: `N${id}`,
    createdAt: "2026-08-31T17:45:00.000Z",
    customerName: "Cliente",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    total: 100,
    shipping: 0,
    city: null,
    region: null,
    country: null,
    items: [{ name: "Tambor", quantity: 1, value: 100, catalogId: null }],
    ...overrides,
  };
}

function snapshotWith(orders: StoreOrder[]) {
  mocks.getStorePanelSnapshot.mockResolvedValue({
    data: { orders },
    collectedAt: "2026-11-07T16:34:19.670Z",
  });
}

describe("listLojaInstrumentos", () => {
  beforeEach(() => {
    mocks.getStorePanelSnapshot.mockReset();
    mocks.findOrdersOfPessoa.mockReset();
    mocks.findOrdersOfPessoa.mockResolvedValue([]);
  });

  it("sem retrato do Painel Loja, avisa que não está disponível e nem consulta fichas", async () => {
    mocks.getStorePanelSnapshot.mockResolvedValue({ data: null, collectedAt: null });
    expect(await listLojaInstrumentos(7)).toEqual({ disponivel: false, coletadoEm: null, itens: [] });
    expect(mocks.findOrdersOfPessoa).not.toHaveBeenCalled();
  });

  it("só pedidos de venda confirmada chegam à ligação com a ficha", async () => {
    snapshotWith([
      order("pago"),
      order("a-enviar", { fulfillmentStatus: "NOT_FULFILLED" }),
      order("aguardando", { paymentStatus: "NOT_PAID" }),
      order("cancelado", { status: "CANCELED" }),
      order("reembolsado", { paymentStatus: "FULLY_REFUNDED" }),
      order("recusado", { paymentStatus: "DECLINED" }),
    ]);
    await listLojaInstrumentos(7);
    const [pessoaId, sent] = mocks.findOrdersOfPessoa.mock.calls[0] as [number, StoreOrder[]];
    expect(pessoaId).toBe(7);
    expect(sent.map(o => o.id)).toEqual(["pago", "a-enviar"]);
  });

  it("uma linha por item, mais recente primeiro, com dia de São Paulo e semelhança só na ligação por nome", async () => {
    const early = order("antigo", {
      createdAt: "2026-03-10T12:00:00.000Z",
      items: [{ name: "Diapasão 128Hz", quantity: 2, value: 180, catalogId: "d" }],
    });
    // 01:30 UTC ainda é o dia anterior em São Paulo.
    const late = order("recente", {
      createdAt: "2026-09-01T01:30:00.000Z",
      items: [
        { name: "Pakal", quantity: 1, value: 3080, catalogId: null },
        { name: "Baqueta", quantity: 1, value: 40, catalogId: null },
      ],
    });
    snapshotWith([early, late]);
    mocks.findOrdersOfPessoa.mockResolvedValue([
      { order: early, mode: "name", similarity: 87 },
      { order: late, mode: "both", similarity: null },
    ]);

    const result = await listLojaInstrumentos(7);
    expect(result.disponivel).toBe(true);
    expect(result.coletadoEm).toBe("2026-11-07T16:34:19.670Z");
    expect(result.itens).toEqual([
      { id: "recente:0", item: "Pakal", quantidade: 1, dataCompra: "2026-08-31", valor: 3080, pedido: "Nrecente", ligadoPor: "both", semelhanca: null },
      { id: "recente:1", item: "Baqueta", quantidade: 1, dataCompra: "2026-08-31", valor: 40, pedido: "Nrecente", ligadoPor: "both", semelhanca: null },
      { id: "antigo:0", item: "Diapasão 128Hz", quantidade: 2, dataCompra: "2026-03-10", valor: 180, pedido: "Nantigo", ligadoPor: "name", semelhanca: 87 },
    ]);
  });

  it("pessoa sem pedidos ligados volta lista vazia, mas disponível", async () => {
    snapshotWith([order("x")]);
    expect(await listLojaInstrumentos(7)).toEqual({
      disponivel: true,
      coletadoEm: "2026-11-07T16:34:19.670Z",
      itens: [],
    });
  });
});
