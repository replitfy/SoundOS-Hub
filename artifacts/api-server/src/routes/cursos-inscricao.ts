import { Router, type IRouter } from "express";
import { normalizeBrazilianPhone } from "../services/phone";
import { eq, desc, ilike, sql, and, or, inArray, isNull } from "drizzle-orm";
import { BulkCascadeDeleteTestCursoInscricoesBody, BulkDeleteCursoInscricoesBody } from "@workspace/api-zod";
import { db, cursosInscricao, pessoasTable, pessoaServicos, eventoFormularios, eventoFormularioVersoes, eventoFormularioSubmissoes, eventoPreinscricoes, enrollmentsTable, eventFormalizations, interesseGeralSubmissoes, commercialOpportunities, classesTable, coursesTable } from "@workspace/db";
import { requireAdminRole, requireAuth } from "../middlewares/roleAuth";
import { validateFormFields, withOptionalInstagram, type EventFormField } from "./event-forms.validation";
import { eventEnrolleeCountSql, mergeDistinctEventEnrollees } from "./event-enrollees";
import { EventFlowError } from "../services/eventIdentity";
import { resolverPessoaDoFormularioPublico } from "../services/identidadeConferencia";
import { recordEventSubmission } from "../services/eventInterest";
import {
  consentimentoParaOFormulario,
  lerConsentimentoWhatsapp,
  registrarConsentimentoDoFormulario,
  registrarConsentimentoNoCartaoNovo,
  TEXTO_CONSENTIMENTO_WHATSAPP,
} from "../services/consentimentoFormulario";
import { dispararPrimeiroContato } from "../services/primeiroContatoFormulario";
import { allowSubmission } from "./public-submission-limit";
import { interestGroupLabel, interestOfferLabel } from "../services/interesseGeral";

const router: IRouter = Router();
// This phrase is an accidental-deletion guard only. Admin authentication remains mandatory.
const TEST_CASCADE_CONFIRMATION = "123mudar";
const TEST_DATA_MARKER = /(^|[^a-z0-9])(e2e|test|teste|fixture|qa)(?=$|[^a-z0-9])/i;

function hasTestMarker(...values: Array<string | null | undefined>): boolean {
  return values.some(value => value != null && TEST_DATA_MARKER.test(value));
}

const NUCLEOS_EVENTO = ["EDUCATION", "EXPERIENCES"] as const;
const TIPOS_EVENTO = ["CURSO", "WORKSHOP", "CONCERTO", "VIVENCIA", "RETIRO", "CERIMONIA", "OUTRO"] as const;
const INTERESSE_FIELDS = [
  { key: "nome", label: "Nome", type: "text", required: true },
  { key: "celular", label: "Celular", type: "tel", required: true },
  { key: "instagram", label: "Instagram", type: "text", required: false },
  { key: "email", label: "E-mail", type: "email", required: true },
];
const COMPLETE_SELECT_FIELDS: Record<string, { label: string; options: string[] }> = {
  sexo: { label: "Sexo", options: ["Feminino", "Masculino", "Prefiro não informar"] },
  comoFicouSabendo: { label: "Mídia de acesso", options: ["Facebook", "Whatsapp", "Instagram", "Website", "Youtube", "Google", "Amigo / Indicação", "Outros"] },
  conectadoProposito: { label: "Você se sente conectado(a) ao seu propósito de vida?", options: ["Totalmente conectado", "Em busca de sentido", "Começando a despertar", "Ainda não percebi"] },
  lugarMusicaSom: { label: "Qual é o lugar da música e do som na sua vida?", options: ["Central — música é minha vocação", "Terapêutica — me cura e conecta", "Recreativa — prazer e lazer", "Espiritual — ferramenta de transcendência", "Periférica — não é prioridade"] },
  participouTrabalhoSom: { label: "Já participou de trabalho com som ou terapia com sons?", options: ["Sim", "Não"] },
  outroCurso: { label: "Realizou algum curso de Sound Healing?", options: ["Sim", "Não"] },
  terapeuta: { label: "Você é terapeuta?", options: ["Sim", "Não"] },
  objetivoCurso: { label: "Seu principal objetivo no curso", options: ["Desenvolvimento pessoal", "Formação profissional como terapeuta", "Aprofundar prática espiritual", "Expandir conhecimento musical"] },
};
const COMPLETO_FIELDS = [
  ...INTERESSE_FIELDS.filter(f => f.key !== "instagram"),
  { key: "sobrenome", label: "Sobrenome", type: "text", required: true },
  { key: "profissao", label: "Profissão", type: "text", required: true },
  { key: "sexo", label: COMPLETE_SELECT_FIELDS.sexo.label, type: "select", required: true, options: COMPLETE_SELECT_FIELDS.sexo.options },
  { key: "dataNascimento", label: "Data de nascimento", type: "date", required: true },
  ...[["cpf","CPF"],["enderecoRua","Endereço"],["cidade","Cidade"],["estadoUf","Estado"],["cep","CEP"],["comoFicouSabendo","Como ficou sabendo"],["qualAmigoParceiro","Qual amigo ou parceiro"],["conectadoProposito","Conexão com o propósito"],["lugarMusicaSom","Lugar da música e do som"],["participouTrabalhoSom","Participou de trabalho com som"],["qualTrabalhoSom","Qual trabalho com som"],["buscaEspiritual","Busca espiritual"],["formacaoMusicaTerapia","Formação em música e terapia"],["outroCurso","Outro curso"],["terapeuta","É terapeuta"],["objetivoCurso","Objetivo no curso"],["intencaoPrincipal","Intenção principal"],["cursoExpectativas","Expectativas do curso"],["servicoInteresse","Serviço de interesse"]].map(([key, label]) => {
    const select = COMPLETE_SELECT_FIELDS[key];
    return select
      ? { key, label: select.label, type: "select", required: false, options: select.options }
      : { key, label, type: "text", required: false };
  }),
];
async function ensureEventForms(eventId: number, eventSlug: string) {
  for (const tipo of ["INTERESSE", "COMPLETO"] as const) {
    let [form] = await db.select().from(eventoFormularios).where(and(eq(eventoFormularios.eventoId, eventId), eq(eventoFormularios.tipo, tipo)));
    if (!form) {
      [form] = await db.insert(eventoFormularios).values({ eventoId: eventId, tipo, slug: `${eventSlug}-${tipo.toLowerCase()}` }).onConflictDoNothing().returning();
      if (!form) [form] = await db.select().from(eventoFormularios).where(and(eq(eventoFormularios.eventoId, eventId), eq(eventoFormularios.tipo, tipo)));
    }
    const versions = await db.select().from(eventoFormularioVersoes).where(eq(eventoFormularioVersoes.formularioId, form!.id)).orderBy(desc(eventoFormularioVersoes.numero)).limit(1);
    if (!versions.length) await db.insert(eventoFormularioVersoes).values({ formularioId: form!.id, numero: 1, campos: tipo === "INTERESSE" ? INTERESSE_FIELDS : COMPLETO_FIELDS });
  }
}

