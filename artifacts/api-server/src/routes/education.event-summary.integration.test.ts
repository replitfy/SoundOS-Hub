import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

// Fail closed before importing the pool or the router. Never target a remote DB.
let localDatabase = false;
try {
  const url = new URL(process.env.DATABASE_URL ?? "");
  localDatabase = ["localhost", "127.0.0.1", "[::1]", "helium"].includes(url.hostname)
    && ["/heliumdb", "/postgres"].includes(url.pathname);
} catch { /* Missing/malformed configuration is rejected below without logging it. */ }
if (
  process.env.EDUCATION_SUMMARY_DEV_TEST !== "1" || !localDatabase || !process.env.REPLIT_DEV_DOMAIN
  || process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1"
) {
  throw new Error(
    "Education integration requires the local development PostgreSQL database. "
    + "Run pnpm test:integration:education-summary in the development workspace.",
  );
}

// Do not import app.ts: it performs unrelated migrations/backfills on import.
// This mounts the production router and real auth/DB without mocks or intercepts.
const { default: educationRouter } = await import("./education");
const { default: cursosInscricaoRouter } = await import("./cursos-inscricao");
const { createSessionToken } = await import("../lib/session");
const {
  db, pool, usersTable, pessoasTable, coursesTable, classesTable,
  cursosInscricao, enrollmentsTable, eventoPreinscricoes,
} = await import("@workspace/db");
const app = express().use("/api", educationRouter, cursosInscricaoRouter);
const endpoint = "/api/education/event-summary";
const marker = `education-summary-${randomUUID()}`;

type SummaryRow = {
  eventId: number; eventName: string; eventType: string; active: boolean;
  startDate: string | null; endDate: string | null; city: string | null;
  location: string | null; classId: number | null; classCode: string | null;
  courseId: number | null; courseName: string | null; capacity: number | null;
  enrolled: number; available: number | null; contracted: number; paid: number;
  outstanding: number; paidPercent: number | null;
};
type Summary = {
  rows: SummaryRow[];
  totals: {
    events: number; enrolled: number; available: number; contracted: number;
    paid: number; outstanding: number; paidPercent: number | null;
  };
  filters: { years: number[]; eventTypes: string[]; courses: string[]; cities: string[] };
};
type Fixtures = {
  userId: number; inactiveUserId: number; people: number[]; courses: number[];
  classes: number[]; events: number[]; enrollments: number[]; preinscriptions: number[];
};
let fixtures: Fixtures | undefined;
let authorization: string;
let expected: SummaryRow[];

async function summary(query: Record<string, string | number> = {}): Promise<Summary> {
  const response = await request(app).get(endpoint).set("Authorization", authorization)
    .query({ search: marker, ...query });
  expect(response.status).toBe(200);
  return response.body;
}

