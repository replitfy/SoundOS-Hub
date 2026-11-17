// Rotas do Painel Loja: filtros, mensagens de erro, gatilho de atualização, ficha do pedido e fim da rota fictícia /store/kpis.
// O snapshot e a busca de fichas são simulados: nenhum teste chama a Wix nem lê Pessoas (as regras de ligação
// têm testes próprios em storeOrderPessoa).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { StorePanelSnapshotState } from "../services/storePanelSnapshot";
import type { StoreOrder } from "../services/wixOrders";

process.env.NODE_ENV = "test";

const session = vi.hoisted(() => ({ areas: ["painel-loja"] as string[] }));

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = { id: "u1", role: "usuario", areas: session.areas };
    next();
  },
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const snapshot = vi.hoisted(() => ({
  getStorePanelSnapshot: vi.fn(),
  refreshStorePanelSnapshot: vi.fn(),
}));

const pessoa = vi.hoisted(() => ({ linkOrdersToPessoas: vi.fn() }));

vi.mock("../services/storeOrderPessoa", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/storeOrderPessoa")>();
  return { ...actual, ...pessoa };
});

vi.mock("../services/storePanelSnapshot", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/storePanelSnapshot")>();
  return { ...actual, ...snapshot };
});

const { default: storeRouter } = await import("./store");

const app = express();
app.use(express.json());
// Em produção o pino-http coloca o logger na requisição.
app.use((req, _res, next) => {
  (req as unknown as { log: { error: () => void } }).log = { error: () => {} };
  next();
});
app.use("/api", storeRouter);

function order(id: string, overrides: Partial<StoreOrder> = {}): StoreOrder {
  return {
    id,
    number: id,
    createdAt: new Date().toISOString(),
    customerName: "Cliente",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    total: 100,
    shipping: 10,
    city: "São Paulo",
    region: "SP",
    country: "BR",
    items: [{ name: "Produto", quantity: 1, value: 90, catalogId: "p" }],
    ...overrides,
  };
}

function state(overrides: Partial<StorePanelSnapshotState> = {}): StorePanelSnapshotState {
  return {
    status: "ready",
    schemaVersion: 1,
    data: { orders: [order("a"), order("b", { paymentStatus: "NOT_PAID", fulfillmentStatus: "NOT_FULFILLED" })] },
    collectedAt: "2026-11-07T12:00:00.000Z",
    lastAttemptedAt: "2026-11-07T12:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  snapshot.getStorePanelSnapshot.mockReset();
  snapshot.refreshStorePanelSnapshot.mockReset();
  pessoa.linkOrdersToPessoas.mockReset();
  session.areas = ["painel-loja"];
});

describe("GET /store/panel", () => {
  it("devolve os números do período a partir do snapshot, sem consultar a Wix", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(state());
    const res = await request(app).get("/api/store/panel");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ready",
      collectedAt: "2026-11-07T12:00:00.000Z",
      lastError: null,
      lastErrorCode: null,
      data: { period: "12m", kpis: { orders: 2, confirmedOrders: 1, revenue: 100 } },
    });
    expect(snapshot.refreshStorePanelSnapshot).not.toHaveBeenCalled();
  });

  it("aplica período, situação e página recebidos", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(state());
    const res = await request(app).get("/api/store/panel").query({ period: "30d", situation: "awaiting_payment", page: "1" });
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe("30d");
    expect(res.body.data.orders).toMatchObject({ situation: "awaiting_payment", total: 1 });
  });

  it("aceita intervalo de datas e chave de produto", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(state());
    const res = await request(app).get("/api/store/panel").query({
      dataDe: "2026-11-01",
      dataAte: "2026-11-30",
      product: "id:p",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.kpis.orders).toBe(2);
    expect(res.body.data.productOptions).toContainEqual({ key: "id:p", name: "Produto" });
  });

  it("antes da primeira carga devolve estado vazio, sem dados inventados", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(
      state({ status: "empty", data: null, collectedAt: null, lastAttemptedAt: null }),
    );
    const res = await request(app).get("/api/store/panel");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "empty", data: null, collectedAt: null });
  });

  it("falha da última atualização vira mensagem em português, com o código, e mantém os dados anteriores", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(state({ status: "error", lastError: "credential_refused" }));
    const res = await request(app).get("/api/store/panel");
    expect(res.status).toBe(200);
    expect(res.body.lastErrorCode).toBe("credential_refused");
    expect(res.body.lastError).toMatch(/credencial/i);
    expect(res.body.data.kpis.orders).toBe(2);
  });

  it("erro gravado desconhecido vira mensagem genérica", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(state({ status: "error", lastError: "algo estranho" }));
    const res = await request(app).get("/api/store/panel");
    expect(res.body.lastErrorCode).toBe("unknown");
    expect(res.body.lastError).toMatch(/Painel Loja/);
  });

  it("filtros inválidos dão 400", async () => {
    for (const query of [
      { period: "7d" },
      { situation: "enviado" },
      { page: "0" },
      { page: "x" },
      { dataDe: "2026-02-30" },
      { dataDe: "2026-11-08", dataAte: "2026-11-01" },
      { product: "" },
    ]) {
      const res = await request(app).get("/api/store/panel").query(query);
      expect(res.status).toBe(400);
    }
    expect(snapshot.getStorePanelSnapshot).not.toHaveBeenCalled();
  });

  it("falha ao ler o banco dá 500 com mensagem clara", async () => {
    snapshot.getStorePanelSnapshot.mockRejectedValue(new Error("db down"));
    const res = await request(app).get("/api/store/panel");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Painel Loja/);
  });
});

