import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { DEFAULT_SOFIA_MODEL_ID } from "@workspace/sofia-models";

export const promptsTable = pgTable("prompts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  version: text("version").notNull(),
  model: text("model").notNull().default(DEFAULT_SOFIA_MODEL_ID),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPromptSchema = createInsertSchema(promptsTable).omit({ id: true, createdAt: true });
export type InsertPrompt = z.infer<typeof insertPromptSchema>;
export type Prompt = typeof promptsTable.$inferSelect;
