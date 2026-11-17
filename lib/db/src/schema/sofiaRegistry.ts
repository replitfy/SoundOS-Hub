import { pgTable, serial, text, boolean, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const SOFIA_ENTITY_TYPES = ["offer", "instrument_family", "event"] as const;
export type SofiaEntityType = typeof SOFIA_ENTITY_TYPES[number];
export const SOFIA_REVIEW_STATUSES = ["draft", "approved", "rejected"] as const;
export type SofiaReviewStatus = typeof SOFIA_REVIEW_STATUSES[number];

/** Canonical, non-commercial facts. Commercial values remain in source systems. */
export const sofiaEntityRegistry = pgTable("sofia_entity_registry", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull().$type<SofiaEntityType>(),
  stableKey: text("stable_key").notNull().unique(),
  displayName: text("display_name").notNull(),
  sourceTable: text("source_table").notNull(),
  sourceId: integer("source_id").notNull(),
  approvedFacts: jsonb("approved_facts").notNull().default({}),
  runtimeAliases: jsonb("runtime_aliases").notNull().default([]),
  sensitive: boolean("sensitive").notNull().default(false),
  reviewStatus: text("review_status").notNull().default("draft").$type<SofiaReviewStatus>(),
  sourceRefs: jsonb("source_refs").notNull().default([]),
  supersededByStableKey: text("superseded_by_stable_key"),
  capabilities: jsonb("capabilities").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SofiaEntity = typeof sofiaEntityRegistry.$inferSelect;
