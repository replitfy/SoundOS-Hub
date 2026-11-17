import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, commercialOpportunities: {}, commercialOpportunityEvents: {} }));
vi.mock("../interesseGeral", () => ({ interestGroupLabel: (grupo: string) => grupo }));

const { descreverFormularioRecente } = await import("./cartaoDoFormulario.js");
const { REGRA_CONTATO_APOS_FORMULARIO } = await import("./contatoAposFormulario.js");

describe("contexto do formulário para a Sofia", () => {
  const quando = new Date("2026-11-07T15:00:00.000Z");

  it("resume título, grupo, data e a página sem parâmetros de endereço", () => {
    const linha = descreverFormularioRecente({
      titulo: "Lista de interesse — Água", grupo: "Água", quando,
      paginaOrigem: "https://site.example/agua/?utm_source=ig&token=segredo#topo",
    });
    expect(linha).toContain('"Lista de interesse — Água"');
    expect(linha).toContain("07/11/2026");
    expect(linha).toContain("grupo Água");
    expect(linha).toContain("site.example/agua");
    expect(linha).not.toMatch(/utm_source|segredo|https:\/\//);
  });

  it("sem grupo nem página, só o que existe", () => {
    const linha = descreverFormularioRecente({ titulo: "Workshop", grupo: null, paginaOrigem: null, quando });
    expect(linha).not.toContain("grupo");
    expect(linha).not.toContain("pela página");
  });

  it("manda não informar preço de evento e não repetir a saudação do modelo", () => {
    const linha = descreverFormularioRecente({ titulo: "Workshop", grupo: null, paginaOrigem: null, quando });
    expect(linha).toMatch(/Não informe preço de evento/);
    expect(linha).toMatch(/não repita a saudação/i);
  });

  it("prioriza dúvidas em vez de reapresentar a página já visitada", () => {
    const linha = descreverFormularioRecente({ titulo: "Retiro", grupo: null, paginaOrigem: null, quando });
    expect(linha).toContain(REGRA_CONTATO_APOS_FORMULARIO);
    expect(linha).toContain("pergunte se ficou alguma dúvida");
    expect(linha).toContain("Não acrescente o link da página do evento");
    expect(linha).toContain("se ela pedir explicitamente o link da página");
    expect(linha).toContain("responda primeiro somente o que foi perguntado");
  });

  it("separa a confirmação ao modelo do pedido de inscrição e não inventa link ausente", () => {
    const linha = descreverFormularioRecente({ titulo: "Retiro", grupo: null, paginaOrigem: null, quando });
    expect(linha).toContain("'sim' ou 'pode falar'");
    expect(linha).toContain("não é por si só um pedido de inscrição");
    expect(linha).toContain("use enviar_interesse");
    expect(linha).toContain("link_interesse oficial");
    expect(linha).toContain("se só houver um tema ou mais de uma opção, confirme");
    expect(linha).toContain("sem inventar endereço e sem substituir pelo link da página");
  });

  it("página que não é endereço válido é ignorada", () => {
    const linha = descreverFormularioRecente({ titulo: "Workshop", grupo: null, paginaOrigem: "isto não é url", quando });
    expect(linha).not.toContain("pela página");
  });
});
