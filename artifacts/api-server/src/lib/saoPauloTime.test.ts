import { describe, expect, it } from "vitest";
import {
  saoPauloMonthKey,
  startOfSaoPauloDay,
  startOfSaoPauloDayContaining,
} from "./saoPauloTime";

describe("horário de São Paulo", () => {
  it("o dia local começa às 03:00 UTC", () => {
    expect(startOfSaoPauloDay(2026, 11, 7).toISOString()).toBe("2026-11-07T03:00:00.000Z");
  });

  it("um segundo antes da meia-noite local ainda é o dia anterior", () => {
    expect(startOfSaoPauloDayContaining(new Date("2026-11-08T02:59:59.000Z")).toISOString()).toBe(
      "2026-11-07T03:00:00.000Z",
    );
    expect(startOfSaoPauloDayContaining(new Date("2026-11-08T03:00:00.000Z")).toISOString()).toBe(
      "2026-11-08T03:00:00.000Z",
    );
  });

  it("dia e mês fora do intervalo são normalizados", () => {
    expect(startOfSaoPauloDay(2026, 11, 0).toISOString()).toBe("2026-10-31T03:00:00.000Z");
    expect(startOfSaoPauloDay(2026, 0, 1).toISOString()).toBe("2025-12-01T03:00:00.000Z");
  });

  it("o mês local acompanha a meia-noite de São Paulo", () => {
    expect(saoPauloMonthKey(new Date("2026-11-01T02:59:59.000Z"))).toBe("2026-10");
    expect(saoPauloMonthKey(new Date("2026-11-01T03:00:00.000Z"))).toBe("2026-11");
  });
});
