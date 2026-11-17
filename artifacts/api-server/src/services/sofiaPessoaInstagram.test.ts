import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, conversations: {}, messages: {}, pessoasTable: {} }));

const { decidirIdentificacaoInstagram, nomeEhPlaceholder, nomeProvisorioWhatsapp, normalizarUsuarioInstagram, primeiroNomeDe } = await import("./sofiaPessoa.js");

const ficha = (id: number, instagram: string | null, extra: { ativo?: boolean; arquivado_em?: string | null } = {}) =>
  ({ id, instagram, ativo: extra.ativo ?? true, arquivado_em: extra.arquivado_em ?? null });

describe("normalizarUsuarioInstagram", () => {
  it("reduz as formas em que o usuário aparece nas fichas ao mesmo valor", () => {
    for (const bruto of [
      "maria.sol", "@maria.sol", "'@maria.sol", "  @Maria.Sol  ", "MARIA.SOL",
      "https://www.instagram.com/maria.sol", "http://instagram.com/maria.sol/", "instagram.com/maria.sol?hl=pt-br",
    ]) {
      expect(normalizarUsuarioInstagram(bruto), bruto).toBe("maria.sol");
    }
  });

  it("valor sem cara de usuário não casa com ninguém", () => {
    for (const bruto of [null, undefined, "", "   ", "@", "Aaron te ajuda", "maria@gmail.com", "maria.sol@instagram.com", "a".repeat(31), "https://www.instagram.com/"]) {
      expect(normalizarUsuarioInstagram(bruto), String(bruto)).toBeNull();
    }
  });
});

describe("decidirIdentificacaoInstagram", () => {
  it("nenhuma ficha com o usuário: cria", () => {
    expect(decidirIdentificacaoInstagram([], "maria.sol")).toEqual({ status: "criar" });
    expect(decidirIdentificacaoInstagram([ficha(1, "maria.solar"), ficha(2, "maria@gmail.com")], "maria.sol")).toEqual({ status: "criar" });
  });

  it("uma ficha ativa com o usuário, em qualquer grafia: reconhece", () => {
    expect(decidirIdentificacaoInstagram([ficha(7, "'@Maria.Sol")], "maria.sol")).toEqual({ status: "reconhecida", pessoaId: 7 });
  });

  it("várias fichas com o usuário: não escolhe a primeira", () => {
    expect(decidirIdentificacaoInstagram([ficha(7, "@maria.sol"), ficha(9, "maria.sol")], "maria.sol")).toEqual({ status: "usuario_compartilhado" });
  });

  it("ficha arquivada ou inativa: não reconhece nem cria outra", () => {
    expect(decidirIdentificacaoInstagram([ficha(7, "maria.sol", { arquivado_em: "2026-01-01" })], "maria.sol")).toEqual({ status: "ficha_inativa" });
    expect(decidirIdentificacaoInstagram([ficha(7, "maria.sol", { ativo: false })], "maria.sol")).toEqual({ status: "ficha_inativa" });
  });

  it("uma ativa e uma arquivada com o mesmo usuário também é ambíguo", () => {
    expect(decidirIdentificacaoInstagram([ficha(7, "maria.sol"), ficha(9, "maria.sol", { arquivado_em: "2026-01-01" })], "maria.sol"))
      .toEqual({ status: "usuario_compartilhado" });
  });
});

describe("nomeEhPlaceholder com ficha aberta pelo Instagram", () => {
  it("o nome que é só o @usuário ainda pode ser substituído pelo nome verdadeiro", () => {
    expect(nomeEhPlaceholder("@maria.sol")).toBe(true);
    expect(nomeEhPlaceholder("Maria Sol")).toBe(false);
    expect(nomeEhPlaceholder("Maria @ Sol")).toBe(false);
  });
});

describe("nome provisório da ficha aberta pelo WhatsApp", () => {
  it("usa o nome de perfil com o sufixo (WhatsApp) e sem emojis ou símbolos", () => {
    expect(nomeProvisorioWhatsapp("Maria Souza", "5511987654321")).toBe("Maria Souza (WhatsApp)");
    expect(nomeProvisorioWhatsapp("  ✨ Mari 🌸  ", "5511987654321")).toBe("Mari (WhatsApp)");
    expect(nomeProvisorioWhatsapp("Zé do Pandeiro".padEnd(120, "a"), "5511987654321").length).toBeLessThanOrEqual(60 + " (WhatsApp)".length);
  });

  it("sem nome de perfil aproveitável cai para o telefone, nunca para vazio", () => {
    for (const perfil of [null, undefined, "", "🌸✨", ".", "x"]) {
      expect(nomeProvisorioWhatsapp(perfil, "5511987654321")).toBe("WhatsApp +5511987654321");
    }
  });

  it("os dois formatos contam como placeholder: o nome dito pela pessoa os substitui e nenhum vira primeiro nome", () => {
    for (const nome of ["Maria Souza (WhatsApp)", "WhatsApp +5511987654321"]) {
      expect(nomeEhPlaceholder(nome)).toBe(true);
      expect(primeiroNomeDe(nome)).toBeNull();
    }
    expect(nomeEhPlaceholder("Maria Souza")).toBe(false);
    expect(nomeEhPlaceholder("Maria (WhatsApp) Souza")).toBe(false);
  });
});
