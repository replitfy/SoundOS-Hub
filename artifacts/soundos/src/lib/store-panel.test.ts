import { describe, expect, it } from "vitest";
import {
  formatBRL,
  formatMonthKey,
  formatOrderDate,
  formatOrderDateTime,
  formatPhone,
  saoPauloDayKey,
  shouldTryAutomaticRefresh,
  summarizeOrderItems,
  truncateLabel,
} from "./store-panel";

describe("shouldTryAutomaticRefresh", () => {
  const now = new Date("2026-11-07T15:00:00.000Z"); // 12:00 em São Paulo

  it("tenta quando nunca houve tentativa", () => {
    expect(shouldTryAutomaticRefresh({ status: "empty", lastAttemptedAt: null }, now)).toBe(true);
  });

  it("não tenta se já houve tentativa hoje em São Paulo, mesmo que tenha falhado", () => {
    expect(shouldTryAutomaticRefresh({ status: "ready", lastAttemptedAt: "2026-11-07T03:00:00.000Z" }, now)).toBe(false);
    expect(shouldTryAutomaticRefresh({ status: "error", lastAttemptedAt: "2026-11-07T14:59:00.000Z" }, now)).toBe(false);
  });

  it("tenta quando a última tentativa foi em outro dia de São Paulo", () => {
    expect(shouldTryAutomaticRefresh({ status: "ready", lastAttemptedAt: "2026-11-07T02:59:59.000Z" }, now)).toBe(true);
    expect(shouldTryAutomaticRefresh({ status: "error", lastAttemptedAt: "2026-11-05T12:00:00.000Z" }, now)).toBe(true);
  });

  it("não tenta enquanto outra atualização está em andamento", () => {
    expect(shouldTryAutomaticRefresh({ status: "refreshing", lastAttemptedAt: "2026-11-01T12:00:00.000Z" }, now)).toBe(false);
  });

  it("a virada do dia é a meia-noite de São Paulo, não a de UTC", () => {
    expect(saoPauloDayKey(new Date("2026-11-08T02:59:59.000Z"))).toBe("2026-11-07");
    expect(saoPauloDayKey(new Date("2026-11-08T03:00:00.000Z"))).toBe("2026-11-08");
  });
});

describe("formatação do painel", () => {
  it("mostra a data do pedido no calendário de São Paulo", () => {
    // 01:30 UTC de 04/11 ainda é 22:30 de 03/11 em São Paulo.
    expect(formatOrderDate("2026-11-04T01:30:00.000Z", "pt-BR")).toBe("03/11/2026");
    expect(formatOrderDate("2026-11-04T01:30:00.000Z", "fr-FR")).toBe("03/11/2026");
  });

  it("resume itens mostrando quantos ficaram de fora", () => {
    const items = [
      { name: "Bastão", quantity: 2 },
      { name: "Pakal", quantity: 1 },
      { name: "Baqueta", quantity: 3 },
    ];
    expect(summarizeOrderItems(items.slice(0, 1))).toBe("2× Bastão");
    expect(summarizeOrderItems(items.slice(0, 2))).toBe("2× Bastão, 1× Pakal");
    expect(summarizeOrderItems(items)).toBe("2× Bastão, 1× Pakal +1");
  });

  it("formata mês e valor nos dois idiomas", () => {
    expect(formatMonthKey("2026-09", "pt-BR")).toBe("set/2026");
    expect(formatMonthKey("2026-09", "fr-FR")).toBe("sept/2026");
    expect(formatBRL(1234.5, "pt-BR").replace(/\s/g, " ")).toBe("R$ 1.234,50");
  });

  it("corta rótulos longos para o gráfico", () => {
    expect(truncateLabel("curto")).toBe("curto");
    expect(truncateLabel("x".repeat(40), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("formatPhone", () => {
  it("formata celular e fixo brasileiros, com ou sem o 55", () => {
    expect(formatPhone("+5511999990000")).toBe("(11) 99999-0000");
    expect(formatPhone("11999990000")).toBe("(11) 99999-0000");
    expect(formatPhone("(21) 2345-6789")).toBe("(21) 2345-6789");
    expect(formatPhone("552123456789")).toBe("(21) 2345-6789");
  });

  it("número de fora do Brasil ou fora do padrão fica como veio", () => {
    expect(formatPhone("+351912345678")).toBe("+351912345678");
    expect(formatPhone("12345")).toBe("12345");
  });
});

describe("formatOrderDateTime", () => {
  it("mostra data e hora no horário de São Paulo", () => {
    const text = formatOrderDateTime("2026-11-03T16:50:25.976Z", "pt-BR");
    expect(text).toBe("03/11/2026 13:50");
    expect(formatOrderDateTime("2026-11-03T03:05:00.000Z", "pt-BR")).toBe("03/11/2026 00:05");
  });
});