beforeAll(async () => {
  // Atomic setup: if any insert fails, the entire fixture set rolls back.
  fixtures = await db.transaction(async tx => {
    const users = await tx.insert(usersTable).values([
      { name: marker, email: `${marker}@example.test`, role: "usuario" },
      { name: marker, email: `${marker}-inactive@example.test`, role: "usuario", active: false },
    ]).returning({ id: usersTable.id });
    const people = await tx.insert(pessoasTable).values(
      Array.from({ length: 7 }, (_, i) => ({ codigo: `${marker}-${i}`, nome: `${marker} Pessoa ${i}` })),
    ).returning({ id: pessoasTable.id });
    const courses = await tx.insert(coursesTable).values(["A", "B"].map(suffix => ({
      name: `${marker} Curso ${suffix}`, cycle: "test", modality: "presencial",
      workload: 1, price: "0",
    }))).returning({ id: coursesTable.id });
    const classes = await tx.insert(classesTable).values([
      { courseId: courses[0].id, code: `${marker}-paga`, location: "Sala integração", capacity: 8, teacher: marker },
      { courseId: courses[1].id, code: `${marker}-zero`, capacity: 0, teacher: marker },
      { courseId: courses[1].id, code: `${marker}-vazia`, capacity: 3, teacher: marker },
      // A paid enrollment in an unrelated class must never leak into event rows.
      { courseId: courses[1].id, code: `${marker}-sem-evento`, capacity: 9, teacher: marker },
    ]).returning({ id: classesTable.id });
    const events = await tx.insert(cursosInscricao).values([
      { slug: `${marker}-avulso`, nome: `${marker} Avulso`, tipoEvento: "OUTRO" },
      // Deliberately omit event.courseId to exercise the class.courseId fallback.
      { slug: `${marker}-pago`, nome: `${marker} Pago`, classId: classes[0].id,
        tipoEvento: "CURSO", local: "Recife", dataInicio: "2198-03-10", dataFim: "2198-03-11" },
      { slug: `${marker}-zero`, nome: `${marker} Zero`, classId: classes[1].id,
        courseId: courses[1].id, tipoEvento: "WORKSHOP", ativo: false,
        local: "Natal", dataInicio: "2199-04-20" },
      { slug: `${marker}-vazio`, nome: `${marker} Vazio`, classId: classes[2].id,
        tipoEvento: "CURSO" },
    ]).returning({ id: cursosInscricao.id });
    const enrollments = await tx.insert(enrollmentsTable).values([
      { pessoaId: people[0].id, classId: classes[0].id, price: "100.10", paymentStatus: "paid" },
      { pessoaId: people[1].id, classId: classes[0].id, price: "50.20", paymentStatus: "pending" },
      { pessoaId: people[2].id, classId: classes[0].id, price: "25.30", paymentStatus: " APROVÁDO " },
      { pessoaId: people[3].id, classId: classes[0].id, price: "999", paymentStatus: "isento" },
      { pessoaId: people[4].id, classId: classes[0].id, price: "0", paymentStatus: "paid" },
      { pessoaId: people[0].id, classId: classes[1].id, price: "40", paymentStatus: "pending" },
      { pessoaId: people[0].id, classId: classes[3].id, price: "900", paymentStatus: "paid" },
    ]).returning({ id: enrollmentsTable.id });
    // Pre-registrations are not enrollments, including an event without a class.
    const preinscriptions = await tx.insert(eventoPreinscricoes).values([
      { eventoId: events[0].id, pessoaId: people[0].id, status: "INTERESSADO" },
      { eventoId: events[1].id, pessoaId: people[0].id, status: "INTERESSADO" },
      // These people have no enrollment: PREINSCRITO is not a matriculado.
      { eventoId: events[1].id, pessoaId: people[5].id, status: "PREINSCRITO" },
      { eventoId: events[1].id, pessoaId: people[6].id, status: "INTERESSADO" },
      { eventoId: events[0].id, pessoaId: people[5].id, status: "PREINSCRITO" },
      // Enrolled elsewhere, but only pre-registered in this empty class.
      { eventoId: events[3].id, pessoaId: people[0].id, status: "PREINSCRITO" },
    ]).returning({ id: eventoPreinscricoes.id });
    return {
      userId: users[0].id, inactiveUserId: users[1].id,
      people: people.map(r => r.id), courses: courses.map(r => r.id),
      classes: classes.map(r => r.id), events: events.map(r => r.id),
      enrollments: enrollments.map(r => r.id), preinscriptions: preinscriptions.map(r => r.id),
    };
  });
  authorization = `Bearer ${createSessionToken(fixtures.userId)}`;
  const empty: SummaryRow = {
    eventId: fixtures.events[0], eventName: `${marker} Avulso`, eventType: "OUTRO", active: true,
    startDate: null, endDate: null, city: null, location: null, classId: null, classCode: null,
    courseId: null, courseName: null, capacity: null, enrolled: 0, available: null,
    contracted: 0, paid: 0, outstanding: 0, paidPercent: null,
  };
  // Literal expectations, independent of the production aggregation helper.
  expected = [
    empty,
    { ...empty, eventId: fixtures.events[1], eventName: `${marker} Pago`, eventType: "CURSO",
      startDate: "2198-03-10", endDate: "2198-03-11", city: "Recife", location: "Sala integração",
      classId: fixtures.classes[0], classCode: `${marker}-paga`, courseId: fixtures.courses[0],
      courseName: `${marker} Curso A`, capacity: 8, enrolled: 5, available: 3,
      contracted: 175.60, paid: 125.40, outstanding: 50.20, paidPercent: 71.41 },
    { ...empty, eventId: fixtures.events[2], eventName: `${marker} Zero`, eventType: "WORKSHOP",
      active: false, startDate: "2199-04-20", city: "Natal", location: "Natal",
      classId: fixtures.classes[1], classCode: `${marker}-zero`, courseId: fixtures.courses[1],
      courseName: `${marker} Curso B`, capacity: 0, enrolled: 1, available: 0,
      contracted: 40, paid: 0, outstanding: 40, paidPercent: 0 },
    { ...empty, eventId: fixtures.events[3], eventName: `${marker} Vazio`, eventType: "CURSO",
      classId: fixtures.classes[2], classCode: `${marker}-vazia`, courseId: fixtures.courses[1],
      courseName: `${marker} Curso B`, capacity: 3, available: 3 },
  ];
});

