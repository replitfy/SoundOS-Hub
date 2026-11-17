import { beforeEach, describe, expect, it, vi } from "vitest";

const registrarRepetido = vi.fn();
const criar = vi.fn();

vi.mock("../sofiaEventCatalog.js", () => ({ getOfficialEventCatalog: vi.fn() }));
vi.mock("@workspace/db", () => ({
  db: {},
  sofiaEventAliasesTable: {},
  videoEventosTable: {},
  videosTable: {},
  eventoFormularios: {},
  messages: {},
  pessoasTable: {},
  OPPORTUNITY_NUCLEI: ["EDUCATION", "EXPERIENCES"],
}));
vi.mock("../commercialOpportunities.js", () => {
  class OpportunityRuleError extends Error {
    constructor(message: string, public readonly code = "OPPORTUNITY_RULE_VIOLATION") {
      super(message);
    }
  }
  return {
    OpportunityRuleError,
    SOFIA_INTEREST_SOURCE: "SOFIA_INTERESSE",
    createOpportunity: criar,
    recordSofiaInterestMention: registrarRepetido,
  };
});

const { abrirCartaoPadrao } = await import("./interesse.js");
const { OpportunityRuleError } = await import("../commercialOpportunities.js");

const params = {
  pessoaId: 77,
  nucleus: "EDUCATION" as const,
  eventoId: 3,
  rotulo: "Ciclo Água (13/01/2027)",
  textoProximaAcao: "Enviar valores e condições",
  agora: new Date("2026-10-20T15:00:00.000Z"),
  conversationId: 3072,
  contexto: {
    conversationId: 3072,
    capturadoEm: "2026-10-20T15:00:00.000Z",
    mensagens: ["Quero fazer o Ciclo Água"],
    ficha: { cidade: "Campinas" },
  },
};

beforeEach(() => {
  registrarRepetido.mockReset();
  criar.mockReset();
});

describe("abrirCartaoPadrao", () => {
  it("interesse novo cria o cartão da Sofia sem responsável, com a conversa no evento de criação", async () => {
    registrarRepetido.mockResolvedValue(false);
    criar.mockResolvedValue({ id: 1 });
    await expect(abrirCartaoPadrao(params)).resolves.toBe("criado");
    expect(criar).toHaveBeenCalledTimes(1);
    expect(criar.mock.calls[0]![0]).toMatchObject({
      source: "SOFIA_INTERESSE",
      actor: { kind: "SOFIA" },
      allowUnowned: true,
      eventMetadata: { sofiaConversation: params.contexto },
    });
    expect(criar.mock.calls[0]![0].ownerUserId).toBeUndefined();
  });

  it("interesse repetido não cria outro cartão: só registra a conversa no que já existe", async () => {
    registrarRepetido.mockResolvedValue(true);
    await expect(abrirCartaoPadrao(params)).resolves.toBe("ja_existia");
    expect(criar).not.toHaveBeenCalled();
    expect(registrarRepetido).toHaveBeenCalledWith(expect.objectContaining({
      pessoaId: 77,
      nucleus: "EDUCATION",
      cursosInscricaoId: 3,
      conversationId: 3072,
      metadata: { sofiaConversation: params.contexto },
    }));
  });

  it("se outra chamada abriu o cartão no meio do caminho, registra a conversa nele e não duplica", async () => {
    registrarRepetido.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    criar.mockRejectedValue(new OpportunityRuleError("Já existe", "ACTIVE_OPPORTUNITY_EXISTS"));
    await expect(abrirCartaoPadrao(params)).resolves.toBe("ja_existia");
    expect(registrarRepetido).toHaveBeenCalledTimes(2);
  });

  it("outros erros de criação continuam subindo para o chamador registrar a falha", async () => {
    registrarRepetido.mockResolvedValue(false);
    criar.mockRejectedValue(new Error("banco fora"));
    await expect(abrirCartaoPadrao(params)).rejects.toThrow("banco fora");
  });
});
