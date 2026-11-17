import { and, desc, eq, exists, ilike, isNull, or, sql, inArray } from "drizzle-orm";
import {
  db,
  commercialOpportunities,
  commercialOpportunityEvents,
  decisionRuns,
  type CommercialOpportunity,
  type OpportunityActorKind,
  type OpportunityStage,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_NUCLEI,
  OPPORTUNITY_TASK_TYPES,
  OPPORTUNITY_EVENT_TYPES,
  type OpportunityNucleus,
  type OpportunityTaskType,
  type ContactStatus,
  type OfferInterestStatus,
  type EligibilityStatus,
  pessoasTable,
  enrollmentsTable,
  cursosInscricao,
  coursesTable,
  conversations,
  usersTable,
  canalEnvios,
} from "@workspace/db";
import { interestGroupLabel } from "./interesseGeral";
import { entregaDasMensagens } from "./conversaMensagens";
import { traduzirErroDeEnvio } from "./metaErros";
import { isPgUniqueViolation } from "../lib/pg-errors.js";

// A transaction client is intentionally structural: this keeps the service
// usable with both drizzle's node-postgres database and transaction clients.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = any;

export class OpportunityRuleError extends Error {
  constructor(
    message: string,
    public readonly code = "OPPORTUNITY_RULE_VIOLATION",
    public readonly status = 400,
    /** Dados para a tela (ex.: a lista de bloqueios de um envio); vão na resposta de erro. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpportunityRuleError";
  }
}

export function parseOpportunityDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
    throw new OpportunityRuleError(`${field} must be a valid date.`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new OpportunityRuleError(`${field} is required.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OpportunityRuleError(`${field} must be an ISO date.`);
  }
  return date;
}

export type OpportunityActor = {
  kind: OpportunityActorKind;
  id?: number;
  /** Espelho legado do perfil, só para auditoria. */
  role?: string;
  /** Perfil de administrador: quem pode confirmar uma oportunidade explicitamente. */
  isAdmin?: boolean;
};

export type ConfirmationEvidence =
  | { kind: "ENROLLMENT"; enrollmentId: number }
  | { kind: "EXPERIENCE_REGISTRATION"; registrationId: number }
  | { kind: "HUMAN_ADMIN" };

export type ConfirmationEvidenceOption = {
  kind: "ENROLLMENT" | "EXPERIENCE_REGISTRATION" | "HUMAN_ADMIN";
  id?: number;
  label: string;
};

export function parseConfirmationEvidence(value: unknown): ConfirmationEvidence | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpportunityRuleError("confirmation must be an object.");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys: Record<string, readonly string[]> = {
    ENROLLMENT: ["kind", "enrollmentId"],
    EXPERIENCE_REGISTRATION: ["kind", "registrationId"],
    HUMAN_ADMIN: ["kind"],
  };
  if (typeof input.kind !== "string" || !allowedKeys[input.kind]) {
    throw new OpportunityRuleError("Invalid confirmation.kind.");
  }
  if (Object.keys(input).some((key) => !allowedKeys[input.kind as string].includes(key))) {
    throw new OpportunityRuleError(
      "Confirmation contains fields unrelated to its evidence kind.",
      "CONFIRMATION_EVIDENCE_INVALID",
      422,
    );
  }
  if (input.kind === "HUMAN_ADMIN") return { kind: "HUMAN_ADMIN" };
  const idField = input.kind === "ENROLLMENT" ? "enrollmentId" : "registrationId";
  const id = input[idField];
  if (!Number.isSafeInteger(id) || (id as number) <= 0) {
    throw new OpportunityRuleError(`confirmation.${idField} is required.`);
  }
  return input.kind === "ENROLLMENT"
    ? { kind: "ENROLLMENT", enrollmentId: id as number }
    : { kind: "EXPERIENCE_REGISTRATION", registrationId: id as number };
}

export type OpportunityBoardRow = CommercialOpportunity & {
  person: { id: number; name: string; email: string | null; phone: string | null } | null;
  owner: { id: number; name: string; email: string; role: string } | null;
  /** De onde veio o cartão: grupo do formulário de interesse, ou o evento (e o curso dele). */
  origem: {
    grupo: string | null;
    grupoLabel: string | null;
    curso: { id: number; name: string } | null;
    evento: { id: number; name: string } | null;
  };
  sofia: {
    eligibilityStatus: EligibilityStatus;
    nextBestAction: string | null;
    decisionRunId: number | null;
    handoffActive: boolean;
  };
};

export function isActiveOpportunityStage(stage: OpportunityStage): boolean {
  return stage !== "CLOSED";
}

/**
 * Os interesses automáticos pertencem à Sofia até um vendedor assumir.
 * A ausência de ownerUserId significa ausência de vendedor, não de responsável.
 */
export const SOFIA_INTEREST_SOURCE = "SOFIA_INTERESSE";

export function assertActiveOpportunityFields(input: {
  stage: OpportunityStage;
  ownerUserId?: number | null;
  nextTaskType?: OpportunityTaskType | null;
  nextTaskText?: string | null;
  nextTaskAt?: Date | string | null;
  /** Só a criação do cartão de interesse da Sofia usa isto. */
  allowUnowned?: boolean;
}): void {
  if (!isActiveOpportunityStage(input.stage)) return;
  if (!input.ownerUserId && !input.allowUnowned) {
    throw new OpportunityRuleError(
      "Active opportunities require an owner.",
      "OWNER_REQUIRED",
    );
  }
  if (!input.nextTaskType || input.nextTaskType === "NONE") {
    throw new OpportunityRuleError(
      "Active opportunities require a next action type.",
      "NEXT_ACTION_REQUIRED",
    );
  }
  if (!input.nextTaskText?.trim()) {
    throw new OpportunityRuleError(
      "Active opportunities require next action text.",
      "NEXT_ACTION_REQUIRED",
    );
  }
  if (!input.nextTaskAt) {
    throw new OpportunityRuleError(
      "Active opportunities require a next task date.",
      "NEXT_TASK_AT_REQUIRED",
    );
  }
}

export function assertReasonForStage(
  stage: OpportunityStage,
  reason: string | null | undefined,
): void {
  if ((stage === "NURTURE" || stage === "CLOSED") && !reason?.trim()) {
    throw new OpportunityRuleError(
      `${stage} requires a non-blank reason.`,
      "REASON_REQUIRED",
    );
  }
}

export function assertSofiaTransitionAllowed(input: {
  actor: OpportunityActor;
  eligibilityStatus: string;
  decisionRunId: number | null;
  humanReview?: boolean;
  handoffConflict?: boolean;
  toStage: OpportunityStage;
}): void {
  if (input.actor.kind !== "SOFIA") return;
  if (input.humanReview || input.eligibilityStatus === "HUMAN_REVIEW") {
    throw new OpportunityRuleError(
      "Sofia cannot operate an opportunity awaiting human review.",
      "SOFIA_HUMAN_REVIEW_BLOCKED",
      409,
    );
  }
  if (input.handoffConflict) {
    throw new OpportunityRuleError(
      "Sofia cannot operate an opportunity with an active human handoff.",
      "SOFIA_HANDOFF_CONFLICT",
      409,
    );
  }
  if (!input.decisionRunId) {
    throw new OpportunityRuleError(
      "Sofia transitions require a decision run.",
      "SOFIA_DECISION_RUN_REQUIRED",
      409,
    );
  }
  if (input.eligibilityStatus !== "ELIGIBLE") {
    throw new OpportunityRuleError(
      "Sofia transitions require an eligible opportunity.",
      "SOFIA_ELIGIBILITY_REQUIRED",
      409,
    );
  }
  if (input.toStage === "CONFIRMED") {
    throw new OpportunityRuleError(
      "Sofia cannot confirm an opportunity.",
      "SOFIA_CONFIRMATION_BLOCKED",
      403,
    );
  }
}

