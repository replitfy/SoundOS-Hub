import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { messages } from "./messages";
import { usersTable } from "./users";

// Anexos do WhatsApp (imagem, vídeo, áudio, documento): um por mensagem. O arquivo fica no armazenamento
// de arquivos do projeto, nunca no banco. Criado por SQL na migração 042; nomes e índices seguem os de lá
// para o drizzle-kit não ver diferença. A legenda é o texto da própria mensagem (messages.content).

export const ANEXO_TIPOS = ["image", "video", "audio", "document"] as const;
export type AnexoTipo = typeof ANEXO_TIPOS[number];

export const ANEXO_DIRECOES = ["recebido", "enviado"] as const;
export type AnexoDirecao = typeof ANEXO_DIRECOES[number];

/** pendente: ainda copiando; copiado: arquivo guardado; indisponivel: não deu para guardar (dá para tentar de novo); recusado: nunca será baixado. */
export const ANEXO_COPIA = ["pendente", "copiado", "indisponivel", "recusado"] as const;
export type AnexoCopia = typeof ANEXO_COPIA[number];

export const mensagemAnexos = pgTable("mensagem_anexos", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  direcao: text("direcao").notNull().$type<AnexoDirecao>(),
  tipo: text("tipo").notNull().$type<AnexoTipo>(),
  nome: text("nome"),
  mimeType: text("mime_type"),
  tamanhoBytes: bigint("tamanho_bytes", { mode: "number" }),
  sha256: text("sha256"),
  copia: text("copia").notNull().$type<AnexoCopia>(),
  /** Código do motivo (a tela traduz); nunca texto de erro do provedor. */
  motivo: text("motivo"),
  storageKey: text("storage_key"),
  /** Endereço no provedor, só enquanto a cópia ainda pode ser tentada de novo; nunca vai para log. */
  urlOrigem: text("url_origem"),
  externoId: text("externo_id"),
  vistoEm: timestamp("visto_em", { withTimezone: true }),
  vistoPor: integer("visto_por").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("mensagem_anexos_message_uq").on(table.messageId),
  uniqueIndex("mensagem_anexos_externo_uq").on(table.externoId).where(sql`direcao = 'recebido' AND externo_id IS NOT NULL`),
  index("mensagem_anexos_conversa_idx").on(table.conversationId),
  index("mensagem_anexos_nao_vistos_idx").on(table.conversationId).where(sql`direcao = 'recebido' AND visto_em IS NULL`),
]);

export type MensagemAnexo = typeof mensagemAnexos.$inferSelect;
