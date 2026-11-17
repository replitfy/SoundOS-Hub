import type { StorePanelData } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLang } from "@/contexts/language";
import { formatBRL } from "@/lib/store-panel";

function Kpi({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <Card className="shadow-sm border-border/50">
      <CardContent className="p-4 space-y-1.5 min-w-0">
        <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-muted-foreground">{title}</p>
        <p className="text-xl font-bold font-display text-foreground truncate" title={value}>{value}</p>
        <p className="text-[10px] text-muted-foreground truncate" title={hint}>{hint}</p>
      </CardContent>
    </Card>
  );
}

export function PanelKpis({ kpis }: { kpis: StorePanelData["kpis"] }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const count = (value: number) => value.toLocaleString(locale);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3" data-testid="store-panel-kpis">
      <Kpi title={t("store.panel.kpi.orders")} value={count(kpis.orders)} hint={t("store.panel.kpi.orders_hint")} />
      <Kpi
        title={t("store.panel.kpi.revenue")}
        value={formatBRL(kpis.revenue, locale)}
        hint={`${t("store.panel.kpi.revenue_hint")}: ${count(kpis.confirmedOrders)}`}
      />
      <Kpi
        title={t("store.panel.kpi.avg_ticket")}
        value={kpis.avgTicket === null ? "—" : formatBRL(kpis.avgTicket, locale)}
        hint={t("store.panel.kpi.avg_ticket_hint")}
      />
      <Kpi
        title={t("store.panel.kpi.awaiting")}
        value={count(kpis.awaitingPayment.orders)}
        hint={formatBRL(kpis.awaitingPayment.value, locale)}
      />
      <Kpi
        title={t("store.panel.kpi.to_ship")}
        value={count(kpis.paidToShip.orders)}
        hint={formatBRL(kpis.paidToShip.value, locale)}
      />
    </div>
  );
}
