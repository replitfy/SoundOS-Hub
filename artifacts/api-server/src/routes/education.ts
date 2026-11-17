import { Router, type IRouter } from "express";
import { eq, ilike, or, and, count, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  coursesTable,
  classesTable,
  enrollmentsTable,
  pessoasTable,
  cursosInscricao,
} from "@workspace/db";
import {
  CreateCourseBody,
  UpdateCourseBody,
  UpdateCourseParams,
  DeleteCourseParams,
  CreateClassBody,
  CreateEnrollmentBody,
  UpdateEnrollmentBody,
  UpdateEnrollmentParams,
} from "@workspace/api-zod";
import { requireAuth, requireAdminRole } from "../middlewares/roleAuth";
import { aggregateEventEnrollments } from "../services/eventSummary";
import { registrationLinkUpdateValues } from "../services/officialEventAgenda";

import { isPgFkViolation } from "../lib/pg-errors";

// Nome exibido do aluno. `pessoas` guarda nome e sobrenome separados; o módulo
// Education sempre mostra o nome inteiro.
const nomeCompleto: SQL<string> = sql<string>`btrim(${pessoasTable.nome} || ' ' || coalesce(${pessoasTable.sobrenome}, ''))`;

function slugificar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Aceita tanto a conexão normal quanto uma transação.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Cada turma tem o seu próprio link de inscrição, derivado do código da turma
 * e herdando dela local e datas.
 *
 * O slug é gerado uma única vez, na criação: depois disso ele nunca muda, mesmo
 * que a turma seja renomeada — um link já divulgado não pode deixar de
 * funcionar. Só o conteúdo (nome exibido, local, datas) é ressincronizado.
 *
 * Roda dentro da mesma transação da turma: ou a turma e o link nascem juntos,
 * ou nenhum dos dois. Sem isso, uma falha aqui deixaria uma turma sem link,
 * num estado que só um novo salvamento da turma consertaria.
 */
async function sincronizarLinkDaTurma(
  executor: Executor,
  cls: typeof classesTable.$inferSelect,
  courseName: string,
): Promise<void> {
  const conteudo = {
    nome: `${courseName} — ${cls.code}`,
    local: cls.location,
    dataInicio: cls.startDate,
    dataFim: cls.endDate,
    courseId: cls.courseId,
  };

  const [existente] = await executor
    .select({
      id: cursosInscricao.id,
      observacoes: cursosInscricao.observacoes,
    })
    .from(cursosInscricao)
    .where(eq(cursosInscricao.classId, cls.id))
    .limit(1);

  if (existente) {
    // Once a row is reconciled with the official site, course/class edits must
    // keep only its relational course link in sync. The site owns its public
    // name, location and dates.
    await executor.update(cursosInscricao)
      .set(registrationLinkUpdateValues(existente.observacoes, conteudo))
      .where(eq(cursosInscricao.id, existente.id));
    return;
  }

  const base = slugificar(cls.code) || `turma-${cls.id}`;
  let slug: string | null = null;
  for (let tentativa = 1; tentativa <= 20; tentativa++) {
    const candidato = tentativa === 1 ? base : `${base}-${tentativa}`;
    const [ocupado] = await executor
      .select({ id: cursosInscricao.id })
      .from(cursosInscricao)
      .where(eq(cursosInscricao.slug, candidato))
      .limit(1);
    if (!ocupado) { slug = candidato; break; }
  }
  if (!slug) {
    throw new Error(`Não foi possível gerar um slug livre para a turma ${cls.code}.`);
  }

  // Sem onConflictDoNothing: se houver corrida, o erro estoura e desfaz a
  // transação inteira, em vez de gravar a turma e engolir a falta do link.
  await executor.insert(cursosInscricao).values({ ...conteudo, slug, classId: cls.id });
}

/** Ressincroniza os links de todas as turmas de um curso. */
async function ressincronizarLinksDoCurso(
  executor: Executor,
  courseId: number,
  courseName: string,
): Promise<void> {
  const turmas = await executor.select().from(classesTable).where(eq(classesTable.courseId, courseId));
  for (const turma of turmas) {
    await sincronizarLinkDaTurma(executor, turma, courseName);
  }
}

