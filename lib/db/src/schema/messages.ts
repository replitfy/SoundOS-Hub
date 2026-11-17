import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";
import { usersTable } from "./users";

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  // Conduta ativa da Sofia no momento desta mensagem (Documento 14/15): "triagem"
  // enquanto ela ainda está entendendo a pessoa, "comercial" a partir do momento
  // em que há confiança e elegibilidade suficientes para orientar/recomendar.
  // Null quando não se aplica (ex.: conversa já congelada em handoff).
  conduta: text("conduta").$type<"triagem" | "comercial" | null>(),
  // Mensagem escrita pela equipe: role "staff" e o autor. O modelo de abertura enviado pela equipe
  // fica como role "assistant" (a Sofia o vê como contexto) com kind "modelo_abertura" e o autor.
  // "anexo": mensagem com arquivo (content é a legenda, que pode ser vazia; o registro fica em
  // mensagem_anexos). "aviso_anexo": a frase fixa com que a Sofia avisa que não vê arquivos.
  authorUserId: integer("author_user_id").references(() => usersTable.id),
  kind: text("kind").$type<"modelo_abertura" | "anexo" | "aviso_anexo" | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
