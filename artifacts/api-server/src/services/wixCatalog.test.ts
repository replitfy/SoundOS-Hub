import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNextCatalogRefreshAt,
  getPublicProductFacts,
  formatPublicProductFacts,
  getPublishedCatalog,
  findMentionedProducts,
  matchPublishedProducts,
  resetWixCatalogCacheForTests,
  searchPublishedProducts,
} from "./wixCatalog";
import type { CatalogProduct } from "./wixCatalog";
import { resetStoreInventoryForTests } from "./omieStoreInventory";

function wixProduct(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `product-${index}`,
    name: `Produto ${String(index).padStart(3, "0")}`,
    description: `<p>Descrição do produto ${index}</p>`,
    sku: `SKU-${index}`,
    visible: true,
    priceData: { price: index, currency: "BRL" },
    stock: { inventoryStatus: "IN_STOCK" },
    productPageUrl: {
      base: "https://www.soundfulness.store",
      path: `/product-page/produto-${index}`,
    },
    variants: [],
    ...overrides,
  };
}

function catalogProduct(name: string, sku: string, description = ""): CatalogProduct {
  return {
    id: sku, sku, skus: [sku], name, description, descriptionSource: "wix",
    price: 100, priceMax: null, currency: "BRL", url: null, imageUrl: null,
    visible: true, inStock: true,
    omieInventory: {
      source: "omie-store", status: "not_linked", quantity: null, physicalQuantity: null,
      reservedQuantity: null, pendingQuantity: null, minimumQuantity: null, unit: null,
      matchedSkus: [], lastUpdated: null,
    },
  };
}