/** Slug do link de inscrição de cada turma, indexado por classId. */
async function slugsPorTurma(): Promise<Map<number, string>> {
  const links = await db
    .select({ classId: cursosInscricao.classId, slug: cursosInscricao.slug })
    .from(cursosInscricao);
  return new Map(
    links.filter((l): l is { classId: number; slug: string } => l.classId !== null).map(l => [l.classId, l.slug]),
  );
}

// ── Local update schemas ───────────────────────────────────────
const CLASS_STATUSES = ["Planejada", "Aberta", "Em Andamento", "Encerrada"] as const;

const UpdateClassBody = z.object({
  courseId: z.number().int().positive().optional(),
  code: z.string().min(1).optional(),
  location: z.string().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  capacity: z.number().int().positive().optional(),
  teacher: z.string().min(1).optional(),
  status: z.enum(CLASS_STATUSES).optional(),
}).strict().superRefine((value, ctx) => {
  const hasStart = value.startDate !== undefined;
  const hasEnd = value.endDate !== undefined;
  const oneFieldMissing = hasStart !== hasEnd;
  const oneValueNull = hasStart && hasEnd && (value.startDate === null) !== (value.endDate === null);
  if (oneFieldMissing || oneValueNull) {
    ctx.addIssue({
      code: "custom",
      message: "Data inicial e data final devem ser informadas juntas ou ambas devem ficar sem data.",
      path: ["startDate"],
    });
  }
});

const UpdateClassParams = z.object({ id: z.coerce.number().int().positive() });

const DeleteEntityParams = z.object({ id: z.coerce.number().int().positive() });

const router: IRouter = Router();

// ── Event summary ──────────────────────────────────────────────
const EventSummaryQuery = z.object({
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  status: z.enum(["active", "archived", "all"]).default("all"),
  eventType: z.string().trim().min(1).optional(),
  tipoEvento: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional(),
  courseId: z.coerce.number().int().positive().optional(),
  group: z.coerce.number().int().positive().optional(),
  city: z.string().trim().min(1).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  search: z.string().trim().optional(),
  sort: z.enum(["date", "name", "course", "city", "type", "enrollments", "enrolled", "contracted", "paid", "percentPaid", "paidPercent"]).default("date"),
  direction: z.enum(["asc", "desc"]).default("asc"),
}).superRefine((value, ctx) => {
  if (value.eventType && value.tipoEvento && value.eventType !== value.tipoEvento) {
    ctx.addIssue({ code: "custom", message: "eventType and tipoEvento must match", path: ["eventType"] });
  }
});

