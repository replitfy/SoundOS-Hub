// Regras puras de ligação pedido → ficha (sem banco). As regras com fichas reais ficam no teste de integração.
import { describe, expect, it } from "vitest";
import {
  contactIdentityOf,
  nameMatchPercent,
  nameSimilarityPercent,
  nameWords,
  orderHasContactData,
  resolveByContact,
  resolveByName,
  type PessoaRef,
} from "./storeOrderPessoa";

const ficha = (id: number, nome: string): PessoaRef => ({ id, codigo: `P${id}`, nome });
const words = nameWords;

describe("nameWords", () => {
  it("ignora acento, caixa, pontuação e conectivos", () => {
    expect(words("  JOSÉ da   Silva-Júnior. ")).toEqual(["jose", "silva", "junior"]);
    expect(words("Maria de Souza")).toEqual(["maria", "souza"]);
    expect(words(null)).toEqual([]);
  });
});

describe("semelhança de nomes", () => {
  it("nomes iguais, mesmo com acento, caixa e conectivo, dão 100%", () => {
    expect(nameSimilarityPercent(words("José da Silva"), words("JOSE SILVA"))).toBe(100);
    expect(nameMatchPercent(words("Maria de Souza"), words("maria souza"))).toBe(100);
  });

  it("liga com 75% ou mais e primeira e última palavra idênticas", () => {
    expect(nameMatchPercent(words("Marcelo Antunes Pereira"), words("Marcelo Pereira"))).toBe(80);
    expect(nameMatchPercent(words("Mariana Souza Santos"), words("Mariana Santos"))).toBe(83);
  });

  it("não liga abaixo de 75%, mesmo com primeira e última palavra iguais", () => {
    expect(nameSimilarityPercent(words("Ana Beatriz Lima"), words("Ana Lima"))).toBe(69);
    expect(nameMatchPercent(words("Ana Beatriz Lima"), words("Ana Lima"))).toBeNull();
  });

  it("nomes parecidos de pessoas diferentes não ligam: a primeira e a última palavra precisam ser idênticas", () => {
    // Só pela semelhança de texto, estes pares passariam dos 75%.
    expect(nameSimilarityPercent(words("Maria Silva"), words("Mario Silva"))).toBeGreaterThanOrEqual(75);
    expect(nameMatchPercent(words("Maria Silva"), words("Mario Silva"))).toBeNull();
    expect(nameSimilarityPercent(words("Fernanda Costa"), words("Fernando Costa"))).toBeGreaterThanOrEqual(75);
    expect(nameMatchPercent(words("Fernanda Costa"), words("Fernando Costa"))).toBeNull();
    // Mesma pessoa com o sobrenome grafado diferente: também fica para conferência humana.
    expect(nameMatchPercent(words("Ana Paula Souza"), words("Ana Paula Sousa"))).toBeNull();
  });

  it("nome de uma palavra só nunca liga, nem contra si mesmo", () => {
    expect(nameMatchPercent(words("Maria"), words("Maria"))).toBeNull();
    expect(nameMatchPercent(words("Maria"), words("Maria Silva"))).toBeNull();
    expect(nameMatchPercent(words("Maria de"), words("Maria"))).toBeNull();
  });

  it("o percentual é arredondado para baixo e o limite de 75% é exato", () => {
    // 86,67% aparece como 86%, nunca 87%.
    expect(nameSimilarityPercent(words("Fernanda Costa"), words("Fernando Costa"))).toBe(86);
    // "abcdefg" x "abcxefg": 8 pares de cada lado, 6 em comum = exatamente 75%.
    expect(nameSimilarityPercent(["abcdefg"], ["abcxefg"])).toBe(75);
  });
});

