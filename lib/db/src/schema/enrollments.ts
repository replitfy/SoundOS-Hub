import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const enrollmentsTable = pgTable("enrollments", {
  id: serial("id").primaryKey(),
  // O aluno é uma `pessoa` do CRM. A tabela `students` que existia aqui foi
  // migrada para `pessoas` (migration 014) — não há mais cadastro paralelo.
  pessoaId: integer("pessoa_id").notNull(),
  classId: integer("class_id").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  paymentStatus: text("payment_status").notNull().default("pending"),
  contractStatus: text("contract_status").notNull().default("pending"),
  hotmartAccessStatus: text("hotmart_access_status"),
  invoiceStatus: text("invoice_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertEnrollmentSchema = createInsertSchema(enrollmentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEnrollment = z.infer<typeof insertEnrollmentSchema>;
export type Enrollment = typeof enrollmentsTable.$inferSelect;
