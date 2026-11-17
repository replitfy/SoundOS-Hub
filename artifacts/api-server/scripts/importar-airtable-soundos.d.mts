export declare const AIRTABLE_BASE_ID: string;
export declare const AIRTABLE_TABLES: Record<string, {
  id: string;
  name: string;
  count: number;
}>;
export declare function normalizedEmail(value: unknown): string | null;
export declare function normalizedPhone(value: unknown): string | null;
export declare function exactDate(value: unknown): string | null;
export declare function resolveIdentity<T extends { id: number | string }>(
  emailMatches: T[],
  phoneMatches: T[],
):
  | { kind: "none" }
  | { kind: "match"; person: T; matchedBy: "email" | "phone" | "both" }
  | { kind: "conflict"; reason: "contradictory" | "ambiguous" };
export declare function sufficientIdentity(person: {
  nome?: unknown;
  email?: unknown;
  phone?: unknown;
}): boolean;
export declare function classStatus(
  startDate: string | null,
  endDate: string | null,
  today?: string,
): "Encerrada" | "Em Andamento" | "Planejada";
export declare function mappedContractStatus(value: unknown): "Assinado" | null;
export declare function enrollmentStatusPlan(value: unknown): {
  insert: { paymentStatus: "pending"; contractStatus: "Assinado" | "pending" };
  update: { contractStatus?: "Assinado" };
};
export declare function mapPersonRecord(record: {
  id: string;
  fields: Record<string, unknown>;
}): Record<string, unknown>;
export declare function buildPlan(
  source: Record<string, Array<{ id: string; fields: Record<string, unknown> }>>,
  existingPeople?: Array<Record<string, unknown> & { id: number }>,
  existingLinks?: Map<string, { entityId: number; sourceFieldsSha256?: string }>,
  existingClasses?: Array<Record<string, unknown> & { id: number }>,
): {
  counts: Record<string, number>;
  personPlans: Array<{ action: string; [key: string]: unknown }>;
  sourcePersonToEntity: Map<string, number>;
  [key: string]: unknown;
};