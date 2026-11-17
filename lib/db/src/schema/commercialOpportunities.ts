import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { pessoasTable, cursosInscricao } from "./pessoas";
import { usersTable } from "./users";
import { decisionRuns } from "./decisionRuns";

export const OPPORTUNITY_STAGES = [
  "NEW_INTEREST",
  "CONTACT_STARTED",
  "QUALIFYING",
  "PATH_IDENTIFIED",
  "DECIDING",
  "ENROLLMENT_RESERVATION_IN_PROGRESS",
  "CONFIRMED",
  "NURTURE",
  "CLOSED",
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPPORTUNITY_NUCLEI = ["EDUCATION", "EXPERIENCES"] as const;
export type OpportunityNucleus = (typeof OPPORTUNITY_NUCLEI)[number];

export const CONTACT_STATUSES = [
  "NOT_STARTED",
  "ATTEMPTED",
  "REACHED",
  "UNREACHABLE",
  "OPTED_OUT",
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const OFFER_INTEREST_STATUSES = [
  "UNKNOWN",
  "INTERESTED",
  "NOT_INTERESTED",
] as const;
export type OfferInterestStatus = (typeof OFFER_INTEREST_STATUSES)[number];

export const ELIGIBILITY_STATUSES = [
  "UNKNOWN",
  "ELIGIBLE",
  "INELIGIBLE",
  "HUMAN_REVIEW",
] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const OPPORTUNITY_TASK_TYPES = [
  "CALL",
  "WHATSAPP",
  "EMAIL",
  "MEETING",
  "INTERNAL",
  "NONE",
] as const;
export type OpportunityTaskType = (typeof OPPORTUNITY_TASK_TYPES)[number];

export const OPPORTUNITY_ACTOR_KINDS = ["HUMAN", "SOFIA", "SYSTEM"] as const;
export type OpportunityActorKind = (typeof OPPORTUNITY_ACTOR_KINDS)[number];

export const OPPORTUNITY_EVENT_TYPES = [
  "CREATED",
  "STAGE_CHANGED",
  "TASK_UPDATED",
  "TASK_COMPLETED",
  "OWNER_CHANGED",
  "CONTACT_UPDATED",
  "PAUSED",
  "REACTIVATED",
  "CLOSED",
  "CONFIRMATION_RECORDED",
  "UPDATED",
] as const;
export type OpportunityEventType = (typeof OPPORTUNITY_EVENT_TYPES)[number];

/**
 * Commercial pipeline projection. `offerIdentity` is deliberately persisted
 * rather than derived in a query: it gives PostgreSQL a race-safe, partial
 * unique index for the active-offer invariant.
 */
export const commercialOpportunities = pgTable(
  "commercial_opportunities",
  {
    id: serial("id").primaryKey(),
    pessoaId: integer("pessoa_id")
      .notNull()
      .references(() => pessoasTable.id, { onDelete: "restrict" }),
    nucleus: text("nucleus").notNull().$type<OpportunityNucleus>(),
    cursosInscricaoId: integer("cursos_inscricao_id").references(
      () => cursosInscricao.id,
      { onDelete: "set null" },
    ),
    offerLabel: text("offer_label"),
    offerIdentity: text("offer_identity").notNull(),
    ownerUserId: integer("owner_user_id").references(() => usersTable.id, {
      onDelete: "restrict",
    }),
    ownerSystem: text("owner_system").$type<"SOFIA">(),
    stage: text("stage")
      .notNull()
      .default("NEW_INTEREST")
      .$type<OpportunityStage>(),
    contactStatus: text("contact_status")
      .notNull()
      .default("NOT_STARTED")
      .$type<ContactStatus>(),
    nextTaskType: text("next_task_type").$type<OpportunityTaskType>(),
    nextTaskText: text("next_task_text"),
    nextTaskAt: timestamp("next_task_at", { withTimezone: true }),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    offerInterestStatus: text("offer_interest_status")
      .notNull()
      .default("UNKNOWN")
      .$type<OfferInterestStatus>(),
    eligibilityStatus: text("eligibility_status")
      .notNull()
      .default("UNKNOWN")
      .$type<EligibilityStatus>(),
    nextBestAction: text("next_best_action"),
    decisionRunId: integer("decision_run_id").references(() => decisionRuns.id, {
      onDelete: "set null",
    }),
    humanCaseReference: text("human_case_reference"),
    // Texto livre e editável do card (a edição fica no histórico, sem subir a versão).
    informacoes: text("informacoes"),
    pauseReason: text("pause_reason"),
    closeReason: text("close_reason"),
    source: text("source").notNull().default("CRM"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    activeOffer: uniqueIndex("commercial_opportunities_active_offer_unique")
      .on(table.pessoaId, table.nucleus, table.offerIdentity)
      .where(sql`${table.stage} <> 'CLOSED'`),
    pessoaIdx: index("commercial_opportunities_pessoa_idx").on(table.pessoaId),
    boardIdx: index("commercial_opportunities_board_idx").on(
      table.stage,
      table.nextTaskAt,
    ),
    ownerIdx: index("commercial_opportunities_owner_idx").on(table.ownerUserId),
  }),
);

export const commercialOpportunityEvents = pgTable(
  "commercial_opportunity_events",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => commercialOpportunities.id, { onDelete: "restrict" }),
    actorKind: text("actor_kind")
      .notNull()
      .$type<OpportunityActorKind>(),
    actorId: integer("actor_id").references(() => usersTable.id, {
      onDelete: "restrict",
    }),
    fromStage: text("from_stage").$type<OpportunityStage>(),
    toStage: text("to_stage").$type<OpportunityStage>(),
    eventType: text("event_type").notNull().$type<OpportunityEventType>(),
    reason: text("reason"),
    source: text("source").notNull().default("CRM"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotency: uniqueIndex("commercial_opportunity_events_idempotency_unique").on(
      table.opportunityId,
      table.idempotencyKey,
    ),
    opportunityTime: index("commercial_opportunity_events_opportunity_time_idx").on(
      table.opportunityId,
      table.createdAt,
    ),
  }),
);

