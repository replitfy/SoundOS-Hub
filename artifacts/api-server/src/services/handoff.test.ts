import { describe, expect, it } from "vitest";
import { detectPreTrigger, detectSimpleModeHandoff, handoffTransitionMessage, simpleHandoffMessage } from "./handoff";

describe("Sofia pre-response handoff policy", () => {
  it("combines recent emotional distress with a later request to talk to the team", () => {
    const trigger = detectPreTrigger(
      "Preciso conversar com alguém da equipe agora.",
      ["Estou passando por um momento emocional muito difícil e me sinto desesperada."],
    );

    expect(trigger).toEqual({
      reason: "tema_sensivel",
      sensitiveContext:
        "Estou passando por um momento emocional muito difícil e me sinto desesperada.\n" +
        "Preciso conversar com alguém da equipe agora.",
      emergencyGuidance: true,
    });
  });

  it("hands off the exact sensitive request from the QA scenario", () => {
    const trigger = detectPreTrigger(
      "Estou em uma situação emocional muito sensível e preciso de orientação terapêutica agora. Quero falar com uma pessoa da equipe.",
    );

    expect(trigger).toMatchObject({
      reason: "tema_sensivel",
      emergencyGuidance: true,
    });
  });

  it("does not resume autonomous guidance after recent emotional distress", () => {
    const trigger = detectPreTrigger(
      "Enquanto isso, pode continuar me orientando sozinha?",
      ["Estou em uma situação emocional muito sensível e preciso de orientação terapêutica agora."],
    );

    expect(trigger).toMatchObject({
      reason: "tema_sensivel",
      emergencyGuidance: true,
    });
  });

  it("does not attach emergency guidance to a non-emotional sensitive handoff", () => {
    const trigger = detectPreTrigger("Quero registrar uma reclamação formal.");

    expect(trigger).toMatchObject({
      reason: "tema_sensivel",
      emergencyGuidance: false,
    });
    expect(handoffTransitionMessage(trigger!.reason, trigger!.emergencyGuidance)).not.toContain("188");
  });

  it.each([
    "Qual é o preço do próximo curso?",
    "A tigela está disponível?",
    "Tem estoque desse produto?",
    "Quero o link para comprar a tigela",
  ])("does not hand off official price, link or availability requests: %s", message => {
    expect(detectPreTrigger(message)).toBeNull();
  });

  it.each([
    ["Quero falar com um atendente humano", "pedido_explicito"],
    ["Tem desconto para o curso?", "informacao_comercial_bloqueada"],
    ["Posso parcelar no cartão?", "informacao_comercial_bloqueada"],
    ["Quero pagar agora", "informacao_comercial_bloqueada"],
    ["Quero fazer a inscrição no curso", "informacao_comercial_bloqueada"],
    ["Quero realizar minha inscrição", "informacao_comercial_bloqueada"],
    ["Gostaria de comprar o curso", "informacao_comercial_bloqueada"],
    ["Pode fechar o curso para mim?", "informacao_comercial_bloqueada"],
    ["Adquira o próximo curso para mim", "informacao_comercial_bloqueada"],
  ] as const)("keeps required handoff for %s", (message, reason) => {
    expect(detectPreTrigger(message)?.reason).toBe(reason);
  });
});
describe("Sofia modo simples: handoff só em quatro grupos", () => {
  it.each([
    "Quero me inscrever no Ciclo Água",
    "Quero comprar a taça tibetana",
    "Quanto custa o Ciclo Terra?",
    "Tem vaga no retiro?",
    "Quero participar da cerimônia de ayahuasca, qual o valor?",
    "Vou pensar",
    "Me fala do Ciclo Terra",
  ])("não dispara para %s", message => {
    expect(detectSimpleModeHandoff(message)).toBeNull();
  });

  it.each([
    ["Como pago? Parcela?", "pagamento", "fechamento_comercial"],
    ["Tem desconto ou cupom?", "pagamento", "fechamento_comercial"],
    ["Aceita pix?", "pagamento", "fechamento_comercial"],
    ["Quero reembolso", "pagamento", "duvida_financeira"],
    ["Quero falar com uma pessoa", "pedido_humano", "pedido_explicito"],
    ["Me passa pra um atendente", "pedido_humano", "pedido_explicito"],
    ["Vou chamar meu advogado e fazer reclamação formal", "reclamacao", "tema_sensivel"],
    ["Não aguento mais viver, quero morrer", "emergencia", "tema_sensivel"],
  ])("%s → %s", (message, group, reason) => {
    expect(detectSimpleModeHandoff(message)).toMatchObject({ group, reason });
  });

  it("emergência leva orientação SAMU/CVV; pagamento tem mensagem acolhedora própria", () => {
    const emergencia = detectSimpleModeHandoff("quero morrer")!;
    expect(emergencia.emergencyGuidance).toBe(true);
    expect(simpleHandoffMessage(emergencia)).toMatch(/SAMU 192.*CVV.*188/s);
    expect(simpleHandoffMessage(detectSimpleModeHandoff("Como pago?")!)).toMatch(/Pagamento, parcelamento/);
  });
});
