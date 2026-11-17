import { pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const eventoFormularios = pgTable("evento_formularios", {
  id: serial("id").primaryKey(),
  eventoId: integer("evento_id").notNull().references(() => cursosInscricao.id, { onDelete: "cascade" }),
  tipo: text("tipo").notNull(),
  slug: text("slug").notNull().unique(),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ eventoTipoUnique: uniqueIndex("evento_formularios_evento_tipo_unique").on(t.eventoId, t.tipo) }));

export const eventoFormularioVersoes = pgTable("evento_formulario_versoes", {
  id: serial("id").primaryKey(),
  formularioId: integer("formulario_id").notNull().references(() => eventoFormularios.id, { onDelete: "cascade" }),
  numero: integer("numero").notNull(),
  campos: jsonb("campos").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ formVersionUnique: uniqueIndex("evento_formulario_versoes_unique").on(t.formularioId, t.numero) }));

export const eventoFormularioSubmissoes = pgTable("evento_formulario_submissoes", {
  id: serial("id").primaryKey(),
  eventoId: integer("evento_id").notNull().references(() => cursosInscricao.id, { onDelete: "cascade" }),
  formularioId: integer("formulario_id").notNull().references(() => eventoFormularios.id, { onDelete: "cascade" }),
  versaoId: integer("versao_id").notNull().references(() => eventoFormularioVersoes.id),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id),
  respostas: jsonb("respostas").notNull(),
  // Caixa "Aceito receber mensagens pelo WhatsApp" e o texto exato que estava na tela.
  consentimentoWhatsapp: boolean("consentimento_whatsapp").notNull().default(false),
  consentimentoTexto: text("consentimento_texto"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const eventoPreinscricoes = pgTable("evento_preinscricoes", {
  id: serial("id").primaryKey(),
  eventoId: integer("evento_id").notNull().references(() => cursosInscricao.id, { onDelete: "cascade" }),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  ultimaSubmissaoId: integer("ultima_submissao_id").references(() => eventoFormularioSubmissoes.id),
  status: text("status").notNull().default("PREINSCRITO"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pessoaEventoUnique: uniqueIndex("evento_preinscricoes_pessoa_evento_unique").on(t.eventoId, t.pessoaId) }));

export const eventoFormulariosRelations = relations(eventoFormularios, ({ one, many }) => ({
  evento: one(cursosInscricao, { fields: [eventoFormularios.eventoId], references: [cursosInscricao.id] }),
  versoes: many(eventoFormularioVersoes),
}));

export type EventoFormulario = typeof eventoFormularios.$inferSelect;
export type EventoFormularioVersao = typeof eventoFormularioVersoes.$inferSelect;
export type EventoFormularioSubmissao = typeof eventoFormularioSubmissoes.$inferSelect;
export type EventoPreinscricao = typeof eventoPreinscricoes.$inferSelect;

// Declared below to avoid a second module for the existing event table.
import { cursosInscricao, pessoasTable } from "./pessoas";