router.get("/education/event-summary", requireAuth, async (req, res): Promise<void> => {
  const parsed = EventSummaryQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid event summary filters", details: parsed.error.flatten() }); return; }
  const query = parsed.data;
  const type = query.eventType ?? query.tipoEvento ?? query.type;
  const clauses: SQL[] = [];
  if (query.status === "active") clauses.push(eq(cursosInscricao.ativo, true));
  if (query.status === "archived") clauses.push(eq(cursosInscricao.ativo, false));
  if (type) clauses.push(eq(cursosInscricao.tipoEvento, type));
  if (query.courseId ?? query.group) clauses.push(sql`coalesce(${cursosInscricao.courseId}, ${classesTable.courseId}) = ${query.courseId ?? query.group!}`);
  if (query.city) clauses.push(ilike(cursosInscricao.local, `%${query.city}%`));
  if (query.year) clauses.push(sql`extract(year from ${cursosInscricao.dataInicio}) = ${query.year}`);
  if (query.month) clauses.push(sql`extract(month from ${cursosInscricao.dataInicio}) = ${query.month}`);
  if (query.search) {
    const term = `%${query.search}%`;
    clauses.push(or(
      ilike(cursosInscricao.nome, term), ilike(cursosInscricao.local, term),
      ilike(classesTable.code, term), ilike(classesTable.location, term),
    )!);
  }

  // Events and enrollments are fetched in sets. In particular, this intentionally
  // does not join evento_preinscricoes: a pre-registration is not an enrollment.
  const selectEvents = (where?: SQL) => db.select({
    id: cursosInscricao.id, name: cursosInscricao.nome, city: cursosInscricao.local,
    location: sql<string | null>`coalesce(${classesTable.location}, ${cursosInscricao.local})`,
    startDate: cursosInscricao.dataInicio, endDate: cursosInscricao.dataFim,
    active: cursosInscricao.ativo, eventType: cursosInscricao.tipoEvento,
    courseId: sql<number | null>`coalesce(${cursosInscricao.courseId}, ${classesTable.courseId})`,
    classId: cursosInscricao.classId, courseName: coursesTable.name, classCode: classesTable.code,
    capacity: classesTable.capacity,
  }).from(cursosInscricao)
    .leftJoin(classesTable, eq(cursosInscricao.classId, classesTable.id))
    .leftJoin(coursesTable, eq(coursesTable.id, sql`coalesce(${cursosInscricao.courseId}, ${classesTable.courseId})`))
    .where(where);
  const [events, baseEvents, enrollmentRows] = await Promise.all([
    selectEvents(clauses.length ? and(...clauses) : undefined),
    selectEvents(),
    db.select({
      classId: enrollmentsTable.classId, price: enrollmentsTable.price,
      paymentStatus: enrollmentsTable.paymentStatus,
    }).from(enrollmentsTable),
  ]);
  const enrollmentsByClass = new Map<number, { price: string | number | null; paymentStatus: string | null }[]>();
  for (const enrollment of enrollmentRows) {
    const values = enrollmentsByClass.get(enrollment.classId) ?? [];
    values.push(enrollment);
    enrollmentsByClass.set(enrollment.classId, values);
  }
  const rows = events.map(event => {
    const financials = aggregateEventEnrollments(event.classId ? (enrollmentsByClass.get(event.classId) ?? []) : []);
    const enrolled = financials.enrollmentCount;
    const capacity = event.capacity;
    return {
      eventId: event.id, eventName: event.name, eventType: event.eventType, active: event.active,
      startDate: event.startDate, endDate: event.endDate, city: event.city, location: event.location,
      classId: event.classId, classCode: event.classCode, courseId: event.courseId,
      courseName: event.courseName, capacity, enrolled,
      available: capacity === null ? null : Math.max(0, capacity - enrolled),
      contracted: financials.contracted, paid: financials.paid, outstanding: financials.pending,
      paidPercent: financials.percentPaid,
    };
  });
  const numericSort = new Set(["enrolled", "enrollments", "contracted", "paid", "paidPercent", "percentPaid"]);
  rows.sort((a, b) => {
    const field = query.sort;
    const av = field === "date" ? (a.startDate ?? "") : field === "name" ? a.eventName :
      field === "course" ? (a.courseName ?? "") : field === "city" ? (a.city ?? "") :
      field === "type" ? a.eventType : (field === "enrollments" || field === "enrolled") ? a.enrolled :
      field === "contracted" ? a.contracted : field === "paid" ? a.paid : a.paidPercent;
    const bv = field === "date" ? (b.startDate ?? "") : field === "name" ? b.eventName :
      field === "course" ? (b.courseName ?? "") : field === "city" ? (b.city ?? "") :
      field === "type" ? b.eventType : (field === "enrollments" || field === "enrolled") ? b.enrolled :
      field === "contracted" ? b.contracted : field === "paid" ? b.paid : b.paidPercent;
    const result = numericSort.has(field) ? (Number(av ?? -1) - Number(bv ?? -1)) : String(av ?? "").localeCompare(String(bv ?? ""));
    return query.direction === "desc" ? -result : result;
  });
  const totals = rows.reduce((acc, row) => ({
    events: acc.events + 1, enrolled: acc.enrolled + row.enrolled, available: acc.available + (row.available ?? 0),
    contracted: acc.contracted + row.contracted, paid: acc.paid + row.paid, outstanding: acc.outstanding + row.outstanding,
  }), { events: 0, enrolled: 0, available: 0, contracted: 0, paid: 0, outstanding: 0 });
  const paidPercent = totals.contracted === 0 ? null : Number(((totals.paid / totals.contracted) * 100).toFixed(2));
  const options = {
    years: [...new Set(baseEvents.map(e => e.startDate ? Number(e.startDate.slice(0, 4)) : null).filter((v): v is number => v !== null))].sort((a, b) => a - b),
    eventTypes: [...new Set(baseEvents.map(e => e.eventType))].sort(),
    courses: [...new Set(baseEvents.map(e => e.courseName).filter((v): v is string => Boolean(v)))].sort(),
    cities: [...new Set(baseEvents.map(e => e.city).filter((v): v is string => Boolean(v)))].sort(),
  };
  res.json({
    rows,
    totals: {
      ...totals,
      contracted: Number(totals.contracted.toFixed(2)),
      paid: Number(totals.paid.toFixed(2)),
      outstanding: Number(totals.outstanding.toFixed(2)),
      paidPercent,
    },
    filters: options,
  });
});

