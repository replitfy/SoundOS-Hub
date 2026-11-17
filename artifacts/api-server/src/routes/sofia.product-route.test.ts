// Modo simples: produtos vêm só de buscar_produto/produtos_similares (catálogo
// publicado Wix + disponibilidade qualitativa do Omie). Sem short-circuit de
// loja, sem handoff por "comprar". Os casos do modo legado ficam em
// sofia.product-route.legacy.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import type { CatalogProduct } from "../services/wixCatalog";

process.env.NODE_ENV = "test";
process.env.SOFIA_MODE = "simple";

const modelMocks = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }));
const catalogMock = vi.hoisted(() => ({ getPublishedCatalog: vi.fn() }));

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = { id: "staff-test", name: "Equipe Teste", role: "admin" };
    next();
  },
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: modelMocks.chatCreate } },
    responses: { create: modelMocks.responsesCreate },
  },
}));

vi.mock("../services/wixCatalog", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/wixCatalog")>()),
  getPublishedCatalog: catalogMock.getPublishedCatalog,
}));

const { db, conversations } = await import("@workspace/db");
const { default: sofiaRouter } = await import("./sofia");
const { installScript, parseSse } = await import("./testing/sofiaScriptedModel");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

const ESTOQUE_SECRETO = 4321;

function produto(
  id: string,
  name: string,
  extra: Partial<CatalogProduct> & { status?: "linked" | "zero" | "not_linked" } = {},
): CatalogProduct {
  const { status = "linked", ...rest } = extra;
  const quantity = status === "zero" ? 0 : ESTOQUE_SECRETO;
  return {
    id, sku: `SS${id}`, skus: [`SS${id}`], name,
    description: `${name}\nAcessórios\nDescrição oficial de ${name}. Segunda frase curta.`,
    descriptionSource: "wix", price: 100, priceMax: 100, currency: "BRL",
    url: `https://www.soundfulness.store/product-page/p-${id}`,
    imageUrl: null, visible: true, inStock: true,
    omieInventory: {
      source: "omie-store", status, quantity, physicalQuantity: quantity, reservedQuantity: 0,
      pendingQuantity: 0, minimumQuantity: 0, unit: "UN", matchedSkus: [`SS${id}`], lastUpdated: "2026-10-05T00:00:00Z",
    },
    ...rest,
  };
}

const catalogo: CatalogProduct[] = [
  produto("1", "Mama Cocha - Bastão de Chuva - 10min", { price: 1480, priceMax: 1480 }),
  produto("2", "Mama Cocha - Bastão de Chuva - 5min", { price: 1080, priceMax: 1080 }),
  produto("3", "Taça Tibetana - Coração", { price: 1680, priceMax: 1680, status: "zero" }),
  produto("4", "Taça Tibetana - Decorada - Grande", { price: 1380, priceMax: 1380 }),
  produto("5", "Kit Profissional Taças Tibetanas para Massagem de Som", { price: 6980, priceMax: 6980 }),
  produto("7", "Hand Pan Kurd 9 Notas", { price: 7890, priceMax: 7890 }),
];

const conversationIds: number[] = [];

async function chat(message: string) {
  const res = await request(app).post("/api/sofia/chat").send({ message });
  const parsed = parseSse(res.text);
  if (parsed.done?.conversationId) conversationIds.push(parsed.done.conversationId);
  return parsed;
}

function toolOutputs(params: Record<string, unknown>): string[] {
  const input = (params.input ?? params.messages) as Array<{ type?: string; role?: string; output?: string; content?: string }>;
  return input.filter(i => i.type === "function_call_output" || i.role === "tool").map(i => i.output ?? i.content ?? "");
}

