import { describe, expect, it } from "vitest";
import { formatDateBR, formatDateTimeBR } from "./date";

describe("formatadores de data pt-BR", () => {
  it("formata datas ISO como dia/mês/ano", () => {
    expect(formatDateBR("2026-09-14")).toBe("14/09/2026");
  });

  it("formata data e hora com ano completo", () => {
    expect(formatDateTimeBR("2026-09-14T15:30:00")).toBe("14/09/2026 15:30");
  });

  it("usa o fallback para valores ausentes ou inválidos", () => {
    expect(formatDateBR(null)).toBe("—");
    expect(formatDateBR("inválida", "?")).toBe("?");
  });
});