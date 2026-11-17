import { pgTable, serial, text, boolean, integer, timestamp, primaryKey, foreignKey } from "drizzle-orm/pg-core";

import { videosTable } from "./videos";

// Aliases que a Sofia (modo simples) usa para resolver nomes informais de
// eventos ("workshop água" → Ciclo Água). O código traz a lista padrão; esta
// tabela acrescenta ou corrige, e ativo=false desliga um alias padrão.
export const sofiaEventAliasesTable = pgTable("sofia_event_aliases", {
  id: serial("id").primaryKey(),
  alias: text("alias").notNull().unique("sofia_event_aliases_alias_key"),
  eventoChave: text("evento_chave").notNull(),
  nomeLike: text("nome_like"),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Vínculo explícito entre vídeo aprovado e evento. Sem vínculo, a Sofia cai
// para `videos.curso`. `principal` é escolha do dono.
export const videoEventosTable = pgTable("video_eventos", {
  videoId: integer("video_id").notNull(),
  eventoChave: text("evento_chave").notNull(),
  principal: boolean("principal").notNull().default(false),
  ordem: integer("ordem").notNull().default(0),
}, table => [
  // Nomes iguais aos da migração 033, para o drizzle-kit não enxergar diferença.
  primaryKey({ name: "video_eventos_pkey", columns: [table.videoId, table.eventoChave] }),
  foreignKey({ name: "video_eventos_video_id_fkey", columns: [table.videoId], foreignColumns: [videosTable.id] })
    .onDelete("cascade"),
]);

export type SofiaEventAliasRow = typeof sofiaEventAliasesTable.$inferSelect;
export type VideoEventoRow = typeof videoEventosTable.$inferSelect;
