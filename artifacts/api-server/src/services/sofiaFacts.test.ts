import { describe, expect, it } from "vitest";
import {
  entityMatchesCurrentMessage,
  checkFactualCommercialBoundary,
  commercialCapabilitiesExplicitlyDisabled,
  evaluateCommercialGate,
  isFactualPilotEntity,
  safeFacts,
  evaluateRegistryReadiness,
} from "./sofiaFacts";

const DOCUMENT_SOURCE = {
  type: "controlled_document",
  sourceType: "document",
  ref: "biblioteca:1.1",
  url: "attached_assets/biblioteca.md",
  checkedAt: "2026-09-15T12:00:00.000Z",
  version: "1.1",
  status: "candidate",
  ingestedContentSha256: "a".repeat(64),
  manifestRef: "attached_assets/manifest-summary.md",
  manifestLinkageStatus: "unavailable_in_summary",
};
const COMMERCIAL_SOURCE = {
  type: "official",
  sourceType: "commercial",
  ref: "pricing:2026",
  url: "https://example.test/pricing",
  checkedAt: "2026-09-15T12:00:00.000Z",
  validUntil: "2999-01-01T00:00:00.000Z",
};
const DISABLED_CAPABILITIES = {
  informPrice: false,
  sendCheckout: false,
  checkAvailability: false,
  sendCheckoutLink: false,
};