function isNucleoEvento(value: unknown): value is typeof NUCLEOS_EVENTO[number] {
  return typeof value === "string" && NUCLEOS_EVENTO.includes(value as typeof NUCLEOS_EVENTO[number]);
}

function isTipoEvento(value: unknown): value is typeof TIPOS_EVENTO[number] {
  return typeof value === "string" && TIPOS_EVENTO.includes(value as typeof TIPOS_EVENTO[number]);
}

function generateSlug(nome: string): string {
  const base = nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${base}-${rand}`;
}

// Helper: select cursosInscricao with inscription count
const selectWithCount = {
  id: cursosInscricao.id,
  slug: cursosInscricao.slug,
  nome: cursosInscricao.nome,
  descricao: cursosInscricao.descricao,
  local: cursosInscricao.local,
  dataInicio: cursosInscricao.dataInicio,
  dataFim: cursosInscricao.dataFim,
  observacoes: cursosInscricao.observacoes,
  ativo: cursosInscricao.ativo,
  nucleo: cursosInscricao.nucleo,
  tipoEvento: cursosInscricao.tipoEvento,
  courseId: cursosInscricao.courseId,
  classId: cursosInscricao.classId,
  createdAt: cursosInscricao.createdAt,
  updatedAt: cursosInscricao.updatedAt,
  inscritosCount: eventEnrolleeCountSql.as("inscritos_count"),
};

// ── GET /cursos-inscricao ──────────────────────────────────────
router.get("/cursos-inscricao", requireAuth, async (req, res): Promise<void> => {
  const { courseId } = req.query as { courseId?: string };
  let rows;
  if (courseId) {
    const cid = parseInt(courseId, 10);
    if (isNaN(cid)) { res.status(400).json({ error: "Invalid courseId" }); return; }
    rows = await db
      .select(selectWithCount)
      .from(cursosInscricao)
      .where(eq(cursosInscricao.courseId, cid))
      .orderBy(sql`${cursosInscricao.dataInicio} asc nulls last`, desc(cursosInscricao.createdAt));
  } else {
    rows = await db
      .select(selectWithCount)
      .from(cursosInscricao)
      .orderBy(sql`${cursosInscricao.dataInicio} asc nulls last`, desc(cursosInscricao.createdAt));
  }
  res.json(rows);
});

// ── GET /cursos-inscricao/:id ──────────────────────────────────
router.get("/cursos-inscricao/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.select(selectWithCount).from(cursosInscricao).where(eq(cursosInscricao.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// ── DELETE /cursos-inscricao/bulk-delete ───────────────────────
router.delete("/cursos-inscricao/bulk-delete", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = BulkDeleteCursoInscricoesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const ids = parsed.data.ids;
  if (ids.some(id => !Number.isInteger(id)) || new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "Os ids devem ser inteiros e não podem se repetir." });
    return;
  }
  const result = await db.transaction(async tx => {
    const events = await tx
      .select({ id: cursosInscricao.id })
      .from(cursosInscricao)
      .where(inArray(cursosInscricao.id, ids))
      .for("update");
    if (events.length !== ids.length) return { kind: "missing" as const };

    const [submission] = await tx
      .select({ eventId: eventoFormularioSubmissoes.eventoId })
      .from(eventoFormularioSubmissoes)
      .where(inArray(eventoFormularioSubmissoes.eventoId, ids))
      .limit(1);
    const [preRegistration] = await tx
      .select({ eventId: eventoPreinscricoes.eventoId })
      .from(eventoPreinscricoes)
      .where(inArray(eventoPreinscricoes.eventoId, ids))
      .limit(1);
    const [formalization] = await tx
      .select({ eventId: eventFormalizations.eventoId })
      .from(eventFormalizations)
      .where(inArray(eventFormalizations.eventoId, ids))
      .limit(1);
    const [serviceHistory] = await tx
      .select({ eventId: pessoaServicos.cursosInscricaoId })
      .from(pessoaServicos)
      .where(inArray(pessoaServicos.cursosInscricaoId, ids))
      .limit(1);
    const [opportunity] = await tx
      .select({ eventId: commercialOpportunities.cursosInscricaoId })
      .from(commercialOpportunities)
      .where(inArray(commercialOpportunities.cursosInscricaoId, ids))
      .limit(1);

    if (submission || preRegistration || formalization || serviceHistory || opportunity) {
      return { kind: "has_history" as const };
    }

    await tx.delete(cursosInscricao).where(inArray(cursosInscricao.id, ids));
    return { kind: "deleted" as const, deletedCount: ids.length };
  });

  if (result.kind === "missing") {
    res.status(404).json({ error: "Um ou mais eventos selecionados não foram encontrados." });
    return;
  }
  if (result.kind === "has_history") {
    res.status(409).json({
      error: "Há respostas, pré-inscrições, formalizações ou histórico ligado a um evento. Arquive-o para preservar esses dados.",
    });
    return;
  }
  res.json({ deletedCount: result.deletedCount });
});

// ── DELETE /cursos-inscricao/bulk-cascade-test-delete ──────────
router.delete("/cursos-inscricao/bulk-cascade-test-delete", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = BulkCascadeDeleteTestCursoInscricoesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ids, confirmation } = parsed.data;
  if (
    confirmation !== TEST_CASCADE_CONFIRMATION
    || ids.some(id => !Number.isInteger(id))
    || new Set(ids).size !== ids.length
  ) {
    res.status(400).json({ error: "Confirmação inválida ou ids repetidos/inválidos." });
    return;
  }

  const result = await db.transaction(async tx => {
    const events = await tx
      .select({
        id: cursosInscricao.id,
        name: cursosInscricao.nome,
        slug: cursosInscricao.slug,
        classId: cursosInscricao.classId,
        courseId: cursosInscricao.courseId,
      })
      .from(cursosInscricao)
      .where(inArray(cursosInscricao.id, ids))
      .for("update");
    if (events.length !== ids.length) return { kind: "missing" as const };
    if (events.some(event => !hasTestMarker(event.name) || !hasTestMarker(event.slug))) {
      return { kind: "not_test" as const };
    }

    const classIds = [...new Set(events.flatMap(event => event.classId === null ? [] : [event.classId]))];
    const classRows = classIds.length
      ? await tx
        .select({ id: classesTable.id, code: classesTable.code, courseId: classesTable.courseId })
        .from(classesTable)
        .where(inArray(classesTable.id, classIds))
        .for("update")
      : [];
    if (classRows.length !== classIds.length) return { kind: "missing_class" as const };
    if (classRows.some(classRow => !hasTestMarker(classRow.code))) {
      return { kind: "not_test" as const };
    }

    const classEventLinks = classIds.length
      ? await tx
        .select({ id: cursosInscricao.id })
        .from(cursosInscricao)
        .where(inArray(cursosInscricao.classId, classIds))
      : [];
    if (classEventLinks.some(event => !ids.includes(event.id))) {
      return { kind: "shared_class" as const };
    }

    const courseIds = [...new Set([
      ...events.flatMap(event => event.courseId === null ? [] : [event.courseId]),
      ...classRows.map(classRow => classRow.courseId),
    ])];
    const courseRows = courseIds.length
      ? await tx
        .select({ id: coursesTable.id, name: coursesTable.name })
        .from(coursesTable)
        .where(inArray(coursesTable.id, courseIds))
        .for("update")
      : [];
    const allClassesForCourses = courseIds.length
      ? await tx
        .select({ id: classesTable.id, courseId: classesTable.courseId })
        .from(classesTable)
        .where(inArray(classesTable.courseId, courseIds))
      : [];
    const courseClassIds = allClassesForCourses.map(classRow => classRow.id);
    const relatedEventConditions = [];
    if (courseIds.length) relatedEventConditions.push(inArray(cursosInscricao.courseId, courseIds));
    if (courseClassIds.length) relatedEventConditions.push(inArray(cursosInscricao.classId, courseClassIds));
    const allEventsForCourses = relatedEventConditions.length
      ? await tx
        .select({ id: cursosInscricao.id, courseId: cursosInscricao.courseId, classId: cursosInscricao.classId })
        .from(cursosInscricao)
        .where(or(...relatedEventConditions))
      : [];

    const [crmOpportunity] = await tx
      .select({ id: commercialOpportunities.id })
      .from(commercialOpportunities)
      .where(inArray(commercialOpportunities.cursosInscricaoId, ids))
      .limit(1);
    if (crmOpportunity) return { kind: "crm_history" as const };

    const enrollments = classIds.length
      ? await tx
        .select({ id: enrollmentsTable.id, pessoaId: enrollmentsTable.pessoaId })
        .from(enrollmentsTable)
        .where(inArray(enrollmentsTable.classId, classIds))
      : [];

    const coursesToDelete = courseRows
      .filter(course => hasTestMarker(course.name))
      .filter(course => allClassesForCourses
        .filter(classRow => classRow.courseId === course.id)
        .every(classRow => classIds.includes(classRow.id)))
      .filter(course => allEventsForCourses
        .filter(event => event.courseId === course.id || classIds.includes(event.classId ?? -1))
        .every(event => ids.includes(event.id)))
      .map(course => course.id);

    const formalizationConditions = [];
    if (ids.length) formalizationConditions.push(inArray(eventFormalizations.eventoId, ids));
    if (classIds.length) formalizationConditions.push(inArray(eventFormalizations.classId, classIds));
    if (formalizationConditions.length) {
      await tx.delete(eventFormalizations).where(or(...formalizationConditions));
    }

    const serviceConditions = [
      inArray(pessoaServicos.cursosInscricaoId, ids),
      and(
        isNull(pessoaServicos.cursosInscricaoId),
        inArray(pessoaServicos.servicoNome, events.map(event => event.name)),
        eq(pessoaServicos.obs, "Inscrição via formulário público"),
      ),
    ];
    await tx.delete(pessoaServicos).where(or(...serviceConditions));

    if (classIds.length) {
      await tx.delete(enrollmentsTable).where(inArray(enrollmentsTable.classId, classIds));
    }
    await tx.delete(cursosInscricao).where(inArray(cursosInscricao.id, ids));
    if (classIds.length) {
      await tx.delete(classesTable).where(inArray(classesTable.id, classIds));
    }
    if (coursesToDelete.length) {
      await tx.delete(coursesTable).where(inArray(coursesTable.id, coursesToDelete));
    }

    return {
      kind: "deleted" as const,
      deletedEventCount: events.length,
      deletedClassCount: classRows.length,
      deletedCourseCount: coursesToDelete.length,
      deletedEnrollmentCount: enrollments.length,
    };
  });

  if (result.kind === "missing") {
    res.status(404).json({ error: "Um ou mais eventos selecionados não foram encontrados." });
    return;
  }
  if (result.kind === "missing_class") {
    res.status(409).json({ error: "Uma turma vinculada não foi encontrada; nenhum registro foi apagado." });
    return;
  }
  if (result.kind === "not_test") {
    res.status(409).json({ error: "A cascata aceita apenas eventos e turmas marcados como teste." });
    return;
  }
  if (result.kind === "shared_class") {
    res.status(409).json({ error: "A turma está vinculada a outro evento não selecionado; nenhum registro foi apagado." });
    return;
  }
  if (result.kind === "crm_history") {
    res.status(409).json({ error: "Há oportunidades no CRM vinculadas a um evento; nenhum registro foi apagado." });
    return;
  }
  res.json({
    deletedEventCount: result.deletedEventCount,
    deletedClassCount: result.deletedClassCount,
    deletedCourseCount: result.deletedCourseCount,
    deletedEnrollmentCount: result.deletedEnrollmentCount,
  });
});

// ── GET /cursos-inscricao/:id/inscritos ────────────────────────
router.get("/cursos-inscricao/:id/inscritos", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [ci] = await db
    .select({ nome: cursosInscricao.nome, classId: cursosInscricao.classId })
    .from(cursosInscricao)
    .where(eq(cursosInscricao.id, id));
  if (!ci) { res.status(404).json({ error: "Not found" }); return; }

  const [publicFormRows, enrollmentRows] = await Promise.all([
    db
    .select({
      pessoaId: pessoaServicos.pessoaId,
      nome: pessoasTable.nome,
      sobrenome: pessoasTable.sobrenome,
      email: pessoasTable.email,
      celular: pessoasTable.celular,
      inscritoEm: pessoaServicos.createdAt,
    })
    .from(pessoaServicos)
    .innerJoin(pessoasTable, eq(pessoaServicos.pessoaId, pessoasTable.id))
    .where(
      sql`(
        ${pessoaServicos.cursosInscricaoId} = ${id}
        OR (${pessoaServicos.cursosInscricaoId} IS NULL AND ${pessoaServicos.servicoNome} = ${ci.nome})
      )
        AND ${pessoaServicos.obs} = 'Inscrição via formulário público'`
    )
    .orderBy(desc(pessoaServicos.createdAt)),
    ci.classId === null
      ? Promise.resolve([])
      : db
        .select({
          pessoaId: enrollmentsTable.pessoaId,
          nome: pessoasTable.nome,
          sobrenome: pessoasTable.sobrenome,
          email: pessoasTable.email,
          celular: pessoasTable.celular,
          inscritoEm: enrollmentsTable.createdAt,
        })
        .from(enrollmentsTable)
        .innerJoin(pessoasTable, eq(enrollmentsTable.pessoaId, pessoasTable.id))
        .where(eq(enrollmentsTable.classId, ci.classId)),
  ]);
  const inscritos = mergeDistinctEventEnrollees(publicFormRows, enrollmentRows);

  res.json({ count: inscritos.length, inscritos });
});

// ── POST /cursos-inscricao ─────────────────────────────────────
router.post("/cursos-inscricao", requireAdminRole, async (req, res): Promise<void> => {
  const { nome, descricao, local, dataInicio, dataFim, observacoes, ativo, nucleo = "EDUCATION", tipoEvento = "CURSO", courseId } = req.body as {
    nome: string; descricao?: string; local?: string;
    dataInicio?: string; dataFim?: string; observacoes?: string; ativo?: boolean;
    nucleo?: string; tipoEvento?: string; courseId?: number;
  };
  if (!nome?.trim()) { res.status(400).json({ error: "nome is required" }); return; }
  if (!isNucleoEvento(nucleo)) { res.status(400).json({ error: "nucleo is invalid" }); return; }
  if (!isTipoEvento(tipoEvento)) { res.status(400).json({ error: "tipoEvento is invalid" }); return; }
  const slug = generateSlug(nome.trim());
  const [row] = await db.insert(cursosInscricao).values({
    slug,
    nome: nome.trim(),
    descricao: descricao || null,
    local: local || null,
    dataInicio: dataInicio || null,
    dataFim: dataFim || null,
    observacoes: observacoes || null,
    ativo: ativo !== false,
    nucleo,
    tipoEvento,
    courseId: courseId ?? null,
  }).returning();
  await ensureEventForms(row.id, row.slug);
  res.status(201).json(row);
});

// ── PATCH /cursos-inscricao/:id ────────────────────────────────
router.patch("/cursos-inscricao/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [existing] = await db
    .select({ classId: cursosInscricao.classId })
    .from(cursosInscricao)
    .where(eq(cursosInscricao.id, id))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const { nome, descricao, local, dataInicio, dataFim, observacoes, ativo, nucleo, tipoEvento, courseId } = req.body as {
    nome?: string; descricao?: string; local?: string;
    dataInicio?: string; dataFim?: string; observacoes?: string; ativo?: boolean;
    nucleo?: string; tipoEvento?: string; courseId?: number | null;
  };
  if (nucleo !== undefined && !isNucleoEvento(nucleo)) { res.status(400).json({ error: "nucleo is invalid" }); return; }
  if (tipoEvento !== undefined && !isTipoEvento(tipoEvento)) { res.status(400).json({ error: "tipoEvento is invalid" }); return; }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (nome !== undefined) update.nome = nome.trim();
  if (descricao !== undefined) update.descricao = descricao || null;
  if (local !== undefined) update.local = local || null;
  if (dataInicio !== undefined) update.dataInicio = dataInicio || null;
  if (dataFim !== undefined) update.dataFim = dataFim || null;
  if (observacoes !== undefined) update.observacoes = observacoes || null;
  if (ativo !== undefined) update.ativo = ativo;
  if (nucleo !== undefined) update.nucleo = nucleo;
  if (tipoEvento !== undefined) update.tipoEvento = tipoEvento;
  if (courseId !== undefined) update.courseId = courseId;
  const [row] = await db.update(cursosInscricao).set(update).where(eq(cursosInscricao.id, id)).returning();
  res.json(row);
});

// ── DELETE /cursos-inscricao/:id (soft delete) ─────────────────
router.delete("/cursos-inscricao/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Link que pertence a uma turma é gerido pela turma. Desativá-lo por aqui
  // deixaria a turma anunciando um formulário que não aceita mais ninguém,
  // sem nada na tela de Turmas indicando isso.
  const [alvo] = await db
    .select({ classId: cursosInscricao.classId })
    .from(cursosInscricao)
    .where(eq(cursosInscricao.id, id))
    .limit(1);
  if (!alvo) { res.status(404).json({ error: "Not found" }); return; }
  if (alvo.classId !== null) {
    res.status(409).json({ error: "Este link pertence a uma turma. Desative ou exclua a turma em Education › Turmas." });
    return;
  }

  const [row] = await db.update(cursosInscricao).set({ ativo: false, updatedAt: new Date() }).where(eq(cursosInscricao.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// ── Configurable event forms ───────────────────────────────────
router.get("/cursos-inscricao/:id/formularios", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [event] = await db.select({ slug: cursosInscricao.slug }).from(cursosInscricao).where(eq(cursosInscricao.id, id));
  if (!event) { res.status(404).json({ error: "Evento não encontrado" }); return; }
  await ensureEventForms(id, event.slug);
  const forms = await db.select().from(eventoFormularios).where(eq(eventoFormularios.eventoId, id));
  const result = await Promise.all(forms.map(async f => ({
    ...f,
    versoes: (await db.select().from(eventoFormularioVersoes).where(eq(eventoFormularioVersoes.formularioId, f.id)).orderBy(desc(eventoFormularioVersoes.numero)))
      .map(versao => ({ ...versao, campos: withOptionalInstagram(f.tipo, versao.campos) })),
  })));
  res.json(result);
});

router.patch("/cursos-inscricao/:id/formularios/:tipo", requireAdminRole, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const tipo = String(req.params.tipo).toUpperCase();
  if (!["INTERESSE", "COMPLETO"].includes(tipo)) { res.status(400).json({ error: "tipo inválido" }); return; }
  const validation = validateFormFields(tipo, req.body?.campos);
  if (!validation.ok) { res.status(400).json({ error: validation.error }); return; }
  const [event] = await db.select({ slug: cursosInscricao.slug }).from(cursosInscricao).where(eq(cursosInscricao.id, id));
  if (!event) { res.status(404).json({ error: "Evento não encontrado" }); return; }
  await ensureEventForms(id, event.slug);
  const [form] = await db.select().from(eventoFormularios).where(and(eq(eventoFormularios.eventoId, id), eq(eventoFormularios.tipo, tipo)));
  const version = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(233, ${form!.id})`);
    const [last] = await tx.select({ numero: eventoFormularioVersoes.numero }).from(eventoFormularioVersoes).where(eq(eventoFormularioVersoes.formularioId, form!.id)).orderBy(desc(eventoFormularioVersoes.numero)).limit(1);
    const [created] = await tx.insert(eventoFormularioVersoes).values({ formularioId: form!.id, numero: (last?.numero ?? 0) + 1, campos: validation.fields }).returning();
    if (req.body.ativo !== undefined) await tx.update(eventoFormularios).set({ ativo: Boolean(req.body.ativo), updatedAt: new Date() }).where(eq(eventoFormularios.id, form!.id));
    return created;
  });
  res.json({ ...form, ativo: req.body.ativo === undefined ? form!.ativo : Boolean(req.body.ativo), versao: version });
});