describe("Wix catalog adapter", () => {
  beforeEach(() => {
    process.env["WIX_API_KEY"] = "test-api-key";
    process.env["WIX_SITE_ID"] = "test-site-id";
    process.env["OMIE_STORE_APP_KEY"] = "";
    process.env["OMIE_STORE_APP_SECRET"] = "";
    resetWixCatalogCacheForTests();
    resetStoreInventoryForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWixCatalogCacheForTests();
    resetStoreInventoryForTests();
  });

  it("reads every page using pagingMetadata.total", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => wixProduct(index + 1));
    const secondPage = Array.from({ length: 50 }, (_, index) => wixProduct(index + 101));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        products: firstPage,
        pagingMetadata: { count: 100, offset: 0, total: 150 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        products: secondPage,
        pagingMetadata: { count: 50, offset: 100, total: 150 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPublishedCatalog(true);

    expect(snapshot.products).toHaveLength(150);
    expect(snapshot.totalRegistered).toBe(150);
    expect(snapshot.totalHidden).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).query.paging.offset).toBe(100);
  });

  it("schedules 22:00 in America/Sao_Paulo on the same day before cutoff", () => {
    expect(getNextCatalogRefreshAt(new Date("2026-08-28T00:00:00.000Z")))
      .toBe("2026-08-28T01:00:00.000Z");
  });

  it("schedules the next day after 22:00 in America/Sao_Paulo", () => {
    expect(getNextCatalogRefreshAt(new Date("2026-08-28T02:00:00.000Z")))
      .toBe("2026-08-29T01:00:00.000Z");
  });

  it("keeps reading full pages when the API omits every total field", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => wixProduct(index + 1));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: firstPage }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [wixProduct(101)] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPublishedCatalog(true);

    expect(snapshot.products).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters hidden products, normalizes variants and preserves valid Wix media", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      products: [
        wixProduct(1, {
          media: { mainMedia: { image: { url: "https://static.wixstatic.com/media/product-1.jpg" } } },
          variants: [
            { choices: { Cor: "Azul", Tamanho: "P" }, variant: { sku: "VAR-1", visible: true, priceData: { price: 10, currency: "BRL" } }, stock: { quantity: 1 } },
            { choices: { Cor: "Verde", Tamanho: "G" }, variant: { sku: "VAR-2", visible: true, priceData: { price: 20, currency: "BRL" } }, stock: { quantity: 0 } },
          ],
        }),
        wixProduct(2, { visible: false }),
        wixProduct(3, { productPageUrl: undefined }),
      ],
      pagingMetadata: { count: 3, offset: 0, total: 3 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPublishedCatalog(true);
    const variantProduct = snapshot.products.find(product => product.id === "product-1")!;
    const noUrlProduct = snapshot.products.find(product => product.id === "product-3")!;

    expect(snapshot.products).toHaveLength(2);
    expect(snapshot.totalRegistered).toBe(3);
    expect(snapshot.totalHidden).toBe(1);
    expect(variantProduct.skus).toEqual(["SKU-1", "VAR-1", "VAR-2"]);
    expect(variantProduct.variantOptions).toEqual(["Azul", "P", "Verde", "G"]);
    expect(variantProduct.variantChoices).toEqual([["Azul", "P"], ["Verde", "G"]]);
    expect(variantProduct.price).toBe(10);
    expect(variantProduct.priceMax).toBe(20);
    expect(variantProduct.imageUrl).toBe("https://static.wixstatic.com/media/product-1.jpg");
    expect(noUrlProduct.url).toBeNull();
    expect(noUrlProduct.imageUrl).toBeNull();
    expect(await searchPublishedProducts("VAR-2")).toEqual([variantProduct]);
    expect(await searchPublishedProducts("Produto 001 Azul P")).toEqual([variantProduct]);
    expect(await searchPublishedProducts("Produto 001 Azul G")).toEqual([]);
    expect(await searchPublishedProducts("Azul")).toEqual([]);
    expect(await searchPublishedProducts("Produto 001 Bluetooth")).toEqual([]);
  });

  it("rejects unsafe or cross-origin product and image URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      products: [
        wixProduct(1, {
          productPageUrl: {
            base: "https://www.soundfulness.store",
            path: "javascript:alert(1)",
          },
          media: { mainMedia: { image: { url: "https://tracker.example/image.jpg" } } },
        }),
        wixProduct(2, {
          productPageUrl: {
            base: "https://www.soundfulness.store",
            path: "https://attacker.example/product",
          },
          media: { mainMedia: { image: { url: "http://static.wixstatic.com/media/insecure.jpg" } } },
        }),
      ],
      pagingMetadata: { count: 2, offset: 0, total: 2 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPublishedCatalog(true);

    expect(snapshot.products).toHaveLength(2);
    expect(snapshot.products.every(product => product.url === null)).toBe(true);
    expect(snapshot.products.every(product => product.imageUrl === null)).toBe(true);
  });

  describe("strict product identity matching", () => {
    const marimba = catalogProduct("Marimba de Vidro 8 Notas", "MAR-V8");
    const marimbaMadeira = catalogProduct("Marimba de Madeira 12 Notas", "MAR-M12");
    const cajon = catalogProduct("Cajon Elétrico", "CAJ-EL");
    const combo = catalogProduct(
      "Combo Mama Cocha",
      "COM-MC",
      "Instrumento elétrico, som envolvente, conexão e experiência musical.",
    );
    const tigela = catalogProduct("Tigela Tibetana 20 cm", "TIG-20");
    const apito = catalogProduct("Apito som de pássaro", "API-PAS");
    const gong = catalogProduct("Gong Sinfônico 80 cm", "GON-80");
    const products = [marimba, marimbaMadeira, cajon, combo, tigela, apito, gong];

    it("matches exact SKU, exact names and meaningful partial names in conversation", () => {
      expect(matchPublishedProducts(products, "MAR-V8")).toEqual([marimba]);
      expect(matchPublishedProducts(products, "Marimba de Vidro 8 Notas")).toEqual([marimba]);
      expect(matchPublishedProducts(products, "Qual o preço da Marimba de Vidro oficial?"))
        .toEqual([marimba]);
      expect(findMentionedProducts(products, "Oi, vocês têm a Marimba de Vidro disponível?"))
        .toEqual([marimba]);
      expect(findMentionedProducts(
        products,
        "A Soundfulness vende Apito som de pássaro? Qual é o preço e o link oficial?",
      )).toEqual([apito]);
      expect(matchPublishedProducts(products, "E o preço do Apito som de pássaro?"))
        .toEqual([apito]);
      expect(matchPublishedProducts(products, "A Marimba de Vidro está disponível?"))
        .toEqual([marimba]);
      expect(matchPublishedProducts(products, "Tem no estoque a Marimba de Vidro?"))
        .toEqual([marimba]);
    });

    it("accepts one small typo while retaining the rest of the product identity", () => {
      expect(matchPublishedProducts(products, "Marimba de Virdro")).toEqual([marimba]);
      expect(findMentionedProducts(products, "Queria saber da Marimpa de Vidro"))
        .toEqual([marimba]);
    });

    it("fails closed for nonexistent names and unknown modifiers", () => {
      expect(matchPublishedProducts(products, "Cajon Elétrico Bluetooth")).toEqual([]);
      expect(findMentionedProducts(products, "Quero comprar o Cajon Elétrico Bluetooth"))
        .toEqual([]);
      expect(matchPublishedProducts(products, "Marimba de Vidro Bluetooth")).toEqual([]);
      expect(matchPublishedProducts(products, "Hang Drum Galáctico")).toEqual([]);
    });

    it("never uses generic description overlap to substitute another product", () => {
      expect(matchPublishedProducts(products, "Cajon Elétrico Bluetooth"))
        .not.toContain(combo);
      expect(matchPublishedProducts(products, "instrumento elétrico com conexão"))
        .toEqual([]);
    });

    it("fails closed for variant modifiers present only in an older flattened cache shape", () => {
      const oldCachedProduct = { ...tigela, variantOptions: ["Azul", "P"] };
      expect(matchPublishedProducts([oldCachedProduct], "Tigela Tibetana Azul P")).toEqual([]);
    });

    it("returns name-family candidates for legitimate one-word catalog requests", () => {
      expect(matchPublishedProducts(products, "Quais cajons vocês têm?")).toEqual([cajon]);
      expect(matchPublishedProducts(products, "Vocês vendem marimba?"))
        .toEqual([marimbaMadeira, marimba]);
      expect(matchPublishedProducts(products, "Quais marimbas vocês têm?"))
        .toEqual([marimbaMadeira, marimba]);
      expect(matchPublishedProducts(products, "Qual o preço do gong?")).toEqual([gong]);
      expect(matchPublishedProducts(products, "Kalimba")).toEqual([]);
    });
  });

  it.each([
    ["linked", "disponivel"],
    ["zero", "indisponivel"],
    ["stale", "indeterminada"],
    ["not_linked", "indeterminada"],
    ["error", "indeterminada"],
  ] as const)("exposes %s inventory only as %s without quantities", (status, availability) => {
    const product = {
      id: "p1", sku: "SKU-1", skus: ["SKU-1"], name: "Tigela",
      description: "Descrição oficial", descriptionSource: "wix",
      price: 100, priceMax: null, currency: "BRL", url: "https://www.soundfulness.store/product-page/tigela",
      imageUrl: null, visible: true, inStock: true,
      omieInventory: {
        source: "omie-store", status, quantity: 17, physicalQuantity: 20,
        reservedQuantity: 3, pendingQuantity: 0, minimumQuantity: 1,
        unit: "UN", matchedSkus: ["SKU-1"], lastUpdated: "2026-09-15T12:00:00Z",
      },
    } satisfies CatalogProduct;

    const facts = getPublicProductFacts(product);

    expect(facts.availability).toBe(availability);
    expect(facts).not.toHaveProperty("quantity");
    expect(JSON.stringify(facts)).not.toContain("17");
    const formatted = formatPublicProductFacts(facts, "Qual é o preço e a disponibilidade?");
    expect(formatted).not.toContain("17");
    expect(formatted).toContain("R$ 100,00");
    expect(formatted).toContain("Disponibilidade:");
    expect(formatted).not.toContain("https://www.soundfulness.store/product-page/tigela");
    expect(formatted).not.toContain("Fonte");

    const linkOnly = formatPublicProductFacts(facts, "Qual é o link do produto?");
    expect(linkOnly).toContain("https://www.soundfulness.store/product-page/tigela");
    expect(linkOnly).not.toContain("R$ 100,00");
  });
});