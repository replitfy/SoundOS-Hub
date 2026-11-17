import { pgTable, uuid, integer, text, timestamp, customType } from "drizzle-orm/pg-core";
import { knowledgeItemsTable } from "./knowledge_items";

export const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

export const knowledgeChunksTable = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  knowledgeItemId: integer("knowledge_item_id")
    .notNull()
    .references(() => knowledgeItemsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().default("default"),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  tokenCount: integer("token_count"),
  embedding: vector1536("embedding"),
  // search_vector is a GENERATED ALWAYS AS tsvector column — omitted here to avoid conflicts
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnowledgeChunk = typeof knowledgeChunksTable.$inferSelect;
