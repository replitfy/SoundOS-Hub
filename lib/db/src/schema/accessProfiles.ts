import { pgTable, serial, text, boolean, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Perfis de acesso: cada usuário pertence a um perfil, e o perfil define quais
 * áreas do menu estão liberadas e se ele é "administrador" (ações hoje
 * restritas a administradores).
 *
 * Os 4 perfis do sistema (admin_master, admin, usuario, assistente) são criados
 * pelo código ao subir o servidor, porque a publicação leva só a estrutura do
 * banco, não os dados.
 */
export const accessProfilesTable = pgTable(
  "access_profiles",
  {
    id: serial("id").primaryKey(),
    /** Chave estável dos perfis do sistema; null nos perfis criados pelo admin. */
    systemKey: text("system_key").unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isAdmin: boolean("is_admin").notNull().default(false),
    /** Ids de área (ver @workspace/access-areas). */
    areas: text("areas").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Última alteração: quem. Guardamos o nome porque o usuário pode ser desativado. */
    updatedByUserId: integer("updated_by_user_id"),
    updatedByName: text("updated_by_name"),
  },
  table => [uniqueIndex("access_profiles_name_lower_key").on(sql`lower(${table.name})`)],
);

export type AccessProfile = typeof accessProfilesTable.$inferSelect;
