import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatUpcomingOfferings, listUpcomingOfferings } from "./sofiaUpcomingOfferings";

const queryRows = vi.hoisted(() => vi.fn());
const catalogRows = vi.hoisted(() => vi.fn());
const getOfficialEventCatalog = vi.hoisted(() => vi.fn());
const dbSelect = vi.hoisted(() => vi.fn(() => ({
  from: () => ({
    innerJoin: () => ({
      leftJoin: () => ({
        where: () => ({
          orderBy: () => queryRows(),
        }),
      }),
    }),
    where: () => ({
      orderBy: () => catalogRows(),
    }),
  }),
})));

vi.mock("@workspace/db", () => ({
  db: { select: dbSelect },
  classesTable: {
    id: "classes.id",
    courseId: "classes.course_id",
    startDate: "classes.start_date",
    endDate: "classes.end_date",
    location: "classes.location",
    status: "classes.status",
  },
  coursesTable: {
    id: "courses.id",
    active: "courses.active",
    name: "courses.name",
    modality: "courses.modality",
    description: "courses.description",
    workload: "courses.workload",
  },
  cursosInscricao: {
    id: "cursos_inscricao.id",
    classId: "cursos_inscricao.class_id",
    ativo: "cursos_inscricao.ativo",
    tipoEvento: "cursos_inscricao.tipo_evento",
  },
}));

vi.mock("./sofiaEventCatalog", () => ({
  getOfficialEventCatalog,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  ilike: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { join: vi.fn(() => ({ joined: true })) },
  ),
}));