router.get("/cursos-inscricao/:id/detalhe", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [event] = await db.select().from(cursosInscricao).where(eq(cursosInscricao.id, id));
  if (!event) { res.status(404).json({ error: "Evento não encontrado" }); return; }
  const interessadosBase = await db.select({ id: eventoPreinscricoes.id, pessoaId: eventoPreinscricoes.pessoaId, status: eventoPreinscricoes.status, nome: pessoasTable.nome, sobrenome: pessoasTable.sobrenome, email: pessoasTable.email, celular: pessoasTable.celular, createdAt: eventoPreinscricoes.createdAt }).from(eventoPreinscricoes).innerJoin(pessoasTable, eq(eventoPreinscricoes.pessoaId, pessoasTable.id)).where(eq(eventoPreinscricoes.eventoId, id));
  const interessados = await Promise.all(interessadosBase.map(async row => {
    const [latest] = await db.select({ tipo: eventoFormularios.tipo, respostas: eventoFormularioSubmissoes.respostas, submittedAt: eventoFormularioSubmissoes.createdAt }).from(eventoFormularioSubmissoes).innerJoin(eventoFormularios, eq(eventoFormularioSubmissoes.formularioId, eventoFormularios.id)).where(and(eq(eventoFormularioSubmissoes.eventoId, id), eq(eventoFormularioSubmissoes.pessoaId, row.pessoaId))).orderBy(desc(eventoFormularioSubmissoes.createdAt)).limit(1);
    const [formalizacao] = await db.select({
      id: eventFormalizations.id, amount: eventFormalizations.amount, reference: eventFormalizations.reference,
      confirmedAt: eventFormalizations.confirmedAt, confirmedBy: eventFormalizations.confirmedBy,
      expiresAt: eventFormalizations.expiresAt, completedAt: eventFormalizations.completedAt, revokedAt: eventFormalizations.revokedAt,
    }).from(eventFormalizations).where(and(eq(eventFormalizations.eventoId, id), eq(eventFormalizations.pessoaId, row.pessoaId)));
    return { ...row, latestFormType: latest?.tipo ?? null, latestAnswers: latest?.respostas ?? {}, latestSubmittedAt: latest?.submittedAt ?? null, formalizacao: formalizacao ?? null };
  }));
  const matriculadosRows = event.classId === null ? [] : await db.select({ enrollmentId: enrollmentsTable.id, pessoaId: enrollmentsTable.pessoaId, classId: enrollmentsTable.classId, price: enrollmentsTable.price, paymentStatus: enrollmentsTable.paymentStatus, contractStatus: enrollmentsTable.contractStatus, enrolledAt: enrollmentsTable.createdAt, nome: pessoasTable.nome, sobrenome: pessoasTable.sobrenome, email: pessoasTable.email, celular: pessoasTable.celular }).from(enrollmentsTable).innerJoin(pessoasTable, eq(enrollmentsTable.pessoaId, pessoasTable.id)).where(eq(enrollmentsTable.classId, event.classId));
  const matriculados = matriculadosRows.map(r => ({ ...r, price: Number(r.price) }));
  res.json({ event, interessados: interessados.filter(x => x.status === "INTERESSADO"), preinscritos: interessados.filter(x => x.status === "PREINSCRITO"), matriculados });
});

