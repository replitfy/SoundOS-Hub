// Motor de decisão da Sofia (Documento 14A) — registro auditável de cada
// decisão relevante: quais evidências foram usadas, qual elegibilidade foi
// avaliada, qual Next Best Action foi escolhida (sempre uma categoria
// oficial, nunca texto livre) e com que confiança/versão de prompt/modelo.
//
// Escopo desta task: regras qualitativas de elegibilidade por pré-requisito
// de módulo já conhecidas (Água → Fogo → Ar → Terra) e classificação de NBA.
// Scoring cognitivo quantitativo por dimensão (Documentos 03A/06B) fica de
// fora até esses documentos existirem — não inventamos pontuação aqui.

import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { pessoasTable } from "./pessoas";
import { conversations } from "./conversations";
import { messages } from "./messages";

// Categorias oficiais de Next Best Action (Documento 14A, cap. NBA).
export const NBA_CATEGORIAS = [
  "aprender", "consumir_conteudo", "explorar", "participar", "aprofundar",
  "experimentar", "conversar", "comunidade", "comprar", "pausar",
] as const;
export type NbaCategoria = (typeof NBA_CATEGORIAS)[number];

// Resultado da checagem de elegibilidade (Documento 14A: "elegibilidade tem
// prioridade absoluta, nenhum score/afinidade/intenção a substitui").
export const ELEGIBILIDADE_STATUS = ["elegivel", "bloqueado", "nao_avaliada"] as const;
export type ElegibilidadeStatus = (typeof ELEGIBILIDADE_STATUS)[number];

// Snapshot de uma evidência considerada nesta decisão (cópia, não referência
// viva — pessoa_evidencias é append-only e pode crescer depois da decisão).
export interface EvidenciaConsiderada {
  campo: string;
  valor: string | null;
  tipoEvidencia: string;
  nivelConfianca: string;
  origem: string;
}

export const decisionRuns = pgTable("sofia_decision_runs", {
  id: serial("id").primaryKey(),
  // Nullable for public factual exchanges that legitimately occur before a
  // conversation is linked to a pessoa. conversation_id still anchors audit.
  pessoaId: integer("pessoa_id").references(() => pessoasTable.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),

  // Contexto no momento da decisão (Documento 14/15: qual conduta estava ativa).
  conduta: text("conduta").$type<"triagem" | "comercial" | null>(),
  promptId: integer("prompt_id"),
  model: text("model"),

  // Evidências consideradas (Perfil Cognitivo Vivo / Acúmulo de Evidências).
  evidenciasConsideradas: jsonb("evidencias_consideradas").$type<EvidenciaConsiderada[]>().notNull().default([]),

  // Elegibilidade (prioridade absoluta sobre score/afinidade/intenção).
  elegibilidadeStatus: text("elegibilidade_status").notNull().$type<ElegibilidadeStatus>(),
  elegibilidadeMotivo: text("elegibilidade_motivo"),

  // Oferta-alvo, quando houver (principal + alternativa coerente).
  ofertaPrincipal: text("oferta_principal"),
  ofertaAlternativa: text("oferta_alternativa"),

  // Next Best Action — sempre uma das categorias oficiais.
  nbaCategoria: text("nba_categoria").notNull().$type<NbaCategoria>(),
  nbaJustificativa: text("nba_justificativa").notNull(),
  nivelConfianca: text("nivel_confianca").notNull().$type<"baixa" | "media" | "alta">(),
  // Additive governance metadata. Existing decision consumers do not need it.
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decisionRunsRelations = relations(decisionRuns, ({ one }) => ({
  pessoa: one(pessoasTable, { fields: [decisionRuns.pessoaId], references: [pessoasTable.id] }),
  conversation: one(conversations, { fields: [decisionRuns.conversationId], references: [conversations.id] }),
  message: one(messages, { fields: [decisionRuns.messageId], references: [messages.id] }),
}));

export type DecisionRun = typeof decisionRuns.$inferSelect;
export type InsertDecisionRun = typeof decisionRuns.$inferInsert;