const linkedByEmail = { state: "linked", mode: "email", person: { id: 7, codigo: "P7", nome: "Ana Lima" }, similarity: null };

describe("ficha da pessoa na lista", () => {
  it("quem só tem o Painel Loja não recebe nada de ficha e a busca em Pessoas nem roda", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(state());
    const res = await request(app).get("/api/store/panel");
    expect(res.status).toBe(200);
    for (const row of res.body.data.orders.rows) expect(row).not.toHaveProperty("pessoaLink");
    expect(pessoa.linkOrdersToPessoas).not.toHaveBeenCalled();
  });

  it("com a área Pessoas, cada linha traz a ligação (ou null) calculada só para a página pedida", async () => {
    session.areas = ["painel-loja", "pessoas"];
    snapshot.getStorePanelSnapshot.mockResolvedValue(state());
    pessoa.linkOrdersToPessoas.mockImplementation(async (orders: StoreOrder[]) => {
      return new Map(
        orders.map(item => [item.id, item.id === "a" ? linkedByEmail : { state: "none" }]),
      );
    });
    const res = await request(app).get("/api/store/panel");
    const rows = res.body.data.orders.rows as Array<{ id: string; pessoaLink: unknown }>;
    expect(rows.find(row => row.id === "a")?.pessoaLink).toEqual({ mode: "email", similarity: null });
    expect(rows.find(row => row.id === "b")?.pessoaLink).toBeNull();
    expect(pessoa.linkOrdersToPessoas.mock.calls[0]![0].map((item: StoreOrder) => item.id).sort()).toEqual(["a", "b"]);
  });

  it("ligação por nome devolve o percentual; conferência e pedido sem ficha não marcam a linha", async () => {
    session.areas = ["pessoas", "painel-loja"];
    snapshot.getStorePanelSnapshot.mockResolvedValue(state());
    pessoa.linkOrdersToPessoas.mockResolvedValue(
      new Map<string, unknown>([
        ["a", { state: "linked", mode: "name", person: { id: 1, codigo: "P1", nome: "Ana Lima" }, similarity: 92 }],
        ["b", { state: "review", source: "contact", reason: "ambiguous", candidates: [] }],
      ]),
    );
    const res = await request(app).get("/api/store/panel");
    const rows = res.body.data.orders.rows as Array<{ id: string; pessoaLink: unknown }>;
    expect(rows.find(row => row.id === "a")?.pessoaLink).toEqual({ mode: "name", similarity: 92 });
    expect(rows.find(row => row.id === "b")?.pessoaLink).toBeNull();
  });

  it("só pede ligação das 20 linhas da página, não do período inteiro", async () => {
    session.areas = ["painel-loja", "pessoas"];
    const many = Array.from({ length: 45 }, (_, index) => order(`m${String(index).padStart(2, "0")}`));
    snapshot.getStorePanelSnapshot.mockResolvedValue(state({ data: { orders: many } }));
    pessoa.linkOrdersToPessoas.mockResolvedValue(new Map());
    const res = await request(app).get("/api/store/panel").query({ page: "2" });
    expect(res.status).toBe(200);
    expect(pessoa.linkOrdersToPessoas.mock.calls[0]![0]).toHaveLength(20);
  });

  it("sem nenhum pedido na página não consulta Pessoas", async () => {
    session.areas = ["painel-loja", "pessoas"];
    snapshot.getStorePanelSnapshot.mockResolvedValue(state({ status: "empty", data: null }));
    const res = await request(app).get("/api/store/panel");
    expect(res.status).toBe(200);
    expect(pessoa.linkOrdersToPessoas).not.toHaveBeenCalled();
  });
});

