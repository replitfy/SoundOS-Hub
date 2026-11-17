import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pessoasTable } from "./pessoas";

/**
 * Append-only notes created by identity reconciliation. Notes preserve contact
 * values that did not win the merge and always retain their source attribution.
 */
export const pessoaNotes = pgTable("pessoa_notes", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  sourcePessoaId: integer("source_pessoa_id").references(() => pessoasTable.id, { onDelete: "set null" }),
  noteType: text("note_type").notNull().default("merge_contact"),
  contactType: text("contact_type"),
  value: text("value").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pessoaIdx: index("pessoa_notes_pessoa_idx").on(table.pessoaId, table.createdAt),
}));

export type PessoaNote = typeof pessoaNotes.$inferSelect;
export const insertPessoaNoteSchema = createInsertSchema(pessoaNotes).omit({ id: true, createdAt: true });
export type InsertPessoaNote = z.infer<typeof insertPessoaNoteSchema>;