export function assertGovernedFieldsActor(
  actor: OpportunityActor,
  fields: { eligibilityStatus?: unknown; decisionRunId?: unknown; nextBestAction?: unknown; humanCaseReference?: unknown },
): void {
  if (actor.kind === "HUMAN" && Object.values(fields).some((value) => value !== undefined)) {
    throw new OpportunityRuleError(
      "Governed Sofia/decision fields can only be changed by an authoritative internal actor.",
      "GOVERNED_FIELDS_FORBIDDEN",
      403,
    );
  }
}

export function assertExpectedOpportunityVersion(
  actualVersion: number,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
    throw new OpportunityRuleError("Opportunity was changed by another user.", "STALE_OPPORTUNITY", 409);
  }
}

export function assertOperationalConfirmationMatch(input: {
  opportunityNucleus: OpportunityNucleus;
  offerNucleus: string | null;
  opportunityClassId: number | null;
  evidenceClassId: number;
  evidenceKind: "ENROLLMENT" | "EXPERIENCE_REGISTRATION";
}): void {
  const expectedNucleus =
    input.evidenceKind === "ENROLLMENT" ? "EDUCATION" : "EXPERIENCES";
  if (
    input.opportunityNucleus !== expectedNucleus ||
    input.offerNucleus !== expectedNucleus ||
    !input.opportunityClassId ||
    input.opportunityClassId !== input.evidenceClassId
  ) {
    throw new OpportunityRuleError(
      `Operational confirmation is not tied to this exact ${expectedNucleus} offer.`,
      "CONFIRMATION_EVIDENCE_INVALID",
      422,
    );
  }
}

export function assertConfirmationStage(
  toStage: OpportunityStage,
  confirmation?: ConfirmationEvidence,
): void {
  if (confirmation && toStage !== "CONFIRMED") {
    throw new OpportunityRuleError(
      "Confirmation evidence is only valid for a CONFIRMED transition.",
      "CONFIRMATION_EVIDENCE_INVALID",
      422,
    );
  }
}

export function assertReactivationTarget(toStage: OpportunityStage): void {
  if (toStage === "NURTURE" || toStage === "CLOSED") {
    throw new OpportunityRuleError(
      "Reactivation must restore an active stage.",
      "INVALID_REACTIVATION_STAGE",
      409,
    );
  }
}

function eventKey(operation: string, actor: OpportunityActor, source: string, key?: string): string {
  return key?.trim()
    ? `${operation}:${actor.kind}:${actor.id ?? 0}:${key.trim()}`
    : `${operation}:${actor.kind}:${actor.id ?? 0}:${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function fingerprint(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${fingerprint(object[key])}`).join(",")}}`;
}

function offerIdentity(
  nucleus: OpportunityNucleus,
  cursosInscricaoId?: number | null,
  offerLabel?: string | null,
): string {
  if (cursosInscricaoId) return `curso:${cursosInscricaoId}`;
  const normalized = offerLabel?.trim().toLocaleLowerCase();
  if (normalized) return `label:${normalized}`;
  return `nucleus:${nucleus.toLocaleLowerCase()}:unspecified`;
}

export function buildOfferIdentity(input: {
  nucleus: OpportunityNucleus;
  cursosInscricaoId?: number | null;
  offerLabel?: string | null;
}): string {
  if (!OPPORTUNITY_NUCLEI.includes(input.nucleus)) {
    throw new OpportunityRuleError("Invalid opportunity nucleus.");
  }
  return offerIdentity(input.nucleus, input.cursosInscricaoId, input.offerLabel);
}

function assertStage(stage: string): asserts stage is OpportunityStage {
  if (!OPPORTUNITY_STAGES.includes(stage as OpportunityStage)) {
    throw new OpportunityRuleError(`Invalid opportunity stage: ${stage}`);
  }
}

function assertTaskType(type: string | null | undefined): void {
  if (type && !OPPORTUNITY_TASK_TYPES.includes(type as OpportunityTaskType)) {
    throw new OpportunityRuleError(`Invalid next task type: ${type}`);
  }
}

export async function appendEvent(
  tx: DbClient,
  params: {
    opportunityId: number;
    actor: OpportunityActor;
    fromStage?: OpportunityStage | null;
    toStage?: OpportunityStage | null;
    eventType: (typeof OPPORTUNITY_EVENT_TYPES)[number];
    reason?: string | null;
    source?: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(commercialOpportunityEvents).values({
    opportunityId: params.opportunityId,
    actorKind: params.actor.kind,
    actorId: params.actor.id ?? null,
    fromStage: params.fromStage ?? null,
    toStage: params.toStage ?? null,
    eventType: params.eventType,
    reason: params.reason?.trim() || null,
    source: params.source ?? "CRM",
    idempotencyKey: params.idempotencyKey,
    metadata: params.metadata ?? {},
  });
}

/**
 * The decision engine is the sole authoritative writer for Sofia-governed
 * opportunity fields. It calls this inside the same transaction that inserts
 * the decision_run, so a CRM projection can never point at a run whose
 * governed snapshot was only partially applied.
 */
export async function applyDecisionRunToOpportunities(
  tx: DbClient,
  input: {
    pessoaId: number;
    decisionRunId: number;
    elegibilidadeStatus: "elegivel" | "bloqueado" | "nao_avaliada";
    nbaCategoria: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const eligibilityStatus: EligibilityStatus =
    input.elegibilidadeStatus === "elegivel"
      ? "ELIGIBLE"
      : input.elegibilidadeStatus === "bloqueado"
        ? "INELIGIBLE"
        : "UNKNOWN";
  const opportunities = await tx
    .select()
    .from(commercialOpportunities)
    .where(and(
      eq(commercialOpportunities.pessoaId, input.pessoaId),
      sql`${commercialOpportunities.stage} <> 'CLOSED'`,
    ));
  for (const opportunity of opportunities) {
    const eventIdempotencyKey = `decision-run:${input.decisionRunId}`;
    const projectedEligibilityStatus =
      opportunity.eligibilityStatus === "HUMAN_REVIEW"
        ? "HUMAN_REVIEW"
        : eligibilityStatus;
    const [updated] = await tx
      .update(commercialOpportunities)
      .set({
        eligibilityStatus: projectedEligibilityStatus,
        nextBestAction: input.nbaCategoria,
        decisionRunId: input.decisionRunId,
        version: sql`${commercialOpportunities.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(commercialOpportunities.id, opportunity.id))
      .returning();
    if (!updated) continue;
    await appendEvent(tx, {
      opportunityId: updated.id,
      actor: { kind: "SOFIA" },
      fromStage: opportunity.stage,
      toStage: opportunity.stage,
      eventType: "UPDATED",
      source: "SOFIA_DECISION_ENGINE",
      idempotencyKey: eventIdempotencyKey,
      metadata: {
        governedFields: ["eligibilityStatus", "nextBestAction", "decisionRunId"],
        decisionRunId: input.decisionRunId,
      },
    });

    // Only an explicit stage signal or an eligible "comprar" decision can
    // advance the pipeline. Textual/ambiguous, ineligible and review outcomes
    // remain projections only. Never reactivate NURTURE or confirm via Sofia.
    const targetStage = deriveSofiaDecisionStage({
      currentStage: opportunity.stage,
      eligibilityStatus: input.elegibilidadeStatus,
      nbaCategoria: input.nbaCategoria,
      metadata: input.metadata,
    });
    const hasActiveNextAction = hasValidActiveNextAction(updated);
    if (!targetStage || !hasActiveNextAction || targetStage === updated.stage) continue;
    try {
      await transitionOpportunity({
        opportunityId: updated.id,
        toStage: targetStage,
        actor: { kind: "SOFIA" },
        source: "SOFIA_DECISION_ENGINE",
        idempotencyKey: `decision-run-stage:${input.decisionRunId}`,
        expectedVersion: updated.version,
        reason: `Decision run ${input.decisionRunId} authorized stage progression.`,
        metadata: {
          decisionRunId: input.decisionRunId,
          evidence: "decision_run",
          nbaCategoria: input.nbaCategoria,
        },
      }, tx);
    } catch (error) {
      if (
        error instanceof OpportunityRuleError &&
        [
          "SOFIA_HUMAN_REVIEW_BLOCKED",
          "SOFIA_HANDOFF_CONFLICT",
          "SOFIA_ELIGIBILITY_REQUIRED",
          "SOFIA_DECISION_RUN_REQUIRED",
        ].includes(error.code)
      ) {
        continue;
      }
      throw error;
    }
  }
}

