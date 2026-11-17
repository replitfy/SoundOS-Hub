// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider, type Lang } from "@/contexts/language";
import { UserSessionProvider } from "@/contexts/user-session";
import { EventosTable } from "./cursos";

const accessState = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/contexts/access", async () => (await import("@/test/access-mock")).accessMock(() => accessState.isAdmin));

type EventRecord = {
  id: number;
  slug: string;
  nome: string;
  descricao: string | null;
  local: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  observacoes: string | null;
  ativo: boolean;
  nucleo: "EDUCATION";
  tipoEvento: "CURSO";
  courseId: number | null;
  classId: number | null;
  createdAt: string;
  updatedAt: string;
  inscritosCount: number;
};

const standalone = (): EventRecord => ({
  id: 10,
  slug: "evento-publico-1234",
  nome: "Evento público",
  descricao: "Descrição original",
  local: "São Paulo",
  dataInicio: "2026-10-10",
  dataFim: "2026-10-11",
  observacoes: "Histórico interno",
  ativo: true,
  nucleo: "EDUCATION",
  tipoEvento: "CURSO",
  courseId: null,
  classId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  inscritosCount: 3,
});

const managed = (): EventRecord => ({
  ...standalone(),
  id: 20,
  slug: "turma-publica-5678",
  nome: "Evento da turma",
  classId: 77,
  inscritosCount: 5,
});

