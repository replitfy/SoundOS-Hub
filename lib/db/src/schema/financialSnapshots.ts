import {
  boolean,
  bigint,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const financialSnapshotsTable = pgTable("financial_snapshots", {
  key: text("key").primaryKey(),
  schemaVersion: integer("schema_version").notNull().default(1),
  filters: jsonb("filters").$type<unknown>().notNull(),
  payload: jsonb("payload").$type<unknown>(),
  status: text("status").notNull().default("empty"),
  collectedAt: timestamp("collected_at", { withTimezone: true }),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  lastError: text("last_error"),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FinancialSnapshotRow = typeof financialSnapshotsTable.$inferSelect;

export const financialTitlesTable = pgTable("financial_titles", {
  base: text("base").notNull(),
  kind: text("kind").notNull(),
  omieId: bigint("omie_id", { mode: "number" }).notNull(),
  accountCode: bigint("account_code", { mode: "number" }),
  issueDate: date("issue_date", { mode: "string" }),
  dueDate: date("due_date", { mode: "string" }),
  referenceDate: date("reference_date", { mode: "string" }),
  amount: doublePrecision("amount").notNull(),
  status: text("status"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull(),
}, table => [
  primaryKey({ columns: [table.base, table.kind, table.omieId] }),
]);

export type FinancialTitleRow = typeof financialTitlesTable.$inferSelect;
export type FinancialTitleInsert = typeof financialTitlesTable.$inferInsert;

export const financialAccountsTable = pgTable("financial_accounts", {
  base: text("base").notNull(),
  code: bigint("code", { mode: "number" }).notNull(),
  description: text("description").notNull(),
  excluded: boolean("excluded").notNull(),
  type: text("type"),
  bank: text("bank"),
  active: boolean("active").notNull(),
  branch: text("branch"),
  accountNumber: text("account_number"),
  openingBalance: doublePrecision("opening_balance").notNull(),
  issuesInvoice: boolean("issues_invoice").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull(),
}, table => [
  primaryKey({ columns: [table.base, table.code] }),
]);

export type FinancialAccountRow = typeof financialAccountsTable.$inferSelect;