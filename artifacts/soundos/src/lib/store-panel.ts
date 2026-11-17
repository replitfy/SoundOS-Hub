import type { StorePanelOrderRow } from "@workspace/api-client-react";

export const STORE_PANEL_TIME_ZONE = "America/Sao_Paulo";

/** Dia civil (aaaa-mm-dd) de um instante em São Paulo, o mesmo calendário que o servidor usa. */
export function saoPauloDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_PANEL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Dica para o navegador: só vale chamar a atualização automática quando ainda não houve
 * tentativa hoje (São Paulo). Quem decide de verdade é o servidor, que repete a checagem de
 * forma atômica; isto só evita chamadas que ele recusaria.
 */
export function shouldTryAutomaticRefresh(
  meta: { status: string; lastAttemptedAt: string | null },
  now: Date = new Date(),
): boolean {
  if (meta.status === "refreshing") return false;
  if (!meta.lastAttemptedAt) return true;
  const attempted = new Date(meta.lastAttemptedAt);
  if (Number.isNaN(attempted.getTime())) return true;
  return saoPauloDayKey(attempted) !== saoPauloDayKey(now);
}

/** Data do pedido no calendário de São Paulo, igual à usada para períodos e meses. */
export function formatOrderDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: STORE_PANEL_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

/** Data e hora completas do pedido, no calendário de São Paulo. */
export function formatOrderDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: STORE_PANEL_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(iso))
    .replace(", ", " ");
}

/** Telefone brasileiro como (11) 99999-0000; números de fora do Brasil ou fora do padrão ficam como vieram. */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const national = (digits.length === 12 || digits.length === 13) && digits.startsWith("55") ? digits.slice(2) : digits;
  if (national.length === 11) return `(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`;
  if (national.length === 10) return `(${national.slice(0, 2)}) ${national.slice(2, 6)}-${national.slice(6)}`;
  return raw;
}

/** "2× Bastão de Chuva, 1× Pakal +2": os dois primeiros itens e quantos ficaram de fora. */
export function summarizeOrderItems(items: StorePanelOrderRow["items"], visible = 2): string {
  const label = (item: StorePanelOrderRow["items"][number]) => `${item.quantity}× ${item.name}`;
  const shown = items.slice(0, visible).map(label).join(", ");
  const hidden = items.length - visible;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

export function fullOrderItems(items: StorePanelOrderRow["items"]): string {
  return items.map(item => `${item.quantity}× ${item.name}`).join("\n");
}

export function formatBRL(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(value);
}

/** Rótulo curto de mês para o eixo do gráfico: "2026-09" → "set/2026". */
export function formatMonthKey(key: string, locale: string): string {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  const parts = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", year: "numeric" }).formatToParts(
    new Date(Date.UTC(year, month - 1, 15)),
  );
  const monthName = parts.find(part => part.type === "month")?.value.replace(/\.$/, "") ?? String(month);
  return `${monthName}/${year}`;
}

export function truncateLabel(value: string, max = 28): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
