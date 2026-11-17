import { describe, it, expect } from "vitest";
import { parseExpansions } from "./ragQueryExpander";

describe("parseExpansions", () => {
  const original = "terapia sonora";

  it("separa as variações pela barra vertical", () => {
    const out = parseExpansions("banho de som|cura pelo som|massagem sonora", original);
    expect(out).toEqual(["banho de som", "cura pelo som", "massagem sonora"]);
  });

  it("remove numeração, marcadores e aspas que o modelo às vezes acrescenta", () => {
    const out = parseExpansions(`1. "banho de som" | - 'cura pelo som' | 3) massagem sonora`, original);
    expect(out).toEqual(["banho de som", "cura pelo som", "massagem sonora"]);
  });

  it("descarta a variação idêntica à query original, ignorando acento e caixa", () => {
    const out = parseExpansions("TERAPIA SONORA|Terapia Sonora|banho de som", "terapia sonorá");
    expect(out).toEqual(["banho de som"]);
  });

  it("descarta variações repetidas entre si", () => {
    const out = parseExpansions("banho de som|BANHO DE SOM|banho de som ", original);
    expect(out).toEqual(["banho de som"]);
  });

  it("limita a 4 variações", () => {
    const out = parseExpansions("um|dois|tres|quatro|cinco|seis", original);
    expect(out).toHaveLength(4);
  });

  it("ignora fragmentos vazios ou longos demais para serem uma query", () => {
    const out = parseExpansions(`a| |${"x".repeat(250)}|banho de som`, original);
    expect(out).toEqual(["banho de som"]);
  });

  it("devolve lista vazia quando o modelo não respondeu nada aproveitável", () => {
    expect(parseExpansions("", original)).toEqual([]);
    expect(parseExpansions("   |  | ", original)).toEqual([]);
  });

  it("aceita uma resposta sem barras como variação única", () => {
    expect(parseExpansions("banho de som", original)).toEqual(["banho de som"]);
  });
});