describe("GET /api/cursos-inscricao/:id/detalhe — real development DB", () => {
  const detailEndpoint = (id: number) => `/api/cursos-inscricao/${id}/detalhe`;
  type Enrollment = {
    enrollmentId: number; pessoaId: number; classId: number;
    price: number; paymentStatus: string; nome: string;
  };
  type Preinscription = { id: number; pessoaId: number; status: string };
  type Detail = {
    event: { id: number; classId: number | null };
    matriculados: Enrollment[]; interessados: Preinscription[]; preinscritos: Preinscription[];
  };

  async function detail(eventIndex: number): Promise<Detail> {
    const response = await request(app).get(detailEndpoint(fixtures!.events[eventIndex]))
      .set("Authorization", authorization);
    expect(response.status).toBe(200);
    expect(response.body.event.id).toBe(fixtures!.events[eventIndex]);
    return response.body;
  }

  function preinscriptionIds(rows: Preinscription[]) {
    return rows.map(({ id, pessoaId, status }) => ({ id, pessoaId, status }))
      .sort((a, b) => a.id - b.id);
  }

  it("returns only the selected class enrollments, including unpaid enrollments", async () => {
    const f = fixtures!;
    // Exact sets catch leaks even when the same person is enrolled in multiple
    // classes. Compare numeric prices and statuses without a financial helper.
    for (const [eventIndex, classIndex, expectedRows] of [
      [1, 0, [
        { enrollmentId: f.enrollments[0], pessoaId: f.people[0], price: 100.10, paymentStatus: "paid" },
        { enrollmentId: f.enrollments[1], pessoaId: f.people[1], price: 50.20, paymentStatus: "pending" },
        { enrollmentId: f.enrollments[2], pessoaId: f.people[2], price: 25.30, paymentStatus: " APROVÁDO " },
        { enrollmentId: f.enrollments[3], pessoaId: f.people[3], price: 999, paymentStatus: "isento" },
        { enrollmentId: f.enrollments[4], pessoaId: f.people[4], price: 0, paymentStatus: "paid" },
      ]],
      [2, 1, [
        { enrollmentId: f.enrollments[5], pessoaId: f.people[0], price: 40, paymentStatus: "pending" },
      ]],
    ] as const) {
      const body = await detail(eventIndex);
      expect(body.event.classId).toBe(f.classes[classIndex]);
      expect(body.matriculados.map(({ enrollmentId, pessoaId, classId, price, paymentStatus }) => ({
        enrollmentId, pessoaId, classId, price, paymentStatus,
      })).sort((a, b) => a.enrollmentId - b.enrollmentId)).toEqual(
        expectedRows.map(row => ({ ...row, classId: f.classes[classIndex] })),
      );
      for (const row of body.matriculados) {
        expect(row.nome).toBe(`${marker} Pessoa ${f.people.indexOf(row.pessoaId)}`);
      }
    }
  });

  it("keeps interested and pre-registered people separate from actual enrollments", async () => {
    const f = fixtures!;
    const body = await detail(1);
    expect(preinscriptionIds(body.interessados)).toEqual([
      { id: f.preinscriptions[1], pessoaId: f.people[0], status: "INTERESSADO" },
      { id: f.preinscriptions[3], pessoaId: f.people[6], status: "INTERESSADO" },
    ]);
    expect(preinscriptionIds(body.preinscritos)).toEqual([
      { id: f.preinscriptions[2], pessoaId: f.people[5], status: "PREINSCRITO" },
    ]);
    expect(body.matriculados.map(row => row.pessoaId).sort((a, b) => a - b))
      .toEqual(f.people.slice(0, 5));
    // Nothing from the other events' pre-registration lists can leak here.
    const otherEvent = await detail(2);
    expect(otherEvent.interessados).toEqual([]);
    expect(otherEvent.preinscritos).toEqual([]);
  });

  it("returns no enrollments for an empty class, even with a pre-registration", async () => {
    const f = fixtures!;
    const body = await detail(3);
    expect(body.event.classId).toBe(f.classes[2]);
    expect(body.matriculados).toEqual([]);
    expect(body.interessados).toEqual([]);
    expect(preinscriptionIds(body.preinscritos)).toEqual([
      { id: f.preinscriptions[5], pessoaId: f.people[0], status: "PREINSCRITO" },
    ]);
  });

  it("returns no enrollments for an event without a class, preserving its own lists", async () => {
    const f = fixtures!;
    const body = await detail(0);
    expect(body.event.classId).toBeNull();
    expect(body.matriculados).toEqual([]);
    expect(preinscriptionIds(body.interessados)).toEqual([
      { id: f.preinscriptions[0], pessoaId: f.people[0], status: "INTERESSADO" },
    ]);
    expect(preinscriptionIds(body.preinscritos)).toEqual([
      { id: f.preinscriptions[4], pessoaId: f.people[5], status: "PREINSCRITO" },
    ]);
  });

  it("requires a real signed session rather than a caller-supplied identity", async () => {
    for (const headers of [
      {}, { "X-User-Id": String(fixtures!.userId) }, { Authorization: "Bearer invalid-token" },
    ]) {
      const response = await request(app).get(detailEndpoint(fixtures!.events[1])).set(headers);
      expect(response.status).toBe(401);
      expect(response.body).not.toHaveProperty("event");
      expect(response.body).not.toHaveProperty("matriculados");
    }
  });
});

