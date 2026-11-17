import { pgTable, serial, integer, text, timestamp, jsonb, index, boolean } from "drizzle-orm/pg-core";
import { pessoasTable } from "./pessoas";

/**
 * Envios do formulário de interesse genérico (sem evento), embarcado no Wix.
 * `grupo` vem da variável do código de embed; `paginaOrigem` é a página que
 * hospeda o iframe, quando o navegador a informa.
 */
export const interesseGeralSubmissoes = pgTable("interesse_geral_submissoes", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id),
  grupo: text("grupo"),
  paginaOrigem: text("pagina_origem"),
  respostas: jsonb("respostas").notNull(),
  // Caixa "Aceito receber mensagens pelo WhatsApp" e o texto exato que estava na tela.
  consentimentoWhatsapp: boolean("consentimento_whatsapp").notNull().default(false),
  consentimentoTexto: text("consentimento_texto"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pessoaIdx: index("interesse_geral_submissoes_pessoa_idx").on(t.pessoaId, t.createdAt),
  createdIdx: index("interesse_geral_submissoes_created_idx").on(t.createdAt),
}));

export type InteresseGeralSubmissao = typeof interesseGeralSubmissoes.$inferSelect;