// ── Education KPIs ────────────────────────────────────────────
router.get("/education/kpis", requireAuth, async (_req, res): Promise<void> => {
  const [activeEnrollments] = await db.select({ count: count() }).from(enrollmentsTable);
  const [pendingContracts] = await db
    .select({ count: count() })
    .from(enrollmentsTable)
    .where(sql`${enrollmentsTable.contractStatus} = 'pending'`);

  const classes = await db.select({ capacity: classesTable.capacity, id: classesTable.id }).from(classesTable);
  const enrollmentsByClass = await db
    .select({ classId: enrollmentsTable.classId, count: count() })
    .from(enrollmentsTable)
    .groupBy(enrollmentsTable.classId);

  let totalOccupancy = 0;
  if (classes.length > 0) {
    for (const cls of classes) {
      const enrolled = enrollmentsByClass.find(e => e.classId === cls.id);
      totalOccupancy += cls.capacity > 0 ? ((enrolled?.count ?? 0) / cls.capacity) * 100 : 0;
    }
    totalOccupancy = totalOccupancy / classes.length;
  }

  res.json({
    activeEnrollments: activeEnrollments.count,
    avgOccupancy: parseFloat(totalOccupancy.toFixed(1)),
    pendingCertificates: 5,
    pendingContracts: pendingContracts.count,
  });
});

// ── Courses ───────────────────────────────────────────────────
router.get("/education/courses", requireAuth, async (_req, res): Promise<void> => {
  const courses = await db.select().from(coursesTable).orderBy(coursesTable.name);
  res.json(courses.map(c => ({
    ...c,
    price: Number(c.price),
  })));
});

router.post("/education/courses", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = CreateCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, cycle, modality, workload, price, description, hotmartRef } = parsed.data;
  const [course] = await db.insert(coursesTable).values({
    name, cycle, modality, workload,
    price: String(price),
    description: description ?? null,
    hotmartRef: hotmartRef ?? null,
  }).returning();
  res.status(201).json({ ...course, price: Number(course.price) });
});

router.patch("/education/courses/:id", requireAdminRole, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateCourseParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateCourseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.cycle !== undefined) updates.cycle = parsed.data.cycle;
  if (parsed.data.modality !== undefined) updates.modality = parsed.data.modality;
  if (parsed.data.workload !== undefined) updates.workload = parsed.data.workload;
  if (parsed.data.price !== undefined) updates.price = String(parsed.data.price);
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.hotmartRef !== undefined) updates.hotmartRef = parsed.data.hotmartRef ?? null;
  if (parsed.data.active !== undefined) updates.active = parsed.data.active;

  const course = await db.transaction(async (tx) => {
    const [atualizado] = await tx.update(coursesTable).set(updates).where(eq(coursesTable.id, params.data.id)).returning();
    if (!atualizado) return null;
    // O nome exibido do link de inscrição inclui o nome do curso — renomear o
    // curso sem ressincronizar deixaria os links das turmas desatualizados.
    if (updates.name !== undefined) {
      await ressincronizarLinksDoCurso(tx, atualizado.id, atualizado.name);
    }
    return atualizado;
  });
  if (!course) { res.status(404).json({ error: "Course not found" }); return; }
  res.json({ ...course, price: Number(course.price) });
});

