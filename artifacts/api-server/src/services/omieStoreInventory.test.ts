import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OmieProdutoEstoqueRaw } from "../lib/omie";
import {
  aggregateInventoryRows,
  getNextStoreInventoryRefreshAt,
  getProductInventory,
  refreshStoreInventory,
  resetStoreInventoryForTests,
} from "./omieStoreInventory";

describe("Omie Store inventory", () => {
  beforeEach(() => {
    process.env["OMIE_STORE_APP_KEY"] = "test-key";
    process.env["OMIE_STORE_APP_SECRET"] = "test-secret";
    resetStoreInventoryForTests();
  });

  it("schedules 23:00 in America/Sao_Paulo", () => {
    expect(getNextStoreInventoryRefreshAt(new Date("2026-08-28T01:30:00.000Z")))
      .toBe("2026-08-28T02:00:00.000Z");
    expect(getNextStoreInventoryRefreshAt(new Date("2026-08-28T02:30:00.000Z")))
      .toBe("2026-08-29T02:00:00.000Z");
  });

  it("aggregates repeated locations by normalized SKU", () => {
    const rows: OmieProdutoEstoqueRaw[] = [
      { cCodigo: " sku-1 ", nSaldo: 2, fisico: 3, reservado: 1 },
      { cCodigo: "SKU-1", nSaldo: 4, fisico: 5, reservado: 1 },
    ];
    expect(aggregateInventoryRows(rows).get("SKU-1")).toMatchObject({
      quantity: 6,
      physicalQuantity: 8,
      reservedQuantity: 2,
    });
  });

  it("matches variants by SKU and sums every matched SKU once", async () => {
    await refreshStoreInventory(async () => [
      { cCodigo: "SKU-BASE", nSaldo: 1, fisico: 2, reservado: 1 },
      { cCodigo: "VAR-A", nSaldo: 3, fisico: 3 },
    ]);

    const inventory = await getProductInventory(["SKU-BASE", "VAR-A", "var-a"]);

    expect(inventory.status).toBe("linked");
    expect(inventory.quantity).toBe(4);
    expect(inventory.matchedSkus).toEqual(["SKU-BASE", "var-a"]);
  });

  it("distinguishes zero stock, missing SKU and unmatched products", async () => {
    await refreshStoreInventory(async () => [{ cCodigo: "ZERO", nSaldo: 0 }]);

    expect((await getProductInventory(["ZERO"])).status).toBe("zero");
    expect((await getProductInventory([])).status).toBe("not_linked");
    expect((await getProductInventory(["UNKNOWN"])).quantity).toBeNull();
  });

  it("preserves the last valid snapshot as stale after an Omie failure", async () => {
    await refreshStoreInventory(async () => [{ cCodigo: "SKU-1", nSaldo: 7 }]);
    await refreshStoreInventory(async () => {
      throw new Error("network unavailable");
    });

    const inventory = await getProductInventory(["SKU-1"]);
    expect(inventory.status).toBe("stale");
    expect(inventory.quantity).toBe(7);
    expect(inventory.lastUpdated).not.toBeNull();
  });

  it("reports error without inventing stock when no valid snapshot exists", async () => {
    const loader = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await refreshStoreInventory(loader);

    const inventory = await getProductInventory(["SKU-1"]);
    expect(inventory.status).toBe("error");
    expect(inventory.quantity).toBeNull();
  });
});