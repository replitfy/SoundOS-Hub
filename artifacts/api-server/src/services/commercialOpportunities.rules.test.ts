import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({
  OPPORTUNITY_NUCLEI: ["EDUCATION", "EXPERIENCES"],
  OPPORTUNITY_TASK_TYPES: ["CALL", "WHATSAPP", "EMAIL", "MEETING", "OTHER", "NONE"],
  OPPORTUNITY_STAGES: [
    "NEW_INTEREST", "CONTACT_STARTED", "QUALIFYING", "PATH_IDENTIFIED",
    "DECIDING", "ENROLLMENT_RESERVATION_IN_PROGRESS", "CONFIRMED", "NURTURE", "CLOSED",
  ],
}));
import {
  assertActiveOpportunityFields,
  assertReasonForStage,
  assertSofiaTransitionAllowed,
  assertGovernedFieldsActor,
  assertExpectedOpportunityVersion,
  parseOpportunityDate,
  assertReactivationTarget,
  deriveSofiaDecisionStage,
  hasValidActiveNextAction,
  assertOperationalConfirmationMatch,
  assertConfirmationStage,
  OpportunityRuleError,
  parseConfirmationEvidence,
  createOpportunity,
  SOFIA_INTEREST_SOURCE,
} from "./commercialOpportunities";

