import { describe, expect, it } from "vitest";
import {
  interestGroupLabel,
  interestOfferIdentity,
  interestOfferLabel,
  interestOfferLabelForEvent,
  normalizeGrupo,
  normalizePaginaOrigem,
  parseInterestEventId,
  validateInterestAnswers,
} from "./interesseGeral";

describe("normalizeGrupo", () => {
  it("remove acento, caixa e símbolos", () => {
    expect(normalizeGrupo("Água")).toBe("agua");
    expect(normalizeGrupo("  Éter / Novo!! ")).toBe("eter-novo");
  });
  it("devolve null para vazio, símbolos e tipos errados", () => {
    expect(normalizeGrupo("")).toBeNull();
    expect(normalizeGrupo("!!!")).toBeNull();
    expect(normalizeGrupo(42)).toBeNull();
    expect(normalizeGrupo(undefined)).toBeNull();
  });
  it("limita o tamanho sem deixar hífen no fim", () => {
    const value = normalizeGrupo(`${"a".repeat(39)}-b`);
    expect(value).toBe("a".repeat(39));
  });
});

describe("rótulos do grupo", () => {
  it("usa o nome dos grupos conhecidos e capitaliza os demais", () => {
    expect(interestGroupLabel("terra")).toBe("Terra");
    expect(interestGroupLabel("eter-novo")).toBe("Eter novo");
    expect(interestGroupLabel(null)).toBeNull();
    expect(interestOfferLabel("fogo")).toBe("Lista de interesse — Fogo");
    expect(interestOfferLabel(null)).toBe("Interesse geral");
    expect(interestOfferLabelForEvent("agua", "Retiro de Água")).toBe("Lista de interesse — Água — Retiro de Água");
    expect(interestOfferLabelForEvent(null, "Retiro de Água")).toBe("Interesse geral — Retiro de Água");
    expect(interestOfferIdentity("agua")).toBe("interesse-geral:agua");
    expect(interestOfferIdentity("agua", 42)).toBe("interesse-geral:agua:evento:42");
  });
});

describe("parseInterestEventId", () => {
  it("aceita a ausência ou um id inteiro positivo", () => {
    expect(parseInterestEventId(undefined)).toBeNull();
    expect(parseInterestEventId("42")).toBe(42);
    expect(parseInterestEventId(42)).toBe(42);
  });

  it("distingue ids inválidos da ausência do vínculo", () => {
    for (const value of ["0", "-2", "1.5", "abc", "", true, Number.MAX_SAFE_INTEGER + 1]) {
      if (value === "") expect(parseInterestEventId(value)).toBeNull();
      else expect(parseInterestEventId(value)).toBe(false);
    }
  });
});

describe("normalizePaginaOrigem", () => {
  it("mantém só http(s), sem credenciais nem âncora", () => {
    expect(normalizePaginaOrigem("https://user:pw@site.com/agua?x=1#topo")).toBe("https://site.com/agua?x=1");
    expect(normalizePaginaOrigem("https://site.com")).toBe("https://site.com/");
  });
  it("descarta o que não é URL http(s)", () => {
    expect(normalizePaginaOrigem("javascript:alert(1)")).toBeNull();
    expect(normalizePaginaOrigem("não é url")).toBeNull();
    expect(normalizePaginaOrigem("")).toBeNull();
    expect(normalizePaginaOrigem(null)).toBeNull();
  });
  it("encurta endereços longos para origem e caminho", () => {
    const result = normalizePaginaOrigem(`https://site.com/p?q=${"x".repeat(900)}`);
    expect(result).toBe("https://site.com/p");
  });
});

describe("validateInterestAnswers", () => {
  const valid = { nome: "Ana", celular: "(11) 98765-4321", instagram: "@ana", email: "ANA@Example.com" };
  it("aceita os quatro campos e normaliza o e-mail", () => {
    const result = validateInterestAnswers(valid);
    expect(result).toMatchObject({ ok: true, answers: { email: "ana@example.com", nome: "Ana" } });
  });
  it("Instagram é opcional: vazio, só espaços ou ausente não recusam e a chave não é gravada", () => {
    const { instagram: _instagram, ...semInstagram } = valid;
    for (const input of [{ ...valid, instagram: "" }, { ...valid, instagram: "   " }, semInstagram]) {
      const result = validateInterestAnswers(input);
      expect(result.ok, JSON.stringify(input)).toBe(true);
      if (result.ok) expect(result.answers).not.toHaveProperty("instagram");
    }
    expect(validateInterestAnswers({ ...valid, instagram: "x".repeat(101) }).ok).toBe(false);
  });
  it("recusa campo obrigatório ausente, campo extra, e-mail e WhatsApp inválidos", () => {
    expect(validateInterestAnswers({ ...valid, nome: "" }).ok).toBe(false);
    expect(validateInterestAnswers({ ...valid, celular: "" }).ok).toBe(false);
    expect(validateInterestAnswers({ ...valid, email: "" }).ok).toBe(false);
    expect(validateInterestAnswers({ ...valid, cpf: "1" }).ok).toBe(false);
    expect(validateInterestAnswers({ ...valid, email: "x" }).ok).toBe(false);
    expect(validateInterestAnswers({ ...valid, celular: "12" }).ok).toBe(false);
    expect(validateInterestAnswers(null).ok).toBe(false);
    expect(validateInterestAnswers([]).ok).toBe(false);
  });
  it("recusa valores que não são texto", () => {
    expect(validateInterestAnswers({ ...valid, nome: 5 }).ok).toBe(false);
  });
});
