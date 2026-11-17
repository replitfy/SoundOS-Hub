import { pgTable, serial, text, integer, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const classesTable = pgTable("classes", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull(),
  code: text("code").notNull(),
  location: text("location"),
  // Cargas históricas podem preservar a turma sem inventar um dia que a
  // fonte não informa. Turmas operacionais continuam exigindo datas na API.
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  capacity: integer("capacity").notNull().default(20),
  teacher: text("teacher").notNull(),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertClassSchema = createInsertSchema(classesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClass = z.infer<typeof insertClassSchema>;
export type Class = typeof classesTable.$inferSelect;
