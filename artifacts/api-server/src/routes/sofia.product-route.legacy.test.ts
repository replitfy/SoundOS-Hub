import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { desc, eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
// Rede de segurança do rollback: estes casos fixam o modo legado.
process.env.SOFIA_MODE = "legacy";

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async (input: { messages?: Array<{ role: string; content?: string }> }) => {
          const userMessage = [...(input.messages ?? [])].reverse()
            .find(message => message.role === "user")?.content ?? "";
          return {
          async *[Symbol.asyncIterator]() {
            yield {
              choices: [{
                delta: { content: `Antes de responder sobre “${userMessage}”, quero entender melhor o pedido.` },
                finish_reason: "stop",
              }],
            };
          },
        };
        }),
      },
    },
    responses: {
      create: vi.fn(async (input: { input?: Array<{ role?: string; content?: string }> }) => {
        const userMessage = [...(input.input ?? [])].reverse()
          .find(message => message.role === "user")?.content ?? "";
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.created", response: { id: "response-test" } };
            yield {
              type: "response.output_text.delta",
              delta: `Antes de responder sobre “${userMessage}”, quero entender melhor o pedido.`,
            };
            yield { type: "response.completed", response: { id: "response-test" } };
          },
        };
      }),
    },
  },
}));

const product = {
  id: "wix-product-1",
  sku: "TIG-1",
  skus: ["TIG-1"],
  name: "Tigela Tibetana",
  description: "Descrição oficial da Wix.",
  descriptionSource: "wix",
  price: 450,
  priceMax: null,
  currency: "BRL",
  url: "https://www.soundfulness.store/product-page/tigela-tibetana",
  imageUrl: null,
  visible: true,
  inStock: true,
  omieInventory: {
    source: "omie-store",
    status: "linked",
    quantity: 17,
    physicalQuantity: 20,
    reservedQuantity: 3,
    pendingQuantity: 0,
    minimumQuantity: 1,
    unit: "UN",
    matchedSkus: ["TIG-1"],
    lastUpdated: "2026-09-15T23:00:00.000Z",
  },
};
const birdWhistleProduct = {
  ...product,
  id: "wix-product-bird-whistle",
  sku: "SS000077",
  skus: ["SS000077"],
  name: "Apito som de pássaro",
  price: 70,
  url: "https://www.soundfulness.store/product-page/apito-som-de-passaro",
};
const marimbaProduct = {
  ...product,
  id: "wix-marimba",
  sku: "SS000023",
  skus: ["SS000023"],
  name: "Marimba de Vidro",
  price: 1280,
  url: "https://www.soundfulness.store/product-page/marimba-de-vidro",
};

vi.mock("../services/wixCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/wixCatalog")>();
  const fixtures = () => [product, birdWhistleProduct, marimbaProduct] as import("../services/wixCatalog").CatalogProduct[];
  return {
  ...actual,
  findMentionedPublishedProducts: vi.fn(async (text: string) =>
    actual.findMentionedProducts(fixtures(), text)),
  searchPublishedProducts: vi.fn(async (text: string, limit = 5) =>
    actual.matchPublishedProducts(fixtures(), text, limit)),
  getPublicProductFacts: vi.fn((selectedProduct = product) => ({
    id: selectedProduct.id,
    sku: selectedProduct.sku,
    name: selectedProduct.name,
    description: selectedProduct.description,
    price: selectedProduct.price,
    priceMax: selectedProduct.priceMax,
    currency: product.currency,
    url: selectedProduct.url,
    availability: "disponivel",
    availabilitySource: "omie-store",
    availabilityUpdatedAt: selectedProduct.omieInventory.lastUpdated,
  })),
  formatPublicProductFacts: vi.fn((facts: {
    name: string;
    description: string;
    price: number;
    url: string;
  }, request = "") => [
    facts.name,
    /\b(preço|valor|quanto custa)\b/i.test(request)
      ? `Preço: R$ ${facts.price.toFixed(2).replace(".", ",")}`
      : null,
    /\b(link|página|url|site)\b/i.test(request) ? `Link: ${facts.url}` : null,
    /\b(disponibilidade|disponível|estoque)\b/i.test(request)
      ? "Disponibilidade: disponível no estoque oficial."
      : null,
  ].filter(Boolean).join("\n")),
};
});

