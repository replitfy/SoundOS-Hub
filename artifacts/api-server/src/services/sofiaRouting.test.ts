import { describe, expect, it } from "vitest";
import { classifySofiaIntent, shouldExposeFactualTools, decidePreGenerationGovernance, factualDecisionShape, factualToolNbaCode, buildDeterministicFactualResponse, shouldReplaceCommercialLeakage, factualFastPathEnvironmentAllowed, persistFactualExchangeAfterAudit, detectFactualOfferingIntent } from "./sofiaRouting";

describe("deterministic Sofia routing", () => {
  it("fast-paths a single descriptive fact", () => {
    expect(classifySofiaIntent("O que é o curso Água?").kind).toBe("factual");
  });
  it("treats an explicit canonical offer id as a factual lookup", () => {
    expect(classifySofiaIntent("Explique OFR_EDU_CICLO_FOGO_PRESENCIAL")).toMatchObject({
      kind: "factual",
      factKind: "offer",
    });
  });
  it("treats a named elemental cycle description as a canonical offer fact", () => {
    expect(classifySofiaIntent("O que é o Ciclo Água presencial?")).toMatchObject({
      kind: "factual",
      factKind: "offer",
    });
  });
  it("allows the factual pilot only in development/homologation and tests", () => {
    expect(factualFastPathEnvironmentAllowed("development")).toBe(true);
    expect(factualFastPathEnvironmentAllowed("test")).toBe(true);
    expect(factualFastPathEnvironmentAllowed("production")).toBe(false);
    expect(factualFastPathEnvironmentAllowed("")).toBe(false);
  });
  it("never persists a factual assistant message when audit persistence fails", async () => {
    const calls: string[] = [];
    await expect(persistFactualExchangeAfterAudit({
      persistUserMessage: async () => { calls.push("user"); },
      persistDecisionRun: async () => { calls.push("audit"); throw new Error("audit unavailable"); },
      persistAssistantMessage: async () => { calls.push("assistant"); return { id: 1 }; },
      linkDecisionToAssistant: async () => { calls.push("link"); },
    })).rejects.toThrow("audit unavailable");
    expect(calls).toEqual(["user", "audit"]);
  });
  it("links the audit only after the factual assistant message exists", async () => {
    const calls: string[] = [];
    await persistFactualExchangeAfterAudit({
      persistUserMessage: async () => { calls.push("user"); },
      persistDecisionRun: async () => { calls.push("audit"); return 7; },
      persistAssistantMessage: async () => { calls.push("assistant"); return { id: 9 }; },
      linkDecisionToAssistant: async (runId, message) => { calls.push(`link:${runId}:${message.id}`); },
    });
    expect(calls).toEqual(["user", "audit", "assistant", "link:7:9"]);
  });
  it("routes suitability and mixed questions to advisory", () => {
    expect(classifySofiaIntent("O que é o curso Água e qual é melhor para mim?").kind).toBe("advisory");
    expect(classifySofiaIntent("Quero participar, como funciona?").kind).toBe("advisory");
  });
  it("recognizes family and event fact categories", () => {
    expect(classifySofiaIntent("Para que serve este instrumento?").factKind).toBe("instrument_family");
    expect(classifySofiaIntent("Qual a duração do retiro?").factKind).toBe("event");
  });
  it("recognizes next course and next event requests as factual offerings", () => {
    expect(detectFactualOfferingIntent("Qual é o próximo curso?")).toEqual({
      factual: true,
      repeated: false,
      kind: "course",
      reason: "offering fact request",
    });
    expect(detectFactualOfferingIntent("Quando é o próximo evento?")).toEqual({
      factual: true,
      repeated: false,
      kind: "event",
      fields: ["name", "date"],
      reason: "offering fact request",
    });
    expect(detectFactualOfferingIntent("vim saber do proximo evento")).toMatchObject({
      factual: true,
      kind: "event",
    });
    expect(detectFactualOfferingIntent("vim saber do proximo evento")).not.toHaveProperty("location");
    expect(detectFactualOfferingIntent("eventos no próximo mês")).not.toHaveProperty("location");
    expect(detectFactualOfferingIntent("qual o próximo evento em outubro?")).not.toHaveProperty("location");
    expect(detectFactualOfferingIntent("qual o próximo evento no final do ano?")).not.toHaveProperty("location");
    expect(detectFactualOfferingIntent("qual o próximo evento em duas semanas?")).not.toHaveProperty("location");
    expect(detectFactualOfferingIntent("qual o próximo evento em breve?")).not.toHaveProperty("location");
    expect(detectFactualOfferingIntent("qual o preço do próximo Retiro Luz?")).toMatchObject({
      factual: true,
      kind: "event",
      specific: true,
    });
    expect(detectFactualOfferingIntent("qual o preço do próximo Retiro de Imersão?")).toMatchObject({
      factual: true,
      kind: "event",
      specific: true,
    });
    expect(detectFactualOfferingIntent("qual o próximo evento amanhã?")).not.toHaveProperty("specific");
    expect(detectFactualOfferingIntent("qual o próximo evento outubro?")).not.toHaveProperty("specific");
    expect(detectFactualOfferingIntent("qual é o próximo evento que vai acontecer?")).not.toHaveProperty("specific");
    expect(detectFactualOfferingIntent("qual é o próximo evento disponível?")).not.toHaveProperty("specific");
    expect(detectFactualOfferingIntent("qual é o próximo evento da agenda?")).not.toHaveProperty("specific");
    expect(detectFactualOfferingIntent("próximo curso presencial em são paulo")).toMatchObject({
      modality: "presencial",
      location: "são paulo",
    });
    expect(detectFactualOfferingIntent("próximo curso em Sao Paulo")).toMatchObject({
      location: "Sao Paulo",
    });
    expect(detectFactualOfferingIntent("próximo curso em SP")).toMatchObject({
      location: "SP",
    });
    expect(detectFactualOfferingIntent("curso em são paulo presencial")).toMatchObject({
      location: "são paulo",
    });
    expect(detectFactualOfferingIntent("curso em São Paulo no próximo mês")).toMatchObject({
      location: "São Paulo",
    });
  });
  it.each(["Ola", "Olá", "Boa noite", "Bom dia", "Tudo bem", "Obrigado"])(
    "does not reuse small talk as the location of a later next-event request: %s",
    smallTalk => {
      const history = [
        { role: "user" as const, content: smallTalk },
        {
          role: "assistant" as const,
          content: "Olá! Que bom te receber por aqui. O que te trouxe à Soundfulness hoje?",
        },
      ];

      const intent = detectFactualOfferingIntent(
        "Quero saber quando será o proximo evento?",
        history,
      );

      expect(intent).toMatchObject({
        factual: true,
        kind: "event",
      });
      expect(intent).not.toHaveProperty("location");
    },
  );
  it.each(["Obrigado", "Pode ser", "Ainda não sei", "Tanto faz"])(
    "does not treat a short reply as location unless Sofia explicitly asked for one: %s",
    reply => {
      const history = [
        { role: "user" as const, content: "Qual é o próximo evento?" },
        { role: "assistant" as const, content: "Qual tipo de evento você está buscando?" },
      ];

      const intent = detectFactualOfferingIntent(reply, history);

      expect(intent).toMatchObject({ factual: false });
      expect(intent).not.toHaveProperty("location");
    },
  );
  it("keeps suitability questions advisory", () => {
    expect(detectFactualOfferingIntent("Qual curso é melhor para mim?")).toMatchObject({
      factual: false,
      reason: "suitability/advisory signal",
    });
  });
  it.each([
    "Quero comprar o curso Formação Avançada, qual é o preço?",
    "Desejo adquirir o próximo curso",
    "Como faço para pagar pelo próximo retiro?",
    "Quero comprar o próximo retiro",
    "Gostaria de comprar o curso Formação Avançada. Qual é o preço?",
    "Pode fechar o curso Formação Avançada para mim? Qual é o preço?",
    "Adquira o próximo curso para mim",
    "Pode fechar o próximo retiro para mim?",
    "Adquira o próximo curso",
    "Contrate o próximo curso",
    "Pague o próximo curso",
    "Compre o curso Formação Avançada. Qual é o preço?",
    "Feche o próximo retiro",
    "Faça minha matrícula no próximo curso",
    "Pode reservar minha vaga no próximo curso para mim?",
    "Poderia reservar o próximo retiro para mim?",
    "Pode fazer minha matrícula no próximo curso?",
    "Gostaria de confirmar minha matrícula no próximo curso",
  ])("keeps offering transactions out of the factual fast path: %s", message => {
    expect(detectFactualOfferingIntent(message).factual).toBe(false);
  });
  it.each([
    "Qual o conteúdo do curso de Sound Healing?",
    "Onde acontece o curso de Sound Healing?",
    "Qual o preço do curso de Sound Healing?",
    "Quando é o retiro Luz?",
    "Como funciona o curso de Sound Healing?",
  ])("marks a named offering fact for identity-constrained lookup: %s", message => {
    expect(detectFactualOfferingIntent(message)).toMatchObject({
      factual: true,
      specific: true,
    });
    expect(detectFactualOfferingIntent(message)).not.toHaveProperty("location");
  });
  it("promotes short follow-ups in the unresolved conversation 209 sequence", () => {
    const history = [
      { role: "user" as const, content: "Quero saber qual é o proximo evento?" },
      { role: "assistant" as const, content: "Qual tipo de evento você está buscando?" },
    ];
    expect(detectFactualOfferingIntent("curso", history)).toMatchObject({
      factual: true,
      repeated: true,
      kind: "course",
    });

    const withCourse = [
      ...history,
      { role: "user" as const, content: "curso" },
      { role: "assistant" as const, content: "Você busca um curso online ou presencial?" },
    ];
    expect(detectFactualOfferingIntent("presencial", withCourse)).toMatchObject({
      factual: true,
      repeated: true,
      kind: "course",
      modality: "presencial",
    });

    const withModality = [
      ...withCourse,
      { role: "user" as const, content: "presencial" },
      { role: "assistant" as const, content: "Em qual cidade ou região?" },
    ];
    expect(detectFactualOfferingIntent("São Paulo", withModality)).toMatchObject({
      factual: true,
      repeated: true,
      kind: "course",
      modality: "presencial",
      location: "São Paulo",
    });
    expect(detectFactualOfferingIntent("são paulo", withModality)).toMatchObject({
      factual: true,
      repeated: true,
      kind: "course",
      modality: "presencial",
      location: "são paulo",
    });
  });
  it("marks a repeated factual request without misclassifying unrelated history", () => {
    const history = [
      { role: "user" as const, content: "Qual é o próximo curso?" },
      { role: "assistant" as const, content: "Ainda vou consultar a agenda." },
    ];
    expect(detectFactualOfferingIntent("Quero informações sobre o próximo curso", history)).toMatchObject({
      factual: true,
      repeated: true,
      kind: "course",
    });
    expect(detectFactualOfferingIntent("Você recomenda o curso para mim?", history)).toMatchObject({
      factual: false,
      repeated: false,
    });
  });
  it("uses the latest named event for short date continuations and event switches", () => {
    const history = [
      { role: "user" as const, content: "Quando acontece o Retiro Luz?" },
      { role: "assistant" as const, content: "Ainda vou consultar a agenda." },
    ];
    expect(detectFactualOfferingIntent("e o ciclo da água", history)).toMatchObject({
      factual: true,
      repeated: true,
      specific: true,
      kind: "event",
      lookupQuery: "e o ciclo da água",
      reason: "named offering continuation",
    });

    const switchedHistory = [
      ...history,
      { role: "user" as const, content: "e o ciclo da água" },
      { role: "assistant" as const, content: "Qual informação você procura?" },
    ];
    expect(detectFactualOfferingIntent("quais são as datas", switchedHistory)).toMatchObject({
      factual: true,
      repeated: true,
      specific: true,
      kind: "event",
      lookupQuery: "e o ciclo da água",
      reason: "fact continuation for named offering",
    });
    expect(detectFactualOfferingIntent("Quando acontece o Retiro Sol?", switchedHistory)).toMatchObject({
      factual: true,
      specific: true,
      kind: "event",
      lookupQuery: "Quando acontece o Retiro Sol?",
    });
  });
  it("keeps the official offering resolved by Sofia across short follow-ups", () => {
    const resolvedHistory = [
      { role: "user" as const, content: "Qual é o próximo curso ou evento presencial da Soundfulness?" },
      {
        role: "assistant" as const,
        content: [
          "A próxima opção encontrada é:",
          "CICLO AR — Data: 07/10/2026 — Local: Aldeia do Holon — Modalidade: Presencial",
          "Fonte: agenda oficial de Eventos.",
        ].join("\n"),
      },
    ];

    expect(detectFactualOfferingIntent("E onde acontece? Tem link oficial?", resolvedHistory)).toMatchObject({
      factual: true,
      repeated: true,
      specific: true,
      kind: "event",
      lookupQuery: "CICLO AR",
      fields: ["location", "link"],
    });

    const afterMissingLink = [
      ...resolvedHistory,
      { role: "user" as const, content: "E onde acontece? Tem link oficial?" },
      { role: "assistant" as const, content: "O local é Aldeia do Holon. Não há link oficial disponível." },
    ];
    expect(detectFactualOfferingIntent("Repita só o nome e a data.", afterMissingLink)).toMatchObject({
      factual: true,
      repeated: true,
      specific: true,
      kind: "event",
      lookupQuery: "CICLO AR",
      fields: ["name", "date"],
    });
  });
  it("keeps a request for help choosing a formation in triage", () => {
    expect(detectFactualOfferingIntent(
      "Estou procurando uma formação para usar som no meu trabalho como terapeuta, mas ainda não sei qual.",
    )).toMatchObject({
      factual: false,
      repeated: false,
      reason: "suitability/advisory signal",
    });
  });
  it("does not promote suitability or unrelated short continuations", () => {
    const history = [
      { role: "user" as const, content: "Quando acontece o Retiro Luz?" },
      { role: "assistant" as const, content: "Ainda vou consultar a agenda." },
    ];
    expect(detectFactualOfferingIntent("ele é adequado para mim?", history)).toMatchObject({
      factual: false,
      reason: "suitability/advisory signal",
    });
    expect(detectFactualOfferingIntent("e o almoço", history)).toMatchObject({
      factual: false,
    });
  });
  it("never exposes factual tools when rollout is disabled or resolution is not singular", () => {
    const intent = classifySofiaIntent("O que é o curso Água?");
    expect(shouldExposeFactualTools(false, 1, intent)).toBe(false);
    expect(shouldExposeFactualTools(true, 0, intent)).toBe(false);
    expect(shouldExposeFactualTools(true, 2, intent)).toBe(false);
    expect(shouldExposeFactualTools(true, 1, intent)).toBe(true);
  });
  it("returns persisted-handoff decisions for commercial and sensitive governance", () => {
    expect(decidePreGenerationGovernance({ commercialCapability: "informPrice", commercialGate: { allowed: false, reason: "commercial_value_adapter_unavailable" }, sensitive: false, advancement: false }))
      .toEqual({ reason: "informacao_comercial_bloqueada", gateReason: "commercial_value_adapter_unavailable" });
    expect(decidePreGenerationGovernance({ commercialCapability: null, sensitive: true, advancement: true, commercialGate: null }))
      .toEqual({ reason: "oferta_sensivel", gateReason: null });
  });
  it("keeps factual audit status, result and confidence consistent", () => {
    expect(factualDecisionShape("found", { id: 1 })).toMatchObject({ nbaCode: "ANSWER_FACT", result: "success", confidence: "high" });
    for (const status of ["not_found", "ambiguous", "pending"] as const) {
      const shape = factualDecisionShape(status, {});
      expect(shape.nbaCode).not.toBe("ANSWER_FACT");
      expect(shape.confidence).toBe("low");
      expect(shape.result).not.toBe("success");
    }
    expect(factualDecisionShape("pending", {}, "boom").nbaCode).toBe("FACT_LOOKUP_ERROR");
  });
  it("does not relabel failed content assets as sent content", () => {
    expect(factualToolNbaCode("sendContentAsset", "pending", factualDecisionShape("pending", {}))).toBe("CONSUME_CONTENT");
    expect(factualToolNbaCode("sendContentAsset", "not_found", factualDecisionShape("not_found", {}))).toBe("FACT_NOT_FOUND");
    expect(factualToolNbaCode("sendContentAsset", "ambiguous", factualDecisionShape("ambiguous", {}))).toBe("FACT_AMBIGUOUS");
    expect(factualToolNbaCode("sendContentAsset", "pending", factualDecisionShape("pending", {}, "erro"))).toBe("FACT_LOOKUP_ERROR");
  });
  it("builds factual output only from the resolved registry entity and preserves validated Wix output", () => {
    expect(buildDeterministicFactualResponse({ name: "Água", description: "Curso introdutório", facts: { description: "Curso introdutório", modality: "online", price: 99 } }))
      .toBe("Água: Curso introdutório\nmodality: online");
    expect(shouldReplaceCommercialLeakage(true, false)).toBe(true);
    expect(shouldReplaceCommercialLeakage(true, true)).toBe(false);
  });
});