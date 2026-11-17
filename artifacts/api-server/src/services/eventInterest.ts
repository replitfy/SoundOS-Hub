import { and, eq, sql } from "drizzle-orm";
import { commercialOpportunities, commercialOpportunityEvents, cursosInscricao, eventoFormularioSubmissoes, eventoPreinscricoes, pessoaServicos } from "@workspace/db";
import { EventFlowError, type EventTx } from "./eventIdentity";
import { textoDaProximaAcao, type ConferenciaDoCartao } from "./identidadeConferencia";

// Separate namespace from the legacy two-integer class/person enrollment lock.
// Event IDs and class IDs can coincide or be inverted across two events.
export async function lockEventPerson(tx: EventTx, eventId: number, personId: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"event-flow:" + eventId + ":" + personId}, 0))`);
}

/** Called inside the person/submission transaction; never returns a half-created card. */
export async function recordEventSubmission(tx: EventTx, input: {
  event: typeof cursosInscricao.$inferSelect;
  personId: number; formId: number; versionId: number; answers: Record<string, string>; complete?: boolean;
  /** Identidade não confirmada: o cartão novo nasce pedindo a conferência da equipe. */
  conferencia?: ConferenciaDoCartao | null;
  /** Caixa de consentimento do WhatsApp e o texto exato que estava na tela. */
  consentimento?: { aceito: boolean; texto: string };
}) {
  const { event, personId } = input;
  const [currentEvent] = await tx.select().from(cursosInscricao).where(eq(cursosInscricao.id, event.id)).for("share");
  if (!currentEvent?.ativo || currentEvent.classId !== event.classId) throw new EventFlowError("O evento mudou ou não está disponível. Fale com a equipe.");
  await lockEventPerson(tx, event.id, personId);
  const [submission] = await tx.insert(eventoFormularioSubmissoes).values({
    eventoId: event.id, formularioId: input.formId, versaoId: input.versionId, pessoaId: personId, respostas: input.answers,
    consentimentoWhatsapp: input.consentimento?.aceito ?? false,
    consentimentoTexto: input.consentimento?.aceito ? input.consentimento.texto : null,
  }).returning();
  const status = input.complete ? "PREINSCRITO" : "INTERESSADO";
  const [pre] = await tx.insert(eventoPreinscricoes).values({
    eventoId: event.id, pessoaId: personId, status, ultimaSubmissaoId: submission!.id,
  }).onConflictDoUpdate({
    target: [eventoPreinscricoes.eventoId, eventoPreinscricoes.pessoaId],
    set: {
      status: sql`CASE WHEN ${eventoPreinscricoes.status} = 'MATRICULADO' THEN 'MATRICULADO' WHEN ${eventoPreinscricoes.status} = 'PREINSCRITO' AND ${status} = 'INTERESSADO' THEN 'PREINSCRITO' ELSE ${status} END`,
      ultimaSubmissaoId: submission!.id, updatedAt: new Date(),
    },
  }).returning();
  const [service] = await tx.select({ id: pessoaServicos.id }).from(pessoaServicos).where(and(eq(pessoaServicos.pessoaId, personId), eq(pessoaServicos.cursosInscricaoId, event.id))).limit(1);
  if (!service) await tx.insert(pessoaServicos).values({ pessoaId: personId, servicoNome: event.nome, cursosInscricaoId: event.id, obs: "Inscrição via formulário público" });
  const offerIdentity = `curso:${event.id}`;
  // Share the existing partial unique index with cards opened by Sofia.
  let [opportunity] = await tx.insert(commercialOpportunities).values({
    pessoaId: personId, nucleus: event.nucleo as "EDUCATION" | "EXPERIENCES", cursosInscricaoId: event.id,
    offerLabel: event.nome, offerIdentity, ownerSystem: "SOFIA", source: "SOFIA_INTERESSE",
    nextTaskType: "WHATSAPP", nextTaskText: textoDaProximaAcao(input.conferencia), nextTaskAt: new Date(),
    offerInterestStatus: "INTERESTED", ...(input.conferencia ? { informacoes: input.conferencia.resumo } : {}),
  }).onConflictDoNothing().returning();
  const created = Boolean(opportunity);
  if (!opportunity) {
    [opportunity] = await tx.select().from(commercialOpportunities).where(and(eq(commercialOpportunities.pessoaId, personId), eq(commercialOpportunities.nucleus, event.nucleo as "EDUCATION" | "EXPERIENCES"), eq(commercialOpportunities.offerIdentity, offerIdentity), sql`${commercialOpportunities.stage} <> 'CLOSED'`)).for("update");
    if (!opportunity) throw new Error("Opportunity not found after conflict");
    [opportunity] = await tx.update(commercialOpportunities).set({
      // Do not take an existing human's card or reset their stage/next action.
      ...(opportunity.ownerUserId === null && opportunity.source === "SOFIA_INTERESSE" ? { ownerSystem: "SOFIA" as const } : {}),
      lastInteractionAt: new Date(), version: sql`${commercialOpportunities.version} + 1`, updatedAt: new Date(),
    }).where(eq(commercialOpportunities.id, opportunity.id)).returning();
  }
  await tx.insert(commercialOpportunityEvents).values({
    opportunityId: opportunity!.id, actorKind: "SYSTEM", eventType: created ? "CREATED" : "UPDATED",
    toStage: opportunity!.stage, source: "FORMULARIO_EVENTO", idempotencyKey: `event-submission:${submission!.id}`,
    metadata: { formSubmission: { submissionId: submission!.id, eventName: event.nome, answers: input.answers }, ...(input.conferencia ? { conferencia: input.conferencia.resumo } : {}) },
  });
  // `created`: este envio abriu o card (e não só atualizou um que já existia).
  return { submission: submission!, pre: pre!, opportunity: opportunity!, created };
}
