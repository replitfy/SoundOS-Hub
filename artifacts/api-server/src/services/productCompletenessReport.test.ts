import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createIncompleteProductsWorkbook, findIncompleteProducts } from "./productCompletenessReport";
import type { CatalogProduct } from "./wixCatalog";

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id: "wix-1",
    sku: "SKU-1",
    skus: ["SKU-1"],
    name: "Produto",
    description: null,
    descriptionSource: "pending",
    price: 10,
    priceMax: 10,
    currency: "BRL",
    url: "https://example.com/produto",
    imageUrl: null,
    visible: true,
    inStock: true,
    omieInventory: {
      source: "omie-store",
      status: "linked",
      quantity: 4,
      physicalQuantity: 4,
      reservedQuantity: 0,
      pendingQuantity: 0,
      minimumQuantity: 1,
      unit: "un",
      matchedSkus: ["SKU-1"],
      lastUpdated: "2026-09-09T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("product completeness report", () => {
  it("includes products missing either field and marks each missing field", () => {
    const rows = findIncompleteProducts([
      product({ id: "photo-and-description", imageUrl: null, descriptionSource: "pending" }),
      product({ id: "photo-only", imageUrl: null, descriptionSource: "wix" }),
      product({ id: "description-only", imageUrl: "https://static.wixstatic.com/image.jpg", descriptionSource: "pending" }),
      product({ id: "complete", imageUrl: "https://static.wixstatic.com/image.jpg", descriptionSource: "wix" }),
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map(row => [row["ID Wix"], row["Foto ausente"], row["Descrição Wix ausente"]])).toEqual([
      ["photo-and-description", "Sim", "Sim"],
      ["photo-only", "Sim", "Não"],
      ["description-only", "Não", "Sim"],
    ]);
  });

  it("creates a readable workbook with headers even when there are no matching products", () => {
    const snapshot = {
      source: "wix",
      lastUpdated: "2026-09-09T12:00:00.000Z",
      totalRegistered: 1,
      totalHidden: 0,
      products: [product({ imageUrl: "https://static.wixstatic.com/image.jpg", descriptionSource: "wix" })],
      inventory: {
        source: "omie-store",
        status: "ok",
        lastUpdated: null,
        lastAttemptedAt: null,
        totalItems: 0,
        error: null,
        nextRefreshAt: "2026-09-10T02:00:00.000Z",
      },
    } satisfies Parameters<typeof createIncompleteProductsWorkbook>[0];
    const workbook = XLSX.read(createIncompleteProductsWorkbook(snapshot), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets["Produtos pendentes"], { header: 1 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Foto ausente");
    expect(rows[0]).toContain("Descrição Wix ausente");
  });
});