router.delete("/education/courses/:id", requireAdminRole, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteCourseParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [course] = await db.delete(coursesTable).where(eq(coursesTable.id, params.data.id)).returning();
  if (!course) { res.status(404).json({ error: "Course not found" }); return; }
  res.sendStatus(204);
});

// ── Classes ───────────────────────────────────────────────────
router.get("/education/classes", requireAuth, async (_req, res): Promise<void> => {
  const classes = await db.select().from(classesTable).orderBy(classesTable.startDate);
  const courses = await db.select({ id: coursesTable.id, name: coursesTable.name }).from(coursesTable);
  const enrollmentCounts = await db
    .select({ classId: enrollmentsTable.classId, count: count() })
    .from(enrollmentsTable)
    .groupBy(enrollmentsTable.classId);
  const slugs = await slugsPorTurma();

  const courseColors: Record<string, string> = {
    "Formação": "#5A78A8",
    "Avançado": "#1F344D",
    "Master": "#C9A45D",
    "Retiro": "#5F7F3F",
  };

  res.json(classes.map(cls => {
    const course = courses.find(c => c.id === cls.courseId);
    const enrolled = enrollmentCounts.find(e => e.classId === cls.id);
    const colorKey = Object.keys(courseColors).find(k => course?.name.includes(k));
    return {
      ...cls,
      courseName: course?.name ?? "Desconhecido",
      courseColor: colorKey ? courseColors[colorKey] : "#5777A6",
      enrolled: enrolled?.count ?? 0,
      inscricaoSlug: slugs.get(cls.id) ?? null,
    };
  }));
});

router.post("/education/classes", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = CreateClassBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rawStatus = (req.body as Record<string, unknown>).status;
  const statusResult = z.enum(CLASS_STATUSES).safeParse(rawStatus);

  // A turma e o seu link de inscrição nascem na mesma transação.
  let cls: typeof classesTable.$inferSelect;
  let courseName = "";
  try {
    ({ cls, courseName } = await db.transaction(async (tx) => {
      const [nova] = await tx.insert(classesTable).values({
        courseId: parsed.data.courseId,
        code: parsed.data.code,
        location: parsed.data.location ?? null,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        capacity: parsed.data.capacity,
        teacher: parsed.data.teacher,
        status: statusResult.success ? statusResult.data : "Planejada",
      }).returning();

      const [course] = await tx.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, nova!.courseId));
      const nome = course?.name ?? "";
      await sincronizarLinkDaTurma(tx, nova!, nome);
      return { cls: nova!, courseName: nome };
    }));
  } catch (err) {
    if (isPgFkViolation(err)) { res.status(400).json({ error: "Curso não encontrado." }); return; }
    throw err;
  }

  const slugs = await slugsPorTurma();

  res.status(201).json({
    ...cls,
    courseName,
    courseColor: "#5A78A8",
    enrolled: 0,
    inscricaoSlug: slugs.get(cls.id) ?? null,
  });
});

