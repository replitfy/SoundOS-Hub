import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db, eventFormalizations, cursosInscricao, eventoFormularios, eventoFormularioVersoes,
  eventoPreinscricoes, enrollmentsTable, commercialOpportunityEvents,
} from "@workspace/db";
import { requireAdminRole, type AuthedRequest } from "../middlewares/roleAuth";
import { EventFlowError, resolveEventPerson } from "../services/eventIdentity";
import { lockEventPerson, recordEventSubmission } from "../services/eventInterest";
import { transitionOpportunity } from "../services/commercialOpportunities";
import { validateSubmission } from "./event-forms.validation";

const router = Router();
const paymentInput = z.object({
  amount: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).refine(v => Number(v) > 0),
  reference: z.string().trim().min(1).max(300),
}).strict();
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const buckets = new Map<string, { n: number; until: number }>();
router.use("/public/formalizacao", (req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const now = Date.now(), ip = req.ip ?? "unknown";
  if (buckets.size > 10000) for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
  const current = buckets.get(ip);
  if (current && current.until > now) {
    if (++current.n > 60) { res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns instantes." }); return; }
  } else buckets.set(ip, { n: 1, until: now + 60000 });
  next();
});

function respondError(error: unknown, res: import("express").Response) {
  if (error instanceof EventFlowError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  throw error;
}
const paymentPath = "/cursos-inscricao/:id/preinscricoes/:preId/pagamento";
router.post(paymentPath, requireAdminRole, async (req, res) => {
  const parsed = paymentInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Informe valor recebido e referência válidos." }); return; }
  const eventId = Number(req.params.id), preId = Number(req.params.preId);
  if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(preId)) { res.status(400).json({ error: "Identificador inválido." }); return; }
  const actor = (req as AuthedRequest).authedUser!;
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  try {
    await db.transaction(async tx => {
      const [event] = await tx.select().from(cursosInscricao).where(eq(cursosInscricao.id, eventId)).for("share");
      const [pre] = await tx.select().from(eventoPreinscricoes).where(and(eq(eventoPreinscricoes.id, preId), eq(eventoPreinscricoes.eventoId, eventId)));
      if (!pre || !event?.ativo) throw new EventFlowError("Interesse ou evento não disponível.", 404);
      if (!event.classId) throw new EventFlowError("Vincule uma turma ao evento antes de confirmar o pagamento.");
      await lockEventPerson(tx, eventId, pre.pessoaId);
      const [existing] = await tx.select().from(eventFormalizations).where(and(eq(eventFormalizations.eventoId, eventId), eq(eventFormalizations.pessoaId, pre.pessoaId))).for("update");
      if (existing?.completedAt) throw new EventFlowError("Esta formalização já foi concluída.");
      const [form] = await tx.select().from(eventoFormularios).where(and(eq(eventoFormularios.eventoId, eventId), eq(eventoFormularios.tipo, "COMPLETO"), eq(eventoFormularios.ativo, true)));
      if (!form) throw new EventFlowError("Ative o formulário completo deste evento antes de liberar o link.");
      const amount = Number(parsed.data.amount).toFixed(2);
      const values = { eventoId: eventId, classId: event.classId, pessoaId: pre.pessoaId, amount, reference: parsed.data.reference, confirmedBy: actor.id, confirmedAt: new Date(), tokenHash: hash(token), expiresAt, revokedAt: null };
      const [payment] = await tx.insert(eventFormalizations).values(values).onConflictDoUpdate({
        target: [eventFormalizations.eventoId, eventFormalizations.pessoaId], set: values,
      }).returning();
      // The audit event stores the manual confirmation, never the bearer token.
      const [opportunity] = await tx.execute(sql`SELECT id FROM commercial_opportunities WHERE pessoa_id=${pre.pessoaId} AND cursos_inscricao_id=${eventId} AND stage <> 'CLOSED' ORDER BY id LIMIT 1`).then(result => result.rows as { id: number }[]);
      if (opportunity) {
        await tx.update(eventFormalizations).set({ opportunityId: opportunity.id }).where(eq(eventFormalizations.id, payment!.id));
        await tx.insert(commercialOpportunityEvents).values({
          opportunityId: opportunity.id, actorKind: "HUMAN", actorId: actor.id, eventType: "UPDATED", source: "PAGAMENTO_MANUAL",
          idempotencyKey: `payment:${payment!.id}:${randomBytes(8).toString("hex")}`,
          metadata: { payment: { amount, reference: parsed.data.reference, confirmedAt: values.confirmedAt.toISOString(), formalizationId: payment!.id, rotated: Boolean(existing) } },
        });
      }
    });
    res.json({ token, expiresAt: expiresAt.toISOString() });
  } catch (error) { respondError(error, res); }
});

router.post(`${paymentPath}/revogar`, requireAdminRole, async (req, res) => {
  try {
    await db.transaction(async tx => {
      const eventId = Number(req.params.id), preId = Number(req.params.preId);
      if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(preId)) throw new EventFlowError("Identificador inválido.", 400);
      const [pre] = await tx.select().from(eventoPreinscricoes).where(and(eq(eventoPreinscricoes.id, preId), eq(eventoPreinscricoes.eventoId, eventId)));
      if (!pre) throw new EventFlowError("Interesse não encontrado.", 404);
      await lockEventPerson(tx, eventId, pre.pessoaId);
      const [payment] = await tx.select().from(eventFormalizations).where(and(eq(eventFormalizations.eventoId, eventId), eq(eventFormalizations.pessoaId, pre.pessoaId))).for("update");
      if (!payment || payment.completedAt) throw new EventFlowError("Não há link pendente para revogar.");
      await tx.update(eventFormalizations).set({ revokedAt: new Date() }).where(eq(eventFormalizations.id, payment.id));
      if (payment.opportunityId) await tx.insert(commercialOpportunityEvents).values({
        opportunityId: payment.opportunityId, actorKind: "HUMAN", actorId: (req as AuthedRequest).authedUser!.id,
        eventType: "UPDATED", source: "FORMALIZACAO", idempotencyKey: `revoke:${payment.id}:${randomBytes(8).toString("hex")}`,
        metadata: { formalizationId: payment.id, revoked: true },
      });
    });
    res.sendStatus(204);
  } catch (error) { respondError(error, res); }
});

