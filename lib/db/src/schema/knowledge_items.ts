import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const knowledgeItemsTable = pgTable("knowledge_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  sourceUrl: text("source_url"),
  tags: text("tags").default(""),
  indexStatus: text("index_status").notNull().default("indexed"),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  chunkCount: integer("chunk_count").default(0),
  contentHash: text("content_hash"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKnowledgeItemSchema = createInsertSchema(knowledgeItemsTable).omit({ id: true, createdAt: true });
export type InsertKnowledgeItem = z.infer<typeof insertKnowledgeItemSchema>;
export type KnowledgeItem = typeof knowledgeItemsTable.$inferSelect;