router.get("/pessoas/:pessoaId/formularios-evento", requireAuth, async (req, res): Promise<void> => {
  const pessoaId = Number(req.params.pessoaId);
  if (!Number.isInteger(pessoaId)) { res.status(400).json({ error: "Invalid pessoaId" }); return; }
  const rows = await db.select({ eventoId: eventoFormularioSubmissoes.eventoId, eventoNome: cursosInscricao.nome, formType: eventoFormularios.tipo, version: eventoFormularioVersoes.numero, answers: eventoFormularioSubmissoes.respostas, submittedAt: eventoFormularioSubmissoes.createdAt })
    .from(eventoFormularioSubmissoes).innerJoin(cursosInscricao, eq(eventoFormularioSubmissoes.eventoId, cursosInscricao.id))
    .innerJoin(eventoFormularios, eq(eventoFormularioSubmissoes.formularioId, eventoFormularios.id))
    .innerJoin(eventoFormularioVersoes, eq(eventoFormularioSubmissoes.versaoId, eventoFormularioVersoes.id))
    .where(eq(eventoFormularioSubmissoes.pessoaId, pessoaId)).orderBy(desc(eventoFormularioSubmissoes.createdAt));
  // Envios do formulário de interesse genérico (Wix) não têm evento; entram na mesma lista
  // com o grupo e a página de origem.
  const generalRows = await db.select().from(interesseGeralSubmissoes)
    .where(eq(interesseGeralSubmissoes.pessoaId, pessoaId)).orderBy(desc(interesseGeralSubmissoes.createdAt));
  const general = generalRows.map(row => ({
    eventoId: null,
    eventoNome: interestOfferLabel(row.grupo),
    formType: "INTERESSE_GERAL" as const,
    version: null,
    answers: row.respostas,
    submittedAt: row.createdAt,
    grupo: row.grupo,
    grupoLabel: interestGroupLabel(row.grupo),
    paginaOrigem: row.paginaOrigem,
  }));
  res.json([...rows, ...general].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()));
});