describe("GET /store/panel/orders/:orderId", () => {
  const detailState = () =>
    state({
      data: {
        orders: [
          order("a", { customerName: "Ana Lima", email: "ana@example.test", phone: "+5511999990000", subtotal: 90, discount: 0, tax: 0, shippingMethod: "PAC" }),
          order("legacy"),
        ],
      },
    });

  it("devolve a ficha do pedido a partir do retrato salvo, sem chamar a Wix", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(detailState());
    const res = await request(app).get("/api/store/panel/orders/a");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "a",
      confirmedSale: true,
      contactAvailable: true,
      customer: { name: "Ana Lima", email: "ana@example.test", phone: "+5511999990000" },
      amounts: { subtotal: 90, shipping: 10, shippingMethod: "PAC", total: 100 },
    });
    expect(snapshot.refreshStorePanelSnapshot).not.toHaveBeenCalled();
  });

  it("sem a área Pessoas a resposta não tem nenhum dado de ficha e Pessoas não é consultada", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(detailState());
    const res = await request(app).get("/api/store/panel/orders/a");
    expect(res.body).not.toHaveProperty("pessoa");
    expect(pessoa.linkOrdersToPessoas).not.toHaveBeenCalled();
  });

  it("com a área Pessoas inclui a ligação resolvida na hora", async () => {
    session.areas = ["painel-loja", "pessoas"];
    snapshot.getStorePanelSnapshot.mockResolvedValue(detailState());
    pessoa.linkOrdersToPessoas.mockResolvedValue(new Map([["a", linkedByEmail]]));
    const res = await request(app).get("/api/store/panel/orders/a");
    expect(res.body.pessoa).toEqual(linkedByEmail);
    expect(pessoa.linkOrdersToPessoas.mock.calls[0]![0]).toHaveLength(1);
  });

  it("pedido de retrato antigo marca o contato como indisponível", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(detailState());
    const res = await request(app).get("/api/store/panel/orders/legacy");
    expect(res.body.contactAvailable).toBe(false);
    expect(res.body.customer).toMatchObject({ email: null, phone: null });
  });

  it("pedido que não está no retrato, ou retrato vazio, dá 404 em português", async () => {
    snapshot.getStorePanelSnapshot.mockResolvedValue(detailState());
    const missing = await request(app).get("/api/store/panel/orders/inexistente");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/Pedido não encontrado/);

    snapshot.getStorePanelSnapshot.mockResolvedValue(state({ status: "empty", data: null }));
    const empty = await request(app).get("/api/store/panel/orders/a");
    expect(empty.status).toBe(404);
  });

  it("falha ao ler o banco dá 500 com mensagem clara", async () => {
    snapshot.getStorePanelSnapshot.mockRejectedValue(new Error("db down"));
    const res = await request(app).get("/api/store/panel/orders/a");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/pedido/i);
  });

  it("falha ao procurar a ficha dá 500 em vez de mostrar o pedido como se não houvesse ficha", async () => {
    session.areas = ["painel-loja", "pessoas"];
    snapshot.getStorePanelSnapshot.mockResolvedValue(detailState());
    pessoa.linkOrdersToPessoas.mockRejectedValue(new Error("db down"));
    const res = await request(app).get("/api/store/panel/orders/a");
    expect(res.status).toBe(500);
  });
});

describe("POST /store/panel/refresh", () => {
  it("o botão Atualizar (manual) é o padrão", async () => {
    snapshot.refreshStorePanelSnapshot.mockResolvedValue(state());
    const res = await request(app).post("/api/store/panel/refresh");
    expect(res.status).toBe(200);
    expect(snapshot.refreshStorePanelSnapshot).toHaveBeenCalledWith("manual");
    expect(res.body).not.toHaveProperty("data");
    expect(res.body.status).toBe("ready");
  });

  it("a atualização automática repassa o gatilho para a regra de uma por dia", async () => {
    snapshot.refreshStorePanelSnapshot.mockResolvedValue(state());
    await request(app).post("/api/store/panel/refresh").query({ trigger: "automatic" });
    expect(snapshot.refreshStorePanelSnapshot).toHaveBeenCalledWith("automatic");
  });

  it("falha da Wix não é erro HTTP: devolve o motivo e o estado de erro", async () => {
    snapshot.refreshStorePanelSnapshot.mockResolvedValue(state({ status: "error", lastError: "wix_unavailable" }));
    const res = await request(app).post("/api/store/panel/refresh");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "error", lastErrorCode: "wix_unavailable" });
    expect(res.body.lastError).toMatch(/Wix/);
  });

  it("gatilho inválido dá 400 sem tentar atualizar", async () => {
    const res = await request(app).post("/api/store/panel/refresh").query({ trigger: "sempre" });
    expect(res.status).toBe(400);
    expect(snapshot.refreshStorePanelSnapshot).not.toHaveBeenCalled();
  });
});

describe("rota fictícia removida", () => {
  it("/store/kpis não existe mais", async () => {
    const res = await request(app).get("/api/store/kpis");
    expect(res.status).toBe(404);
  });
});
