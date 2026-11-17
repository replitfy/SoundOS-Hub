import { describe, expect, it } from "vitest";
import { normalizeBrazilianPhone } from "./phone.js";

describe("normalizeBrazilianPhone (espelha a função SQL viva da migração 030)", () => {
  it.each([
    ["+55 (11) 98888-9898", "11988889898", "11-988889898"],
    ["11 98888-9898", "11988889898", "11-988889898"],
    ["(11) 9888-9898", "1198889898", "11-98889898"],
    ["551198889898", "1198889898", "11-98889898"],
    ["5511988889898", "11988889898", "11-988889898"],
  ])("%s → chave %s", (raw, key, display) => {
    expect(normalizeBrazilianPhone(raw)).toEqual({ valid: true, key, display });
  });

  it("mantém número que não é brasileiro como está, com chave só de dígitos", () => {
    expect(normalizeBrazilianPhone(" +44 20 7946 09581 ")).toEqual({ valid: false, key: "4420794609581", display: "+44 20 7946 09581" });
  });

  it.each([null, undefined, "", "   ", "#ERROR!"])("vazio ou lixo de planilha (%s) não tem chave", raw => {
    expect(normalizeBrazilianPhone(raw)).toEqual({ valid: false, key: null, display: null });
  });

  it("texto sem dígitos é inválido e sem chave", () => {
    expect(normalizeBrazilianPhone("sem telefone")).toMatchObject({ valid: false, key: null });
  });
});