async function loadPublic(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new EventFlowError("Link indisponível. Peça um novo link à equipe.", 404);
  const [payment] = await db.select().from(eventFormalizations).where(eq(eventFormalizations.tokenHash, hash(token)));
  if (!payment || payment.revokedAt || payment.expiresAt.getTime() <= Date.now()) throw new EventFlowError("Link indisponível. Peça um novo link à equipe.", 404);
  const [event] = await db.select().from(cursosInscricao).where(eq(cursosInscricao.id, payment.eventoId));
  if (!event?.ativo || !event.classId || event.classId !== payment.classId) throw new EventFlowError("Evento indisponível. Fale com a equipe.", 404);
  const [form] = await db.select().from(eventoFormularios).where(and(eq(eventoFormularios.eventoId, event.id), eq(eventoFormularios.tipo, "COMPLETO"), eq(eventoFormularios.ativo, true)));
  if (!form) throw new EventFlowError("Formulário indisponível. Fale com a equipe.", 404);
  const [version] = await db.select().from(eventoFormularioVersoes).where(eq(eventoFormularioVersoes.formularioId, form.id)).orderBy(desc(eventoFormularioVersoes.numero)).limit(1);
  if (!version) throw new EventFlowError("Formulário indisponível.", 404);
  return { payment, event, form, version };
}
router.get("/public/formalizacao/:token", async (req, res) => {
  try {
    const { payment, event, version } = await loadPublic(String(req.params.token));
    res.json({ status: payment.completedAt ? "completed" : "pending", evento: { nome: event.nome }, campos: version.campos, expiresAt: payment.expiresAt.toISOString() });
  } catch (error) { respondError(error, res); }
});
router.post("/public/formalizacao/:token", async (req, res) => {
  try {
    const found = await loadPublic(String(req.params.token));
    const validation = validateSubmission(found.version.campos, req.body?.respostas);
    if (!validation.ok) throw new EventFlowError(validation.error, 400, "INVALID_ANSWERS");
    if (Object.keys(req.body ?? {}).some(k => k !== "respostas")) throw new EventFlowError("Campos não permitidos.", 400);
    const result = await db.transaction(async tx => {
      // Identity locks precede event locks in every submission path.
      const personId = found.payment.completedAt ? found.payment.pessoaId : await resolveEventPerson(tx, validation.answers, found.payment.pessoaId);
      // Serialize against rotation/revocation before applying any public writes.
      await lockEventPerson(tx, found.event.id, found.payment.pessoaId);
      const [payment] = await tx.select().from(eventFormalizations).where(eq(eventFormalizations.id, found.payment.id)).for("update");
      if (!payment || payment.tokenHash !== hash(String(req.params.token)) || payment.revokedAt || payment.expiresAt.getTime() <= Date.now()) throw new EventFlowError("Link indisponível. Peça um novo link à equipe.", 404);
      if (payment.completedAt) return { success: true, enrollmentId: payment.enrollmentId!, alreadyCompleted: true };
      const [currentEvent] = await tx.select().from(cursosInscricao).where(eq(cursosInscricao.id, found.event.id)).for("share");
      if (!currentEvent?.ativo || currentEvent.classId !== found.event.classId) throw new EventFlowError("O evento mudou. Fale com a equipe.");
      const { submission, pre, opportunity } = await recordEventSubmission(tx, { event: found.event, personId, formId: found.form.id, versionId: found.version.id, answers: validation.answers, complete: true });
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${found.event.classId!}, ${personId})`);
      const existing = await tx.select().from(enrollmentsTable).where(and(eq(enrollmentsTable.pessoaId, personId), eq(enrollmentsTable.classId, found.event.classId!))).for("update");
      if (existing.length > 1) throw new EventFlowError("Há matrículas duplicadas nesta turma. A equipe precisa conferir.");
      let enrollment = existing[0];
      if (enrollment) {
        if (enrollment.paymentStatus !== "paid" || Number(enrollment.price) !== Number(payment.amount)) throw new EventFlowError("A matrícula existente tem dados financeiros diferentes. Peça conferência à equipe.");
      } else {
        [enrollment] = await tx.insert(enrollmentsTable).values({ pessoaId: personId, classId: found.event.classId!, price: payment.amount, paymentStatus: "paid", contractStatus: "pending" }).returning();
      }
      await tx.update(eventoPreinscricoes).set({ status: "MATRICULADO", updatedAt: new Date() }).where(eq(eventoPreinscricoes.id, pre.id));
      await tx.update(eventFormalizations).set({ completedAt: new Date(), enrollmentId: enrollment!.id, submissionId: submission.id, opportunityId: opportunity.id }).where(eq(eventFormalizations.id, payment.id));
      // Same governance as manual enrollment confirmation, authoritative operational evidence.
      // Sofia never confirms: the author is the staff member who confirmed payment.
      if (opportunity.stage !== "CONFIRMED") await transitionOpportunity({
        opportunityId: opportunity.id, toStage: "CONFIRMED", actor: { kind: "SYSTEM", id: payment.confirmedBy },
        source: "FORMALIZACAO", idempotencyKey: `formalization:${payment.id}`,
        confirmation: found.event.nucleo === "EDUCATION" ? { kind: "ENROLLMENT", enrollmentId: enrollment!.id } : { kind: "EXPERIENCE_REGISTRATION", registrationId: enrollment!.id },
        metadata: { formalizationId: payment.id, submissionId: submission.id, contractGeneration: "PENDING_TEMPLATE" },
      }, tx);
      else await tx.insert(commercialOpportunityEvents).values({
        opportunityId: opportunity.id, actorKind: "SYSTEM", eventType: "UPDATED", source: "FORMALIZACAO",
        idempotencyKey: `formalization:${payment.id}`, metadata: { enrollmentId: enrollment!.id, formalizationId: payment.id, contractGeneration: "PENDING_TEMPLATE" },
      });
      return { success: true, enrollmentId: enrollment!.id };
    });
    res.json(result);
  } catch (error) { respondError(error, res); }
});
export default router;
