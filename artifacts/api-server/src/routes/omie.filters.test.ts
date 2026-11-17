import { describe, expect, it } from "vitest";
import { parseFinancialFilters } from "./omie";

describe("financial route filters", () => {
  it("accepts the documented base-scoped account filter", () => {
    expect(parseFinancialFilters({
      nCodCC: "education:123,store:456",
      base: "education",
      dataDe: "2026-01-01",
      dataAte: "2026-09-15",
    })).toEqual({
      filters: {
        accountKeys: ["education:123", "store:456"],
        base: "education",
        dataDe: "2026-01-01",
        dataAte: "2026-09-15",
      },
    });
  });

  it("rejects inverted periods at the API boundary", () => {
    expect(parseFinancialFilters({
      dataDe: "2026-09-15",
      dataAte: "2026-09-14",
    })).toEqual({
      error: "Período inválido: a data inicial deve ser anterior ou igual à data final.",
    });
  });
});