// ─────────────────────────────────────────────────────────────────
// PUBLIC routes — no auth required
// ─────────────────────────────────────────────────────────────────

async function getPublicForm(slug: string) {
  const [form] = await db.select({ form: eventoFormularios, event: cursosInscricao })
    .from(eventoFormularios).innerJoin(cursosInscricao, eq(eventoFormularios.eventoId, cursosInscricao.id))
    .where(and(eq(eventoFormularios.slug, slug), eq(eventoFormularios.ativo, true), eq(cursosInscricao.ativo, true)));
  if (!form) return null;
  const [latest] = await db.select().from(eventoFormularioVersoes).where(eq(eventoFormularioVersoes.formularioId, form.form.id)).orderBy(desc(eventoFormularioVersoes.numero)).limit(1);
  const version = latest && { ...latest, campos: withOptionalInstagram(form.form.tipo, latest.campos) };
  return { ...form, version };
}

router.get("/public/formularios/:slug", async (req, res): Promise<void> => {
  const found = await getPublicForm(req.params.slug as string);
  if (!found) { res.status(404).json({ error: "Formulário não encontrado" }); return; }
  res.json({ ...found.form, evento: found.event, versao: found.version, ...(found.form.tipo === "INTERESSE" ? { consentimento: consentimentoParaOFormulario() } : {}) });
});
router.get("/public/cursos-inscricao/:slug/formulario-completo", async (req, res): Promise<void> => {
  const [event] = await db
    .select({ id: cursosInscricao.id, slug: cursosInscricao.slug })
    .from(cursosInscricao)
    .where(and(
      eq(cursosInscricao.slug, req.params.slug as string),
      eq(cursosInscricao.ativo, true),
    ));
  if (!event) { res.status(404).json({ error: "Evento não encontrado" }); return; }
  await ensureEventForms(event.id, event.slug);
  const [form] = await db.select({ slug: eventoFormularios.slug })
    .from(eventoFormularios)
    .innerJoin(cursosInscricao, eq(eventoFormularios.eventoId, cursosInscricao.id))
    .where(and(
      eq(cursosInscricao.slug, req.params.slug as string),
      eq(cursosInscricao.ativo, true),
      eq(eventoFormularios.tipo, "COMPLETO"),
      eq(eventoFormularios.ativo, true),
    ));
  if (!form) { res.status(404).json({ error: "Formulário completo não encontrado" }); return; }
  const found = await getPublicForm(form.slug);
  if (!found) { res.status(404).json({ error: "Formulário completo não encontrado" }); return; }
  res.json({ ...found.form, evento: found.event, versao: found.version });
});
router.get("/public/cursos-inscricao/formularios/:slug", async (req, res): Promise<void> => {
  const found = await getPublicForm(req.params.slug as string);
  if (!found) { res.status(404).json({ error: "Formulário não encontrado" }); return; }
  res.json({ ...found.form, evento: found.event, versao: found.version, ...(found.form.tipo === "INTERESSE" ? { consentimento: consentimentoParaOFormulario() } : {}) });
});