describe("Sofia modo simples — produtos", () => {
  beforeEach(() => {
    catalogMock.getPublishedCatalog.mockResolvedValue({
      source: "wix", lastUpdated: "2026-10-05T00:00:00Z", totalRegistered: catalogo.length, totalHidden: 0,
      products: catalogo, inventory: {},
    });
  });

  afterAll(async () => {
    if (conversationIds.length > 0) await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  });

  it("'link do Mama Cocha de 10 minutos' traz nome, preço e URL Wix corretos", async () => {
    const url = "https://www.soundfulness.store/product-page/p-1";
    const resposta = `O *Mama Cocha - Bastão de Chuva - 10min* custa R$ 1.480,00 e está disponível: ${url}`;
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "buscar_produto", args: { consulta: "Mama Cocha de 10 minutos" } }] },
      { text: resposta },
    ]);
    const { content, done } = await chat("Qual o link do Mama Cocha de 10 minutos?");
    const saida = JSON.parse(toolOutputs(script.requests[1]!.params)[0]!) as { tipo_match: string; produtos: Array<{ nome: string; preco: number; url: string }> };
    expect(saida.tipo_match).toBe("exato");
    expect(saida.produtos[0]).toMatchObject({ nome: "Mama Cocha - Bastão de Chuva - 10min", preco: 1480, url });
    expect(content).toBe(resposta);
    expect(done?.handoffTriggered).toBeUndefined();
  });

  it("taça tibetana para massagem sonora: opções reais com preço e link, sem quantidade de estoque", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "buscar_produto", args: { consulta: "taça tibetana", uso: "massagem sonora" } }] },
      { text: "Tenho estas opções:\n- Kit Profissional Taças Tibetanas para Massagem de Som — R$ 6.980,00 https://www.soundfulness.store/product-page/p-5\n- Taça Tibetana - Decorada - Grande — R$ 1.380,00 https://www.soundfulness.store/product-page/p-4" },
    ]);
    const { content } = await chat("Tem taça tibetana pra massagem sonora?");
    const bruto = toolOutputs(script.requests[1]!.params)[0]!;
    const saida = JSON.parse(bruto) as { produtos: Array<{ url: string; preco: number; disponibilidade: string }> };
    expect(saida.produtos.length).toBeGreaterThanOrEqual(2);
    expect(saida.produtos.length).toBeLessThanOrEqual(5);
    for (const p of saida.produtos) {
      expect(p.url).toMatch(/^https:\/\/www\.soundfulness\.store\/product-page\//);
      expect(["disponivel", "indisponivel", "indeterminada"]).toContain(p.disponibilidade);
    }
    expect(bruto).not.toContain(String(ESTOQUE_SECRETO));
    expect(bruto).not.toMatch(/quantity|quantidade/i);
    expect(content).toContain("product-page/p-5");
    expect(content).toContain("R$ 6.980,00");
  });

  it("item inexistente: parecido rotulado e URL inventada removida", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "buscar_produto", args: { consulta: "Hang Drum" } }] },
      { toolCalls: [{ name: "produtos_similares", args: { nome: "Hang Drum" } }] },
      { text: "Não encontrei exatamente o Hang Drum. Um parecido é o Hand Pan Kurd 9 Notas (R$ 7.890,00): https://www.soundfulness.store/product-page/p-7\nVeja também https://www.soundfulness.store/product-page/hang-drum-original" },
    ]);
    const { content, done } = await chat("Vocês vendem Hang Drum?");
    expect(script.remaining()).toBe(0);
    const primeira = JSON.parse(toolOutputs(script.requests[1]!.params)[0]!) as { tipo_match: string };
    expect(primeira.tipo_match).not.toBe("exato");
    expect(content).toContain("parecido");
    expect(content).toContain("product-page/p-7");
    expect(content).not.toContain("hang-drum-original");
    expect(done?.handoffTriggered).toBeUndefined();
  });

  it("'o kit ainda tem?' responde disponibilidade qualitativa; quantidade inventada não aparece como fato", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "buscar_produto", args: { consulta: "Kit Profissional Taças Tibetanas" } }] },
      { text: "Sim, o Kit Profissional está disponível: https://www.soundfulness.store/product-page/p-5" },
    ]);
    const { content } = await chat("O Kit Profissional de taças ainda tem?");
    const bruto = toolOutputs(script.requests[1]!.params)[0]!;
    expect(bruto).toContain("\"disponibilidade\":\"disponivel\"");
    expect(bruto).not.toContain(String(ESTOQUE_SECRETO));
    expect(content).toContain("disponível");
  });

  it("'quero comprar' recebe o link, sem handoff", async () => {
    installScript(modelMocks, [
      { toolCalls: [{ name: "buscar_produto", args: { consulta: "Taça Tibetana Decorada Grande" } }] },
      { text: "Perfeito! Você compra por aqui: https://www.soundfulness.store/product-page/p-4" },
    ]);
    const { content, done } = await chat("Quero comprar a Taça Tibetana Decorada Grande");
    expect(content).toContain("product-page/p-4");
    expect(done?.handoffTriggered).toBeUndefined();
  });

  it("catálogo fora do ar: a tool devolve instrução de erro e a Sofia não inventa", async () => {
    catalogMock.getPublishedCatalog.mockRejectedValue(new Error("wix down"));
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "buscar_produto", args: { consulta: "tigela" } }] },
      { text: "Vou confirmar com o time interno e te passo o link certinho." },
    ]);
    const { content } = await chat("Tem tigela tibetana?");
    const saida = JSON.parse(toolOutputs(script.requests[1]!.params)[0]!) as { tipo_match: string; instrucao: string };
    expect(saida.tipo_match).toBe("erro");
    expect(saida.instrucao).toMatch(/não invente/i);
    expect(content).toContain("time interno");
  });
});
