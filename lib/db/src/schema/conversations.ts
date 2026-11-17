import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { DEFAULT_SOFIA_MODEL_ID } from "@workspace/sofia-models";
import { pessoasTable } from "./pessoas";

// Handoff automático (Documento 14A, cap. 13): quando a Sofia identifica um
// gatilho (pedido explícito, sinais contraditórios, tema sensível, dúvida
// financeira complexa, necessidade de especialista) ela suspende ações
// automáticas naquela conversa e sinaliza que um humano precisa assumir.
export const CONVERSATION_STATUSES = [
  "ativa",              // Sofia conduzindo normalmente
  "aguardando_humano",  // handoff disparado, ninguém assumiu ainda
  "atendimento_humano", // um humano assumiu a conversa
] as const;
export type ConversationStatus = typeof CONVERSATION_STATUSES[number];

export const HANDOFF_REASONS = [
  "pedido_explicito",
  "confianca_baixa",
  "sinais_contraditorios",
  "tema_sensivel",
  "duvida_financeira",
  "especialista_necessario",
  // Gatilhos específicos da conduta comercial (Documento 15): a Sofia aciona o
  // handoff em vez de insistir quando esbarra em elegibilidade insuficiente ou
  // recebe um pedido de fechamento que exigiria dado comercial não autorizado
  // (preço, desconto, disponibilidade, parcelamento, cupom, link de checkout).
  "elegibilidade_insuficiente",
  "fechamento_comercial",
  "informacao_comercial_bloqueada",
  "oferta_sensivel",
] as const;
export type HandoffReason = typeof HANDOFF_REASONS[number];

export const CONVERSATION_CANAIS = ["interno", "instagram", "whatsapp"] as const;
export type ConversationCanal = typeof CONVERSATION_CANAIS[number];

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  hidden: boolean("hidden").notNull().default(false),
  model: text("model").notNull().default(DEFAULT_SOFIA_MODEL_ID),
  pessoaId: integer("pessoa_id").references(() => pessoasTable.id),
  status: text("status").notNull().default("ativa").$type<ConversationStatus>(),
  handoffReason: text("handoff_reason").$type<HandoffReason | null>(),
  // JSON serializado do resumo estruturado (intenção, evidências, confiança,
  // contexto sensível, próximos passos sugeridos) gerado no momento do handoff.
  handoffSummary: text("handoff_summary"),
  handoffTriggeredAt: timestamp("handoff_triggered_at", { withTimezone: true }),
  handoffResolvedAt: timestamp("handoff_resolved_at", { withTimezone: true }),
  handoffResolvedBy: text("handoff_resolved_by"),
  // Canal de origem: "interno" (chat do SoundOS) ou "instagram" (DM pelo Hablla).
  canal: text("canal").notNull().default("interno").$type<ConversationCanal>(),
  canalUsuario: text("canal_usuario"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
