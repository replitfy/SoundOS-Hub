import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pessoasTable } from "./pessoas";

/**
 * Immutable merge event. Snapshots are intentionally JSON so the audit remains
 * useful even as the live pessoa schema evolves.
 */
export const pessoaMergeAudits = pgTable("pessoa_merge_audits", {
  id: serial("id").primaryKey(),
  sourcePessoaId: integer("source_pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "restrict" }),
  targetPessoaId: integer("target_pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "restrict" }),
  actorUserId: integer("actor_user_id"),
  reason: text("reason").notNull(),
  options: jsonb("options").notNull(),
  sourceSnapshot: jsonb("source_snapshot").notNull(),
  targetSnapshot: jsonb("target_snapshot").notNull(),
  resultSnapshot: jsonb("result_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sourceTargetUnique: uniqueIndex("pessoa_merge_audits_source_target_unique").on(table.sourcePessoaId, table.targetPessoaId),
}));

export type PessoaMergeAudit = typeof pessoaMergeAudits.$inferSelect;
export const insertPessoaMergeAuditSchema = createInsertSchema(pessoaMergeAudits).omit({ id: true, createdAt: true });
export type InsertPessoaMergeAudit = z.infer<typeof insertPessoaMergeAuditSchema>;