import { describe, expect, it } from "vitest";
import type { EventSummaryRow } from "./index";
import {
  clampPage,
  isPastEducationEvent,
  paginateEducationRows,
  parseEducationSort,
  sortEducationRows,
} from "./education-table-state";

function row(id: number, values: Partial<EventSummaryRow> = {}): EventSummaryRow {
  return {
    eventId: id,
    eventName: `Evento ${id}`,
    eventType: "Curso",
    active: true,
    startDate: null,
    endDate: null,
    city: null,
    location: null,
    classId: null,
    classCode: null,
    courseId: null,
    courseName: null,
    capacity: null,
    enrolled: 0,
    available: null,
    contracted: 0,
    paid: 0,
    outstanding: 0,
    paidPercent: null,
    ...values,
  };
}

describe("education table sorting and pagination", () => {
  it("considera o fim do evento e mantém datas de hoje ou ausentes", () => {
    const today = "2026-11-13";
    expect(isPastEducationEvent(row(1, { startDate: "2026-11-10", endDate: "2026-11-12" }), today)).toBe(true);
    expect(isPastEducationEvent(row(2, { startDate: "2026-11-10", endDate: "2026-11-13" }), today)).toBe(false);
    expect(isPastEducationEvent(row(3, { startDate: "2026-11-13", endDate: null }), today)).toBe(false);
    expect(isPastEducationEvent(row(4), today)).toBe(false);
  });

  it("preserves legacy URL sort keys and default directions", () => {
    expect(parseEducationSort("date", null)).toEqual({ key: "startDate", direction: "asc" });
    expect(parseEducationSort("event", null)).toEqual({ key: "event", direction: "asc" });
    expect(parseEducationSort("event", "desc")).toEqual({ key: "event", direction: "desc" });
    expect(parseEducationSort("occupancy", null)).toEqual({ key: "enrolled", direction: "desc" });
    expect(parseEducationSort("financials", null)).toEqual({ key: "paid", direction: "desc" });
  });

  it("sorts dates chronologically and year/month numerically", () => {
    const rows = [
      row(1, { startDate: "2025-10-02" }),
      row(2, { startDate: "2024-12-31" }),
      row(3, { startDate: "2025-02-01" }),
    ];
    expect(sortEducationRows(rows, { key: "startDate", direction: "asc" }).map(r => r.eventId))
      .toEqual([2, 3, 1]);
    expect(sortEducationRows(rows, { key: "month", direction: "asc" }).map(r => r.eventId))
      .toEqual([3, 1, 2]);
  });

  it("keeps nulls last in either direction and preserves ties stably", () => {
    const rows = [
      row(1, { available: null }),
      row(2, { available: 4 }),
      row(3, { available: 4 }),
      row(4, { available: 8 }),
    ];
    expect(sortEducationRows(rows, { key: "available", direction: "asc" }).map(r => r.eventId))
      .toEqual([2, 3, 4, 1]);
    expect(sortEducationRows(rows, { key: "available", direction: "desc" }).map(r => r.eventId))
      .toEqual([4, 2, 3, 1]);
  });

  it("uses enrolled for occupancy and paginates without overlap", () => {
    const rows = Array.from({ length: 43 }, (_, index) => row(index + 1, { enrolled: index }));
    expect(sortEducationRows(rows.slice(0, 3), { key: "enrolled", direction: "desc" }).map(r => r.eventId))
      .toEqual([3, 2, 1]);
    expect(paginateEducationRows(rows, 1)).toHaveLength(20);
    expect(paginateEducationRows(rows, 2).map(r => r.eventId)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 21),
    );
    expect(paginateEducationRows(rows, 3).map(r => r.eventId)).toEqual([41, 42, 43]);
    expect(clampPage(9, 43)).toBe(3);
    expect(clampPage(2, 0)).toBe(1);
  });
});