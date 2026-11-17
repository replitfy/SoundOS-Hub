import type { StorePanelOrderRow, StoreSituation } from "@workspace/api-client-react";
import type { TranslationKey } from "@/contexts/language";

export const CHART_COLOR = "#5777A6";
export const CHART_TICK = { fontSize: 10, fill: "var(--color-muted-foreground)" } as const;
export const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "none",
  boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
  fontSize: 12,
} as const;

export const SITUATION_KEYS: Record<StoreSituation, TranslationKey> = {
  paid_delivered: "store.panel.situation.paid_delivered",
  paid_to_ship: "store.panel.situation.paid_to_ship",
  awaiting_payment: "store.panel.situation.awaiting_payment",
  declined: "store.panel.situation.declined",
  refunded: "store.panel.situation.refunded",
  cancelled: "store.panel.situation.cancelled",
};

/** Cor do ponto de cada situação: verde para venda confirmada, âmbar para pendente, vermelho/cinza para o resto. */
export const SITUATION_DOT: Record<StoreSituation, string> = {
  paid_delivered: "bg-emerald-500",
  paid_to_ship: "bg-sky-500",
  awaiting_payment: "bg-amber-500",
  declined: "bg-rose-500",
  refunded: "bg-violet-400",
  cancelled: "bg-muted-foreground/50",
};

export const PAYMENT_KEYS: Record<StorePanelOrderRow["payment"], TranslationKey> = {
  paid: "store.panel.payment.paid",
  awaiting: "store.panel.payment.awaiting",
  declined: "store.panel.payment.declined",
  refunded: "store.panel.payment.refunded",
  canceled: "store.panel.payment.canceled",
};

export const DELIVERY_KEYS: Record<StorePanelOrderRow["delivery"], TranslationKey> = {
  delivered: "store.panel.delivery.delivered",
  partial: "store.panel.delivery.partial",
  to_ship: "store.panel.delivery.to_ship",
  none: "store.panel.delivery.none",
};

export const PAYMENT_VARIANT: Record<StorePanelOrderRow["payment"], "default" | "secondary" | "outline" | "destructive"> = {
  paid: "secondary",
  awaiting: "outline",
  declined: "destructive",
  refunded: "outline",
  canceled: "outline",
};
