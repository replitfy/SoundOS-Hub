import { describe, expect, it } from "vitest";
import { aggregateEventEnrollments } from "./eventSummary";

describe("event summary aggregation", () => {
  it("counts paid, pending and installments against contracted value", () => {
    const result = aggregateEventEnrollments([
      { price: "100", paymentStatus: "Pago" },
      { price: "80", paymentStatus: "Em atraso" },
      { price: "50", paymentStatus: "Parcelado" },
    ]);
    expect(result).toMatchObject({ enrollmentCount: 3, contracted: 230, paid: 100, pending: 130, percentPaid: 43.48 });
  });

  it("accepts canonical English and Portuguese paid states, but exempts are not received or outstanding", () => {
    const result = aggregateEventEnrollments([
      { price: 10, paymentStatus: "paid" },
      { price: 20, paymentStatus: "PAGO" },
      { price: 30, paymentStatus: "Isento" },
      { price: 40, paymentStatus: "exempt" },
    ]);
    expect(result).toMatchObject({ contracted: 30, paid: 30, pending: 0, percentPaid: 100 });
  });

  it("returns a null percentage when there is no contracted value", () => {
    expect(aggregateEventEnrollments([])).toMatchObject({
      enrollmentCount: 0, contracted: 0, paid: 0, pending: 0, percentPaid: null,
    });
  });
});