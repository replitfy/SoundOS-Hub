import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Catálogo de vídeos importado da planilha "link_d_videos" (Documento 12).
// Cada item só pode ser sugerido pela Sofia quando tem link real do YouTube
// E foi explicitamente aprovado por um humano (aprovadoParaSofia = true).
export const videosTable = pgTable("videos", {
  id: serial("id").primaryKey(),
  ref: text("ref"),
  // Código estável usado pela Sofia e pela reimportação de planilha para
  // identificar o vídeo (upsert). Único quando presente; vídeos antigos
  // importados antes deste campo existir podem não ter um ainda.
  codigo: text("codigo").unique(),
  titulo: text("titulo").notNull(),
  descricao: text("descricao"),
  tipo: text("tipo"),
  curso: text("curso"),
  duracao: text("duracao"),
  link: text("link"),
  temLinkReal: boolean("tem_link_real").notNull().default(false),
  aprovadoParaSofia: boolean("aprovado_para_sofia").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVideoSchema = createInsertSchema(videosTable).omit({ id: true, createdAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type Video = typeof videosTable.$inferSelect;
