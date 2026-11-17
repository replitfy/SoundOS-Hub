// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CommercialOpportunityEvent } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";
import { CardHistorico } from "./card-historico";

afterEach(() => { cleanup(); });

function evento(parcial: Partial<CommercialOpportunityEvent> & { id: number }): CommercialOpportunityEvent {
  return {
    opportunityId: 1,
    actorKind: "HUMAN",
    actorId: 7,
    actorName: "Marina Souza",
    eventType: "UPDATED",
    createdAt: "2026-11-02T13:30:00.000Z",
    metadata: {},
    ...parcial,
  } as CommercialOpportunityEvent;
}

function renderHistorico(events: CommercialOpportunityEvent[]) {
  return render(
    <LanguageProvider>
      <CardHistorico events={events} pessoaId={1} canOpenConversation={false} />
    </LanguageProvider>,
  );
}

describe("histórico do cartão", () => {
  it("mostra o nome de quem agiu, inclusive em registros antigos sem ação do atendimento", () => {
    renderHistorico([
      evento({ id: 1, eventType: "STAGE_CHANGED", fromStage: "NEW_INTEREST", toStage: "QUALIFYING", actorName: "Paulo Lima" }),
      evento({ id: 2, eventType: "CREATED", actorKind: "SOFIA", actorId: null, actorName: null }),
      evento({ id: 3, eventType: "PAUSED", actorKind: "SYSTEM", actorId: null, actorName: null }),
    ]);
    expect(screen.getByTestId("crm-evento-ator-1").textContent).toBe("Paulo Lima");
    expect(screen.getByTestId("crm-evento-ator-2").textContent).toBe("Sofia");
    expect(screen.getByTestId("crm-evento-ator-3").textContent).toBe("Sistema");
    // Os tipos reais de evento têm texto próprio (não aparece a chave crua).
    expect(screen.getByText("Mudança de etapa")).toBeTruthy();
    expect(screen.queryByText(/crm\.event\./)).toBeNull();
  });

  it("texto de tarefa e de compromisso excluídos continua legível no histórico", () => {
    renderHistorico([
      evento({ id: 10, metadata: { action: "TASK_DELETED", taskId: 4, text: "Ligar para confirmar a vaga" } }),
      evento({ id: 11, metadata: { action: "APPOINTMENT_DELETED", appointmentId: 2, title: "Conversa de apresentação", startsAt: "2026-11-10T17:00:00.000Z", link: "https://meet.example/abc" } }),
    ]);
    expect(screen.getByText("Tarefa excluída")).toBeTruthy();
    expect(screen.getByText("Ligar para confirmar a vaga")).toBeTruthy();
    expect(screen.getByText("Compromisso excluído")).toBeTruthy();
    expect(screen.getByText(/Conversa de apresentação/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/meet\.example\/abc/)).toBeTruthy();
  });

  it("alteração de informações mostra antes e depois, e não despeja o JSON da ação", () => {
    const { container } = renderHistorico([
      evento({ id: 20, metadata: { action: "INFORMATION_UPDATED", previous: "Prefere noite", current: "Prefere manhã" } }),
    ]);
    expect(screen.getByText("Informações atualizadas")).toBeTruthy();
    expect(screen.getByText("Prefere manhã")).toBeTruthy();
    expect(screen.getByText("Prefere noite")).toBeTruthy();
    expect(container.textContent).not.toContain('"action"');
  });

  it("assumir o atendimento e enviar mensagem aparecem como ações com o nome da pessoa da equipe", () => {
    renderHistorico([
      evento({ id: 30, metadata: { action: "ATTENDANCE_ASSUMED" }, actorName: "Ana Prado" }),
      evento({ id: 31, metadata: { action: "MESSAGE_SENT", excerpt: "Olá, tudo bem?" }, actorName: "Ana Prado" }),
    ]);
    expect(screen.getByText("Atendimento assumido pela equipe")).toBeTruthy();
    expect(screen.getByText("Mensagem enviada pela equipe")).toBeTruthy();
    expect(screen.getByText("Olá, tudo bem?")).toBeTruthy();
    expect(screen.getAllByText("Ana Prado")).toHaveLength(2);
  });

  it("anotação da Sofia mostra só o que mudou, com a Sofia como autora, e não despeja o JSON", () => {
    const { container } = renderHistorico([
      evento({
        id: 40, actorKind: "SOFIA", actorId: null, actorName: null,
        metadata: {
          action: "SOFIA_ENTENDIMENTO",
          sofiaEntendimento: { intencao: "Quer o Ciclo Água", necessidades: ["Relaxar", "Estudar à noite"], informacoes: [] },
          mudancas: { intencao: "Quer o Ciclo Água", necessidades: ["Estudar à noite"], informacoes: [], removidos: ["Curso presencial"] },
        },
      }),
    ]);
    expect(screen.getByText("Sofia atualizou o que entendeu da conversa")).toBeTruthy();
    expect(screen.getByTestId("crm-evento-ator-40").textContent).toBe("Sofia");
    expect(screen.getByText("Quer o Ciclo Água")).toBeTruthy();
    expect(screen.getByText("Estudar à noite")).toBeTruthy();
    expect(screen.getByText("Curso presencial")).toBeTruthy();
    // O retrato completo fica no bloco do cartão; o histórico lista só a mudança.
    expect(screen.queryByText("Relaxar")).toBeNull();
    expect(container.textContent).not.toContain('"action"');
  });
});