const { db, conversations, decisionRuns, messages, pessoasTable } = await import("@workspace/db");
const { default: sofiaRouter } = await import("./sofia");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

function sseContent(text: string): string {
  return text.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as { content?: string })
    .map(event => event.content ?? "")
    .join("");
}

function responseConversationId(text: string): number {
  const event = text.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as { conversationId?: number })
    .find(event => typeof event.conversationId === "number");
  if (!event?.conversationId) throw new Error("response conversation ID missing");
  conversationIds.push(event.conversationId);
  return event.conversationId;
}

const conversationIds: number[] = [];
let pessoaId: number;

describe("Sofia product factual route", () => {
  beforeAll(async () => {
    const marker = randomUUID();
    const [person] = await db.insert(pessoasTable).values({
      codigo: `SOFIA-PRODUCT-${marker}`,
      nome: `Sofia product test ${marker}`,
    }).returning({ id: pessoasTable.id });
    if (!person) throw new Error("test person insert failed");
    pessoaId = person.id;
  });

  afterAll(async () => {
    if (conversationIds.length > 0) {
      await db.delete(decisionRuns).where(inArray(decisionRuns.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (pessoaId) await db.delete(pessoasTable).where(eq(pessoasTable.id, pessoaId));
  });

  it("answers a broad store assortment question with the approved institutional summary", async () => {
    const message = "Oi! Quais produtos vocês vendem na loja da Soundfulness?";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toBe(
      "Vendemos produtos de sound healing, musicoterapia e instrumentos que têm o poder transformador do som. Todos os nossos instrumentos são vibracionais.",
    );
    expect(answer).not.toContain(product.name);
    expect(answer).not.toContain("Fonte");

    const conversation = { id: responseConversationId(response.text) };

    const decisionLog = await request(app)
      .get(`/api/sofia/conversations/${conversation.id}/decision-runs`);
    expect(decisionLog.status).toBe(200);
    expect(decisionLog.body).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          intent: "product_catalog_summary",
          result: "success",
        }),
        triggerMessage: expect.objectContaining({
          role: "user",
          content: message,
        }),
        responseMessage: expect.objectContaining({
          role: "assistant",
          content: answer,
        }),
      }),
    ]);
  });

  it("returns only assistant links and orders tied decision runs deterministically", async () => {
    const tiedAt = new Date("2026-09-19T18:00:00.000Z");
    const [conversation] = await db.insert(conversations).values({
      title: `Decision run linkage ${randomUUID()}`,
      pessoaId,
    }).returning({ id: conversations.id });
    if (!conversation) throw new Error("decision linkage conversation insert failed");
    conversationIds.push(conversation.id);

    const [assistantMessage, userMessage] = await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: "assistant",
        content: "Resposta histórica sem gatilho anterior.",
        createdAt: tiedAt,
      },
      {
        conversationId: conversation.id,
        role: "user",
        content: "Esta mensagem não pode ser rotulada como resposta.",
        createdAt: tiedAt,
      },
    ]).returning({ id: messages.id });
    if (!assistantMessage || !userMessage) throw new Error("decision linkage message insert failed");

    const sharedRun = {
      pessoaId,
      conversationId: conversation.id,
      conduta: "triagem" as const,
      promptId: null,
      model: "gpt-test",
      evidenciasConsideradas: [],
      elegibilidadeStatus: "nao_avaliada" as const,
      elegibilidadeMotivo: null,
      ofertaPrincipal: null,
      ofertaAlternativa: null,
      nbaCategoria: "conversar" as const,
      nbaJustificativa: "Fixture de vínculo do diagnóstico.",
      nivelConfianca: "media" as const,
      metadata: {},
      createdAt: tiedAt,
    };
    const insertedRuns = await db.insert(decisionRuns).values([
      { ...sharedRun, messageId: assistantMessage.id },
      { ...sharedRun, messageId: userMessage.id },
    ]).returning({ id: decisionRuns.id });

    const decisionLog = await request(app)
      .get(`/api/sofia/conversations/${conversation.id}/decision-runs`);

    expect(decisionLog.status).toBe(200);
    expect(decisionLog.body.map((run: { id: number }) => run.id))
      .toEqual(insertedRuns.map(run => run.id));
    expect(decisionLog.body[0]).toEqual(expect.objectContaining({
      triggerMessage: null,
      responseMessage: expect.objectContaining({
        id: assistantMessage.id,
        role: "assistant",
      }),
    }));
    expect(decisionLog.body[1]).toEqual(expect.objectContaining({
      triggerMessage: null,
      responseMessage: null,
    }));
  });

  it("returns only the requested Wix price and Omie availability without exact inventory quantities", async () => {
    const message = "Qual é o preço e a disponibilidade da tigela tibetana?";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });
    const answer = sseContent(response.text);

    expect(response.status).toBe(200);
    expect(answer).toContain("R$ 450,00");
    expect(answer).not.toContain(product.url);
    expect(answer).toContain("disponível no estoque oficial");
    expect(answer).not.toContain("Fonte");
    expect(answer).not.toContain("17");
    expect(answer).not.toContain("conectar com alguém");

    const [conversation] = await db.select({
      id: conversations.id,
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, responseConversationId(response.text))).limit(1);
    if (!conversation) throw new Error("product conversation not found");
    expect(conversation).toMatchObject({ status: "ativa", handoffReason: null });
    const [run] = await db.select({ metadata: decisionRuns.metadata })
      .from(decisionRuns)
      .where(eq(decisionRuns.conversationId, conversation.id))
      .orderBy(desc(decisionRuns.id))
      .limit(1);
    expect(run?.metadata).toMatchObject({
      intent: "product_fact",
      sources: [expect.objectContaining({
        type: "official_product_catalog",
        catalog: "wix",
        inventory: "omie-store",
        productId: product.id,
      })],
      candidate_set: [expect.objectContaining({
        id: product.id,
        name: product.name,
        availability: "disponivel",
      })],
      omitted_fields: expect.arrayContaining(["inventory_quantity", "physical_quantity"]),
    });
    expect(JSON.stringify(run?.metadata)).not.toContain("\"quantity\":17");
    expect(JSON.stringify(run?.metadata)).not.toContain("\"physicalQuantity\":20");
  });

  it("recognizes a literal published product name outside the fixed instrument vocabulary", async () => {
    const message = "A Soundfulness vende Apito som de pássaro? Qual é o preço e o link oficial?";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toContain(birdWhistleProduct.name);
    expect(response.text).toContain("R$ 70,00");
    expect(response.text).toContain(birdWhistleProduct.url);
    expect(response.text).not.toContain("conectar com alguém");

    const [conversation] = await db.select({
      id: conversations.id,
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, responseConversationId(response.text))).limit(1);
    if (!conversation) throw new Error("bird whistle conversation not found");
    expect(conversation).toMatchObject({ status: "ativa", handoffReason: null });
  });

  it("keeps the reported real Marimba price and official link", async () => {
    const response = await request(app).post("/api/sofia/chat").send({
      message: "Vocês vendem Marimba de Vidro? Qual o preço e o link oficial?",
      pessoaId,
    });
    responseConversationId(response.text);
    expect(response.status).toBe(200);
    const answer = sseContent(response.text);
    expect(answer).toContain(marimbaProduct.name);
    expect(answer).toContain("1280,00");
    expect(answer).toContain(marimbaProduct.url);
    expect(answer).not.toContain(product.name);
  });

  it.each([
    "Vocês vendem Cajon Elétrico Bluetooth? Qual o preço e o link oficial?",
    "Vocês têm Cajon Elétrico Bluetooth?",
    "Qual o preço da Marimba de Vidro Bluetooth?",
    "Vocês vendem Pandeiro Astral Bluetooth? Qual o preço e o link?",
    "Vocês vendem Pandeiro Astral Bluetooth?",
    "Vocês têm Pandeiro Astral Bluetooth?",
    "Estou procurando o produto Pandeiro Astral Bluetooth",
  ])("rejects an absent product without substituting a real item: %s", async message => {
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });
    const conversationId = responseConversationId(response.text);
    const answer = sseContent(response.text);
    expect(response.status).toBe(200);
    expect(answer).toMatch(/não (?:encontrei|existe|temos|está|consta)/i);
    expect(answer).toMatch(/catálogo/i);
    expect(answer).not.toMatch(/https?:|R\$|Tigela|Mama Cocha|alternativa/i);
    const [run] = await db.select({ metadata: decisionRuns.metadata }).from(decisionRuns)
      .where(eq(decisionRuns.conversationId, conversationId))
      .orderBy(desc(decisionRuns.id)).limit(1);
    expect(run?.metadata).toMatchObject({ result: "not_found", candidate_set: [] });
  });

  it("does not reuse a previous real product for a newly named absent product", async () => {
    const first = await request(app).post("/api/sofia/chat").send({
      message: "Vocês vendem Marimba de Vidro? Qual o preço e o link oficial?",
      pessoaId,
    });
    const conversationId = responseConversationId(first.text);
    const response = await request(app).post("/api/sofia/chat").send({
      conversationId,
      pessoaId,
      message: "E Cajon Elétrico Bluetooth, vocês têm? Qual o preço e o link?",
    });
    const answer = sseContent(response.text);
    expect(answer).toMatch(/não (?:encontrei|existe|temos|está|consta)/i);
    expect(answer).not.toMatch(/https?:|R\$|Marimba|Tigela|Mama Cocha/i);
  });

  it("keeps a first-turn request for help choosing a formation in triage", async () => {
    const message = "Estou procurando uma formação para usar som no meu trabalho como terapeuta, mas ainda não sei qual.";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toContain("Antes de responder");
    expect(response.text).not.toContain("Não encontrei curso ou turma futura");

    const [conversation] = await db.select({
      id: conversations.id,
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, responseConversationId(response.text))).limit(1);
    if (!conversation) throw new Error("triage conversation not found");
    expect(conversation).toMatchObject({ status: "ativa", handoffReason: null });
  });

  it("does not turn a suitability question about one exact product into a catalog answer", async () => {
    const message = "A Tigela Tibetana é adequada para mim?";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).toContain("Antes de responder");
    expect(response.text).not.toContain(product.url);
    expect(response.text).not.toContain("R$ 450,00");

    const [conversation] = await db.select({
      id: conversations.id,
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, responseConversationId(response.text))).limit(1);
    if (!conversation) throw new Error("suitability conversation not found");
    expect(conversation).toMatchObject({ status: "ativa", handoffReason: null });
  });

  it("routes a transaction request about one exact product to handoff", async () => {
    const message = "Quero contratar a Tigela Tibetana";
    const response = await request(app).post("/api/sofia/chat").send({ message, pessoaId });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain(product.url);
    expect(response.text).not.toContain("R$ 450,00");

    const [conversation] = await db.select({
      id: conversations.id,
      status: conversations.status,
      handoffReason: conversations.handoffReason,
    }).from(conversations).where(eq(conversations.id, responseConversationId(response.text))).limit(1);
    if (!conversation) throw new Error("transaction conversation not found");
    expect(conversation).toMatchObject({ status: "aguardando_humano", handoffReason: "informacao_comercial_bloqueada" });
  });

});