describe("commercial opportunity invariants", () => {
  it("accepts both generated Date values and wire-format timestamps", () => {
    const generated = new Date("2030-01-02T03:04:05.000Z");
    expect(parseOpportunityDate(generated, "nextTaskAt")).toBe(generated);
    expect(parseOpportunityDate("2030-01-02T03:04:05.000Z", "nextTaskAt")).toEqual(generated);
  });

  it("requires a replacement task for every active opportunity", () => {
    expect(() => assertActiveOpportunityFields({
      stage: "CONTACT_STARTED",
      ownerUserId: 7,
      nextTaskType: "WHATSAPP",
      nextTaskText: "Follow up",
      nextTaskAt: new Date(),
    })).not.toThrow();
    expect(() => assertActiveOpportunityFields({
      stage: "CONTACT_STARTED",
      ownerUserId: 7,
      nextTaskType: "NONE",
      nextTaskText: null,
      nextTaskAt: null,
    })).toThrowError(/next action/i);
  });

  it("requires reasons for nurture and close", () => {
    expect(() => assertReasonForStage("NURTURE", "Waiting for next cohort")).not.toThrow();
    expect(() => assertReasonForStage("CLOSED", "Not a fit")).not.toThrow();
    expect(() => assertReasonForStage("NURTURE", "  ")).toThrowError(/reason/i);
  });

  it("guards Sofia against review, handoff, missing evidence and confirmation", () => {
    const base = {
      actor: { kind: "SOFIA" as const },
      eligibilityStatus: "ELIGIBLE",
      decisionRunId: 12,
      toStage: "DECIDING" as const,
    };
    expect(() => assertSofiaTransitionAllowed(base)).not.toThrow();
    expect(() => assertSofiaTransitionAllowed({ ...base, handoffConflict: true })).toThrow();
    expect(() => assertSofiaTransitionAllowed({ ...base, eligibilityStatus: "HUMAN_REVIEW" })).toThrow();
    expect(() => assertSofiaTransitionAllowed({ ...base, decisionRunId: null })).toThrow();
    expect(() => assertSofiaTransitionAllowed({ ...base, toStage: "CONFIRMED" })).toThrow();
  });

  it("rejects governed decision fields from ordinary staff", () => {
    expect(() => assertGovernedFieldsActor(
      { kind: "HUMAN", id: 7, role: "assistente" },
      { eligibilityStatus: "ELIGIBLE" },
    )).toThrowError(/authoritative/i);
    expect(() => assertGovernedFieldsActor(
      { kind: "SOFIA" },
      { eligibilityStatus: "ELIGIBLE", decisionRunId: 9 },
    )).not.toThrow();
  });

  it("rejects stale optimistic versions", () => {
    expect(() => assertExpectedOpportunityVersion(4, 3)).toThrowError(/changed/i);
    expect(() => assertExpectedOpportunityVersion(4, 4)).not.toThrow();
  });

  it("cannot reactivate into a paused or closed no-op stage", () => {
    expect(() => assertReactivationTarget("NURTURE")).toThrowError(/active stage/i);
    expect(() => assertReactivationTarget("CLOSED")).toThrowError(/active stage/i);
    expect(() => assertReactivationTarget("CONTACT_STARTED")).not.toThrow();
  });

  it("derives only conservative Sofia stage progressions", () => {
    expect(deriveSofiaDecisionStage({
      currentStage: "QUALIFYING",
      eligibilityStatus: "elegivel",
      nbaCategoria: "comprar",
    })).toBe("DECIDING");
    expect(deriveSofiaDecisionStage({
      currentStage: "QUALIFYING",
      eligibilityStatus: "bloqueado",
      nbaCategoria: "comprar",
    })).toBeNull();
    expect(deriveSofiaDecisionStage({
      currentStage: "QUALIFYING",
      eligibilityStatus: "nao_avaliada",
      nbaCategoria: "conversar",
      metadata: { opportunityStage: "DECIDING" },
    })).toBeNull();
    expect(deriveSofiaDecisionStage({
      currentStage: "QUALIFYING",
      eligibilityStatus: "elegivel",
      nbaCategoria: "conversar",
      metadata: { opportunityStage: "DECIDING" },
    })).toBe("DECIDING");
    expect(deriveSofiaDecisionStage({
      currentStage: "NURTURE",
      eligibilityStatus: "elegivel",
      nbaCategoria: "comprar",
    })).toBeNull();
  });

  it("requires an active next action before Sofia may advance a stage", () => {
    expect(hasValidActiveNextAction({
      ownerUserId: 7,
      nextTaskType: "CALL",
      nextTaskText: "Follow up",
      nextTaskAt: new Date(),
    })).toBe(true);
    expect(hasValidActiveNextAction({
      ownerUserId: null,
      nextTaskType: "CALL",
      nextTaskText: "Follow up",
      nextTaskAt: new Date(),
    })).toBe(false);
    expect(hasValidActiveNextAction({
      ownerUserId: 7,
      nextTaskType: "NONE",
      nextTaskText: null,
      nextTaskAt: null,
    })).toBe(false);
  });

  it("accepts only operational evidence tied to the exact Experiences offer", () => {
    expect(() => assertOperationalConfirmationMatch({
      opportunityNucleus: "EXPERIENCES",
      offerNucleus: "EXPERIENCES",
      opportunityClassId: 42,
      evidenceClassId: 42,
      evidenceKind: "EXPERIENCE_REGISTRATION",
    })).not.toThrow();
    expect(() => assertOperationalConfirmationMatch({
      opportunityNucleus: "EXPERIENCES",
      offerNucleus: "EXPERIENCES",
      opportunityClassId: 42,
      evidenceClassId: 99,
      evidenceKind: "EXPERIENCE_REGISTRATION",
    })).toThrowError(/exact EXPERIENCES offer/i);
    expect(() => assertOperationalConfirmationMatch({
      opportunityNucleus: "EDUCATION",
      offerNucleus: "EXPERIENCES",
      opportunityClassId: 42,
      evidenceClassId: 42,
      evidenceKind: "EXPERIENCE_REGISTRATION",
    })).toThrowError(/exact EXPERIENCES offer/i);
  });

  it("uses the canonical invalid-evidence error for unrelated operational references", () => {
    try {
      assertOperationalConfirmationMatch({
        opportunityNucleus: "EXPERIENCES",
        offerNucleus: "EXPERIENCES",
        opportunityClassId: 42,
        evidenceClassId: 99,
        evidenceKind: "EXPERIENCE_REGISTRATION",
      });
      throw new Error("Expected evidence rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OpportunityRuleError);
      expect((error as OpportunityRuleError).code).toBe("CONFIRMATION_EVIDENCE_INVALID");
      expect((error as OpportunityRuleError).status).toBe(422);
    }
  });

  it("rejects confirmation evidence on transitions that do not confirm", () => {
    expect(() => assertConfirmationStage(
      "DECIDING",
      { kind: "EXPERIENCE_REGISTRATION", registrationId: 73 },
    )).toThrowError(/only valid for a CONFIRMED transition/i);
    expect(() => assertConfirmationStage(
      "CONFIRMED",
      { kind: "EXPERIENCE_REGISTRATION", registrationId: 73 },
    )).not.toThrow();
  });

  it("parses confirmation as an exact discriminated reference", () => {
    expect(parseConfirmationEvidence({
      kind: "EXPERIENCE_REGISTRATION",
      registrationId: 73,
    })).toEqual({ kind: "EXPERIENCE_REGISTRATION", registrationId: 73 });
    expect(() => parseConfirmationEvidence({
      kind: "EXPERIENCE_REGISTRATION",
      registrationId: 73,
      reference: "free text",
    })).toThrowError(/unrelated/i);
    expect(() => parseConfirmationEvidence({
      kind: "EXPERIENCE_REGISTRATION",
      registrationId: 73,
      enrollmentId: 73,
    })).toThrowError(/unrelated/i);
    expect(() => parseConfirmationEvidence({
      kind: "HUMAN_ADMIN",
      registrationId: 73,
    })).toThrowError(/unrelated/i);
  });
});

describe("cartão de interesse da Sofia sem responsável", () => {
  const ativo = {
    stage: "NEW_INTEREST" as const,
    nextTaskType: "WHATSAPP" as const,
    nextTaskText: "Enviar valores e condições",
    nextTaskAt: new Date(),
  };

  it("exige responsável por padrão", () => {
    expect(() => assertActiveOpportunityFields({ ...ativo, ownerUserId: null })).toThrowError(/owner/i);
  });

  it("permite cartão sem responsável só com allowUnowned, mantendo a próxima ação obrigatória", () => {
    expect(() => assertActiveOpportunityFields({ ...ativo, ownerUserId: null, allowUnowned: true })).not.toThrow();
    expect(() => assertActiveOpportunityFields({
      ...ativo, ownerUserId: null, allowUnowned: true, nextTaskText: "  ",
    })).toThrowError(/next action/i);
  });

  const base = {
    pessoaId: 1,
    nucleus: "EDUCATION" as const,
    cursosInscricaoId: 3,
    nextTaskType: "WHATSAPP" as const,
    nextTaskText: "Enviar valores e condições",
    nextTaskAt: new Date(),
    allowUnowned: true,
  };

  it.each([
    { nome: "ator humano", extra: { actor: { kind: "HUMAN" as const, id: 9 }, source: SOFIA_INTEREST_SOURCE } },
    { nome: "outra origem", extra: { actor: { kind: "SOFIA" as const }, source: "CRM" } },
    { nome: "responsável informado", extra: { actor: { kind: "SOFIA" as const }, source: SOFIA_INTEREST_SOURCE, ownerUserId: 4 } },
  ])("recusa cartão sem responsável para $nome", async ({ extra }) => {
    await expect(createOpportunity({ ...base, ...extra })).rejects.toMatchObject({ code: "UNOWNED_NOT_ALLOWED", status: 403 });
  });
});
