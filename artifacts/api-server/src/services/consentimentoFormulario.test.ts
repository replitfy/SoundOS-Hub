import { describe, expect, it, vi } from "vitest";

vi.mock("./commercialOpportunities", () => ({ OpportunityRuleError: class extends Error {} }));
vi.mock("./contatoAutorizacao", () => ({ registrarContatoDoSistema: vi.fn() }));
vi.mock("./crmAtendimento", () => ({ registrarAcao: vi.fn() }));

const { TEXTO_CONSENTIMENTO_WHATSAPP, consentimentoParaOFormulario, lerConsentimentoWhatsapp } = await import("./consentimentoFormulario");

describe("consentimento do WhatsApp nos formulários", () => {
  it("só o valor true conta; texto, número e ausência são 'não marcou'", () => {
    expect(lerConsentimentoWhatsapp(true)).toBe(true);
    for (const valor of [false, "true", "on", 1, null, undefined, {}, []]) expect(lerConsentimentoWhatsapp(valor)).toBe(false);
  });

  it("o formulário recebe o mesmo texto que fica gravado na autorização", () => {
    expect(consentimentoParaOFormulario()).toEqual({ texto: TEXTO_CONSENTIMENTO_WHATSAPP });
    expect(TEXTO_CONSENTIMENTO_WHATSAPP).toBe("Aceito receber mensagens da Soundfulness pelo WhatsApp");
  });
});