export function deriveSofiaDecisionStage(input: {
  currentStage: OpportunityStage;
  eligibilityStatus: "elegivel" | "bloqueado" | "nao_avaliada";
  nbaCategoria: string;
  metadata?: Record<string, unknown>;
}): OpportunityStage | null {
  if (input.eligibilityStatus !== "elegivel") return null;
  const explicit = input.metadata?.opportunityStage ?? input.metadata?.stage;
  if (typeof explicit === "string" &&
      OPPORTUNITY_STAGES.includes(explicit as OpportunityStage) &&
      !["NURTURE", "CONFIRMED", "CLOSED"].includes(explicit)) {
    const currentIndex = OPPORTUNITY_STAGES.indexOf(input.currentStage);
    const targetIndex = OPPORTUNITY_STAGES.indexOf(explicit as OpportunityStage);
    if (targetIndex > currentIndex) return explicit as OpportunityStage;
  }
  if (
    input.nbaCategoria === "comprar" &&
    ["NEW_INTEREST", "CONTACT_STARTED", "QUALIFYING", "PATH_IDENTIFIED"].includes(input.currentStage)
  ) {
    return "DECIDING";
  }
  return null;
}

export function hasValidActiveNextAction(input: {
  ownerUserId: number | null;
  nextTaskType: OpportunityTaskType | null;
  nextTaskText: string | null;
  nextTaskAt: Date | null;
}): boolean {
  return Boolean(
    input.ownerUserId &&
    input.nextTaskType &&
    input.nextTaskType !== "NONE" &&
    input.nextTaskText?.trim() &&
    input.nextTaskAt,
  );
}