function renderTable(lang: Lang, isAdmin = true) {
  accessState.isAdmin = isAdmin;
  localStorage.setItem("soundos_lang", lang);
  sessionStorage.setItem("soundos_user_session", JSON.stringify({
    id: 1,
    name: "Teste",
    email: "teste@example.com",
    sessionToken: "signed-test-token",
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <UserSessionProvider>
          <EventosTable />
        </UserSessionProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

describe.each([
  { lang: "pt" as const, width: 1280, edit: "Editar Evento público", archive: "Arquivar Evento público", restore: "Restaurar Evento editado", archived: "Arquivado", active: "Ativo", save: "Salvar", confirm: "Arquivar", search: "Buscar por nome", showArchived: "Mostrar arquivados", bulkDelete: "Excluir selecionados (2)", confirmDelete: "Excluir definitivamente" },
  { lang: "pt" as const, width: 390, edit: "Editar Evento público", archive: "Arquivar Evento público", restore: "Restaurar Evento editado", archived: "Arquivado", active: "Ativo", save: "Salvar", confirm: "Arquivar", search: "Buscar por nome", showArchived: "Mostrar arquivados", bulkDelete: "Excluir selecionados (2)", confirmDelete: "Excluir definitivamente" },
  { lang: "fr" as const, width: 1280, edit: "Modifier Evento público", archive: "Archiver Evento público", restore: "Restaurer Evento editado", archived: "Archivé", active: "Actif", save: "Enregistrer", confirm: "Archiver", search: "Rechercher un événement", showArchived: "Afficher les archivés", bulkDelete: "Supprimer (2)", confirmDelete: "Supprimer définitivement" },
  { lang: "fr" as const, width: 390, edit: "Modifier Evento público", archive: "Archiver Evento público", restore: "Restaurer Evento editado", archived: "Archivé", active: "Actif", save: "Enregistrer", confirm: "Archiver", search: "Rechercher un événement", showArchived: "Afficher les archivés", bulkDelete: "Supprimer (2)", confirmDelete: "Supprimer définitivement" },
])("ações de eventos em $lang com largura $width", ({ lang, width, edit, archive, restore, archived, active, save, confirm, search, showArchived, bulkDelete, confirmDelete }) => {
  let events: EventRecord[];
  let deleteCalls: number[][];
  let cascadeCalls: Array<{ ids: number[]; confirmation: string }>;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    events = [standalone(), managed()];
    deleteCalls = [];
    cascadeCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cursos-inscricao" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(events), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/cursos-inscricao/bulk-delete" && init?.method === "DELETE") {
        const ids = (JSON.parse(String(init.body)) as { ids: number[] }).ids;
        deleteCalls.push(ids);
        events = events.filter((event) => !ids.includes(event.id));
        return new Response(JSON.stringify({ deletedCount: ids.length }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/cursos-inscricao/bulk-cascade-test-delete" && init?.method === "DELETE") {
        const payload = JSON.parse(String(init.body)) as { ids: number[]; confirmation: string };
        cascadeCalls.push(payload);
        events = events.filter((event) => !payload.ids.includes(event.id));
        return new Response(JSON.stringify({
          deletedEventCount: payload.ids.length,
          deletedClassCount: payload.ids.length,
          deletedCourseCount: payload.ids.length,
          deletedEnrollmentCount: payload.ids.length * 3,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const match = url.match(/^\/api\/cursos-inscricao\/(\d+)$/);
      if (match && init?.method === "PATCH") {
        const id = Number(match[1]);
        const patch = JSON.parse(String(init.body)) as Partial<EventRecord>;
        events = events.map((event) => event.id === id ? { ...event, ...patch } : event);
        return new Response(JSON.stringify(events.find((event) => event.id === id)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }));
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("edita, arquiva, restaura e restringe ações por permissão", async () => {
    const view = renderTable(lang);
    await screen.findByText("Evento público");

    const managedRow = screen.getByText("Evento da turma").closest("tr")!;
    expect(within(managedRow).getByLabelText(`${lang === "fr" ? "Sélectionner" : "Selecionar"} Evento da turma`)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(edit));
    const nameInput = screen.getByDisplayValue("Evento público");
    fireEvent.change(nameInput, { target: { value: "Evento editado" } });
    fireEvent.click(screen.getByRole("button", { name: save }));
    await screen.findByText("Evento editado");

    const slugBefore = events[0]!.slug;
    const countBefore = events[0]!.inscritosCount;
    const historyBefore = events[0]!.observacoes;
    fireEvent.click(screen.getByLabelText(archive.replace("Evento público", "Evento editado")));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: confirm }));
    await waitFor(() => expect(events[0]!.ativo).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: showArchived }));
    await screen.findByText(archived);
    expect(events[0]).toMatchObject({
      ativo: false,
      slug: slugBefore,
      inscritosCount: countBefore,
      observacoes: historyBefore,
    });

    fireEvent.click(screen.getByLabelText(restore));
    await waitFor(() => expect(screen.getByText(active)).toBeTruthy());
    expect(events[0]!.ativo).toBe(true);

    view.unmount();
    sessionStorage.clear();
    renderTable(lang, false);
    await screen.findByText("Evento editado");
    expect(screen.queryByLabelText(edit.replace("Evento público", "Evento editado"))).toBeNull();
    expect(screen.queryByLabelText(archive.replace("Evento público", "Evento editado"))).toBeNull();
  });

  it("ordena a tabela por coluna e alterna entre crescente e decrescente", async () => {
    renderTable(lang);
    await screen.findByText("Evento público");

    const eventHeader = lang === "fr" ? "Événement" : "Evento";
    const sortButton = screen.getByRole("button", {
      name: `${lang === "fr" ? "Trier par" : "Ordenar por"} ${eventHeader}`,
    });
    const eventNames = () => Array.from(document.querySelectorAll("tbody tr"))
      .map(row => row.querySelector("td a")?.textContent)
      .filter(Boolean);

    fireEvent.click(sortButton);
    expect(eventNames()).toEqual(["Evento da turma", "Evento público"]);
    expect(sortButton.closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(sortButton);
    expect(eventNames()).toEqual(["Evento público", "Evento da turma"]);
    expect(sortButton.closest("th")?.getAttribute("aria-sort")).toBe("descending");
  });

  it("redimensiona a coluna do evento, salva a largura e permite restaurar o padrão", async () => {
    renderTable(lang);
    await screen.findByText("Evento público");

    const column = document.querySelector('col[data-testid="events-column-nome"]');
    const resizeButton = screen.getByRole("button", {
      name: lang === "fr" ? "Redimensionner la colonne Événement" : "Redimensionar coluna Evento",
    });
    expect(column?.getAttribute("style")).toContain("width: 340px");

    fireEvent.keyDown(resizeButton, { key: "ArrowRight" });
    await waitFor(() => expect(column?.getAttribute("style")).toContain("width: 350px"));
    await waitFor(() => {
      const storedWidths = JSON.parse(localStorage.getItem("soundos.education.event-column-widths.v1") ?? "{}");
      expect(storedWidths.nome).toBe(350);
    });

    fireEvent.doubleClick(resizeButton);
    await waitFor(() => expect(column?.getAttribute("style")).toContain("width: 340px"));
  });

  it("busca por parte do nome e exclui em lote eventos arquivados após confirmar", async () => {
    events = [
      { ...standalone(), id: 31, nome: "E2E teste ativo" },
      { ...standalone(), id: 32, nome: "E2E teste arquivado", ativo: false },
      { ...standalone(), id: 33, nome: "Evento real" },
    ];
    renderTable(lang);
    await screen.findByText("E2E teste ativo");

    fireEvent.change(screen.getByPlaceholderText(search), { target: { value: "E2E teste" } });
    expect(screen.getByText("E2E teste ativo")).toBeTruthy();
    expect(screen.queryByText("Evento real")).toBeNull();
    expect(screen.queryByText("E2E teste arquivado")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: showArchived }));
    expect(screen.getByText("E2E teste arquivado")).toBeTruthy();
    const selectLabel = lang === "fr" ? "Sélectionner" : "Selecionar";
    fireEvent.click(screen.getByLabelText(`${selectLabel} E2E teste ativo`));
    fireEvent.click(screen.getByLabelText(`${selectLabel} E2E teste arquivado`));
    fireEvent.click(screen.getByRole("button", { name: bulkDelete }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("E2E teste ativo")).toBeTruthy();
    expect(within(dialog).getByText("E2E teste arquivado")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: confirmDelete }));

    await waitFor(() => expect(deleteCalls).toEqual([[31, 32]]));
    await waitFor(() => expect(screen.queryByText("E2E teste ativo")).toBeNull());
    expect(events.map(event => event.id)).toEqual([33]);
  });

  it("exige a frase de confirmação para apagar em cascata eventos de teste", async () => {
    const testActive = {
      ...standalone(),
      id: 41,
      slug: "e2e-event-41",
      nome: "E2E evento de teste",
    };
    const testArchived = {
      ...standalone(),
      id: 42,
      slug: "teste-evento-42",
      nome: "Evento teste arquivado",
      ativo: false,
    };
    events = [testActive, testArchived];
    renderTable(lang);
    await screen.findByText(testActive.nome);

    fireEvent.click(screen.getByRole("switch", { name: showArchived }));
    fireEvent.click(screen.getByLabelText(`${lang === "fr" ? "Sélectionner" : "Selecionar"} ${testActive.nome}`));
    fireEvent.click(screen.getByLabelText(`${lang === "fr" ? "Sélectionner" : "Selecionar"} ${testArchived.nome}`));
    fireEvent.click(screen.getByRole("button", {
      name: lang === "fr" ? "Supprimer les tests (2)" : "Excluir testes em cascata (2)",
    }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/fichas de pessoas e conversas serão preservadas|fiches de personnes et les conversations seront conservées/i)).toBeTruthy();
    const confirmButton = within(dialog).getByRole("button", {
      name: lang === "fr" ? "Supprimer les tests" : "Apagar testes",
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(lang === "fr" ? "Phrase de confirmation" : "Senha de confirmação"), {
      target: { value: "errado" },
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(lang === "fr" ? "Phrase de confirmation" : "Senha de confirmação"), {
      target: { value: "123mudar" },
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(cascadeCalls).toEqual([{
      ids: [41, 42],
      confirmation: "123mudar",
    }]));
    await waitFor(() => expect(screen.queryByText(testActive.nome)).toBeNull());
    expect(events).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });
});