router.post("/public/formularios/:slug/submissoes", async (req, res): Promise<void> => {
  if (!allowSubmission(req.ip || "unknown", String(req.params.slug))) { res.status(429).json({ error: "Muitas submissões. Tente novamente em alguns instantes." }); return; }
  const found = await getPublicForm(req.params.slug as string);
  if (!found || !found.version) { res.status(404).json({ error: "Formulário não encontrado" }); return; }
  if (found.form.tipo !== "INTERESSE") {
    res.status(403).json({ code: "PAYMENT_AUTHORIZATION_REQUIRED", error: "A formalização exige o link individual liberado pela equipe após a confirmação do pagamento." }); return;
  }
  const respostas = req.body?.respostas ?? req.body;
  if (!respostas || typeof respostas !== "object" || Array.isArray(respostas)) {
    res.status(400).json({ error: "Respostas inválidas." });
    return;
  }
  const fields = (found.version.campos as EventFormField[]).filter(field => field.active !== false);
  const allowedKeys = new Set(fields.map(field => field.key));
  const unknownKey = Object.keys(respostas).find(key => !allowedKeys.has(key));
  if (unknownKey) { res.status(400).json({ error: `Campo não permitido: ${unknownKey}` }); return; }
  for (const field of fields) {
    const value = respostas[field.key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      res.status(400).json({ error: `${field.key} deve ser texto` }); return;
    }
    if (field.required && (value === undefined || value === null || String(value).trim() === "")) {
      res.status(400).json({ error: `${field.key} é obrigatório` }); return;
    }
    if (typeof value === "string" && value.length > (field.type === "textarea" ? 10_000 : 1_000)) {
      res.status(400).json({ error: `${field.key} excede o tamanho permitido` }); return;
    }
    if (field.type === "select" && value != null && field.options?.length && !field.options.includes(String(value))) {
      res.status(400).json({ error: `${field.key} é inválido` }); return;
    }
    if (field.type === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      res.status(400).json({ error: `${field.label} deve ser um e-mail válido` }); return;
    }
    if (field.type === "tel" && value && value.replace(/\D/g, "").length < 10) {
      res.status(400).json({ error: `${field.label} deve ter DDD e telefone` }); return;
    }
    if (field.type === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      res.status(400).json({ error: `${field.label} deve ser uma data válida` }); return;
    }
  }
  const email = String(respostas.email ?? "").trim().toLowerCase();
  // Mesma chave que o trigger grava em celular_normalizado (sem o 55).
  const phone = normalizeBrazilianPhone(String(respostas.celular ?? "")).key ?? "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Informe um e-mail válido." });
    return;
  }
  if (phone && phone.length < 10) {
    res.status(400).json({ error: "Informe um celular válido com DDD." });
    return;
  }
  // O consentimento vem fora de `respostas` e só no corpo novo (`{ respostas, consentimentoWhatsapp }`); o corpo
  // antigo, com as respostas soltas, nunca consente. Só `true` conta.
  const consentiu = Boolean(req.body?.respostas) && lerConsentimentoWhatsapp(req.body?.consentimentoWhatsapp);
  try {
    const result = await db.transaction(async tx => {
      // Conflito de identidade nunca chega ao cliente: a equipe recebe o caso na ficha e no cartão.
      const { personId: pessoaId, conferencia } = await resolverPessoaDoFormularioPublico(tx, respostas, `formulário de interesse do evento "${found.event.nome}"`);
      // A autorização entra antes do cartão: a trava de contato sempre vem antes das travas de cartão.
      const registroId = await registrarConsentimentoDoFormulario(tx, { pessoaId, consentiu, conferencia: Boolean(conferencia) });
      const records = await recordEventSubmission(tx, {
        event: found.event, personId: pessoaId, formId: found.form.id, versionId: found.version!.id, answers: respostas, conferencia,
        consentimento: { aceito: consentiu, texto: TEXTO_CONSENTIMENTO_WHATSAPP },
      });
      if (records.created) await registrarConsentimentoNoCartaoNovo(tx, records.opportunity.id, registroId);
      return { pessoaId, conferencia: Boolean(conferencia), ...records };
    });
    res.status(201).json({ success: true, pessoaId: result.pessoaId, submissaoId: result.submission.id, preinscricaoId: result.pre.id, opportunityId: result.opportunity.id });
    // Depois da resposta e do commit: o primeiro contato nunca atrasa nem derruba a inscrição de interesse.
    dispararPrimeiroContato({
      pessoaId: result.pessoaId, opportunityId: result.opportunity.id, consentiu,
      conferencia: result.conferencia, cartaoNovo: result.created,
    });
  } catch (error) {
    if (error instanceof EventFlowError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
});