describe("resolveByName", () => {
  it("uma só ficha parecida liga e devolve o percentual", () => {
    const result = resolveByName("Marcelo Antunes Pereira", [ficha(1, "Marcelo Pereira"), ficha(2, "Marcela Pereira")]);
    expect(result).toEqual({
      state: "linked",
      mode: "name",
      person: { id: 1, codigo: "P1", nome: "Marcelo Pereira" },
      similarity: 80,
    });
  });

  it("duas fichas que passam nas regras viram conferência, com o percentual de cada uma, da maior para a menor", () => {
    const result = resolveByName("Mariana Souza Santos", [ficha(7, "Mariana Santos"), ficha(3, "Mariana Souza Santos")]);
    expect(result).toMatchObject({ state: "review", source: "name", reason: "ambiguous" });
    if (result?.state !== "review") throw new Error("esperava conferência");
    expect(result.candidates.map(candidate => [candidate.id, candidate.similarity])).toEqual([
      [3, 100],
      [7, 83],
    ]);
  });

  it("limita as candidatas a 5", () => {
    const pool = Array.from({ length: 8 }, (_, index) => ficha(index + 1, "Lia Souza"));
    const result = resolveByName("Lia Souza", pool);
    if (result?.state !== "review") throw new Error("esperava conferência");
    expect(result.candidates).toHaveLength(5);
  });

  it("sem candidata, nome vazio ou de uma palavra: não resolve", () => {
    expect(resolveByName("Marcelo Antunes Pereira", [ficha(1, "Carla Dias")])).toBeNull();
    expect(resolveByName(null, [ficha(1, "Carla Dias")])).toBeNull();
    expect(resolveByName("Carla", [ficha(1, "Carla")])).toBeNull();
  });

  it("ficha com o nome completo num campo só (sem sobrenome) também liga", () => {
    expect(resolveByName("Luiza Helena Prado", [ficha(9, "Luiza Helena Prado")])).toMatchObject({
      state: "linked",
      mode: "name",
      similarity: 100,
    });
  });
});

describe("resolveByContact", () => {
  const a = ficha(1, "Ana Lima");
  const b = ficha(2, "Bia Lima");

  it("e-mail único, telefone único e os dois concordando", () => {
    expect(resolveByContact([a], [])).toMatchObject({ state: "linked", mode: "email", person: a });
    expect(resolveByContact([], [b])).toMatchObject({ state: "linked", mode: "phone", person: b });
    expect(resolveByContact([a], [a])).toMatchObject({ state: "linked", mode: "both", person: a });
  });

  it("e-mail e telefone em fichas diferentes é contraditório e lista as duas", () => {
    const result = resolveByContact([a], [b]);
    expect(result).toMatchObject({ state: "review", source: "contact", reason: "contradictory" });
    if (result?.state !== "review") throw new Error("esperava conferência");
    expect(result.candidates.map(candidate => candidate.id)).toEqual([1, 2]);
    expect(result.candidates.every(candidate => candidate.similarity === null)).toBe(true);
  });

  it("várias fichas no mesmo e-mail ou telefone compartilhado não escolhe nenhuma", () => {
    expect(resolveByContact([a, b], [])).toMatchObject({ state: "review", reason: "ambiguous" });
    expect(resolveByContact([], [a, b])).toMatchObject({ state: "review", reason: "ambiguous" });
  });

  it("sem nenhuma ficha devolve null para o nome poder tentar", () => {
    expect(resolveByContact([], [])).toBeNull();
  });
});

describe("contato do pedido", () => {
  it("normaliza e-mail e telefone (com e sem 55) e ignora telefone inválido", () => {
    expect(contactIdentityOf({ email: "  Ana@Example.TEST ", phone: "+55 (11) 99999-0000" })).toEqual({
      email: "ana@example.test",
      phone: "11999990000",
    });
    expect(contactIdentityOf({ email: null, phone: "11999990000" }).phone).toBe("11999990000");
    expect(contactIdentityOf({ email: null, phone: "12345" })).toEqual({ email: null, phone: null });
    expect(contactIdentityOf({})).toEqual({ email: null, phone: null });
  });

  it("pedido de retrato antigo (campos ausentes) é diferente de pedido sem e-mail/telefone (nulos)", () => {
    expect(orderHasContactData({})).toBe(false);
    expect(orderHasContactData({ email: null, phone: null })).toBe(true);
  });
});
