// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/language";
import CargaAirtable from "./carga-airtable";

const api = vi.hoisted(() => ({
  runs: [] as unknown[],
  startPreview: vi.fn(),
  startLoad: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>("@workspace/api-client-react");
  return {
    ...actual,
    useGetAirtableCarga: () => ({
      data: { runs: api.runs, settings: { previewValidMinutes: 60, referenceRecords: 4829, minimumFraction: 0.9 } },
      isLoading: false,
      isError: false,
    }),
    useStartAirtableCargaPreview: () => ({ mutate: api.startPreview, isPending: false }),
    useStartAirtableCargaLoad: () => ({ mutate: api.startLoad, isPending: false }),
  };
});

const TOTALS = {
  sourceRecords: 4913,
  toCreate: 48,
  alreadyExist: 4720,
  alreadyExistBy: { email: 121, phone: 281, both: 4318, previousLoad: 0 },
  review: { total: 145, byReason: { duplicado_no_airtable: 11, ambiguo: 90, contraditorio: 1, dados_insuficientes: 43 } },
  enrollments: {
    sourceRecords: 3712,
    eventRecords: 432,
    forNewClients: 60,
    toCreate: 37,
    clientsWithEnrollment: 29,
    review: { total: 23, byReason: { turma_ausente: 12, turma_ambigua: 5, duplicada: 4, pessoa_ambigua: 2 } },
  },
};

function run(overrides: Record<string, unknown>) {
  return {
    id: 7, kind: "preview", status: "completed", step: null,
    startedAt: "2026-11-11T14:00:00.000Z", finishedAt: "2026-11-11T14:00:20.000Z",
    requestedBy: { id: 1, name: "Marina" }, previewRunId: null, errorCode: null,
    sourceRecordsRead: 4913, totals: TOTALS, minimumExpected: 4346, created: null, reconciliation: null,
    usableForLoad: true, validUntil: "2026-11-11T15:00:20.000Z", ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider><CargaAirtable /></LanguageProvider>
    </QueryClientProvider>,
  );
}

describe("tela Manutenção · Carga do Airtable", () => {
  beforeEach(() => {
    localStorage.setItem("soundos_lang", "pt");
    api.startPreview.mockReset();
    api.startLoad.mockReset();
    api.runs = [run({})];
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("mostra só totais da prévia e o limite de segurança da leitura", () => {
    renderPage();
    expect(screen.getByTestId("carga-title").textContent).toBe("Manutenção · Carga do Airtable");
    expect(screen.getByTestId("carga-total-read").textContent).toContain("4.913");
    expect(screen.getByTestId("carga-total-create").textContent).toContain("48");
    expect(screen.getByTestId("carga-total-exist").textContent).toContain("4.720");
    expect(screen.getByTestId("carga-total-review").textContent).toContain("145");
    // 90% da última leitura boa (4913).
    expect(screen.getByTestId("carga-guard").textContent).toContain("4.421");
    expect(screen.getByTestId("carga-totals").textContent).not.toMatch(/@/);
  });

  it("mostra as matrículas dos clientes novos só em totais, com os motivos da revisão", () => {
    renderPage();
    const section = screen.getByTestId("carga-enrollments");
    expect(screen.getByTestId("carga-enroll-for-new").textContent).toContain("60");
    expect(screen.getByTestId("carga-enroll-create").textContent).toContain("37");
    expect(screen.getByTestId("carga-enroll-clients").textContent).toContain("29");
    expect(screen.getByTestId("carga-enroll-review").textContent).toContain("23");
    expect(section.textContent).toContain("Turma não encontrada no SoundOS");
    expect(section.textContent).toContain("Inscrição ligada a mais de um cliente");
    expect(section.textContent).not.toMatch(/@/);
  });

  it("prévia de antes das matrículas não permite executar a carga e pede uma nova", () => {
    api.runs = [run({ totals: { ...TOTALS, enrollments: null }, usableForLoad: false })];
    renderPage();
    expect((screen.getByTestId("carga-load-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("carga-preview-problem").textContent).toContain("antes da inclusão das matrículas");
    expect(screen.queryByTestId("carga-enrollments")).toBeNull();
  });

  it("gerar prévia dispara a leitura; a carga só abre com prévia utilizável e exige a confirmação marcada", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("carga-preview-button"));
    expect(api.startPreview).toHaveBeenCalledTimes(1);

    const loadButton = screen.getByTestId("carga-load-button") as HTMLButtonElement;
    expect(loadButton.disabled).toBe(false);
    fireEvent.click(loadButton);

    const dialog = screen.getByTestId("carga-dialog");
    expect(within(dialog).getByText(/recuperação por ponto no tempo do Replit/)).toBeTruthy();
    expect(within(dialog).getByText(/Serão criadas 48 fichas novas e 37 matrículas em turmas que já existem/)).toBeTruthy();
    expect(within(dialog).getByText(/horário exato de início da carga fica registrado no histórico/)).toBeTruthy();

    const confirm = screen.getByTestId("carga-confirm-button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(api.startLoad).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("carga-confirm-checkbox"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(api.startLoad).toHaveBeenCalledTimes(1);
    expect(api.startLoad.mock.calls[0]![0]).toEqual({ data: { previewRunId: 7, restoreConfirmed: true } });
  });

  it("sem prévia utilizável (expirada ou já usada) a carga fica bloqueada e explica o motivo", () => {
    api.runs = [run({ usableForLoad: false, validUntil: "2026-11-11T15:00:20.000Z" })];
    renderPage();
    expect((screen.getByTestId("carga-load-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("carga-preview-problem").textContent).toContain("expirou");

    cleanup();
    api.runs = [
      run({ id: 9, kind: "load", status: "completed", previewRunId: 7, created: 48, enrollmentsCreated: 37, usableForLoad: false, validUntil: null, reconciliation: { passed: true, checks: [] } }),
      run({ usableForLoad: false }),
    ];
    renderPage();
    expect(screen.getByTestId("carga-preview-problem").textContent).toContain("já foi usada");
    expect(screen.getByTestId("carga-last-done").textContent).toContain("48 fichas e 37 matrículas criadas");
  });

  it("durante a execução mostra a etapa e a referência de restauração e trava os botões", () => {
    api.runs = [
      run({ id: 8, kind: "load", status: "running", step: "writing", finishedAt: null, totals: null, previewRunId: 7, usableForLoad: false, validUntil: null }),
      run({}),
    ];
    renderPage();
    expect(screen.getByTestId("carga-step").textContent).toBe("Criando as fichas e as matrículas");
    expect(screen.getByTestId("carga-running").textContent).toContain("Referência para restauração");
    expect(screen.getByTestId("carga-started-at").textContent).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
    expect((screen.getByTestId("carga-preview-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("carga-load-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("traduz o código de erro da última execução e lista as conferências que falharam", () => {
    api.runs = [
      run({
        id: 10, kind: "load", status: "failed", errorCode: "RECONCILIACAO_FALHOU", previewRunId: 7, usableForLoad: false, validUntil: null,
        reconciliation: { passed: false, checks: [{ name: "people_count", ok: true }, { name: "existing_people_untouched", ok: false }] },
      }),
    ];
    renderPage();
    const failed = screen.getByTestId("carga-last-failed");
    expect(failed.textContent).toContain("A conferência final não bateu. Tudo foi desfeito.");
    expect(failed.textContent).toContain("Fichas existentes intactas");
    expect(screen.getByTestId("carga-history").textContent).toContain("Falhou");
  });

  it("código de erro desconhecido cai no texto genérico, nunca na chave crua", () => {
    api.runs = [run({ id: 11, status: "failed", errorCode: "CODIGO_NOVO", totals: null, usableForLoad: false, validUntil: null })];
    renderPage();
    expect(screen.getByTestId("carga-last-failed").textContent).toContain("Não foi possível concluir a operação.");
    expect(screen.getByTestId("carga-last-failed").textContent).not.toContain("carga.err");
  });

  it("existe em francês", () => {
    localStorage.setItem("soundos_lang", "fr");
    renderPage();
    expect(screen.getByTestId("carga-title").textContent).toBe("Maintenance · Chargement Airtable");
    expect(screen.getByTestId("carga-preview-button").textContent).toBe("Générer l'aperçu");
    fireEvent.click(screen.getByTestId("carga-load-button"));
    expect(within(screen.getByTestId("carga-dialog")).getByText(/récupération à un instant donné de Replit/)).toBeTruthy();
    expect(within(screen.getByTestId("carga-dialog")).getByText(/37 inscriptions dans des classes existantes/)).toBeTruthy();
  });
});
