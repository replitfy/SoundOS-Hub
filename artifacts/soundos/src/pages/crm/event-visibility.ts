import { isBefore, isValid, parseISO, startOfMonth } from "date-fns";

type DatedEvent = {
  dataInicio?: string | null;
  dataFim?: string | null;
};

function parseEventDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = parseISO(value);
  return isValid(date) ? date : null;
}

export function isCurrentOrFutureEvent(event: DatedEvent, now = new Date()): boolean {
  const effectiveEnd = parseEventDate(event.dataFim) ?? parseEventDate(event.dataInicio);
  return effectiveEnd !== null && !isBefore(effectiveEnd, startOfMonth(now));
}