afterAll(async () => {
  try {
    if (!fixtures) return;
    const f = fixtures;
    // Exact returned IDs only, dependency-first and atomic; no TRUNCATE,
    // prefix deletes, CASCADE, migrations, or writes to pre-existing records.
    await db.transaction(async tx => {
      await tx.delete(eventoPreinscricoes).where(inArray(eventoPreinscricoes.id, f.preinscriptions));
      await tx.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, f.enrollments));
      await tx.delete(cursosInscricao).where(inArray(cursosInscricao.id, f.events));
      await tx.delete(classesTable).where(inArray(classesTable.id, f.classes));
      await tx.delete(coursesTable).where(inArray(coursesTable.id, f.courses));
      await tx.delete(pessoasTable).where(inArray(pessoasTable.id, f.people));
      await tx.delete(usersTable).where(inArray(usersTable.id, [f.userId, f.inactiveUserId]));
    });
    for (const [table, ids] of [
      [eventoPreinscricoes, f.preinscriptions], [enrollmentsTable, f.enrollments],
      [cursosInscricao, f.events], [classesTable, f.classes], [coursesTable, f.courses],
      [pessoasTable, f.people], [usersTable, [f.userId, f.inactiveUserId]],
    ] as const) {
      expect(await db.select({ id: table.id }).from(table).where(inArray(table.id, [...ids]))).toEqual([]);
    }
  } finally {
    await pool.end();
  }
});

