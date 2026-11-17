import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, promptsTable: {} }));

const { planejarPromptPadrao } = await import("./ensureSofiaPromptPadrao");
const { SOFIA_PROMPT_PADRAO_BODY } = await import("./sofiaPromptPadrao");

const versao = (id: number, body: string, isActive = false, model = "openai/gpt-5.6-sol") =>
  ({ id, body, version: `v${id}.0`, model, isActive });

describe("prompt padrão da Sofia no start do servidor", () => {
  it("não recria nem reativa quando o texto já existe (mesmo com CRLF)", () => {
    const comCrlf = SOFIA_PROMPT_PADRAO_BODY.replace(/\n/g, "\r\n");
    const plano = planejarPromptPadrao([versao(15, "outro", true), versao(16, comCrlf)], SOFIA_PROMPT_PADRAO_BODY);
    expect(plano).toEqual({ tipo: "existe", id: 16, version: "v16.0" });
  });

  it("cria a próxima versão com o modelo do prompt ativo quando o texto mudou", () => {
    const plano = planejarPromptPadrao([versao(1, "a"), versao(2, "b", true, "openai/gpt-5.6-terra")], "texto novo");
    expect(plano).toEqual({ tipo: "criar", version: "v3.0", model: "openai/gpt-5.6-terra" });
  });

  it("o texto do prompt no código não está vazio e fala como Sofia", () => {
    expect(SOFIA_PROMPT_PADRAO_BODY.length).toBeGreaterThan(5000);
    expect(SOFIA_PROMPT_PADRAO_BODY).toContain("Sofia");
  });

  it("traz a formação de 4 cursos: começa por Água ou Fogo, avançado pede a pergunta antes do link, sem pré-requisito oficial", () => {
    const secao = SOFIA_PROMPT_PADRAO_BODY.split("## A formação em Sound Healing")[1]?.split("\n## ")[0] ?? "";
    expect(secao).toContain("*4 cursos*");
    expect(secao).toContain("*Ciclo Água* ou pelo *Ciclo Fogo*");
    expect(secao).toMatch(/não chame `enviar_interesse` nem mande link de imediato/);
    expect(secao).toMatch(/Nunca diga que a pessoa "não pode"/);
    expect(SOFIA_PROMPT_PADRAO_BODY).not.toContain("não condicione nada a módulos anteriores");
  });
});
