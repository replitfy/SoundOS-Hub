import * as XLSX from "xlsx";
import type { CatalogProduct, CatalogSnapshot } from "./wixCatalog";

export type IncompleteProductRow = {
  "Produto": string;
  "ID Wix": string;
  "SKU(s)": string;
  "URL Wix": string;
  "Preço mínimo": number | string;
  "Preço máximo": number | string;
  "Moeda": string;
  "Estoque": number | string;
  "Status do estoque": string;
  "Foto ausente": string;
  "Descrição Wix ausente": string;
  "Data do snapshot Wix": string;
};

export const INCOMPLETE_PRODUCT_HEADERS: Array<keyof IncompleteProductRow> = [
  "Produto",
  "ID Wix",
  "SKU(s)",
  "URL Wix",
  "Preço mínimo",
  "Preço máximo",
  "Moeda",
  "Estoque",
  "Status do estoque",
  "Foto ausente",
  "Descrição Wix ausente",
  "Data do snapshot Wix",
];

function spreadsheetText(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function officialDescriptionMissing(product: CatalogProduct): boolean {
  return product.descriptionSource !== "wix";
}

export function findIncompleteProducts(products: CatalogProduct[]): IncompleteProductRow[] {
  return products
    .map(product => {
      const missingPhoto = !product.imageUrl;
      const missingDescription = officialDescriptionMissing(product);
      if (!missingPhoto && !missingDescription) return null;

      return {
        "Produto": spreadsheetText(product.name),
        "ID Wix": spreadsheetText(product.id),
        "SKU(s)": spreadsheetText(product.skus.join(", ")),
        "URL Wix": spreadsheetText(product.url),
        "Preço mínimo": product.price ?? "",
        "Preço máximo": product.priceMax ?? "",
        "Moeda": spreadsheetText(product.currency),
        "Estoque": product.omieInventory.quantity ?? "",
        "Status do estoque": spreadsheetText(product.omieInventory.status),
        "Foto ausente": missingPhoto ? "Sim" : "Não",
        "Descrição Wix ausente": missingDescription ? "Sim" : "Não",
        "Data do snapshot Wix": product.omieInventory.lastUpdated ?? "",
      } satisfies IncompleteProductRow;
    })
    .filter((row): row is IncompleteProductRow => row !== null);
}

export function createIncompleteProductsWorkbook(snapshot: CatalogSnapshot): Buffer {
  const rows = findIncompleteProducts(snapshot.products).map(row => ({
    ...row,
    "Data do snapshot Wix": snapshot.lastUpdated,
  }));
  const worksheet = XLSX.utils.aoa_to_sheet([
    INCOMPLETE_PRODUCT_HEADERS,
    ...rows.map(row => INCOMPLETE_PRODUCT_HEADERS.map(header => row[header])),
  ]);
  worksheet["!autofilter"] = {
    ref: `A1:${XLSX.utils.encode_col(INCOMPLETE_PRODUCT_HEADERS.length - 1)}${Math.max(rows.length + 1, 2)}`,
  };
  worksheet["!cols"] = INCOMPLETE_PRODUCT_HEADERS.map(header => ({
    wch: Math.min(Math.max(String(header).length + 2, 14), 34),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Produtos pendentes");
  workbook.Props = {
    Title: "Produtos Wix com pendências",
    Subject: "Produtos sem foto ou sem descrição oficial",
    CreatedDate: new Date(),
  };
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