describe("Sofia factual contracts", () => {
  it("removes commercial keys recursively at every facts level", () => {
    expect(safeFacts({ description: "curso", price: 10, nested: { checkout: "x" } }))
      .toEqual({ description: "curso" });
  });
  it("readiness rejects zero/gaps and accepts one usable approved entity", () => {
    expect(evaluateRegistryReadiness([]).ready).toBe(false);
    const base = { reviewStatus: "approved", entityType: "offer" as const, stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
      approvedFacts: { description: "fato" }, sourceRefs: [DOCUMENT_SOURCE], sensitive: false, capabilities: DISABLED_CAPABILITIES };
    const fogo = { ...base, stableKey: "OFR_EDU_CICLO_FOGO_PRESENCIAL" };
    expect(evaluateRegistryReadiness([base, fogo]).ready).toBe(true);
    expect(evaluateRegistryReadiness([{ ...base, sourceRefs: ["legacy"] }, fogo]).gaps)
      .toEqual(["OFR_EDU_CICLO_AGUA_PRESENCIAL"]);
    expect(evaluateRegistryReadiness([base, fogo, { ...base, stableKey: "non-pilot" }]).approvedCount).toBe(2);
  });
  it("accepts only the two non-superseded pilot entities", () => {
    expect(isFactualPilotEntity({ stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL" })).toBe(true);
    expect(isFactualPilotEntity({ stableKey: "event:3" })).toBe(false);
    expect(isFactualPilotEntity({
      stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
      supersededByStableKey: "another-key",
    })).toBe(false);
    const agua = {
      reviewStatus: "approved",
      entityType: "offer" as const,
      stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
      approvedFacts: { description: "fato" },
      sourceRefs: [DOCUMENT_SOURCE],
      sensitive: false,
      capabilities: DISABLED_CAPABILITIES,
      supersededByStableKey: "another-key",
    };
    const fogo = { ...agua, stableKey: "OFR_EDU_CICLO_FOGO_PRESENCIAL", supersededByStableKey: null };
    expect(evaluateRegistryReadiness([agua, fogo]).ready).toBe(false);
  });
  it("requires non-sensitive entities with every commercial capability explicitly disabled", () => {
    expect(commercialCapabilitiesExplicitlyDisabled(DISABLED_CAPABILITIES)).toBe(true);
    expect(commercialCapabilitiesExplicitlyDisabled({ ...DISABLED_CAPABILITIES, informPrice: true })).toBe(false);
    expect(commercialCapabilitiesExplicitlyDisabled({ informPrice: false })).toBe(false);

    const base = {
      reviewStatus: "approved",
      entityType: "offer" as const,
      approvedFacts: { description: "fato" },
      sourceRefs: [DOCUMENT_SOURCE],
      capabilities: DISABLED_CAPABILITIES,
      sensitive: false,
    };
    const agua = { ...base, stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL", sensitive: true };
    const fogo = { ...base, stableKey: "OFR_EDU_CICLO_FOGO_PRESENCIAL" };
    expect(evaluateRegistryReadiness([agua, fogo]).ready).toBe(false);
    expect(evaluateRegistryReadiness([
      { ...agua, sensitive: false, capabilities: { ...DISABLED_CAPABILITIES, informPrice: true } },
      fogo,
    ]).ready).toBe(false);
  });
  it("requires presencial in the current message for short runtime aliases", () => {
    const row = {
      stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
      displayName: "Ciclo Água Presencial",
      runtimeAliases: ["Ciclo Água", "Sound Healing Individual"],
    };
    expect(entityMatchesCurrentMessage(row, "O que é o Ciclo Água?")).toBe(false);
    expect(entityMatchesCurrentMessage(row, "O que é o Ciclo Água presencial?")).toBe(true);
    expect(entityMatchesCurrentMessage(row, "O que é o Ciclo Água online?")).toBe(false);
    expect(entityMatchesCurrentMessage(row, "Explique OFR_EDU_CICLO_AGUA_PRESENCIAL")).toBe(true);
    expect(entityMatchesCurrentMessage(row, "Explique o evento 3")).toBe(false);
  });
  it("drops commercial values in text and nested arrays", () => {
    expect(safeFacts({ description: "investimento 500", content: ["som", "checkoutUrl https://x"] }, "offer"))
      .toEqual({ content: ["som"] });
  });
  it("denies every capability without an official/current source", () => {
    for (const capability of ["informPrice", "sendCheckout", "checkAvailability"]) {
      expect(evaluateCommercialGate({
        capabilities: { [capability]: true }, sourceRefs: [DOCUMENT_SOURCE], requestedCapability: capability,
      }).allowed).toBe(false);
    }
  });
  it("rejects document expiry fields and future commercial checks", () => {
    const documentWithInventedExpiry = { ...DOCUMENT_SOURCE, validUntil: "2999-01-01T00:00:00.000Z" };
    expect(evaluateRegistryReadiness([
      {
        reviewStatus: "approved",
        entityType: "offer",
        stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
        approvedFacts: { description: "fato" },
        sourceRefs: [documentWithInventedExpiry],
      },
      {
        reviewStatus: "approved",
        entityType: "offer",
        stableKey: "OFR_EDU_CICLO_FOGO_PRESENCIAL",
        approvedFacts: { description: "fato" },
        sourceRefs: [DOCUMENT_SOURCE],
      },
    ]).ready).toBe(false);
    expect(evaluateCommercialGate({
      capabilities: { informPrice: true },
      sourceRefs: [{ ...COMMERCIAL_SOURCE, checkedAt: "2998-01-01T00:00:00.000Z" }],
      requestedCapability: "informPrice",
    }).allowed).toBe(false);
    expect(evaluateCommercialGate({
      capabilities: { informPrice: true },
      sourceRefs: [{ ...COMMERCIAL_SOURCE, checkedAt: "2026-09-15T12:00:00.000Z", validUntil: "2026-01-01T00:00:00.000Z" }],
      requestedCapability: "informPrice",
    }).allowed).toBe(false);
  });
  it("keeps manifest hashes absent until an exact manifest line is verified", () => {
    const base = {
      reviewStatus: "approved",
      entityType: "offer" as const,
      approvedFacts: { description: "fato" },
      sensitive: false,
      capabilities: DISABLED_CAPABILITIES,
    };
    const fogo = {
      ...base,
      stableKey: "OFR_EDU_CICLO_FOGO_PRESENCIAL",
      sourceRefs: [DOCUMENT_SOURCE],
    };
    expect(evaluateRegistryReadiness([
      {
        ...base,
        stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
        sourceRefs: [{ ...DOCUMENT_SOURCE, manifestLinkageStatus: undefined }],
      },
      fogo,
    ]).ready).toBe(false);
    expect(evaluateRegistryReadiness([
      {
        ...base,
        stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
        sourceRefs: [{ ...DOCUMENT_SOURCE, manifestLinkageStatus: "verified" }],
      },
      fogo,
    ]).ready).toBe(false);
    expect(evaluateRegistryReadiness([
      {
        ...base,
        stableKey: "OFR_EDU_CICLO_AGUA_PRESENCIAL",
        sourceRefs: [DOCUMENT_SOURCE],
      },
      fogo,
    ]).ready).toBe(true);
  });
  it("checks every commercial capability before allowing a factual response", async () => {
    const checked: string[] = [];
    const boundary = await checkFactualCommercialBoundary("offer", "canonical", {
      loadCapabilities: async () => DISABLED_CAPABILITIES,
      checker: async (_type, _id, capability) => {
        checked.push(capability);
        return { allowed: false, reason: "capability_not_authorized" };
      },
    });
    expect(boundary.passed).toBe(true);
    expect(checked).toEqual(["informPrice", "sendCheckout", "checkAvailability", "sendCheckoutLink"]);
  });
  it("allows only the requested capability with a current official source", () => {
    expect(evaluateCommercialGate({
      capabilities: { informPrice: true, sendCheckout: false },
      sourceRefs: [COMMERCIAL_SOURCE], requestedCapability: "informPrice",
    })).toEqual({ allowed: true, reason: "authorized" });
    expect(evaluateCommercialGate({
      capabilities: { informPrice: true }, sourceRefs: [COMMERCIAL_SOURCE], requestedCapability: "sendCheckout",
    }).allowed).toBe(false);
  });
});