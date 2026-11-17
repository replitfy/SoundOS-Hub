import { pgTable, serial, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { pessoasTable } from "./pessoas";

// Tipos de evidência (Documento 14/14A): a Sofia deve raciocinar por acúmulo de
// evidências de naturezas distintas, nunca por um único sinal isolado.
export const TIPOS_EVIDENCIA = [
  "declarada",     // a pessoa afirmou diretamente (ex.: formulário, chat)
  "comportamental",// inferido do comportamento observado (cliques, engajamento)
  "transacional",  // inferido de uma compra/matrícula/pagamento
  "relacional",    // inferido de quem indicou/conectou a pessoa
  "inferida",      // inferência da Sofia sem confirmação humana
  "validada",      // confirmado manualmente por um humano da equipe
] as const;
export type TipoEvidencia = typeof TIPOS_EVIDENCIA[number];

export const NIVEIS_CONFIANCA = ["baixa", "media", "alta"] as const;
export type NivelConfianca = typeof NIVEIS_CONFIANCA[number];

// Heurística simples de confiança por tipo de evidência (Documento 14A).
// A reclassificação estatística por convergência fica para o motor de decisão.
export const NIVEL_CONFIANCA_POR_TIPO: Record<TipoEvidencia, NivelConfianca> = {
  declarada: "alta",
  validada: "alta",
  transacional: "media",
  comportamental: "media",
  relacional: "media",
  inferida: "baixa",
};

// ── pessoa_evidencias: registro append-only ─────────────────────
// Nunca é atualizado nem apagado no fluxo normal — cada nova observação sobre
// um campo gera uma linha nova, preservando o histórico completo.
export const pessoaEvidencias = pgTable("pessoa_evidencias", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  campo: text("campo").notNull(),
  valor: text("valor"),
  tipoEvidencia: text("tipo_evidencia").notNull().$type<TipoEvidencia>(),
  origem: text("origem").notNull(), // ex.: "sofia", "humano", "humano:12"
  nivelConfianca: text("nivel_confianca").notNull().$type<NivelConfianca>(),
  aplicada: text("aplicada").notNull().default("sim"), // "sim" | "nao" (bloqueada por dado confirmado)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pessoaEvidenciasRelations = relations(pessoaEvidencias, ({ one }) => ({
  pessoa: one(pessoasTable, { fields: [pessoaEvidencias.pessoaId], references: [pessoasTable.id] }),
}));

export type PessoaEvidencia = typeof pessoaEvidencias.$inferSelect;
export type InsertPessoaEvidencia = typeof pessoaEvidencias.$inferInsert;

// ── pessoa_campos_confirmados: marca campos "travados" por humano ──
// Não é append-only (é um upsert por campo) — é apenas o marcador de proteção;
// o histórico completo continua vivendo em pessoa_evidencias.
export const pessoaCamposConfirmados = pgTable("pessoa_campos_confirmados", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  campo: text("campo").notNull(),
  confirmadoPor: text("confirmado_por").notNull(),
  confirmadoEm: timestamp("confirmado_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("pessoa_campos_confirmados_pessoa_campo_idx").on(table.pessoaId, table.campo),
]);

export type PessoaCampoConfirmado = typeof pessoaCamposConfirmados.$inferSelect;
export type InsertPessoaCampoConfirmado = typeof pessoaCamposConfirmados.$inferInsert;