describe("structured upcoming courses and events", () => {
  beforeEach(() => {
    queryRows.mockReset();
    catalogRows.mockReset();
    getOfficialEventCatalog.mockReset();
  });
  it("returns sanitized public facts and applies optional filters", async () => {
    queryRows.mockResolvedValueOnce([{
      classId: 2,
      courseId: 4,
      courseName: "Formação Básica em Sound Healing",
      startDate: "2027-01-13",
      endDate: "2027-01-13",
      location: "Vila Mariana — São Paulo – SP",
      modality: "Presencial/Online",
      description: "Fundamentos da terapia sonora.",
      workload: 80,
      status: "in_progress",
      capacity: 20,
    }]);

    const result = await listUpcomingOfferings({
      modality: "presencial",
      location: "São Paulo",
      now: new Date("2026-09-15T12:00:00.000Z"),
    });

    expect(result.items).toEqual([{
      classId: 2,
      courseId: 4,
      courseName: "Formação Básica em Sound Healing",
      startDate: "2027-01-13",
      endDate: "2027-01-13",
      location: "Vila Mariana — São Paulo – SP",
      modality: "Presencial/Online",
      description: "Fundamentos da terapia sonora.",
      workload: 80,
      status: "in_progress",
    }]);
    expect(result.items[0]).not.toHaveProperty("capacity");
    expect(result.items[0]).not.toHaveProperty("price");
    expect(result.source).toMatchObject({
      tables: ["classes", "courses"],
      policy: "public_course_facts",
    });
  });

  it("formats one offering with Brazilian date and never states the price", () => {
    const text = formatUpcomingOfferings({
      items: [{
        classId: 1,
        courseId: 2,
        courseName: "Formação Avançada",
        startDate: "2026-10-29",
        endDate: "2026-10-31",
        location: "São Paulo",
        modality: "Presencial",
        description: "Aprofundamento terapêutico.",
        workload: 120,
        status: "Planejada",
      }],
      source: { tables: ["classes", "courses"], fetchedAt: "2026-09-15T12:00:00.000Z", policy: "public_course_facts" },
    }, ["name", "date", "price"]);

    expect(text).toContain("29/10/2026 a 31/10/2026");
    expect(text).toContain("Valor: o time interno informa valores e condições.");
    expect(text).not.toContain("R$");
    expect(text).not.toContain("4.800");
    expect(text).not.toContain("Fonte:");
    expect(text).not.toContain("A próxima opção encontrada");
  });

  it("masks amounts written in the description of an event", () => {
    const text = formatUpcomingOfferings({
      items: [{
        classId: null, courseId: null, courseName: "Ciclo Água", startDate: "2027-01-13", endDate: "2027-01-17",
        location: "São Paulo", modality: "Presencial", workload: null, status: "active",
        description: "Vivência de cinco dias. Investimento: R$ 4.800,00 (ou 3.000 reais à vista).",
      }],
      source: { tables: ["cursos_inscricao", "classes", "courses"], fetchedAt: "2026-09-15T12:00:00.000Z", policy: "public_event_agenda" },
    }, ["name", "description"]);

    expect(text).toContain("Vivência de cinco dias.");
    expect(text).not.toMatch(/R\$|4\.800|3\.000|reais/);
  });

  it("returns only the fields requested in a factual follow-up", () => {
    const result = {
      items: [{
        classId: 1,
        courseId: 2,
        courseName: "Ciclo Ar",
        startDate: "2026-10-07",
        endDate: null,
        location: "Aldeia do Holon",
        modality: "Presencial",
        description: "Descrição longa que não foi pedida.",
        workload: 20,
        status: "Planejada",
      }],
      source: {
        tables: ["classes", "courses"] as ["classes", "courses"],
        fetchedAt: "2026-09-15T12:00:00.000Z",
        policy: "public_course_facts" as const,
      },
    };

    expect(formatUpcomingOfferings(result, ["location", "link"]))
      .toBe("Local: Aldeia do Holon\nLink oficial: ainda não informado.");
    expect(formatUpcomingOfferings(result, ["name", "date"]))
      .toBe("Ciclo Ar\nData: 07/10/2026");
    const withUrl = {
      ...result,
      items: [{ ...result.items[0]!, url: "https://www.soundfulness.online/event-details/ciclo-ar" }],
    };
    expect(formatUpcomingOfferings(withUrl, ["link"]))
      .toBe("Link oficial: https://www.soundfulness.online/event-details/ciclo-ar");
  });

  it("preserves tied offerings on the same date", () => {
    const item = {
      classId: 1,
      courseId: 2,
      courseName: "Curso A",
      startDate: "2026-10-29",
      endDate: null,
      location: null,
      modality: "Presencial",
      description: null,
      workload: 10,
      status: "scheduled",
    };
    const text = formatUpcomingOfferings({
      items: [item, { ...item, classId: 2, courseId: 3, courseName: "Curso B" }],
      source: { tables: ["classes", "courses"], fetchedAt: "2026-09-15T12:00:00.000Z", policy: "public_course_facts" },
    });

    expect(text).toContain("1. Curso A");
    expect(text).toContain("2. Curso B");
  });

  it("returns only offerings tied on the nearest available date", async () => {
    queryRows.mockResolvedValueOnce([
      {
        classId: 1, courseId: 1, courseName: "Curso A", startDate: "2026-10-10",
        endDate: null, location: "SP", modality: "Presencial", description: null,
        workload: 8, status: "Planejada",
      },
      {
        classId: 2, courseId: 2, courseName: "Curso B", startDate: "2026-10-10",
        endDate: null, location: "RJ", modality: "Presencial", description: null,
        workload: 8, status: "scheduled",
      },
      {
        classId: 3, courseId: 3, courseName: "Curso futuro", startDate: "2026-11-10",
        endDate: null, location: "SP", modality: "Online", description: null,
        workload: 8, status: "scheduled",
      },
    ]);

    const result = await listUpcomingOfferings({ now: new Date("2026-09-15T12:00:00Z") });

    expect(result.items.map(item => item.courseName)).toEqual(["Curso A", "Curso B"]);
  });

  it("uses the complete official Events agenda for a generic event request", async () => {
    getOfficialEventCatalog.mockResolvedValueOnce({
      source: {
        tables: ["cursos_inscricao", "classes", "courses"],
        fetchedAt: "2026-09-15T12:00:00.000Z",
        policy: "public_event_agenda",
      },
      items: [{
        eventId: 24,
        slug: "ciclo-ar",
        name: "Ciclo Ar",
        description: null,
        startDate: "2026-10-01",
        endDate: null,
        location: "RS",
        nucleus: "EDUCATION",
        eventType: "CURSO",
        classId: 1,
        courseId: 1,
        modality: "Presencial",
        workload: 8,
      }],
    });

    const result = await listUpcomingOfferings({ kind: "event", now: new Date("2026-09-15T12:00:00Z") });

    expect(result.items.map(item => item.courseName)).toEqual(["Ciclo Ar"]);
    expect(result.source.policy).toBe("public_event_agenda");
  });

  it("constrains a named factual request to the matching official offering", async () => {
    queryRows.mockResolvedValueOnce([
      {
        classId: 1, courseId: 1, courseName: "Formação Básica", startDate: "2026-10-01",
        endDate: null, location: "SP", modality: "Presencial", description: "Introdução",
        workload: 8, status: "Planejada", eventType: "CURSO",
      },
      {
        classId: 2, courseId: 2, courseName: "Formação Avançada", startDate: "2026-10-29",
        endDate: null, location: "SP", modality: "Presencial", description: "Avançado",
        workload: 24, status: "Planejada", eventType: "CURSO",
      },
    ]);
    const result = await listUpcomingOfferings({
      kind: "course",
      query: "Qual é o preço da Formação Avançada?",
      requireNameMatch: true,
    });

    expect(result.items.map(item => item.courseName)).toEqual(["Formação Avançada"]);
  });

  it("returns no result instead of the globally next offering when a required name does not match", async () => {
    queryRows.mockResolvedValueOnce([
      {
        classId: 1, courseId: 1, courseName: "Formação Básica", startDate: "2026-10-01",
        endDate: null, location: "SP", modality: "Presencial", description: null,
        workload: 8, status: "Planejada", eventType: "CURSO",
      },
    ]);
    catalogRows.mockResolvedValueOnce([]);

    const result = await listUpcomingOfferings({
      kind: "course",
      query: "Qual o conteúdo do curso de Sound Healing?",
      requireNameMatch: true,
    });

    expect(result.items).toEqual([]);
  });

  it("falls back to stable official course facts when the named course has no future class", async () => {
    queryRows.mockResolvedValueOnce([]);
    catalogRows.mockResolvedValueOnce([{
      courseId: 9,
      courseName: "Curso Sem Turma",
      modality: "Online",
      description: "Conteúdo oficial.",
      workload: 12,
    }]);

    const result = await listUpcomingOfferings({
      kind: "course",
      query: "Qual o preço do Curso Sem Turma?",
      requireNameMatch: true,
    });

    expect(result.items).toEqual([expect.objectContaining({
      classId: null,
      courseId: 9,
      courseName: "Curso Sem Turma",
      startDate: null,
    })]);
    expect(formatUpcomingOfferings(result)).toContain("nenhuma turma futura confirmada");
  });

  it("answers transparently when no future offering exists", () => {
    expect(formatUpcomingOfferings({
      items: [],
      source: { tables: ["classes", "courses"], fetchedAt: "2026-09-15T12:00:00.000Z", policy: "public_course_facts" },
    })).toContain("Não encontrei");
  });

  it("describes a missing public event as having no published active date", () => {
    expect(formatUpcomingOfferings({
      items: [],
      source: {
        tables: ["cursos_inscricao", "classes", "courses"],
        fetchedAt: "2026-09-15T12:00:00.000Z",
        policy: "public_event_agenda",
      },
    })).toBe("Não há data publicada para um evento futuro compatível.");
  });
});