export async function createOpportunity(input: {
  pessoaId: number;
  nucleus: OpportunityNucleus;
  cursosInscricaoId?: number | null;
  offerLabel?: string | null;
  ownerUserId?: number | null;
  nextTaskType: OpportunityTaskType;
  nextTaskText: string;
  nextTaskAt: Date;
  source?: string;
  actor: OpportunityActor;
  idempotencyKey?: string;
  decisionRunId?: number | null;
  /** Cartão sem responsável: só para o interesse aberto pela Sofia. */
  allowUnowned?: boolean;
  /** Contexto extra gravado no evento de criação (ex.: trecho da conversa). Não entra na impressão digital da requisição. */
  eventMetadata?: Record<string, unknown>;
}): Promise<CommercialOpportunity> {
  if (!Number.isSafeInteger(input.pessoaId) || input.pessoaId <= 0) {
    throw new OpportunityRuleError("A valid pessoaId is required.", "PESSOA_REQUIRED");
  }
  assertGovernedFieldsActor(input.actor, { decisionRunId: input.decisionRunId });
  assertTaskType(input.nextTaskType);
  if (
    input.allowUnowned &&
    (input.actor.kind !== "SOFIA" || input.source !== SOFIA_INTEREST_SOURCE || input.ownerUserId)
  ) {
    throw new OpportunityRuleError(
      "Only Sofia's interest card may be created without an owner.",
      "UNOWNED_NOT_ALLOWED",
      403,
    );
  }
  assertActiveOpportunityFields({
    stage: "NEW_INTEREST",
    ownerUserId: input.ownerUserId ?? input.actor.id,
    allowUnowned: input.allowUnowned,
    nextTaskType: input.nextTaskType,
    nextTaskText: input.nextTaskText,
    nextTaskAt: input.nextTaskAt,
  });
  const identity = buildOfferIdentity(input);
  const key = eventKey("create", input.actor, input.source ?? "CRM", input.idempotencyKey);
  const requestFingerprint = fingerprint({
    pessoaId: input.pessoaId, nucleus: input.nucleus, cursosInscricaoId: input.cursosInscricaoId ?? null,
    offerLabel: input.offerLabel?.trim() ?? null, ownerUserId: input.ownerUserId ?? input.actor.id ?? null,
    nextTaskType: input.nextTaskType, nextTaskText: input.nextTaskText.trim(),
    nextTaskAt: input.nextTaskAt.toISOString(), decisionRunId: input.decisionRunId ?? null,
  });

  try {
    return await db.transaction(async (tx) => {
      // Idempotent retries return the original aggregate and never append a
      // second event. The unique index remains the final concurrency guard.
      const prior = await tx
        .select({ opportunity: commercialOpportunities, event: commercialOpportunityEvents })
        .from(commercialOpportunityEvents)
        .innerJoin(
          commercialOpportunities,
          eq(commercialOpportunityEvents.opportunityId, commercialOpportunities.id),
        )
        .where(
          and(
            eq(commercialOpportunityEvents.idempotencyKey, key),
            eq(commercialOpportunityEvents.eventType, "CREATED"),
          ),
        )
        .limit(1);
      if (prior[0]?.opportunity) {
        const priorFingerprint = prior[0].event.metadata?.requestFingerprint;
        if (priorFingerprint && priorFingerprint !== requestFingerprint) {
          throw new OpportunityRuleError("Idempotency key was already used with a different request.", "IDEMPOTENCY_KEY_REUSED", 409);
        }
        return prior[0].opportunity;
      }

      const [created] = await tx
        .insert(commercialOpportunities)
        .values({
          pessoaId: input.pessoaId,
          nucleus: input.nucleus,
          cursosInscricaoId: input.cursosInscricaoId ?? null,
          offerLabel: input.offerLabel?.trim() || null,
          offerIdentity: identity,
          ownerUserId: input.ownerUserId ?? input.actor.id ?? null,
          ownerSystem: input.allowUnowned ? "SOFIA" : null,
          nextTaskType: input.nextTaskType,
          nextTaskText: input.nextTaskText.trim(),
          nextTaskAt: input.nextTaskAt,
          decisionRunId: input.decisionRunId ?? null,
          source: input.source ?? "CRM",
        })
        .returning();
      if (!created) throw new Error("Opportunity insert returned no row");
      await appendEvent(tx, {
        opportunityId: created.id,
        actor: input.actor,
        toStage: created.stage,
        eventType: "CREATED",
        source: input.source,
        idempotencyKey: key,
        metadata: { ...(input.eventMetadata ?? {}), requestFingerprint },
      });
      return created;
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      // The unique index serializes two first requests for the same offer. If
      // they carry the same scoped idempotency key, return that committed
      // aggregate rather than turning a legitimate retry into a conflict.
      const [prior] = await db
        .select({ opportunity: commercialOpportunities, event: commercialOpportunityEvents })
        .from(commercialOpportunityEvents)
        .innerJoin(
          commercialOpportunities,
          eq(commercialOpportunityEvents.opportunityId, commercialOpportunities.id),
        )
        .where(
          and(
            eq(commercialOpportunityEvents.idempotencyKey, key),
            eq(commercialOpportunityEvents.eventType, "CREATED"),
          ),
        )
        .limit(1);
      if (prior) {
        if (prior.event.metadata?.requestFingerprint !== requestFingerprint) {
          throw new OpportunityRuleError("Idempotency key was already used with a different request.", "IDEMPOTENCY_KEY_REUSED", 409);
        }
        return prior.opportunity;
      }
      throw new OpportunityRuleError(
        "An active opportunity already exists for this person and offer.",
        "ACTIVE_OPPORTUNITY_EXISTS",
        409,
      );
    }
    throw error;
  }
}

/** Janela em que a mesma conversa não gera um segundo registro de interesse no histórico. */
const SOFIA_MENTION_DEDUPE_MINUTES = 30;

/**
 * A pessoa voltou a demonstrar interesse na mesma oferta enquanto já existe um
 * cartão ativo (da Sofia ou de um humano). Não cria cartão: só registra no
 * histórico o novo trecho da conversa e atualiza a última interação.
 *
 * Responsável, etapa, próxima ação e `version` ficam como estão. A `version`
 * não muda de propósito: ela protege quem edita o cartão, e este registro só
 * toca `lastInteractionAt`, campo que nenhuma edição humana grava. Subir a
 * versão faria a próxima gravação de quem está com o painel aberto falhar.
 *
 * Devolve `false` quando não há cartão ativo da oferta (o chamador cria um).
 */
export async function recordSofiaInterestMention(input: {
  pessoaId: number;
  nucleus: OpportunityNucleus;
  cursosInscricaoId: number;
  conversationId: number | null;
  metadata: Record<string, unknown>;
  idempotencyKey?: string;
  now?: Date;
}): Promise<boolean> {
  const identity = buildOfferIdentity({ nucleus: input.nucleus, cursosInscricaoId: input.cursosInscricaoId });
  const now = input.now ?? new Date();
  const actor: OpportunityActor = { kind: "SOFIA" };
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(commercialOpportunities)
      .where(and(
        eq(commercialOpportunities.pessoaId, input.pessoaId),
        eq(commercialOpportunities.nucleus, input.nucleus),
        eq(commercialOpportunities.offerIdentity, identity),
        sql`${commercialOpportunities.stage} <> 'CLOSED'`,
      ))
      .limit(1)
      .for("update");
    if (!current) return false;

    await tx
      .update(commercialOpportunities)
      .set({ lastInteractionAt: now, updatedAt: now })
      .where(eq(commercialOpportunities.id, current.id));

    if (input.conversationId !== null) {
      // A Sofia pode chamar a ferramenta várias vezes na mesma conversa (o
      // cliente insiste no valor, por exemplo): um registro basta.
      const [recent] = await tx
        .select({ id: commercialOpportunityEvents.id })
        .from(commercialOpportunityEvents)
        .where(and(
          eq(commercialOpportunityEvents.opportunityId, current.id),
          eq(commercialOpportunityEvents.source, SOFIA_INTEREST_SOURCE),
          sql`${commercialOpportunityEvents.createdAt} > now() - make_interval(mins => ${SOFIA_MENTION_DEDUPE_MINUTES})`,
          sql`${commercialOpportunityEvents.metadata} -> 'sofiaConversation' ->> 'conversationId' = ${String(input.conversationId)}`,
        ))
        .limit(1);
      if (recent) return true;
    }

    await appendEvent(tx, {
      opportunityId: current.id,
      actor,
      toStage: current.stage,
      eventType: "UPDATED",
      source: SOFIA_INTEREST_SOURCE,
      idempotencyKey: eventKey("sofia-mention", actor, SOFIA_INTEREST_SOURCE, input.idempotencyKey),
      metadata: input.metadata,
    });
    return true;
  });
}

