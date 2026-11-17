import { pgTable, serial, text, boolean, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accessProfilesTable } from "./accessProfiles";

export const USER_ROLES = ["admin_master", "admin", "usuario", "assistente"] as const;
export type UserRole = typeof USER_ROLES[number];

export const userRoleEnum = pgEnum("soundos_user_role", USER_ROLES);

export const usersTable = pgTable("soundos_users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  /**
   * Espelho legado do perfil, mantido só para auditoria e compatibilidade. A
   * autorização usa `profileId`: nada de acesso deve ser decidido por este campo.
   */
  role: userRoleEnum("role").notNull().default("usuario"),
  /** Perfil de acesso. Null só em linhas antigas: o servidor resolve pelo `role`. */
  profileId: integer("profile_id").references(() => accessProfilesTable.id, { onDelete: "restrict" }),
  passwordHash: text("password_hash"),
  /** true = user must set a new password before they can log in */
  passwordMustReset: boolean("password_must_reset").notNull().default(false),
  active: boolean("active").notNull().default(true),
  lastLogin: timestamp("last_login", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
