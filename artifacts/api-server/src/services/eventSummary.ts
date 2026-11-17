export type EnrollmentForSummary = {
  price: string | number | null;
  paymentStatus: string | null;
};

export type EventSummaryFinancials = {
  enrollmentCount: number;
  contracted: number;
  paid: number;
  pending: number;
  percentPaid: number | null;
};

/** Payment states that mean the entire enrollment price has been received. */
export const PAID_PAYMENT_STATUSES = new Set([
  "paid", "pago", "complete", "completed", "completo", "approved", "aprovado",
  "settled", "quitado", "received", "recebido",
]);
export const EXEMPT_PAYMENT_STATUSES = new Set(["isento", "exempt"]);

function normalizePaymentStatus(status: string | null): string {
  return String(status ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function aggregateEventEnrollments(enrollments: EnrollmentForSummary[]): EventSummaryFinancials {
  let contracted = 0;
  let paid = 0;
  for (const enrollment of enrollments) {
    const price = Number(enrollment.price ?? 0);
    const value = Number.isFinite(price) ? price : 0;
    const status = normalizePaymentStatus(enrollment.paymentStatus);
    // Exempt enrollments are waived entirely: they are not contracted,
    // received, or outstanding.
    if (EXEMPT_PAYMENT_STATUSES.has(status)) continue;
    contracted += value;
    if (PAID_PAYMENT_STATUSES.has(status)) paid += value;
  }
  contracted = Number(contracted.toFixed(2));
  paid = Number(paid.toFixed(2));
  return {
    enrollmentCount: enrollments.length,
    contracted,
    paid,
    pending: Number((contracted - paid).toFixed(2)),
    percentPaid: contracted === 0 ? null : Number(((paid / contracted) * 100).toFixed(2)),
  };
}