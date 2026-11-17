// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionRun } from "@workspace/api-client-react";
import DecisionRunsPanel from "./decision-runs-panel";

function makeRun(overrides: Partial<DecisionRun> = {}): DecisionRun {
  return {
    id: 1,
    pessoaId: 10,
    conversationId: 20,
    messageId: 31,
    conduta: "triagem",
    promptId: 15,
    model: "openai/gpt-test",
    triggerMessage: {
      id: 30,
      role: "user",
      content: "Onde acontece o próximo evento?",
      createdAt: "2026-09-19T18:00:00.000Z",
    },
    responseMessage: {
      id: 31,
      role: "assistant",
      content: "Aldeia do Holon, Serra da Mantiqueira.",
      conduta: "triagem",
      createdAt: "2026-09-19T18:00:01.000Z",
    },
    evidenciasConsideradas: [],
    elegibilidadeStatus: "nao_avaliada",
    nbaCategoria: "explorar",
    nbaJustificativa: "Resposta factual aprovada.",
    nivelConfianca: "alta",
    metadata: {
      intent: "upcoming_offering",
      result: "success",
      nba_code: "ANSWER_FACT",
      sources: [{
        type: "official_event_catalog",
        policy: "public_event_agenda",
        tables: ["events", "classes"],
      }],
      candidate_set: [{
        courseName: "Ciclo Ar",
        requestedFields: ["location"],
      }],
      filters: { modality: "presencial", location: null },
      omitted_fields: ["class_capacity"],
    },
    createdAt: "2026-09-19T18:00:01.000Z",
    ...overrides,
  };
}

function renderPanel(runs: DecisionRun[]) {
  const onRefresh = vi.fn();
  const onFocusMessage = vi.fn();
  render(
    <DecisionRunsPanel
      runs={runs}
      isLoading={false}
      isFetching={false}
      isError={false}
      onRefresh={onRefresh}
      hoveredMessageId={null}
      onHoverMessage={vi.fn()}
      onFocusMessage={onFocusMessage}
      onClose={vi.fn()}
    />,
  );
  return { onRefresh, onFocusMessage };
}

describe("DecisionRunsPanel", () => {
  afterEach(cleanup);

  it("shows the conversation, rationale, sources, candidates and filters for an admin", () => {
    const { onFocusMessage } = renderPanel([makeRun()]);

    expect(screen.getByTestId("summary-total").textContent).toContain("1");
    expect(screen.getByTestId("summary-attention").textContent).toContain("0");

    fireEvent.click(screen.getByTestId("run-toggle-1"));

    expect(screen.getByText("Onde acontece o próximo evento?")).toBeDefined();
    expect(screen.getByText("Aldeia do Holon, Serra da Mantiqueira.")).toBeDefined();
    expect(screen.getByText("Resposta factual aprovada.")).toBeDefined();
    expect(screen.getAllByText(/public_event_agenda/).length).toBeGreaterThan(0);
    expect(screen.getByText("Ciclo Ar")).toBeDefined();
    expect(screen.getByText("location")).toBeDefined();
    expect(screen.getByText(/modality=presencial/)).toBeDefined();

    fireEvent.click(screen.getByTestId("focus-chat-1"));
    expect(onFocusMessage).toHaveBeenCalledWith(31);
  });

  it("filters failures and handoffs into attention", () => {
    const healthy = makeRun();
    const attention = makeRun({
      id: 2,
      messageId: null,
      responseMessage: null,
      nivelConfianca: "baixa",
      metadata: {
        intent: "product_fact",
        result: "ambiguous",
      },
    });
    const handoff = makeRun({
      id: 3,
      messageId: 33,
      responseMessage: {
        id: 33,
        role: "assistant",
        content: "Vou conectar você com uma pessoa da equipe.",
        createdAt: "2026-09-19T18:01:00.000Z",
      },
      nivelConfianca: "media",
      metadata: {
        outcome: "handoff",
        handoffReason: "pedido_explicito",
      },
    });
    renderPanel([healthy, attention, handoff]);

    expect(screen.getByTestId("summary-total").textContent).toContain("3");
    expect(screen.getByTestId("summary-attention").textContent).toContain("2");

    fireEvent.click(screen.getByTestId("filter-attention"));

    expect(screen.getByTestId("decision-run-2")).toBeDefined();
    expect(screen.getByTestId("decision-run-3")).toBeDefined();
    expect(screen.getByTestId("attention-reasons-3").textContent).toContain("Handoff acionado");
    expect(screen.queryByTestId("decision-run-1")).toBeNull();
  });

  it("makes missing historical linkage and telemetry explicit", () => {
    renderPanel([makeRun({
      id: 4,
      triggerMessage: null,
      model: null,
      promptId: null,
      metadata: {},
    })]);

    expect(screen.getByTestId("summary-attention").textContent).toContain("1");
    fireEvent.click(screen.getByTestId("run-toggle-4"));

    expect(screen.getByTestId("missing-trigger-4")).toBeDefined();
    expect(screen.getByText("Modelo: não registrado")).toBeDefined();
    expect(screen.getByText("Prompt: não registrado")).toBeDefined();
    expect(screen.getByText("Este registro não possui metadados adicionais.")).toBeDefined();
  });

  it("refreshes the diagnostic log manually", () => {
    const { onRefresh } = renderPanel([makeRun()]);

    fireEvent.click(screen.getByTestId("button-refresh-diags"));

    expect(onRefresh).toHaveBeenCalledOnce();
  });
});