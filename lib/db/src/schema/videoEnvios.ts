import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";
import { messages } from "./messages";
import { pessoasTable } from "./pessoas";
import { videosTable } from "./videos";

// Registro de envio real (Documento 12 / tarefa "quais vídeos a Sofia
// realmente manda para os leads"): a tool `recommendVideos` pode retornar até
// 2 candidatos, mas só contam como "enviados" os que de fato aparecem no
// texto final que chega até a pessoa (depois de todos os gates de
// elegibilidade). Guardamos um snapshot (código/título/link) além da FK para
// que o histórico continue legível mesmo se o vídeo for editado/excluído do
// catálogo depois.
export const videoEnvios = pgTable("video_envios", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  messageId: integer("message_id")
    .references(() => messages.id, { onDelete: "set null" }),
  pessoaId: integer("pessoa_id").references(() => pessoasTable.id),
  videoId: integer("video_id").references(() => videosTable.id, { onDelete: "set null" }),
  codigo: text("codigo"),
  titulo: text("titulo").notNull(),
  link: text("link").notNull(),
  curso: text("curso"),
  tipo: text("tipo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVideoEnvioSchema = createInsertSchema(videoEnvios).omit({ id: true, createdAt: true });
export type InsertVideoEnvio = z.infer<typeof insertVideoEnvioSchema>;
export type VideoEnvio = typeof videoEnvios.$inferSelect;