export async function transitionOpportunity(input: {
  opportunityId: number;
  toStage: OpportunityStage;
  actor: OpportunityActor;
  reason?: string | null;
  source?: string;
  idempotencyKey?: string;
  expectedVersion?: number;
  confirmation?: ConfirmationEvidence;
  metadata?: Record<string, unknown>;
}, transaction?: DbClient): Promise<CommercialOpportunity> {
  assertStage(input.toStage);
  assertReasonForStage(input.toStage, input.reason);
  assertConfirmationStage(input.toStage, input.confirmation);
  if (input.toStage === "CONFIRMED") {
    if (input.actor.kind === "SOFIA") {
      throw new OpportunityRuleError("Human confirmation is required.", "CONFIRMATION_REQUIRED", 403);
    }
    if (!input.confirmation) {
      throw new OpportunityRuleError(
        "CONFIRMED requires a server-resolved enrollment or authorized human confirmation.",
        "CONFIRMATION_EVIDENCE_REQUIRED",
        422,
      );
    }
    if (input.confirmation.kind === "HUMAN_ADMIN" && input.actor.isAdmin !== true) {
      throw new OpportunityRuleError(
        "Only administrators may explicitly confirm an opportunity.",
        "ADMIN_CONFIRMATION_REQUIRED",
        403,
      );
    }
  }
  const key = eventKey("transition", input.actor, input.source ?? "CRM", input.idempotencyKey);
  const requestFingerprint = fingerprint({
    opportunityId: input.opportunityId, toStage: input.toStage, reason: input.reason?.trim() ?? null,
    confirmation: input.confirmation ?? null, expectedVersion: input.expectedVersion ?? null,
  });
  const transition = async (tx: DbClient): Promise<CommercialOpportunity> => {
    await tx.execute(sql`SELECT id FROM commercial_opportunities WHERE id = ${input.opportunityId} FOR UPDATE`);
    const rows = await tx
      .select()
      .from(commercialOpportunities)
      .where(eq(commercialOpportunities.id, input.opportunityId))
      .limit(1);
    const current = rows[0];
    if (!current) throw new OpportunityRuleError("Opportunity not found.", "NOT_FOUND", 404);
    const priorEvent = await tx
      .select()
      .from(commercialOpportunityEvents)
      .where(
        and(
          eq(commercialOpportunityEvents.opportunityId, input.opportunityId),
          eq(commercialOpportunityEvents.idempotencyKey, key),
        ),
      )
      .limit(1);
    if (priorEvent.length) {
      const priorFingerprint = priorEvent[0].metadata?.requestFingerprint;
      if (priorFingerprint !== requestFingerprint) {
        throw new OpportunityRuleError("Idempotency key was already used with a different request.", "IDEMPOTENCY_KEY_REUSED", 409);
      }
      return current;
    }
    assertExpectedOpportunityVersion(current.version, input.expectedVersion);
    if (current.stage === input.toStage) {
      throw new OpportunityRuleError(
        "Opportunity is already in the requested stage.",
        "NO_OP_TRANSITION",
        409,
      );
    }
    let unresolvedHandoff = false;
    if (input.actor.kind === "SOFIA") {
      const [handoff] = await tx.select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.pessoaId, current.pessoaId),
          or(
            eq(conversations.status, "aguardando_humano"),
            eq(conversations.status, "atendimento_humano"),
          ),
        ))
        .limit(1);
      unresolvedHandoff = Boolean(handoff);
    }
    assertSofiaTransitionAllowed({
      actor: input.actor,
      eligibilityStatus: current.eligibilityStatus,
      decisionRunId: current.decisionRunId,
      handoffConflict: unresolvedHandoff,
      toStage: input.toStage,
    });
    if (input.actor.kind === "SOFIA") {
      const [run] = await tx
        .select({ id: decisionRuns.id })
        .from(decisionRuns)
        .where(and(eq(decisionRuns.id, current.decisionRunId!), eq(decisionRuns.pessoaId, current.pessoaId)))
        .limit(1);
      if (!run) {
        throw new OpportunityRuleError(
          "Sofia transitions require a decision run belonging to the opportunity person.",
          "SOFIA_DECISION_RUN_REQUIRED",
          409,
        );
      }
    }
    if (
      input.toStage === "CONFIRMED" &&
      (input.confirmation?.kind === "ENROLLMENT" ||
        input.confirmation?.kind === "EXPERIENCE_REGISTRATION")
    ) {
      const expectedNucleus =
        input.confirmation.kind === "ENROLLMENT" ? "EDUCATION" : "EXPERIENCES";
      const evidenceId =
        input.confirmation.kind === "ENROLLMENT"
          ? input.confirmation.enrollmentId
          : input.confirmation.registrationId;
      if (current.nucleus !== expectedNucleus || !current.cursosInscricaoId) {
        throw new OpportunityRuleError(
          `Operational confirmation is only available for an exact ${expectedNucleus} offer.`,
          "CONFIRMATION_EVIDENCE_INVALID",
          422,
        );
      }
      const [enrollment] = await tx
        .select({
          id: enrollmentsTable.id,
          classId: enrollmentsTable.classId,
          paymentStatus: enrollmentsTable.paymentStatus,
          contractStatus: enrollmentsTable.contractStatus,
        })
        .from(enrollmentsTable)
        .where(and(
          eq(enrollmentsTable.id, evidenceId),
          eq(enrollmentsTable.pessoaId, current.pessoaId),
          or(
            eq(enrollmentsTable.paymentStatus, "paid"),
            eq(enrollmentsTable.paymentStatus, "installments"),
            eq(enrollmentsTable.contractStatus, "signed"),
          ),
        ))
        .limit(1);
      if (!enrollment) {
        throw new OpportunityRuleError(
          "Operational enrollment confirmation is not a trustworthy enrollment for this person.",
          "CONFIRMATION_EVIDENCE_INVALID",
          422,
        );
      }
      const [offer] = await tx
        .select({ classId: cursosInscricao.classId, nucleo: cursosInscricao.nucleo })
        .from(cursosInscricao)
        .where(eq(cursosInscricao.id, current.cursosInscricaoId))
        .limit(1);
      if (!offer) {
        throw new OpportunityRuleError(
          `Operational confirmation is not tied to this exact ${expectedNucleus} offer.`,
          "CONFIRMATION_EVIDENCE_INVALID",
          422,
        );
      }
      assertOperationalConfirmationMatch({
        opportunityNucleus: current.nucleus,
        offerNucleus: offer.nucleo,
        opportunityClassId: offer.classId,
        evidenceClassId: enrollment.classId,
        evidenceKind: input.confirmation.kind,
      });
    }
    assertActiveOpportunityFields({
      stage: input.toStage,
      ownerUserId: current.ownerUserId,
      allowUnowned: current.ownerUserId === null && current.ownerSystem === "SOFIA",
      nextTaskType: current.nextTaskType,
      nextTaskText: current.nextTaskText,
      nextTaskAt: current.nextTaskAt,
    });

    const [updated] = await tx
      .update(commercialOpportunities)
      .set({
        stage: input.toStage,
        stageEnteredAt: new Date(),
        pauseReason: input.toStage === "NURTURE" ? input.reason?.trim() || null : null,
        closeReason: input.toStage === "CLOSED" ? input.reason?.trim() || null : null,
        version: sql`${commercialOpportunities.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(commercialOpportunities.id, input.opportunityId))
      .returning();
    if (!updated) throw new OpportunityRuleError("Opportunity not found.", "NOT_FOUND", 404);
    await appendEvent(tx, {
      opportunityId: updated.id,
      actor: input.actor,
      fromStage: current.stage,
      toStage: updated.stage,
      eventType: input.toStage === "NURTURE"
        ? "PAUSED"
        : input.toStage === "CLOSED"
          ? "CLOSED"
          : current.stage === "NURTURE"
            ? "REACTIVATED"
            : input.confirmation
              ? "CONFIRMATION_RECORDED"
              : "STAGE_CHANGED",
      reason: input.reason,
      source: input.source,
      idempotencyKey: key,
      metadata: {
        ...(input.confirmation ? { confirmation: input.confirmation } : {}),
        ...(input.metadata ?? {}),
        requestFingerprint,
      },
    });
    return updated;
  };
  return transaction ? transition(transaction) : db.transaction(transition);
}

export async function updateOpportunity(input: {
  opportunityId: number;
  actor: OpportunityActor;
  ownerUserId?: number | null;
  contactStatus?: ContactStatus;
  nextTaskType?: OpportunityTaskType | null;
  nextTaskText?: string | null;
  nextTaskAt?: Date | null;
  offerInterestStatus?: OfferInterestStatus;
  eligibilityStatus?: EligibilityStatus;
  nextBestAction?: string | null;
  humanCaseReference?: string | null;
  decisionRunId?: number | null;
  source?: string;
  idempotencyKey?: string;
  expectedVersion?: number;
  markInteraction?: boolean;
  eventType?: (typeof OPPORTUNITY_EVENT_TYPES)[number];
}): Promise<CommercialOpportunity> {
  assertTaskType(input.nextTaskType);
  assertGovernedFieldsActor(input.actor, {
    eligibilityStatus: input.eligibilityStatus,
    decisionRunId: input.decisionRunId,
    nextBestAction: input.nextBestAction,
    humanCaseReference: input.humanCaseReference,
  });
  const key = eventKey("update", input.actor, input.source ?? "CRM", input.idempotencyKey);
  const requestFingerprint = fingerprint(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM commercial_opportunities WHERE id = ${input.opportunityId} FOR UPDATE`);
    const [current] = await tx
      .select()
      .from(commercialOpportunities)
      .where(eq(commercialOpportunities.id, input.opportunityId))
      .limit(1);
    if (!current) throw new OpportunityRuleError("Opportunity not found.", "NOT_FOUND", 404);
    const priorEvent = await tx
      .select()
      .from(commercialOpportunityEvents)
      .where(
        and(
          eq(commercialOpportunityEvents.opportunityId, input.opportunityId),
          eq(commercialOpportunityEvents.idempotencyKey, key),
        ),
      )
      .limit(1);
    if (priorEvent.length) {
      if (priorEvent[0].metadata?.requestFingerprint !== requestFingerprint) {
        throw new OpportunityRuleError("Idempotency key was already used with a different request.", "IDEMPOTENCY_KEY_REUSED", 409);
      }
      return current;
    }
    assertExpectedOpportunityVersion(current.version, input.expectedVersion);

    const patch = {
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.ownerUserId != null ? { ownerSystem: null } : {}),
      ...(input.contactStatus !== undefined ? { contactStatus: input.contactStatus } : {}),
      ...(input.nextTaskType !== undefined ? { nextTaskType: input.nextTaskType } : {}),
      ...(input.nextTaskText !== undefined ? { nextTaskText: input.nextTaskText?.trim() || null } : {}),
      ...(input.nextTaskAt !== undefined ? { nextTaskAt: input.nextTaskAt } : {}),
      ...(input.offerInterestStatus !== undefined ? { offerInterestStatus: input.offerInterestStatus } : {}),
      ...(input.eligibilityStatus !== undefined ? { eligibilityStatus: input.eligibilityStatus } : {}),
      ...(input.nextBestAction !== undefined ? { nextBestAction: input.nextBestAction?.trim() || null } : {}),
      ...(input.humanCaseReference !== undefined ? { humanCaseReference: input.humanCaseReference?.trim() || null } : {}),
      ...(input.decisionRunId !== undefined ? { decisionRunId: input.decisionRunId } : {}),
      ...(input.markInteraction || input.contactStatus !== undefined
        ? { lastInteractionAt: new Date() }
        : {}),
      version: sql`${commercialOpportunities.version} + 1`,
      updatedAt: new Date(),
    };
    const candidate = {
      stage: current.stage,
      ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : current.ownerUserId,
      // Só preserva uma responsabilidade já existente; não permite remover um vendedor.
      allowUnowned: current.ownerUserId === null && current.ownerSystem === "SOFIA",
      nextTaskType: input.nextTaskType !== undefined ? input.nextTaskType : current.nextTaskType,
      nextTaskText: input.nextTaskText !== undefined ? input.nextTaskText : current.nextTaskText,
      nextTaskAt: input.nextTaskAt !== undefined ? input.nextTaskAt : current.nextTaskAt,
    };
    assertActiveOpportunityFields(candidate);
    const [updated] = await tx
      .update(commercialOpportunities)
      .set(patch)
      .where(eq(commercialOpportunities.id, input.opportunityId))
      .returning();
    if (!updated) throw new OpportunityRuleError("Opportunity not found.", "NOT_FOUND", 404);
    await appendEvent(tx, {
      opportunityId: updated.id,
      actor: input.actor,
      fromStage: current.stage,
      eventType: input.eventType ?? (input.ownerUserId !== undefined ? "OWNER_CHANGED" : input.nextTaskType !== undefined || input.nextTaskText !== undefined || input.nextTaskAt !== undefined ? "TASK_UPDATED" : input.contactStatus !== undefined ? "CONTACT_UPDATED" : "UPDATED"),
      source: input.source,
      idempotencyKey: key,
      metadata: {
        fields: Object.keys(patch).filter((field) => field !== "version" && field !== "updatedAt"),
        requestFingerprint,
      },
    });
    return updated;
  });
}