// ── Alunos ────────────────────────────────────────────────────
// Não existe cadastro de aluno separado: um aluno é uma pessoa do CRM que tem
// ao menos uma matrícula. Por isso esta lista é derivada de `enrollments` — e
// por isso não há POST/PATCH/DELETE aqui: a pessoa vira aluna ao ser
// matriculada, e os dados dela são editados na ficha do CRM (/pessoas/:id),
// que é o único lugar que respeita as regras de evidência.
router.get("/education/students", requireAuth, async (req, res): Promise<void> => {
  const { search } = req.query as { search?: string };

  const rows = await db
    .select({
      id: pessoasTable.id,
      codigo: pessoasTable.codigo,
      nome: nomeCompleto,
      email: pessoasTable.email,
      celular: pessoasTable.celular,
      cpf: pessoasTable.cpf,
      cidade: pessoasTable.cidade,
      comoFicouSabendo: pessoasTable.comoFicouSabendo,
      createdAt: pessoasTable.createdAt,
      classId: classesTable.id,
      classCode: classesTable.code,
      courseName: coursesTable.name,
    })
    .from(enrollmentsTable)
    .innerJoin(pessoasTable, eq(enrollmentsTable.pessoaId, pessoasTable.id))
    .innerJoin(classesTable, eq(enrollmentsTable.classId, classesTable.id))
    .leftJoin(coursesTable, eq(classesTable.courseId, coursesTable.id))
    .where(search ? ilike(nomeCompleto, `%${search}%`) : undefined)
    .orderBy(nomeCompleto);

  // Uma linha por matrícula vira uma linha por aluno, com as turmas agrupadas.
  const porPessoa = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    let aluno = porPessoa.get(r.id);
    if (!aluno) {
      aluno = {
        id: r.id,
        codigo: r.codigo,
        nome: r.nome,
        email: r.email,
        celular: r.celular,
        cpf: r.cpf,
        cidade: r.cidade,
        comoFicouSabendo: r.comoFicouSabendo,
        createdAt: r.createdAt.toISOString(),
        turmas: [] as unknown[],
      };
      porPessoa.set(r.id, aluno);
    }
    (aluno.turmas as unknown[]).push({
      classId: r.classId,
      classCode: r.classCode,
      courseName: r.courseName ?? "",
    });
  }

  res.json([...porPessoa.values()]);
});

// Pessoas do CRM disponíveis para matricular. Diferente de /education/students,
// aqui entram todas as pessoas ativas — inclusive quem ainda não é aluno.
router.get("/education/pessoa-options", requireAuth, async (req, res): Promise<void> => {
  const { search } = req.query as { search?: string };
  const termo = search?.trim();

  const filtro = termo
    ? and(
        eq(pessoasTable.ativo, true),
        or(ilike(nomeCompleto, `%${termo}%`), ilike(pessoasTable.email, `%${termo}%`)),
      )
    : eq(pessoasTable.ativo, true);

  const rows = await db
    .select({
      id: pessoasTable.id,
      codigo: pessoasTable.codigo,
      nome: nomeCompleto,
      email: pessoasTable.email,
    })
    .from(pessoasTable)
    .where(filtro)
    .orderBy(nomeCompleto)
    .limit(100);

  res.json(rows);
});

// ── Enrollments ───────────────────────────────────────────────
router.get("/education/enrollments", requireAuth, async (req, res): Promise<void> => {
  const { classId } = req.query as { classId?: string };

  let query = db
    .select({
      id: enrollmentsTable.id,
      pessoaId: enrollmentsTable.pessoaId,
      classId: enrollmentsTable.classId,
      price: enrollmentsTable.price,
      paymentStatus: enrollmentsTable.paymentStatus,
      contractStatus: enrollmentsTable.contractStatus,
      hotmartAccessStatus: enrollmentsTable.hotmartAccessStatus,
      invoiceStatus: enrollmentsTable.invoiceStatus,
      createdAt: enrollmentsTable.createdAt,
      pessoaNome: nomeCompleto,
      classCode: classesTable.code,
    })
    .from(enrollmentsTable)
    .leftJoin(pessoasTable, eq(enrollmentsTable.pessoaId, pessoasTable.id))
    .leftJoin(classesTable, eq(enrollmentsTable.classId, classesTable.id));

  const rows = classId
    ? await query.where(eq(enrollmentsTable.classId, parseInt(classId, 10)))
    : await query;

  res.json(rows.map(r => ({
    ...r,
    price: Number(r.price),
    pessoaNome: r.pessoaNome ?? "",
    className: r.classCode ?? "",
    createdAt: r.createdAt.toISOString(),
  })));
});

