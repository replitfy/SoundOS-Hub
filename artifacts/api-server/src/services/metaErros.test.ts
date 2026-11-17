import { describe, expect, it } from "vitest";
import { codigoDaFalhaGuardada, codigoDaMeta, codigoDaMetaNoTexto, codigoDoErroEmTexto, traduzirCodigoDaMeta, traduzirErroDeEnvio } from "./metaErros";

describe("erros da Meta em português", () => {
  it("traduz os três códigos conhecidos e nomeia os demais pelo código", () => {
    expect(traduzirCodigoDaMeta(131030)).toMatch(/lista de teste da Meta \(131030\)/);
    expect(traduzirCodigoDaMeta(131047)).toMatch(/24h/);
    expect(traduzirCodigoDaMeta(131026)).toMatch(/não recebe WhatsApp/);
    expect(traduzirCodigoDaMeta(130429)).toBe("Falha da Meta, código 130429.");
  });

  it("traduz o 131037 como nome de exibição ainda não aprovado, também para falhas antigas já gravadas", () => {
    const texto = traduzirCodigoDaMeta(131037);
    expect(texto).toMatch(/nome de exibição/);
    expect(texto).toMatch(/aprovado pela Meta \(131037\)/);
    expect(texto).toMatch(/respostas podem ser recusadas/);
    // Falha gravada antes da tradução existir: "Falha da Meta, código 131037."
    expect(traduzirErroDeEnvio("Falha da Meta, código 131037.")).toBe(texto);
    expect(traduzirErroDeEnvio('API request failed with status 400: {"error":{"code":131037,"message":"display name approval needed"}}')).toBe(texto);
    expect(traduzirErroDeEnvio(texto)).toBe(texto);
  });

  it("recupera o código de uma falha guardada, traduzida ou não", () => {
    expect(codigoDaFalhaGuardada("Falha da Meta, código 131037.")).toBe(131037);
    expect(codigoDaFalhaGuardada(traduzirCodigoDaMeta(131037))).toBe(131037);
    expect(codigoDaFalhaGuardada(traduzirCodigoDaMeta(190))).toBe(190);
    expect(codigoDaFalhaGuardada(traduzirCodigoDaMeta(131047))).toBe(131047);
    expect(codigoDaFalhaGuardada("Falha da Meta, código 100.")).toBe(100);
    expect(codigoDaFalhaGuardada("O Hablla não conseguiu enviar a mensagem.")).toBeNull();
    expect(codigoDaFalhaGuardada(null)).toBeNull();
  });

  it("lê o código como número ou texto e ignora o que não é código", () => {
    expect(codigoDaMeta(131030)).toBe(131030);
    expect(codigoDaMeta(" 131047 ")).toBe(131047);
    expect(codigoDaMeta("abc")).toBeNull();
    expect(codigoDaMeta(12)).toBeNull();
  });

  it("acha o código no texto do erro sem copiar a mensagem do provedor", () => {
    expect(codigoDaMetaNoTexto("(#131030) Recipient phone number not in allowed list")).toBe(131030);
    expect(traduzirErroDeEnvio("(#131030) Recipient phone number not in allowed list")).not.toMatch(/Recipient/);
    expect(traduzirErroDeEnvio("Erro qualquer sem código")).toBe("Erro qualquer sem código");
    expect(traduzirErroDeEnvio(null)).toBeNull();
  });

  it("lê o código do campo \"code\" do texto do Hablla, antes de qualquer sequência de dígitos", () => {
    expect(codigoDoErroEmTexto('API request failed with status 401: {"error":{"fbtrace_id":"A130123z","code":190}}')).toBe(190);
    expect(codigoDoErroEmTexto('failed: {"error":{"code":"131030"}}')).toBe(131030);
    expect(codigoDoErroEmTexto("(#131047) fora da janela")).toBe(131047);
    expect(codigoDoErroEmTexto("sem código")).toBeNull();
    expect(codigoDoErroEmTexto(null)).toBeNull();
  });

  it("traduz o 190 como token inválido ou expirado", () => {
    expect(traduzirCodigoDaMeta(190)).toMatch(/token de acesso da Meta/);
  });

  it("traduzir de novo um texto já traduzido não muda nada", () => {
    const uma = traduzirErroDeEnvio("(#131030) x")!;
    expect(traduzirErroDeEnvio(uma)).toBe(uma);
  });
});