/**
 * Atribui o cartão sem responsável à pessoa logada. A condição "ainda sem
 * responsável" é verificada sob `FOR UPDATE`, então quando dois atendentes
 * clicam ao mesmo tempo só o primeiro vence; o segundo recebe 409 e nada é
 * sobrescrito. A próxima ação existente não é tocada.
 */
export async function claimOpportunity(input: {
  opportunityId: number;
  actor: OpportunityActor;
  source?: string;
  idempotencyKey?: string;
}): Promise<CommercialOpportunity> {
  const claimantId = input.actor.id;
  if (input.actor.kind !== "HUMAN" || !claimantId) {
    throw new OpportunityRuleError(
      "Only an authenticated staff member can claim an opportunity.",
      "CLAIM_REQUIRES_HUMAN",
      403,
    );
  }
  const key = eventKey("claim", input.actor, input.source ?? "CRM", input.idempotencyKey);
  const requestFingerprint = fingerprint({ opportunityId: input.opportunityId, claimantId });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM commercial_opportunities WHERE id = ${input.opportunityId} FOR UPDATE`);
    const [current] = await tx
      .select()
      .from(commercialOpportunities)
      .where(eq(commercialOpportunities.id, input.opportunityId))
      .limit(1);
    if (!current) throw new OpportunityRuleError("Opportunity not found.", "NOT_FOUND", 404);
    const [priorEvent] = await tx
      .select()
      .from(commercialOpportunityEvents)
      .where(
        and(
          eq(commercialOpportunityEvents.opportunityId, input.opportunityId),
          eq(commercialOpportunityEvents.idempotencyKey, key),
        ),
      )
      .limit(1);
    if (priorEvent) {
      if (priorEvent.metadata?.requestFingerprint !== requestFingerprint) {
        throw new OpportunityRuleError("Idempotency key was already used with a different request.", "IDEMPOTENCY_KEY_REUSED", 409);
      }
      return current;
    }
    if (!isActiveOpportunityStage(current.stage)) {
      throw new OpportunityRuleError("Closed opportunities cannot be claimed.", "OPPORTUNITY_CLOSED", 409);
    }
    if (current.ownerUserId === claimantId) return current;
    if (current.ownerUserId !== null) {
      throw new OpportunityRuleError(
        "Opportunity was already claimed by another user.",
        "OPPORTUNITY_ALREADY_CLAIMED",
        409,
      );
    }
    const [updated] = await tx
      .update(commercialOpportunities)
      .set({
        ownerUserId: claimantId,
        version: sql`${commercialOpportunities.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(commercialOpportunities.id, input.opportunityId),
          isNull(commercialOpportunities.ownerUserId),
        ),
      )
      .returning();
    if (!updated) {
      throw new OpportunityRuleError(
        "Opportunity was already claimed by another user.",
        "OPPORTUNITY_ALREADY_CLAIMED",
        409,
      );
    }
    await appendEvent(tx, {
      opportunityId: updated.id,
      actor: input.actor,
      fromStage: current.stage,
      eventType: "OWNER_CHANGED",
      source: input.source,
      idempotencyKey: key,
      metadata: {
        claimed: true,
        fields: ["ownerUserId"],
        previousOwnerUserId: null,
        ownerUserId: claimantId,
        requestFingerprint,
      },
    });
    return updated;
  });
}