router.post("/education/enrollments", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = CreateEnrollmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  let enrollment;
  try {
    [enrollment] = await db.insert(enrollmentsTable).values({
      pessoaId: parsed.data.pessoaId,
      classId: parsed.data.classId,
      price: String(parsed.data.price),
      paymentStatus: parsed.data.paymentStatus ?? "pending",
      contractStatus: parsed.data.contractStatus ?? "pending",
    }).returning();
  } catch (err) {
    if (isPgFkViolation(err)) {
      res.status(400).json({ error: "Pessoa ou turma não encontrada." }); return;
    }
    throw err;
  }

  const [pessoa] = await db.select({ nome: nomeCompleto }).from(pessoasTable).where(eq(pessoasTable.id, enrollment.pessoaId));
  const [cls] = await db.select({ code: classesTable.code }).from(classesTable).where(eq(classesTable.id, enrollment.classId));

  res.status(201).json({
    ...enrollment,
    price: Number(enrollment.price),
    pessoaNome: pessoa?.nome ?? "",
    className: cls?.code ?? "",
    createdAt: enrollment.createdAt.toISOString(),
  });
});

// Local schema that allows explicit null to clear optional enrollment fields
const UpdateEnrollmentBodyLocal = z.object({
  paymentStatus: z.string().min(1).optional(),
  contractStatus: z.string().min(1).optional(),
  hotmartAccessStatus: z.string().nullable().optional(),
  invoiceStatus: z.string().nullable().optional(),
});

router.patch("/education/enrollments/:id", requireAdminRole, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateEnrollmentParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateEnrollmentBodyLocal.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Record<string, unknown> = {};
  if (parsed.data.paymentStatus !== undefined) updates.paymentStatus = parsed.data.paymentStatus;
  if (parsed.data.contractStatus !== undefined) updates.contractStatus = parsed.data.contractStatus;
  if (parsed.data.hotmartAccessStatus !== undefined) updates.hotmartAccessStatus = parsed.data.hotmartAccessStatus;
  if (parsed.data.invoiceStatus !== undefined) updates.invoiceStatus = parsed.data.invoiceStatus;

  const [enrollment] = await db.update(enrollmentsTable).set(updates).where(eq(enrollmentsTable.id, params.data.id)).returning();
  if (!enrollment) { res.status(404).json({ error: "Enrollment not found" }); return; }

  const [pessoa] = await db.select({ nome: nomeCompleto }).from(pessoasTable).where(eq(pessoasTable.id, enrollment.pessoaId));
  const [cls] = await db.select({ code: classesTable.code }).from(classesTable).where(eq(classesTable.id, enrollment.classId));

  res.json({
    ...enrollment,
    price: Number(enrollment.price),
    pessoaNome: pessoa?.nome ?? "",
    className: cls?.code ?? "",
    createdAt: enrollment.createdAt.toISOString(),
  });
});

router.patch("/education/classes/:id", requireAdminRole, async (req, res): Promise<void> => {
  const params = UpdateClassParams.safeParse({ id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateClassBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Record<string, unknown> = {};
  if (parsed.data.courseId !== undefined) updates.courseId = parsed.data.courseId;
  if (parsed.data.code !== undefined) updates.code = parsed.data.code;
  if (parsed.data.location !== undefined) updates.location = parsed.data.location;
  if (parsed.data.startDate !== undefined) updates.startDate = parsed.data.startDate;
  if (parsed.data.endDate !== undefined) updates.endDate = parsed.data.endDate;
  if (parsed.data.capacity !== undefined) updates.capacity = parsed.data.capacity;
  if (parsed.data.teacher !== undefined) updates.teacher = parsed.data.teacher;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No updates provided" }); return; }

  const atualizada = await db.transaction(async (tx) => {
    const [cls] = await tx.update(classesTable).set(updates).where(eq(classesTable.id, params.data.id)).returning();
    if (!cls) return null;
    const [course] = await tx.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, cls.courseId));
    // Local e datas do link acompanham a turma; o slug divulgado não muda.
    await sincronizarLinkDaTurma(tx, cls, course?.name ?? "");
    return cls;
  });
  if (!atualizada) { res.status(404).json({ error: "Class not found" }); return; }
  const cls = atualizada;

  const enrollmentCounts = await db
    .select({ classId: enrollmentsTable.classId, count: count() })
    .from(enrollmentsTable)
    .groupBy(enrollmentsTable.classId);
  const enrolled = enrollmentCounts.find(e => e.classId === cls.id)?.count ?? 0;
  const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, cls.courseId));
  const courseName = course?.name ?? "";
  const slugs = await slugsPorTurma();

  res.json({
    ...cls,
    courseName,
    courseColor: "#5A78A8",
    enrolled,
    inscricaoSlug: slugs.get(cls.id) ?? null,
  });
});

