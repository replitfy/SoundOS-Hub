import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CatalogProduct } from "../wixCatalog.js";

const catalogMock = vi.hoisted(() => ({ getPublishedCatalog: vi.fn() }));
vi.mock("../wixCatalog.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../wixCatalog.js")>()),
  getPublishedCatalog: catalogMock.getPublishedCatalog,
}));

import {
  buscarProduto,
  buscarProdutoNoCatalogo,
  descricaoCurta,
  produtosSimilaresNoCatalogo,
  urlsDeProdutos,
} from "./produtos.js";

function produto(
  id: string,
  name: string,
  extra: Partial<CatalogProduct> & { status?: "linked" | "zero" | "not_linked"; quantity?: number } = {},
): CatalogProduct {
  const { status = "linked", quantity = 7, ...rest } = extra;
  return {
    id,
    sku: `SS${id}`,
    skus: [`SS${id}`],
    name,
    description: `${name}\nAcessórios\nDescrição oficial de ${name}. Segunda frase curta.`,
    descriptionSource: "wix",
    price: 100,
    priceMax: 100,
    currency: "BRL",
    url: `https://www.soundfulness.online/product-page/${id}`,
    imageUrl: null,
    visible: true,
    inStock: true,
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
  produto("3", "Taça Tibetana - Coração", { price: 1680, priceMax: 1680, status: "zero", quantity: 0 }),
  produto("4", "Taça Tibetana - Decorada - Grande", { price: 1380, priceMax: 1380 }),
  produto("5", "Kit Profissional Taças Tibetanas para Massagem de Som", { price: 6980, priceMax: 6980 }),
  produto("6", "Baqueta Feltro para Taças Tibetanas", { price: 98, priceMax: 98 }),
  produto("7", "Hand Pan Kurd 9 Notas", { price: 7890, priceMax: 7890 }),
  produto("8", "Sino Variado", { price: 200, priceMax: 350, url: null }),
  produto("9", "Taça Manipuri", { description: "Descrição gerada", descriptionSource: "sofia-web" }),
];

describe("buscar_produto", () => {
  it("encontra o item exato pelo nome, mesmo com número e unidade escritos por extenso", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "Mama Cocha de 10 minutos" });
    expect(r.tipo_match).toBe("exato");
    expect(r.produtos).toHaveLength(1);
    expect(r.produtos[0]).toMatchObject({ nome: "Mama Cocha - Bastão de Chuva - 10min", preco: 1480, preco_max: null });
    expect(r.produtos[0]!.url).toContain("/product-page/1");
  });

  it("categoria suposta pelo modelo não esconde o item pedido pelo nome", () => {
    // Caso real: o modelo mandou categoria "instrumentos" para "Taça Zen" e a busca voltava vazia.
    const exato = buscarProdutoNoCatalogo(catalogo, { consulta: "Hand Pan Kurd 9 Notas", categoria: "instrumentos" });
    expect(exato.tipo_match).toBe("exato");
    expect(exato.produtos[0]!.nome).toBe("Hand Pan Kurd 9 Notas");

    const ranking = buscarProdutoNoCatalogo(catalogo, { consulta: "taça tibetana", categoria: "instrumentos musicais" });
    expect(ranking.tipo_match).not.toBe("nenhum");
    expect(ranking.produtos.length).toBeGreaterThan(0);
  });

  it("categoria que casa com o catálogo continua estreitando o ranking", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "feltro", categoria: "acessórios" });
    expect(r.produtos.map(p => p.nome)).toContain("Baqueta Feltro para Taças Tibetanas");
  });

  it("aceita um erro de digitação no nome", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "Taça Tibetana Coracao" });
    expect(r.tipo_match).toBe("exato");
    expect(r.produtos[0]!.nome).toBe("Taça Tibetana - Coração");
  });

  it("devolve a família, com os disponíveis primeiro e sem acessórios", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "taça tibetana", uso: "massagem sonora" });
    expect(r.tipo_match).toBe("familia");
    expect(r.produtos.map(p => p.nome)).not.toContain("Baqueta Feltro para Taças Tibetanas");
    expect(r.produtos.at(-1)!.disponibilidade).toBe("indisponivel");
    expect(r.produtos.length).toBeLessThanOrEqual(3);
  });

  it("apresenta um parecido rotulado quando o item pedido não existe", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "Hang Drum" });
    expect(r.tipo_match).toBe("similar");
    expect(r.instrucao).toMatch(/não encontrou exatamente/);
    expect(r.produtos[0]).toMatchObject({ nome: "Hand Pan Kurd 9 Notas", motivo_match: "parecido" });
  });

  it("devolve nenhum quando não há nada razoável", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "violão elétrico" });
    expect(r).toMatchObject({ tipo_match: "nenhum", produtos: [] });
    expect(r.instrucao).toBeTruthy();
  });

  it("devolve erro quando o catálogo falha", async () => {
    catalogMock.getPublishedCatalog.mockRejectedValueOnce(new Error("wix fora"));
    const r = await buscarProduto({ consulta: "taça" });
    expect(r).toMatchObject({ tipo_match: "erro", produtos: [] });
  });

  it("informa faixa de preço quando o valor varia e usa null em vez de URL vazia", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "Sino Variado" });
    expect(r.produtos[0]).toMatchObject({ preco: 200, preco_max: 350, url: null });
    expect(urlsDeProdutos(r)).toEqual([]);
  });

  it("não usa descrição gerada por IA", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "Taça Manipuri" });
    expect(r.produtos[0]!.descricao_curta).toBeNull();
  });

  it("mostra disponibilidade qualitativa e nunca a quantidade", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "Taça Tibetana Coração" });
    expect(r.produtos[0]!.disponibilidade).toBe("indisponivel");
    expect(JSON.stringify(r)).not.toMatch(/quantity|quantidade|"0"/);
  });

  it("respeita preco_max ordenando pelo menor preço", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "taça tibetana", preco_max: 2000 });
    expect(r.produtos.every(p => (p.preco ?? 0) <= 2000)).toBe(true);
    expect(r.produtos[0]!.nome).toBe("Taça Tibetana - Decorada - Grande");
  });

  it("limita a no máximo 5 itens", () => {
    const r = buscarProdutoNoCatalogo(catalogo, { consulta: "", uso: "taça", limite: 50 });
    expect(r.produtos.length).toBeLessThanOrEqual(5);
  });
});