router.post("/cursos-inscricao/:id/preinscricoes/:preId/confirmar", requireAdminRole, async (req, res): Promise<void> => {
  const eventId = Number(req.params.id), preId = Number(req.params.preId);
  const [pre] = await db.select().from(eventoPreinscricoes).where(and(eq(eventoPreinscricoes.id, preId), eq(eventoPreinscricoes.eventoId, eventId)));
  const [event] = await db.select({ classId: cursosInscricao.classId }).from(cursosInscricao).where(eq(cursosInscricao.id, eventId));
  if (!pre || !event) { res.status(404).json({ error: "Pré-inscrição não encontrada" }); return; }
  if (event.classId === null) { res.status(409).json({ error: "Este evento não está vinculado a uma turma." }); return; }
  if (pre.status !== "PREINSCRITO") { res.status(409).json({ error: "Somente uma pré-inscrição completa pode ser confirmada." }); return; }
  const price = Number(req.body?.price);
  const paymentStatus = String(req.body?.paymentStatus ?? "pending").toLowerCase();
  const contractStatus = String(req.body?.contractStatus ?? "pending").toLowerCase();
  if (!Number.isFinite(price) || price < 0) { res.status(400).json({ error: "Informe um preço válido." }); return; }
  if (!["pending", "paid", "installments"].includes(paymentStatus)) { res.status(400).json({ error: "Status de pagamento inválido." }); return; }
  if (!["pending", "signed"].includes(contractStatus)) { res.status(400).json({ error: "Status de contrato inválido." }); return; }
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${event.classId!}, ${pre.pessoaId})`);
    const [duplicate] = await tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable).where(and(eq(enrollmentsTable.pessoaId, pre.pessoaId), eq(enrollmentsTable.classId, event.classId!))).limit(1);
    if (duplicate) return { duplicate };
    const [created] = await tx.insert(enrollmentsTable).values({ pessoaId: pre.pessoaId, classId: event.classId!, price: String(price), paymentStatus, contractStatus }).returning();
    await tx.update(eventoPreinscricoes).set({ status: "MATRICULADO", updatedAt: new Date() }).where(eq(eventoPreinscricoes.id, pre.id));
    return { created };
  });
  if (result.duplicate) { res.status(409).json({ error: "Pessoa já está matriculada nesta turma.", enrollmentId: result.duplicate.id }); return; }
  res.status(201).json(result.created);
});

// ── GET /public/cursos-inscricao/:slug ─────────────────────────
router.get("/public/cursos-inscricao/:slug", async (req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(cursosInscricao)
    .where(eq(cursosInscricao.slug, req.params.slug as string));
  if (!row || !row.ativo) { res.status(404).json({ error: "Evento não encontrado" }); return; }
  await ensureEventForms(row.id, row.slug);
  res.json(row);
});

// ── GET /public/pessoas/lookup?email= ─────────────────────────
router.get("/public/pessoas/lookup", async (req, res): Promise<void> => {
  // Public identifiers are not authentication; no CPF/address disclosure.
  res.setHeader("Cache-Control", "no-store");
  res.json({ found: false });
});

// ── POST /public/inscricao ─────────────────────────────────────
router.post("/public/inscricao", async (req, res): Promise<void> => {
  res.status(403).json({ code: "PAYMENT_AUTHORIZATION_REQUIRED", error: "Peça à equipe seu link individual de formalização após a confirmação do pagamento." });
});

export default router;
