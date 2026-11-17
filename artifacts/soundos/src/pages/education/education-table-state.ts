import type { EventSummaryRow } from "./index";

export const EDUCATION_PAGE_SIZE = 20;

export type EducationSortKey =
  | "event"
  | "code"
  | "year"
  | "month"
  | "startDate"
  | "city"
  | "enrolled"
  | "available"
  | "contracted"
  | "paid"
  | "outstanding"
  | "paidPercent";

export type SortDirection = "asc" | "desc";

export interface EducationSort {
  key: EducationSortKey;
  direction: SortDirection;
}

export function isPastEducationEvent(
  row: Pick<EventSummaryRow, "startDate" | "endDate">,
  today: string,
): boolean {
  const lastEventDay = row.endDate ?? row.startDate;
  return Boolean(lastEventDay && lastEventDay < today);
}

const SORT_KEYS = new Set<EducationSortKey>([
  "event", "code", "year", "month", "startDate", "city", "enrolled",
  "available", "contracted", "paid", "outstanding", "paidPercent",
]);

const LEGACY_SORTS: Record<string, EducationSort> = {
  date: { key: "startDate", direction: "asc" },
  event: { key: "event", direction: "asc" },
  occupancy: { key: "enrolled", direction: "desc" },
  financials: { key: "paid", direction: "desc" },
};

export function parseEducationSort(sort: string | null, direction: string | null): EducationSort {
  if (sort && LEGACY_SORTS[sort] && direction !== "asc" && direction !== "desc") {
    return LEGACY_SORTS[sort];
  }
  if (sort && SORT_KEYS.has(sort as EducationSortKey)) {
    return {
      key: sort as EducationSortKey,
      direction: direction === "desc" ? "desc" : "asc",
    };
  }
  return LEGACY_SORTS.date;
}

function dateParts(value: string | null): { year: number; month: number; time: number } | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, time };
}

function sortValue(row: EventSummaryRow, key: EducationSortKey): string | number | null {
  switch (key) {
    case "event": return row.eventName || null;
    case "code": return row.classCode || null;
    case "year": return dateParts(row.startDate)?.year ?? null;
    case "month": return dateParts(row.startDate)?.month ?? null;
    case "startDate": return dateParts(row.startDate)?.time ?? null;
    case "city": return row.city || null;
    case "enrolled": return row.enrolled;
    case "available": return row.available;
    case "contracted": return row.contracted;
    case "paid": return row.paid;
    case "outstanding": return row.outstanding;
    case "paidPercent": return row.paidPercent;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortEducationRows(
  rows: readonly EventSummaryRow[],
  { key, direction }: EducationSort,
): EventSummaryRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aValue = sortValue(a.row, key);
      const bValue = sortValue(b.row, key);
      if (aValue === null && bValue === null) return a.index - b.index;
      if (aValue === null) return 1;
      if (bValue === null) return -1;

      const comparison = typeof aValue === "string" && typeof bValue === "string"
        ? collator.compare(aValue, bValue)
        : Number(aValue) - Number(bValue);
      return (direction === "asc" ? comparison : -comparison) || a.index - b.index;
    })
    .map(({ row }) => row);
}

export function clampPage(page: number, totalRows: number, pageSize = EDUCATION_PAGE_SIZE): number {
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  return Math.min(Math.max(1, page), pageCount);
}

export function paginateEducationRows<T>(
  rows: readonly T[],
  page: number,
  pageSize = EDUCATION_PAGE_SIZE,
): T[] {
  const validPage = clampPage(page, rows.length, pageSize);
  return rows.slice((validPage - 1) * pageSize, validPage * pageSize);
}