import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const dashboardSnapshotsTable = pgTable("dashboard_snapshots", {
  key: text("key").primaryKey(),
  schemaVersion: integer("schema_version").notNull().default(1),
  payload: jsonb("payload").$type<unknown>(),
  status: text("status").notNull().default("empty"),
  collectedAt: timestamp("collected_at", { withTimezone: true }),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  lastError: text("last_error"),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DashboardSnapshotRow = typeof dashboardSnapshotsTable.$inferSelect;