describe("GET /api/education/event-summary — real development DB", () => {
  it("returns exact rows and weighted totals for real records, not pre-registrations", async () => {
    const body = await summary({ sort: "name" });
    expect(body.rows).toEqual([expected[0], expected[1], expected[3], expected[2]]);
    expect(body.totals).toEqual({
      events: 4, enrolled: 6, available: 6, contracted: 215.60,
      paid: 125.40, outstanding: 90.20, paidPercent: 58.16,
    });
  });

  it.each([
    ["active", { status: "active" }, [0, 1, 3]],
    ["archived", { status: "archived" }, [2]],
    ["all", { status: "all" }, [0, 1, 2, 3]],
    ["year", { year: 2198 }, [1]],
    ["month", { month: 4 }, [2]],
    ["city (case-insensitive)", { city: "rECi" }, [1]],
    ["eventType", { eventType: "CURSO" }, [1, 3]],
    ["tipoEvento alias", { tipoEvento: "WORKSHOP" }, [2]],
    ["type alias", { type: "OUTRO" }, [0]],
    ["matching type aliases", { eventType: "CURSO", tipoEvento: "CURSO" }, [1, 3]],
    ["combined filters", { year: 2199, month: 4, city: "Natal", status: "archived", type: "WORKSHOP" }, [2]],
  ] as const)("filters %s and recomputes totals", async (_name, query, indices) => {
    const body = await summary(query);
    const selected = indices.map(i => expected[i]);
    expect(body.rows.sort((a, b) => a.eventId - b.eventId)).toEqual(selected);
    // Sum the literal fixture expectations, never response rows or production helpers.
    const totals = selected.reduce((acc, row) => ({
      events: acc.events + 1, enrolled: acc.enrolled + row.enrolled,
      available: acc.available + (row.available ?? 0), contracted: acc.contracted + row.contracted,
      paid: acc.paid + row.paid, outstanding: acc.outstanding + row.outstanding,
    }), { events: 0, enrolled: 0, available: 0, contracted: 0, paid: 0, outstanding: 0 });
    expect(body.totals).toEqual({
      ...totals, paidPercent: totals.contracted ? Number((totals.paid / totals.contracted * 100).toFixed(2)) : null,
    });
  });

  it("filters courses through both the direct event link and the class fallback", async () => {
    for (const key of ["courseId", "group"]) {
      expect((await summary({ [key]: fixtures!.courses[0] })).rows).toEqual([expected[1]]);
      expect((await summary({ [key]: fixtures!.courses[1], sort: "name" })).rows).toEqual([expected[3], expected[2]]);
    }
  });

  it("searches event name, event city, class code, and class location", async () => {
    for (const [search, index] of [
      [`${marker} Avulso`, 0], [`${marker}-paga`, 1], ["sALA INTEGRAÇÃO", 1], ["nATal", 2],
    ] as const) {
      // Course scoping keeps generic city/location text isolated from existing data.
      const query: Record<string, string | number> = index === 0
        ? { search } : { search, courseId: fixtures!.courses[index === 1 ? 0 : 1] };
      expect((await summary(query)).rows).toEqual([expected[index]]);
    }
  });

  it("returns zero totals and null percent for no results; filter options remain global", async () => {
    const body = await summary({ search: `${marker}-no-match` });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual({
      events: 0, enrolled: 0, available: 0, contracted: 0, paid: 0, outstanding: 0, paidPercent: null,
    });
    expect(body.filters).toEqual((await summary({ status: "archived" })).filters);
    expect(body.filters.years).toEqual(expect.arrayContaining([2198, 2199]));
    expect(body.filters.eventTypes).toEqual(expect.arrayContaining(["CURSO", "OUTRO", "WORKSHOP"]));
    expect(body.filters.courses).toEqual(expect.arrayContaining([`${marker} Curso A`, `${marker} Curso B`]));
    expect(body.filters.cities).toEqual(expect.arrayContaining(["Natal", "Recife"]));
    for (const values of Object.values(body.filters)) {
      expect(values).not.toContain(null);
      expect(values.length).toBe(new Set<string | number>(values).size);
    }
    expect(body.filters.years).toEqual([...body.filters.years].sort((a, b) => a - b));
    for (const key of ["eventTypes", "courses", "cities"] as const) {
      expect(body.filters[key]).toEqual([...body.filters[key]].sort());
    }
  });

  it("sorts numeric values in both directions and accepts the numeric aliases", async () => {
    for (const sort of ["enrollments", "enrolled", "contracted", "paid", "percentPaid", "paidPercent"]) {
      const asc = await summary({ sort, direction: "asc" });
      const desc = await summary({ sort, direction: "desc" });
      expect(asc.rows.at(-1)?.eventId).toBe(fixtures!.events[1]);
      expect(desc.rows[0].eventId).toBe(fixtures!.events[1]);
      expect(asc.totals).toEqual(desc.totals);
    }
  });

  it.each([
    { year: 1899 }, { year: 2201 }, { month: 0 }, { month: 13 }, { courseId: 0 },
    { group: -1 }, { status: "invalid" }, { sort: "invalid" }, { direction: "invalid" },
    { eventType: "CURSO", tipoEvento: "EVENTO" },
  ])("rejects invalid filters: %j", async query => {
    const response = await request(app).get(endpoint).set("Authorization", authorization).query(query);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid event summary filters");
  });

  it("blocks unauthenticated, forged, inactive, and deleted-user requests", async () => {
    const headers = [
      {}, { "X-User-Id": String(fixtures!.userId) }, { Authorization: "Bearer invalid-token" },
      { Authorization: `Bearer ${createSessionToken(fixtures!.inactiveUserId)}` },
    ];
    for (const header of headers) {
      const response = await request(app).get(endpoint).set(header);
      expect(response.status).toBe(401);
      expect(response.body).not.toHaveProperty("rows");
    }
    // Deletion is limited to our inactive fixture and remains safe for teardown.
    const token = createSessionToken(fixtures!.inactiveUserId);
    await db.delete(usersTable).where(eq(usersTable.id, fixtures!.inactiveUserId));
    expect((await request(app).get(endpoint).set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
});