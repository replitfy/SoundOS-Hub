import { format, isValid, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

type DateValue = string | number | Date | null | undefined;

function parseDateValue(value: DateValue): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date
    ? value
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? parseISO(value)
      : new Date(value);
  return isValid(date) ? date : null;
}

export function formatDateBR(value: DateValue, fallback = "—"): string {
  const date = parseDateValue(value);
  return date ? format(date, "dd/MM/yyyy", { locale: ptBR }) : fallback;
}

export function formatDateTimeBR(value: DateValue, fallback = "—"): string {
  const date = parseDateValue(value);
  return date ? format(date, "dd/MM/yyyy HH:mm", { locale: ptBR }) : fallback;
}

/** Data e hora com segundos: para registros em que o instante exato importa (ex.: referência de restauração). */
export function formatDateTimeSecondsBR(value: DateValue, fallback = "—"): string {
  const date = parseDateValue(value);
  return date ? format(date, "dd/MM/yyyy HH:mm:ss", { locale: ptBR }) : fallback;
}
