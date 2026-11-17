import { describe, it, expect, vi, beforeEach } from "vitest";

// O expander é o único ponto do RAG que depende de uma chamada de rede. Se ela falhar,
// a busca tem que continuar respondendo com a query original — nunca propagar o erro.
const create = vi.fn();

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create } } },
}));

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { expandQuery, _limparCacheExpansao } = await import("./ragQueryExpander");

describe("expandQuery", () => {
  beforeEach(() => {
    create.mockReset();
    _limparCacheExpansao();
  });

  const responder = (content: string) => ({ choices: [{ message: { content } }] });

  it("devolve a original seguida das variações", async () => {
    create.mockResolvedValue(responder("sonoterapia|cura pelo som"));
    await expect(expandQuery("terapia sonora")).resolves.toEqual([
      "terapia sonora",
      "sonoterapia",
      "cura pelo som",
    ]);
  });

  it("degrada para busca simples quando a chamada falha", async () => {
    create.mockRejectedValue(new Error("proxy fora do ar"));
    await expect(expandQuery("terapia sonora")).resolves.toEqual(["terapia sonora"]);
  });

  it("degrada para busca simples quando a resposta vem vazia", async () => {
    create.mockResolvedValue(responder(""));
    await expect(expandQuery("terapia sonora")).resolves.toEqual(["terapia sonora"]);
  });

  it("não chama o modelo de novo para a mesma query", async () => {
    create.mockResolvedValue(responder("sonoterapia"));
    await expandQuery("terapia sonora");
    await expandQuery("  TERAPIA SONORA  ");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("também cacheia a falha, para não repetir a espera a cada mensagem", async () => {
    create.mockRejectedValue(new Error("timeout"));
    await expandQuery("terapia sonora");
    await expandQuery("terapia sonora");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("compartilha uma expansão em andamento entre chamadas simultâneas", async () => {
    let liberar: (v: unknown) => void = () => {};
    create.mockReturnValue(new Promise(res => { liberar = res; }));

    const ambas = Promise.all([expandQuery("terapia sonora"), expandQuery("Terapia Sonora")]);
    liberar(responder("sonoterapia"));

    expect(await ambas).toEqual([
      ["terapia sonora", "sonoterapia"],
      ["Terapia Sonora", "sonoterapia"],
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("devolve lista vazia para query em branco, sem chamar o modelo", async () => {
    await expect(expandQuery("   ")).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});
