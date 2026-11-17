// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CommercialOpportunityEvent } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";
import { CardEntendimento, entendimentoMaisRecente } from "./card-entendimento";

afterEach(() => { cleanup(); });

function evento(parcial: Partial<CommercialOpportunityEvent> & { id: number }): CommercialOpportunityEvent {
  return {
    opportunityId: 1,
    actorKind: "SOFIA",
    actorId: null,
    actorName: null,
    eventType: "UPDATED",
    createdAt: "2026-11-02T13:30:00.000Z",
    metadata: {},
    ...parcial,
  } as CommercialOpportunityEvent;
}

const anotacao = (id: number, retrato: Record<string, unknown>) =>
  evento({ id, metadata: { action: "SOFIA_ENTENDIMENTO", sofiaEntendimento: retrato, mudancas: {} } });

describe("entendimentoMaisRecente", () => {
  it("usa o registro mais novo, em qualquer ordem da lista", () => {
    const antigo = anotacao(5, { intencao: "Quer saber do Ciclo Água", necessidades: [], informacoes: [] });
    const novo = anotacao(9, { intencao: "Quer se inscrever", necessidades: ["Estudar à noite"], informacoes: [] });
    expect(entendimentoMaisRecente([antigo, novo])?.intencao).toBe("Quer se inscrever");
    expect(entendimentoMaisRecente([novo, antigo])?.intencao).toBe("Quer se inscrever");
  });

  it("ignora eventos de outras ações e retratos vazios", () => {
    expect(entendimentoMaisRecente([])).toBeNull();
    expect(entendimentoMaisRecente([evento({ id: 1, metadata: { action: "NOTE_ADDED", text: "x" } })])).toBeNull();
    expect(entendimentoMaisRecente([evento({ id: 2, eventType: "CREATED", metadata: { action: "SOFIA_ENTENDIMENTO", sofiaEntendimento: { intencao: "Falso" } } })])).toBeNull();
    expect(entendimentoMaisRecente([anotacao(3, { intencao: "  ", necessidades: [], informacoes: [] })])).toBeNull();
  });

  it("tolera metadados fora do formato", () => {
    const r = entendimentoMaisRecente([anotacao(4, { intencao: 7, necessidades: ["a", 3, null], informacoes: "x" })]);
    expect(r).toMatchObject({ intencao: null, necessidades: ["a"], informacoes: [] });
  });
});

describe("bloco O que a Sofia entendeu", () => {
  const renderBloco = (events: CommercialOpportunityEvent[]) =>
    render(<LanguageProvider><CardEntendimento events={events} /></LanguageProvider>);

  it("mostra intenção, necessidades e informações do último registro, com o aviso de que não é confirmado", () => {
    renderBloco([
      anotacao(1, { intencao: "Quer saber do Ciclo Água", necessidades: ["Relaxar"], informacoes: [] }),
      anotacao(2, { intencao: "Quer se inscrever no Ciclo Fogo", necessidades: ["Relaxar", "Estudar à noite"], informacoes: ["Mora em Campinas"] }),
    ]);
    expect(screen.getByText("O que a Sofia entendeu")).toBeTruthy();
    expect(screen.getByTestId("crm-entendimento-intencao").textContent).toContain("Quer se inscrever no Ciclo Fogo");
    expect(screen.queryByText(/Ciclo Água/)).toBeNull();
    expect(screen.getByTestId("crm-entendimento-necessidades").textContent).toContain("Estudar à noite");
    expect(screen.getByTestId("crm-entendimento-informacoes").textContent).toContain("Mora em Campinas");
    expect(screen.getByText(/Não é confirmado/)).toBeTruthy();
  });

  it("sem anotação da Sofia, o bloco nem aparece", () => {
    renderBloco([evento({ id: 1, eventType: "CREATED" })]);
    expect(screen.queryByTestId("crm-entendimento")).toBeNull();
  });
});
