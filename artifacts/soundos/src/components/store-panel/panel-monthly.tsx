import type { StorePanelData } from "@workspace/api-client-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLang } from "@/contexts/language";
import { formatBRL, formatMonthKey } from "@/lib/store-panel";
import { CHART_COLOR, CHART_TICK, TOOLTIP_STYLE } from "./shared";

export function PanelMonthly({ monthly }: { monthly: StorePanelData["monthly"] }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const hasSales = monthly.some(month => month.orders > 0);

  return (
    <Card className="shadow-sm border-border/50" data-testid="store-panel-monthly">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{t("store.panel.monthly.title")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("store.panel.monthly.subtitle")}</p>
      </CardHeader>
      <CardContent>
        {!hasSales ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("store.panel.monthly.empty")}</p>
        ) : (
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                <XAxis
                  dataKey="month"
                  tickFormatter={(value: string) => formatMonthKey(value, locale)}
                  tick={CHART_TICK}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={14}
                />
                <YAxis
                  width={48}
                  tickFormatter={(value: number) => value.toLocaleString(locale, { notation: "compact" })}
                  tick={CHART_TICK}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  labelFormatter={(value: string) => formatMonthKey(value, locale)}
                  formatter={(value: number, _name: string, entry) => {
                    const sales = (entry.payload as { orders: number }).orders;
                    return [
                      `${formatBRL(value, locale)} · ${sales.toLocaleString(locale)} ${t("store.panel.monthly.sales").toLowerCase()}`,
                      t("store.panel.monthly.revenue"),
                    ];
                  }}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Bar dataKey="revenue" fill={CHART_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