export async function completeOpportunityTask(input: {
  opportunityId: number;
  actor: OpportunityActor;
  source?: string;
  idempotencyKey?: string;
  nextTaskType: OpportunityTaskType;
  nextTaskText: string;
  nextTaskAt: Date;
  expectedVersion?: number;
}): Promise<CommercialOpportunity> {
  return updateOpportunity({
    opportunityId: input.opportunityId,
    actor: input.actor,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    nextTaskType: input.nextTaskType,
    nextTaskText: input.nextTaskText,
    nextTaskAt: input.nextTaskAt,
    expectedVersion: input.expectedVersion,
    markInteraction: true,
    eventType: "TASK_COMPLETED",
  });
}

/**
 * Returns typed, server-resolvable confirmation choices. Free-form operational
 * references are deliberately not exposed: an operational registration is
 * only offered when it matches the exact pessoa, nucleus and offer class.
 */
export async function getConfirmationEvidenceOptions(
  opportunityId: number,
  options?: { includeHumanAdmin?: boolean },
): Promise<{ opportunityId: number; options: ConfirmationEvidenceOption[] }> {
  const [opportunity] = await db
    .select({
      id: commercialOpportunities.id,
      pessoaId: commercialOpportunities.pessoaId,
      nucleus: commercialOpportunities.nucleus,
      cursosInscricaoId: commercialOpportunities.cursosInscricaoId,
      classId: cursosInscricao.classId,
      offerNucleus: cursosInscricao.nucleo,
    })
    .from(commercialOpportunities)
    .leftJoin(cursosInscricao, eq(commercialOpportunities.cursosInscricaoId, cursosInscricao.id))
    .where(eq(commercialOpportunities.id, opportunityId))
    .limit(1);
  if (!opportunity) throw new OpportunityRuleError("Opportunity not found.", "NOT_FOUND", 404);

  const evidenceOptions: ConfirmationEvidenceOption[] = options?.includeHumanAdmin
    ? [{
        kind: "HUMAN_ADMIN",
        label: "Authorized administrator confirmation",
      }]
    : [];
  if (
    (opportunity.nucleus === "EDUCATION" || opportunity.nucleus === "EXPERIENCES") &&
    opportunity.offerNucleus === opportunity.nucleus &&
    opportunity.classId
  ) {
    const enrollments = await db
      .select({
        id: enrollmentsTable.id,
        classId: enrollmentsTable.classId,
        paymentStatus: enrollmentsTable.paymentStatus,
        contractStatus: enrollmentsTable.contractStatus,
      })
      .from(enrollmentsTable)
      .where(and(
        eq(enrollmentsTable.pessoaId, opportunity.pessoaId),
        eq(enrollmentsTable.classId, opportunity.classId),
        or(
          eq(enrollmentsTable.paymentStatus, "paid"),
          eq(enrollmentsTable.paymentStatus, "installments"),
          eq(enrollmentsTable.contractStatus, "signed"),
        ),
      ))
      .orderBy(desc(enrollmentsTable.createdAt));
    const kind =
      opportunity.nucleus === "EDUCATION"
        ? "ENROLLMENT" as const
        : "EXPERIENCE_REGISTRATION" as const;
    evidenceOptions.unshift(...enrollments.map((enrollment) => ({
      kind,
      id: enrollment.id,
      label: opportunity.nucleus === "EDUCATION"
        ? `Education enrollment #${enrollment.id}`
        : `Experiences registration #${enrollment.id}`,
    })));
  }
  return { opportunityId, options: evidenceOptions };
}

/** Grupo do formulário de interesse: o que vem depois de "interesse-geral:" na identidade da oferta. */
// Função, não constante: é avaliada só quando a consulta é montada (a tabela precisa existir no import).
const grupoDoCartao = () => sql<string | null>`CASE WHEN ${commercialOpportunities.offerIdentity} LIKE 'interesse-geral:%' THEN substring(${commercialOpportunities.offerIdentity} from 17) END`;

function origemDoCartao(row: {
  grupo: string | null;
  evento: { id: number; name: string } | null;
  curso: { id: number; name: string } | null;
}): OpportunityBoardRow["origem"] {
  return {
    grupo: row.grupo,
    grupoLabel: row.grupo ? interestGroupLabel(row.grupo === "geral" ? null : row.grupo) : null,
    curso: row.curso?.id ? row.curso : null,
    evento: row.evento?.id ? row.evento : null,
  };
}

/** Opções dos filtros do CRM: só o que existe em algum cartão (de qualquer etapa). */
export async function listOpportunityFilterOptions(): Promise<{
  grupos: Array<{ value: string; label: string | null }>;
  cursos: Array<{ id: number; name: string }>;
  eventos: Array<{ id: number; name: string; cursoId: number | null }>;
}> {
  const [grupos, eventos] = await Promise.all([
    db.selectDistinct({ grupo: grupoDoCartao() }).from(commercialOpportunities).where(sql`${grupoDoCartao()} IS NOT NULL`).orderBy(grupoDoCartao()),
    db.selectDistinct({ id: cursosInscricao.id, name: cursosInscricao.nome, cursoId: cursosInscricao.courseId, cursoName: coursesTable.name })
      .from(commercialOpportunities)
      .innerJoin(cursosInscricao, eq(cursosInscricao.id, commercialOpportunities.cursosInscricaoId))
      .leftJoin(coursesTable, eq(coursesTable.id, cursosInscricao.courseId))
      .orderBy(cursosInscricao.nome),
  ]);
  const cursos = new Map<number, string>();
  for (const evento of eventos) if (evento.cursoId !== null && evento.cursoName) cursos.set(evento.cursoId, evento.cursoName);
  return {
    grupos: grupos.flatMap(g => g.grupo ? [{ value: g.grupo, label: interestGroupLabel(g.grupo === "geral" ? null : g.grupo) }] : []),
    cursos: [...cursos].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    eventos: eventos.map(e => ({ id: e.id, name: e.name, cursoId: e.cursoId })),
  };
}

