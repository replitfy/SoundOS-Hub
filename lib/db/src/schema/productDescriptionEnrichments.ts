import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const productDescriptionEnrichmentsTable = pgTable("product_description_enrichments", {
  productId: text("product_id").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  description: text("description"),
  source: text("source"),
  status: text("status").notNull(),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProductDescriptionEnrichmentRow =
  typeof productDescriptionEnrichmentsTable.$inferSelect;