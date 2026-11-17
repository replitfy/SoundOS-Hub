import { pgTable, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Configuração editável dos blocos de "conduta" (Documento 14 — Triagem /
// Documento 15 — Playbook Comercial) que services/conduta.ts injeta no
// system prompt a cada mensagem, depois do texto do prompt principal. Antes
// desta tabela esses blocos eram constantes fixas no código — só dava para
// mudá-los com um deploy. É uma linha única (id fixo = 1); campos nulos
// significam "usar o texto padrão embutido no código".
export const condutaConfigTable = pgTable("conduta_config", {
  id: integer("id").primaryKey().default(1),
  triagemBlock: text("triagem_block"),
  comercialBlock: text("comercial_block"),
  forbiddenBlock: text("forbidden_block"),
  fastPathEnabled: boolean("fast_path_enabled").notNull().default(false),
  // 'legacy' | 'simple' (CHECK na migração 033). A env SOFIA_MODE vence esta coluna.
  sofiaMode: text("sofia_mode").notNull().default("simple"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCondutaConfigSchema = createInsertSchema(condutaConfigTable).omit({ id: true, updatedAt: true });
export type InsertCondutaConfig = z.infer<typeof insertCondutaConfigSchema>;
export type CondutaConfigRow = typeof condutaConfigTable.$inferSelect;
