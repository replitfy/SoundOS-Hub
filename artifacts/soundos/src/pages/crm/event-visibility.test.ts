import { describe, expect, it } from "vitest";
import { isCurrentOrFutureEvent } from "./event-visibility";

const now = new Date(2026, 8, 14);

describe("isCurrentOrFutureEvent", () => {
  it("keeps events from the current month and future months", () => {
    expect(isCurrentOrFutureEvent({ dataInicio: "2026-09-01" }, now)).toBe(true);
    expect(isCurrentOrFutureEvent({ dataInicio: "2026-10-20" }, now)).toBe(true);
  });

  it("hides events that ended before the current month", () => {
    expect(isCurrentOrFutureEvent({ dataInicio: "2026-08-31" }, now)).toBe(false);
    expect(isCurrentOrFutureEvent({ dataInicio: "2026-07-01", dataFim: "2026-08-15" }, now)).toBe(false);
  });

  it("keeps an event that started earlier but continues into the current month", () => {
    expect(isCurrentOrFutureEvent({ dataInicio: "2026-08-20", dataFim: "2026-09-05" }, now)).toBe(true);
  });

  it("hides undated or invalid events", () => {
    expect(isCurrentOrFutureEvent({}, now)).toBe(false);
    expect(isCurrentOrFutureEvent({ dataInicio: "invalid" }, now)).toBe(false);
  });
});