describe("descricao_curta", () => {
  it("pula nome e rótulo, corta frases com linguagem de cura e limita o tamanho", () => {
    const item = produto("x", "Gong Teste", {
      description: "Gong Teste\nAcessórios\nUm gong artesanal de bronze. Promove a cura da ansiedade. Som longo e envolvente.",
    });
    expect(descricaoCurta(item)).toBe("Um gong artesanal de bronze. Som longo e envolvente.");
  });
});

describe("produtos_similares", () => {
  it("exclui o próprio item e prioriza alternativas disponíveis ao indisponível", () => {
    const r = produtosSimilaresNoCatalogo(catalogo, { nome: "Taça Tibetana - Coração" });
    expect(r.tipo_match).toBe("similar");
    expect(r.produtos.map(p => p.nome)).not.toContain("Taça Tibetana - Coração");
    expect(r.produtos[0]!.disponibilidade).toBe("disponivel");
    expect(r.produtos[0]!.motivo_match).toBe("alternativa_ao_item_indisponivel");
  });

  it("aceita produto_id e sku", () => {
    expect(produtosSimilaresNoCatalogo(catalogo, { produto_id: "1" }).produtos[0]!.nome).toContain("5min");
    expect(produtosSimilaresNoCatalogo(catalogo, { sku: "SS2" }).produtos[0]!.nome).toContain("10min");
  });
});

beforeEach(() => {
  catalogMock.getPublishedCatalog.mockReset();
});
