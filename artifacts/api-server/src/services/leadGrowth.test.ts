import { describe, expect, it } from "vitest";
import { aggregateLeadGrowth, currentLeadGrowthWindow } from "./leadGrowth";

const days = ["2026-06-13", "2026-06-14", "2026-06-15"];
const row = (pessoaId: number, timestamp: string) => ({
  pessoaId,
  createdAt: new Date(timestamp),
});

describe("aggregateLeadGrowth", () => {
  it("counts each person once per day even when a form is resubmitted", () => {
    const result = aggregateLeadGrowth(
      days,
      [
        row(1, "2026-06-14T12:00:00.000Z"),
        row(1, "2026-06-14T13:00:00.000Z"),
        row(2, "2026-06-14T13:00:00.000Z"),
      ],
    );

    expect(result[1]).toEqual({ day: "2026-06-14", leads: 2 });
  });

  it("counts leads on the day they submit the form", () => {
    const result = aggregateLeadGrowth(
      days,
      [row(1, "2026-06-13T12:00:00.000Z"), row(1, "2026-06-15T12:00:00.000Z")],
    );

    expect(result.map(point => point.leads)).toEqual([1, 0, 1]);
  });

  it("returns one zero-valued point for every requested day when there are no leads", () => {
    expect(aggregateLeadGrowth(days, [])).toEqual(
      days.map(day => ({ day, leads: 0 })),
    );
  });
});

describe("currentLeadGrowthWindow", () => {
  it("returns exactly 30 São Paulo calendar days including today", () => {
    const window = currentLeadGrowthWindow(new Date("2026-06-15T12:00:00.000Z"));

    expect(window.days).toHaveLength(30);
    expect(window.days[0]).toBe("2026-05-17");
    expect(window.days[29]).toBe("2026-06-15");
    expect(window.start.toISOString()).toBe("2026-05-17T03:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-06-16T03:00:00.000Z");
  });

  it("rolls the daily window across a January/December year boundary", () => {
    const window = currentLeadGrowthWindow(new Date("2027-01-08T12:00:00.000Z"));

    expect(window.days[0]).toBe("2026-12-10");
    expect(window.days[29]).toBe("2027-01-08");
  });

  it("uses the local date when UTC is already the following day in São Paulo", () => {
    const window = currentLeadGrowthWindow(new Date("2026-09-01T01:00:00.000Z"));

    expect(window.days[0]).toBe("2026-08-02");
    expect(window.days[29]).toBe("2026-08-31");
    expect(window.start.toISOString()).toBe("2026-08-02T03:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-09-01T03:00:00.000Z");
  });

  it("uses an inclusive start and exclusive end at São Paulo midnight", () => {
    const window = currentLeadGrowthWindow(new Date("2026-09-01T01:00:00.000Z"));
    const result = aggregateLeadGrowth(
      window.days,
      [
        { pessoaId: 1, createdAt: new Date("2026-08-02T02:59:59.999Z") },
        { pessoaId: 2, createdAt: window.start },
        { pessoaId: 3, createdAt: new Date("2026-09-01T02:59:59.999Z") },
        { pessoaId: 4, createdAt: window.end },
      ],
    );

    expect(result[0].leads).toBe(1);
    expect(result[29].leads).toBe(1);
    expect(result).toHaveLength(30);
  });

  it("assigns leads on either side of São Paulo midnight to the correct day", () => {
    const result = aggregateLeadGrowth(
      ["2026-03-31", "2026-04-01"],
      [
        { pessoaId: 1, createdAt: new Date("2026-04-01T02:59:59.999Z") },
        { pessoaId: 2, createdAt: new Date("2026-04-01T03:00:00.000Z") },
        { pessoaId: 3, createdAt: new Date("2026-04-01T03:00:00.001Z") },
      ],
    );

    expect(result).toEqual([
      { day: "2026-03-31", leads: 1 },
      { day: "2026-04-01", leads: 2 },
    ]);
  });

  it("uses historical São Paulo DST offsets in the date range", () => {
    const window = currentLeadGrowthWindow(new Date("2018-12-10T12:00:00.000Z"));

    expect(window.start.toISOString()).toBe("2018-11-11T02:00:00.000Z");
    expect(window.end.toISOString()).toBe("2018-12-11T02:00:00.000Z");
  });
});