import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { messages } from "./messages";

// Canais externos da Sofia (Instagram e WhatsApp, ambos pelo Hablla). Criado por SQL nas
// migrações 035 e 038; os nomes aqui seguem os de lá para o drizzle-kit não ver diferença.

export const CANAIS_EXTERNOS = ["instagram", "whatsapp"] as const;
export type CanalExterno = typeof CANAIS_EXTERNOS[number];

export const HABLLA_EVENTO_STATUS = ["recebido", "respondido", "ignorado", "falhou"] as const;
export type HabllaEventoStatus = typeof HABLLA_EVENTO_STATUS[number];

/**
 * Estado de entrega de um envio. "enviado" é o estado do Instagram (aceito pelo Hablla);
 * no WhatsApp a ordem é aceito → enviado (Meta) → entregue → lido, e "falhou" é final.
 */
export const CANAL_ENVIO_STATUS = ["aceito", "enviado", "entregue", "lido", "falhou"] as const;
export type CanalEnvioStatus = typeof CANAL_ENVIO_STATUS[number];

/** Liga o id externo do contato (IGSID no Instagram, telefone no WhatsApp) a uma única conversa. */
export const canalContatos = pgTable("canal_contatos", {
  id: serial("id").primaryKey(),
  canal: text("canal").notNull().$type<CanalExterno>(),
  contatoExternoId: text("contato_externo_id").notNull(),
  usuario: text("usuario"),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("canal_contatos_canal_contato_key").on(table.canal, table.contatoExternoId),
  index("canal_contatos_conversation_idx").on(table.conversationId),
]);

/** Todo evento recebido do Hablla, com o payload bruto e o desfecho. */
export const habllaEventos = pgTable("hablla_eventos", {
  id: serial("id").primaryKey(),
  canal: text("canal").notNull().default("instagram").$type<CanalExterno>(),
  externoId: text("externo_id").notNull(),
  tipoEvento: text("tipo_evento"),
  payload: jsonb("payload").notNull().$type<unknown>(),
  status: text("status").notNull().default("recebido").$type<HabllaEventoStatus>(),
  motivo: text("motivo"),
  conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processadoEm: timestamp("processado_em", { withTimezone: true }),
}, table => [
  unique("hablla_eventos_externo_id_key").on(table.externoId),
  index("hablla_eventos_canal_created_idx").on(table.canal, table.createdAt.desc()),
]);

/** Cada resposta enviada ao contato por um canal externo (ou que falhou). */
export const canalEnvios = pgTable("canal_envios", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
  canal: text("canal").notNull().$type<CanalExterno>(),
  texto: text("texto"),
  status: text("status").notNull().$type<CanalEnvioStatus>(),
  erro: text("erro"),
  externoId: text("externo_id"),
  /** Id da fila de envio devolvido pelo Hablla no aceite (HTTP 202). Não é o id da mensagem. */
  filaId: text("fila_id"),
  /** Id da mensagem na Meta (wamid), usado para casar os eventos de status. */
  metaMessageId: text("meta_message_id"),
  entregaAtualizadaEm: timestamp("entrega_atualizada_em", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("canal_envios_conversation_idx").on(table.conversationId, table.createdAt),
  index("canal_envios_message_idx").on(table.messageId),
  index("canal_envios_fila_idx").on(table.canal, table.filaId).where(sql`fila_id IS NOT NULL`),
  index("canal_envios_meta_message_idx").on(table.canal, table.metaMessageId).where(sql`meta_message_id IS NOT NULL`),
]);

/** Linha única (id = 1). Ausente = "Sofia não responde" e nenhum token configurado. */
export const habllaConfig = pgTable("hablla_config", {
  id: integer("id").primaryKey().default(1),
  instagramResponde: boolean("instagram_responde").notNull().default(false),
  webhookTokenHash: text("webhook_token_hash"),
  webhookTokenGeradoEm: timestamp("webhook_token_gerado_em", { withTimezone: true }),
  whatsappResponde: boolean("whatsapp_responde").notNull().default(false),
  // A Sofia manda o modelo de abertura a quem preenche o formulário de interesse e consentiu. Desligada por padrão.
  sofiaIniciaConversa: boolean("sofia_inicia_conversa").notNull().default(false),
  whatsappWebhookTokenHash: text("whatsapp_webhook_token_hash"),
  whatsappWebhookTokenGeradoEm: timestamp("whatsapp_webhook_token_gerado_em", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type CanalContato = typeof canalContatos.$inferSelect;
export type HabllaEvento = typeof habllaEventos.$inferSelect;
export type CanalEnvio = typeof canalEnvios.$inferSelect;
export type HabllaConfigRow = typeof habllaConfig.$inferSelect;
