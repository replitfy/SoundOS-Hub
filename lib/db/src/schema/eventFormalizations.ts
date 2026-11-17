import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { cursosInscricao, pessoasTable } from "./pessoas";
import { usersTable } from "./users";
import { enrollmentsTable } from "./enrollments";
import { commercialOpportunities } from "./commercialOpportunities";
import { eventoFormularioSubmissoes } from "./eventForms";
import { classesTable } from "./classes";

export const eventFormalizations = pgTable("event_formalizations", {
  id: serial("id").primaryKey(),
  eventoId: integer("evento_id").notNull().references(() => cursosInscricao.id),
  classId: integer("class_id").notNull().references(() => classesTable.id),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id),
  opportunityId: integer("opportunity_id").references(() => commercialOpportunities.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  reference: text("reference").notNull(),
  confirmedBy: integer("confirmed_by").notNull().references(() => usersTable.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  enrollmentId: integer("enrollment_id").references(() => enrollmentsTable.id),
  submissionId: integer("submission_id").references(() => eventoFormularioSubmissoes.id),
}, t => ({ eventPerson: uniqueIndex("event_formalizations_event_person_unique").on(t.eventoId, t.pessoaId) }));
