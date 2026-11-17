import { describe, expect, it } from "vitest";
import { buildFormalizacaoUrl, extractFormSubmission, extractSofiaConversation, formalizacaoState, isSofiaOwned, sofiaConversationHref } from "./formalizacao";

const base = { id: 1, amount: "450.00", reference: "PIX-1", confirmedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", completedAt: null, revokedAt: null };

describe("formalizacao helpers", () => {
  it("derives state", () => {
    expect(formalizacaoState(null)).toBe("none");
    expect(formalizacaoState(base)).toBe("pending");
    expect(formalizacaoState({ ...base, completedAt: "x" })).toBe("completed");
    expect(formalizacaoState({ ...base, revokedAt: "x" })).toBe("revoked");
    expect(formalizacaoState({ ...base, expiresAt: "2000-01-01T00:00:00Z" })).toBe("expired");
  });
  it("builds url with base prefix", () => {
    expect(buildFormalizacaoUrl("abc", "https://x.dev", "/")).toBe("https://x.dev/formalizacao/abc");
    expect(buildFormalizacaoUrl("abc", "https://x.dev", "/app")).toBe("https://x.dev/app/formalizacao/abc");
  });
  it("detects Sofia only without human owner", () => {
    expect(isSofiaOwned({ ownerUserId: null, ownerSystem: "SOFIA" })).toBe(true);
    expect(isSofiaOwned({ ownerUserId: 4, ownerSystem: "SOFIA" })).toBe(false);
    expect(isSofiaOwned({ ownerUserId: null, ownerSystem: null })).toBe(false);
  });
  it("extracts form submission", () => {
    expect(extractFormSubmission({ formSubmission: { answers: { a: "1" }, eventName: "E", submissionId: 3 } })?.eventName).toBe("E");
    expect(extractFormSubmission({ formSubmission: { answers: "x", eventName: "E", submissionId: 3 } })).toBeNull();
    expect(extractFormSubmission(null)).toBeNull();
  });
  it("extracts group and origin page only when informed", () => {
    const generic = extractFormSubmission({ formSubmission: { answers: {}, eventName: "Interesse — Água", submissionId: 1, grupo: "agua", paginaOrigem: " https://site.com/agua " } });
    expect(generic).toMatchObject({ grupo: "agua", paginaOrigem: "https://site.com/agua" });
    const event = extractFormSubmission({ formSubmission: { answers: {}, eventName: "E", submissionId: 2, grupo: 7, paginaOrigem: "  " } });
    expect(event).toMatchObject({ grupo: null, paginaOrigem: null });
  });
  it("extracts the Sofia conversation block with only the filled ficha fields", () => {
    const sc = extractSofiaConversation({
      requestFingerprint: "x",
      sofiaConversation: {
        conversationId: 12,
        mensagens: ["  Quero fazer o Ciclo Água ", "", 7],
        ficha: { cidade: "Campinas", profissao: "  ", servicoInteresse: "Sound Healing", objetivos: ["Atender clientes", ""], cpf: "000" },
      },
    });
    expect(sc).toEqual({
      conversationId: 12,
      mensagens: ["Quero fazer o Ciclo Água"],
      ficha: [
        { chave: "cidade", valor: "Campinas" },
        { chave: "servicoInteresse", valor: "Sound Healing" },
        { chave: "objetivos", valor: "Atender clientes" },
      ],
    });
  });
  it("ignores events without a usable Sofia conversation block", () => {
    expect(extractSofiaConversation(null)).toBeNull();
    expect(extractSofiaConversation({ formSubmission: {} })).toBeNull();
    expect(extractSofiaConversation({ sofiaConversation: "x" })).toBeNull();
    expect(extractSofiaConversation({ sofiaConversation: { conversationId: "7" } })).toEqual({ conversationId: null, mensagens: [], ficha: [] });
  });
  it("links to the Sofia conversation screen", () => {
    expect(sofiaConversationHref(5, 12)).toBe("/sofia?pessoa=5&conv=12");
    expect(sofiaConversationHref(null, 12)).toBe("/sofia?conv=12");
  });
});
