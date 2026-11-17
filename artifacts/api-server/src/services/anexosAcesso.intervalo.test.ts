import { describe, expect, it } from "vitest";
import { intervaloDeBytes } from "./anexosAcesso";

describe("intervaloDeBytes (Range)", () => {
  it("sem cabeçalho serve o arquivo inteiro", () => {
    expect(intervaloDeBytes(undefined, 100)).toEqual({ tipo: "completo" });
  });

  it.each([
    ["bytes=0-9", { tipo: "parcial", inicio: 0, fim: 9 }],
    ["bytes=10-", { tipo: "parcial", inicio: 10, fim: 99 }],
    ["bytes=-20", { tipo: "parcial", inicio: 80, fim: 99 }],
    ["bytes=90-5000", { tipo: "parcial", inicio: 90, fim: 99 }],
    ["bytes=-500", { tipo: "parcial", inicio: 0, fim: 99 }],
  ])("%s", (cabecalho, esperado) => expect(intervaloDeBytes(cabecalho, 100)).toEqual(esperado));

  it.each(["bytes=100-", "bytes=200-300", "bytes=50-10", "bytes=-0", "bytes=-"])("%s não é atendível", cabecalho => {
    expect(intervaloDeBytes(cabecalho, 100)).toEqual({ tipo: "invalido" });
  });

  it("vários intervalos ou formato desconhecido servem o arquivo inteiro", () => {
    expect(intervaloDeBytes("bytes=0-1,5-6", 100)).toEqual({ tipo: "completo" });
    expect(intervaloDeBytes("items=0-1", 100)).toEqual({ tipo: "completo" });
  });

  it("arquivo vazio nunca atende um intervalo", () => {
    expect(intervaloDeBytes("bytes=0-0", 0)).toEqual({ tipo: "invalido" });
  });
});
