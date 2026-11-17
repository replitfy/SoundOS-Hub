import { beforeEach, describe, expect, it, vi } from "vitest";

const eventRows = vi.hoisted(() => vi.fn());
const dbSelect = vi.hoisted(() => vi.fn(() => ({
  from: () => ({
    leftJoin: () => ({
      leftJoin: () => ({
        where: () => ({
          orderBy: () => eventRows(),
        }),
      }),
    }),
  }),
})));

vi.mock("@workspace/db", () => ({
  db: { select: dbSelect },
  cursosInscricao: {
    id: "cursos_inscricao.id",
    slug: "cursos_inscricao.slug",
    nome: "cursos_inscricao.nome",
    descricao: "cursos_inscricao.descricao",
    local: "cursos_inscricao.local",
    dataInicio: "cursos_inscricao.data_inicio",
    dataFim: "cursos_inscricao.data_fim",
    ativo: "cursos_inscricao.ativo",
    nucleo: "cursos_inscricao.nucleo",
    tipoEvento: "cursos_inscricao.tipo_evento",
    classId: "cursos_inscricao.class_id",
    courseId: "cursos_inscricao.course_id",
  },
  classesTable: {
    id: "classes.id",
    courseId: "classes.course_id",
  },
  coursesTable: {
    id: "courses.id",
    modality: "courses.modality",
    description: "courses.description",
    workload: "courses.workload",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  ilike: vi.fn(),
  isNotNull: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import { getOfficialEventCatalog } from "./sofiaEventCatalog";

describe("official structured Events catalog", () => {
  beforeEach(() => eventRows.mockReset());

  it("keeps standalone active agenda rows and returns only the nearest date", async () => {
    eventRows.mockResolvedValueOnce([
      {
        eventId: 10,
        slug: "evento-avulso",
        name: "Evento Avulso",
        description: "Cadastro da agenda",
        startDate: "2026-09-20",
        endDate: null,
        location: "SP",
        nucleus: "EXPERIENCES",
        eventType: "VIVENCIA",
        classId: null,
        courseId: null,
        modality: null,
        workload: null,
      },
      {
        eventId: 11,
        slug: "evento-futuro",
        name: "Evento Futuro",
        description: null,
        startDate: "2026-10-10",
        endDate: null,
        location: "RJ",
        nucleus: "EDUCATION",
        eventType: "CURSO",
        classId: 4,
        courseId: 2,
        modality: "Presencial",
        workload: 20,
      },
    ]);

    const result = await getOfficialEventCatalog({ now: new Date("2026-09-15T12:00:00Z") });

    expect(result.items).toEqual([expect.objectContaining({
      eventId: 10,
      name: "Evento Avulso",
      classId: null,
      courseId: null,
    })]);
    expect(result.source).toMatchObject({
      tables: ["cursos_inscricao", "classes", "courses"],
      policy: "public_event_agenda",
    });
  });

  it("never substitutes another event when a required name does not match", async () => {
    eventRows.mockResolvedValueOnce([{
      eventId: 10,
      slug: "evento-a",
      name: "Evento A",
      description: null,
      startDate: "2026-09-20",
      endDate: null,
      location: "SP",
      nucleus: "EDUCATION",
      eventType: "CURSO",
      classId: null,
      courseId: null,
      modality: null,
      workload: null,
    }]);

    const result = await getOfficialEventCatalog({
      query: "Quando será o Evento B?",
      requireNameMatch: true,
    });

    expect(result.items).toEqual([]);
  });

  it("does not substitute one named retreat for another", async () => {
    eventRows.mockResolvedValueOnce([
      {
        eventId: 20, slug: "retiro-sol", name: "Retiro Sol", description: null,
        startDate: "2026-09-20", endDate: null, location: "SP", nucleus: "EXPERIENCES",
        eventType: "RETIRO", classId: null, courseId: null, modality: null, workload: null,
      },
      {
        eventId: 21, slug: "retiro-luz", name: "Retiro Luz", description: null,
        startDate: "2026-10-20", endDate: null, location: "MG", nucleus: "EXPERIENCES",
        eventType: "RETIRO", classId: null, courseId: null, modality: null, workload: null,
      },
    ]);

    const result = await getOfficialEventCatalog({
      query: "Quando será o Retiro Luz?",
      requireNameMatch: true,
    });

    expect(result.items.map(item => item.name)).toEqual(["Retiro Luz"]);
  });

  it("does not let an automatic class signup link precede the official public event", async () => {
    eventRows.mockResolvedValueOnce([
      {
        eventId: 24,
        slug: "ar-presencial-out-26-turma-02-sp",
        name: "Ciclo Ar — AR_PRESENCIAL_OUT/26_turma_02_SP",
        description: "Importado da base histórica",
        startDate: "2026-10-01",
        endDate: "2026-10-01",
        location: "RS",
        nucleus: "EDUCATION",
        eventType: "CURSO",
        classId: 75,
        classCode: "AR_PRESENCIAL_OUT/26_turma_02_SP",
        courseId: 15,
        observations: null,
        modality: "Presencial",
        workload: 40,
      },
      {
        eventId: 6,
        slug: "ciclo-ar-out-2026",
        name: "CICLO AR - Retiro de Imersão em Arte Cerimonial",
        description: "Imersão residencial completa.",
        startDate: "2026-10-07",
        endDate: "2026-10-12",
        location: "Campos do Jordão",
        nucleus: "EDUCATION",
        eventType: "CURSO",
        classId: 4,
        classCode: "AR_PRESENCIAL_OUT/26_turma_01_SP",
        courseId: 4,
        observations: "Fonte oficial sincronizada: https://www.soundfulness.online/event-details/ciclo-ar",
        modality: "Presencial",
        workload: 40,
      },
    ]);

    const result = await getOfficialEventCatalog({
      now: new Date("2026-09-19T12:00:00Z"),
    });

    expect(result.items.map(item => item.eventId)).toEqual([6]);
  });

  it("never exposes an event price, as a field or written in free text", async () => {
    eventRows.mockResolvedValueOnce([{
      eventId: 30, slug: "ciclo-agua", name: "Ciclo Água (R$ 4.800)",
      description: "Investimento de R$ 4.800,00 ou 4800 reais em 12x. Vivência com sons.",
      startDate: "2026-09-20", endDate: null, location: "SP — R$ 90 de estacionamento",
      nucleus: "EXPERIENCES", eventType: "CICLO", classId: null, courseId: null,
      modality: "Presencial", workload: null,
    }]);

    const result = await getOfficialEventCatalog({ now: new Date("2026-09-15T12:00:00Z") });
    const item = result.items[0]!;

    expect(item).not.toHaveProperty("price");
    expect(JSON.stringify(item)).not.toMatch(/R\$|4\.800|4800|reais/);
    expect(item.description).toContain("Vivência com sons.");
  });
});