export const commercialOpportunityRelations = relations(
  commercialOpportunities,
  ({ one, many }) => ({
    pessoa: one(pessoasTable, {
      fields: [commercialOpportunities.pessoaId],
      references: [pessoasTable.id],
    }),
    owner: one(usersTable, {
      fields: [commercialOpportunities.ownerUserId],
      references: [usersTable.id],
    }),
    offer: one(cursosInscricao, {
      fields: [commercialOpportunities.cursosInscricaoId],
      references: [cursosInscricao.id],
    }),
    events: many(commercialOpportunityEvents),
  }),
);

export const commercialOpportunityEventRelations = relations(
  commercialOpportunityEvents,
  ({ one }) => ({
    opportunity: one(commercialOpportunities, {
      fields: [commercialOpportunityEvents.opportunityId],
      references: [commercialOpportunities.id],
    }),
    actor: one(usersTable, {
      fields: [commercialOpportunityEvents.actorId],
      references: [usersTable.id],
    }),
  }),
);

// Conventional `*Table` aliases keep the schema ergonomic alongside the
// existing courses/classes/enrollments exports.
export const commercialOpportunitiesTable = commercialOpportunities;
export const commercialOpportunityEventsTable = commercialOpportunityEvents;

export type CommercialOpportunity = typeof commercialOpportunities.$inferSelect;
export type InsertCommercialOpportunity = typeof commercialOpportunities.$inferInsert;
export type CommercialOpportunityEvent =
  typeof commercialOpportunityEvents.$inferSelect;
export type InsertCommercialOpportunityEvent =
  typeof commercialOpportunityEvents.$inferInsert;