export async function listOpportunities(filters: {
  stage?: OpportunityStage;
  nucleus?: OpportunityNucleus;
  ownerUserId?: number;
  /** Só cartões sem responsável (interesses abertos pela Sofia que ninguém assumiu). */
  unassigned?: boolean;
  search?: string;
  includeClosed?: boolean;
  /** Grupo do formulário de interesse ("geral" = sem grupo). */
  grupo?: string;
  cursoId?: number;
  eventoId?: number;
}): Promise<OpportunityBoardRow[]> {
  const where = [];
  if (filters.grupo) where.push(sql`${grupoDoCartao()} = ${filters.grupo}`);
  if (filters.cursoId) where.push(eq(coursesTable.id, filters.cursoId));
  if (filters.eventoId) where.push(eq(commercialOpportunities.cursosInscricaoId, filters.eventoId));
  if (filters.stage) where.push(eq(commercialOpportunities.stage, filters.stage));
  if (filters.nucleus) where.push(eq(commercialOpportunities.nucleus, filters.nucleus));
  if (filters.unassigned) where.push(isNull(commercialOpportunities.ownerUserId));
  else if (filters.ownerUserId) where.push(eq(commercialOpportunities.ownerUserId, filters.ownerUserId));
  if (!filters.includeClosed) where.push(sql`${commercialOpportunities.stage} <> 'CLOSED'`);
  if (filters.search?.trim()) {
    const pattern = `%${filters.search.trim()}%`;
    where.push(
      or(
        ilike(commercialOpportunities.offerLabel, pattern),
        ilike(commercialOpportunities.humanCaseReference, pattern),
        exists(
          db
            .select({ id: pessoasTable.id })
            .from(pessoasTable)
            .where(
              and(
                eq(pessoasTable.id, commercialOpportunities.pessoaId),
                or(
                  ilike(pessoasTable.nome, pattern),
                  ilike(pessoasTable.sobrenome, pattern),
                ),
              ),
            ),
        ),
      ),
    );
  }
  const rows = await db
    .select({
      opportunity: commercialOpportunities,
      person: {
        id: pessoasTable.id,
        name: sql<string>`${pessoasTable.nome} || CASE WHEN ${pessoasTable.sobrenome} IS NULL THEN '' ELSE ' ' || ${pessoasTable.sobrenome} END`,
        email: pessoasTable.email,
        phone: pessoasTable.celular,
      },
      owner: {
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      },
      grupo: grupoDoCartao(),
      evento: { id: cursosInscricao.id, name: cursosInscricao.nome },
      curso: { id: coursesTable.id, name: coursesTable.name },
    })
    .from(commercialOpportunities)
    .innerJoin(pessoasTable, eq(commercialOpportunities.pessoaId, pessoasTable.id))
    .leftJoin(usersTable, eq(commercialOpportunities.ownerUserId, usersTable.id))
    .leftJoin(cursosInscricao, eq(cursosInscricao.id, commercialOpportunities.cursosInscricaoId))
    .leftJoin(coursesTable, eq(coursesTable.id, cursosInscricao.courseId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(commercialOpportunities.updatedAt));
  const pessoaIds = rows.map((row) => row.opportunity.pessoaId);
  const handoffs = pessoaIds.length
    ? await db
      .select({ pessoaId: conversations.pessoaId })
      .from(conversations)
      .where(and(
        inArray(conversations.pessoaId, pessoaIds),
        or(eq(conversations.status, "aguardando_humano"), eq(conversations.status, "atendimento_humano")),
      ))
    : [];
  const handoffPessoaIds = new Set(handoffs.map((row) => row.pessoaId));
  return rows.map((row) => ({
    ...row.opportunity,
    person: row.person,
    owner: row.owner,
    origem: origemDoCartao(row),
    sofia: {
      eligibilityStatus: row.opportunity.eligibilityStatus,
      nextBestAction: row.opportunity.nextBestAction,
      decisionRunId: row.opportunity.decisionRunId,
      handoffActive: handoffPessoaIds.has(row.opportunity.pessoaId),
    },
  }));
}

export async function getOpportunityDetail(id: number): Promise<{
  opportunity: OpportunityBoardRow;
  events: Array<typeof commercialOpportunityEvents.$inferSelect & { actorName: string | null }>;
} | null> {
  const [row] = await db
    .select({
      opportunity: commercialOpportunities,
      person: {
        id: pessoasTable.id,
        name: sql<string>`${pessoasTable.nome} || CASE WHEN ${pessoasTable.sobrenome} IS NULL THEN '' ELSE ' ' || ${pessoasTable.sobrenome} END`,
        email: pessoasTable.email,
        phone: pessoasTable.celular,
      },
      owner: {
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      },
      grupo: grupoDoCartao(),
      evento: { id: cursosInscricao.id, name: cursosInscricao.nome },
      curso: { id: coursesTable.id, name: coursesTable.name },
    })
    .from(commercialOpportunities)
    .innerJoin(pessoasTable, eq(commercialOpportunities.pessoaId, pessoasTable.id))
    .leftJoin(usersTable, eq(commercialOpportunities.ownerUserId, usersTable.id))
    .leftJoin(cursosInscricao, eq(cursosInscricao.id, commercialOpportunities.cursosInscricaoId))
    .leftJoin(coursesTable, eq(coursesTable.id, cursosInscricao.courseId))
    .where(eq(commercialOpportunities.id, id))
    .limit(1);
  if (!row) return null;
  const [handoff] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(
      eq(conversations.pessoaId, row.opportunity.pessoaId),
      or(eq(conversations.status, "aguardando_humano"), eq(conversations.status, "atendimento_humano")),
    ))
    .limit(1);
  // O nome de quem agiu vem do usuário, também nas entradas antigas (só tinham o id do ator).
  const eventRows = await db
    .select({ event: commercialOpportunityEvents, actorName: usersTable.name })
    .from(commercialOpportunityEvents)
    .leftJoin(usersTable, and(eq(usersTable.id, commercialOpportunityEvents.actorId), eq(commercialOpportunityEvents.actorKind, "HUMAN")))
    .where(eq(commercialOpportunityEvents.opportunityId, id))
    .orderBy(desc(commercialOpportunityEvents.createdAt), desc(commercialOpportunityEvents.id));
  // O envio do modelo de abertura fica no histórico uma vez só; o estado de entrega (aceito, enviado,
  // entregue, lido ou falhou) muda depois, então é lido agora e vai junto, sem ser gravado no evento.
  const idsDasMensagens = eventRows
    .map(({ event }) => (event.metadata as Record<string, unknown> | null))
    .filter(meta => meta?.action === "TEMPLATE_SENT" && typeof meta.messageId === "number")
    .map(meta => meta!.messageId as number);
  const entregas = idsDasMensagens.length > 0
    ? await entregaDasMensagens(inArray(canalEnvios.messageId, idsDasMensagens))
    : new Map<number, { status: string; erro: string | null }>();
  const events = eventRows.map(({ event, actorName }) => {
    const meta = event.metadata as Record<string, unknown> | null;
    const entrega = meta?.action === "TEMPLATE_SENT" && typeof meta.messageId === "number" ? entregas.get(meta.messageId) : undefined;
    return {
      ...event,
      actorName: actorName ?? null,
      ...(entrega ? { metadata: { ...meta, delivery: { status: entrega.status, error: traduzirErroDeEnvio(entrega.erro) } } } : {}),
    };
  });
  return {
    opportunity: {
      ...row.opportunity,
      person: row.person,
      owner: row.owner,
      origem: origemDoCartao(row),
      sofia: {
        eligibilityStatus: row.opportunity.eligibilityStatus,
        nextBestAction: row.opportunity.nextBestAction,
        decisionRunId: row.opportunity.decisionRunId,
        handoffActive: Boolean(handoff),
      },
    },
    events,
  };
}