router.delete("/education/classes/:id", requireAdminRole, async (req, res): Promise<void> => {
  const params = DeleteEntityParams.safeParse({ id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [enrollment] = await db.select({ id: enrollmentsTable.id }).from(enrollmentsTable).where(eq(enrollmentsTable.classId, params.data.id)).limit(1);
  if (enrollment) { res.status(409).json({ error: "Turma possui matrículas — remova-as primeiro." }); return; }

  try {
    // O link da turma é desativado, não apagado: apagá-lo faria a lista de
    // inscritos daquele formulário perder a referência (pessoa_servicos
    // guarda o id do link).
    await db
      .update(cursosInscricao)
      .set({ ativo: false, classId: null })
      .where(eq(cursosInscricao.classId, params.data.id));

    const [cls] = await db.delete(classesTable).where(eq(classesTable.id, params.data.id)).returning();
    if (!cls) { res.status(404).json({ error: "Class not found" }); return; }
    res.sendStatus(204);
  } catch (err) {
    if (isPgFkViolation(err)) { res.status(409).json({ error: "Turma possui matrículas — remova-as primeiro." }); return; }
    throw err;
  }
});

router.delete("/education/enrollments/:id", requireAdminRole, async (req, res): Promise<void> => {
  const params = DeleteEntityParams.safeParse({ id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [enrollment] = await db.delete(enrollmentsTable).where(eq(enrollmentsTable.id, params.data.id)).returning();
  if (!enrollment) { res.status(404).json({ error: "Enrollment not found" }); return; }
  res.sendStatus(204);
});

// ── Calendar ──────────────────────────────────────────────────
router.get("/education/calendar", requireAuth, async (_req, res): Promise<void> => {
  const classes = await db.select().from(classesTable).orderBy(classesTable.startDate);
  const courses = await db.select({ id: coursesTable.id, name: coursesTable.name }).from(coursesTable);

  const colors = ["#5A78A8", "#1F344D", "#C9A45D", "#5F7F3F", "#8A4E2E", "#D94A3A"];

  const events = classes.flatMap((cls, i) => {
    // Turmas históricas sem dia confirmado ficam visíveis em Turmas, mas não
    // podem ocupar uma data inventada no calendário.
    if (!cls.startDate) return [];
    const course = courses.find(c => c.id === cls.courseId);
    return [{
      id: cls.id,
      date: cls.startDate,
      label: course?.name ?? cls.code,
      color: colors[i % colors.length],
      location: cls.location ?? "Online",
      type: "class",
    }];
  });

  // Add some extra events
  events.push(
    { id: 1000, date: "2026-07-15", label: "Webinar: Introdução ao Som", color: "#C9A45D", location: "Zoom", type: "webinar" },
    { id: 1001, date: "2026-07-20", label: "Retiro de Fim de Semana", color: "#5F7F3F", location: "Sítio Harmonia", type: "retreat" },
    { id: 1002, date: "2026-08-01", label: "Aula Inaugural – Turma Agosto", color: "#5A78A8", location: "Studio SP", type: "class" },
  );

  res.json(events);
});

export default router;
