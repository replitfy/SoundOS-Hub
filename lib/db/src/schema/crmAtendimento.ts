import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { commercialOpportunities } from "./commercialOpportunities";
import { pessoasTable } from "./pessoas";
import { conversations } from "./conversations";
import { messages } from "./messages";
import { usersTable } from "./users";

/** Observações do card: só se acrescenta, nunca se edita. */
export const commercialOpportunityNotes = pgTable("commercial_opportunity_notes", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => commercialOpportunities.id, { onDelete: "restrict" }),
  text: text("text").notNull(),
  authorUserId: integer("author_user_id").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oppIdx: index("commercial_opportunity_notes_opp_idx").on(t.opportunityId, t.createdAt),
}));

/** Lista de tarefas do card. A "próxima ação" continua nas colunas da oportunidade. */
export const commercialOpportunityTasks = pgTable("commercial_opportunity_tasks", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => commercialOpportunities.id, { onDelete: "restrict" }),
  text: text("text").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  doneAt: timestamp("done_at", { withTimezone: true }),
  doneByUserId: integer("done_by_user_id").references(() => usersTable.id),
  createdByUserId: integer("created_by_user_id").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oppIdx: index("commercial_opportunity_tasks_opp_idx").on(t.opportunityId, t.createdAt),
}));

export const commercialOpportunityAppointments = pgTable("commercial_opportunity_appointments", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => commercialOpportunities.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  link: text("link"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oppIdx: index("commercial_opportunity_appointments_opp_idx").on(t.opportunityId, t.startsAt),
}));

export const CONTATO_REGISTRO_KINDS = ["AUTORIZOU", "NAO_QUER_RECEBER", "NAO_QUER_RECEBER_DESFEITO"] as const;
export type ContatoRegistroKind = (typeof CONTATO_REGISTRO_KINDS)[number];
export const CONTATO_ORIGENS = ["FORMULARIO", "CONVERSA_WHATSAPP", "PRESENCIAL", "OUTRO"] as const;
export type ContatoOrigem = (typeof CONTATO_ORIGENS)[number];

/**
 * Registro, só de inserções, de quem autorizou contato e de quem pediu para não receber.
 * O estado atual é derivado: "não quer receber" vale até um NAO_QUER_RECEBER_DESFEITO posterior.
 */
export const pessoaContatoRegistros = pgTable("pessoa_contato_registros", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id),
  kind: text("kind").notNull().$type<ContatoRegistroKind>(),
  origem: text("origem").notNull().$type<ContatoOrigem>(),
  origemTexto: text("origem_texto"),
  // Registro feito pela equipe tem o usuário; o feito pelo próprio sistema (consentimento no formulário,
  // pedido de parar na conversa) não tem usuário e vem com `registradoPeloSistema`. Sempre um dos dois.
  registradoPorUserId: integer("registrado_por_user_id").references(() => usersTable.id),
  registradoPeloSistema: boolean("registrado_pelo_sistema").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pessoaIdx: index("pessoa_contato_registros_pessoa_idx").on(t.pessoaId, t.createdAt),
}));

export const PRIMEIRO_CONTATO_RESULTADOS = ["EM_ANDAMENTO", "ENVIADO", "FALHOU", "NAO_ENVIADO"] as const;
export type PrimeiroContatoResultado = (typeof PRIMEIRO_CONTATO_RESULTADOS)[number];

/**
 * Uma linha por card novo de formulário que passou pela análise do primeiro contato automático: o modelo
 * foi enviado, falhou, ou não foi enviado (com o código do motivo). Os índices únicos parciais garantem um
 * modelo automático por pessoa e por telefone, mesmo com envios simultâneos do formulário.
 */
export const primeiroContatoAutomatico = pgTable("primeiro_contato_automatico", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id),
  opportunityId: integer("opportunity_id").notNull().references(() => commercialOpportunities.id),
  telefoneChave: text("telefone_chave"),
  resultado: text("resultado").notNull().$type<PrimeiroContatoResultado>(),
  motivo: text("motivo"),
  conversationId: integer("conversation_id").references(() => conversations.id),
  messageId: integer("message_id").references(() => messages.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cardUq: uniqueIndex("primeiro_contato_automatico_card_uq").on(t.opportunityId),
  pessoaUq: uniqueIndex("primeiro_contato_automatico_pessoa_uq").on(t.pessoaId).where(sql`${t.resultado} <> 'NAO_ENVIADO'`),
  telefoneUq: uniqueIndex("primeiro_contato_automatico_telefone_uq").on(t.telefoneChave)
    .where(sql`${t.resultado} <> 'NAO_ENVIADO' AND ${t.telefoneChave} IS NOT NULL`),
  createdIdx: index("primeiro_contato_automatico_created_idx").on(t.createdAt).where(sql`${t.resultado} <> 'NAO_ENVIADO'`),
}));
