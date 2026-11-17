import type { StorePanelCityRow, StorePanelData, StorePanelProductRow } from "@workspace/api-client-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatBRL, truncateLabel } from "@/lib/store-panel";
import { CHART_COLOR, CHART_TICK, TOOLTIP_STYLE } from "./shared";

interface ChartRow {
  label: string;
  value: number;
}

function HorizontalBars({ rows, locale, valueLabel }: { rows: ChartRow[]; locale: string; valueLabel: string }) {
  return (
    <div style={{ height: rows.length * 26 + 24 }} data-testid="store-panel-bars">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-border)" />
          <XAxis
            type="number"
            tickFormatter={(value: number) => value.toLocaleString(locale, { notation: "compact" })}
            tick={CHART_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={132}
            tickFormatter={(value: string) => truncateLabel(value, 22)}
            tick={CHART_TICK}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            formatter={(value: number) => [formatBRL(value, locale), valueLabel]}
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar dataKey="value" fill={CHART_COLOR} radius={[0, 4, 4, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function AnalysisCard({
  title,
  subtitle,
  testId,
  children,
}: {
  title: string;
  subtitle: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-sm border-border/50 min-w-0" data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export function PanelProducts({ products }: { products: StorePanelData["products"] }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const labelOf = (row: StorePanelProductRow) =>
    row.kind === "others" ? t("store.panel.products.others") : row.name ?? t("store.panel.products.unnamed");

  return (
    <AnalysisCard
      title={t("store.panel.products.title")}
      subtitle={t("store.panel.products.subtitle")}
      testId="store-panel-products"
    >
      {products.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("store.panel.products.empty")}</p>
      ) : (
        <>
          <HorizontalBars
            rows={products.rows.map(row => ({ label: labelOf(row), value: row.value }))}
            locale={locale}
            valueLabel={t("store.panel.products.value")}
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("store.panel.products.product")}</TableHead>
                <TableHead className="text-right">{t("store.panel.products.quantity")}</TableHead>
                <TableHead className="text-right">{t("store.panel.products.value")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.rows.map((row, index) => (
                <TableRow key={`${row.kind}-${index}`}>
                  <TableCell className="max-w-[240px]">
                    <p className="truncate" title={labelOf(row)}>{labelOf(row)}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.quantity.toLocaleString(locale)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatBRL(row.value, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("store.panel.products.total")}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{products.totalQuantity.toLocaleString(locale)}</TableCell>
                <TableCell className="text-right whitespace-nowrap font-semibold tabular-nums">{formatBRL(products.totalValue, locale)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </AnalysisCard>
  );
}

export function PanelCities({ cities }: { cities: StorePanelData["cities"] }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const othersKeys: Record<StorePanelCityRow["kind"], TranslationKey | null> = {
    city: null,
    others: "store.panel.cities.others",
    unknown: "store.panel.cities.unknown",
  };
  const labelOf = (row: StorePanelCityRow) => {
    const key = othersKeys[row.kind];
    if (key) return t(key);
    if (!row.city) return t("store.panel.cities.unknown");
    return row.region ? `${row.city}/${row.region}` : row.city;
  };
  const totalAvg = cities.totalOrders > 0 ? cities.totalValue / cities.totalOrders : null;

  return (
    <AnalysisCard
      title={t("store.panel.cities.title")}
      subtitle={t("store.panel.cities.subtitle")}
      testId="store-panel-cities"
    >
      {cities.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("store.panel.cities.empty")}</p>
      ) : (
        <>
          <HorizontalBars
            rows={cities.rows.map(row => ({ label: labelOf(row), value: row.value }))}
            locale={locale}
            valueLabel={t("store.panel.cities.value")}
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("store.panel.cities.city")}</TableHead>
                <TableHead className="text-right">{t("store.panel.cities.orders")}</TableHead>
                <TableHead className="text-right">{t("store.panel.cities.value")}</TableHead>
                <TableHead className="text-right hidden sm:table-cell">{t("store.panel.cities.avg_ticket")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cities.rows.map((row, index) => (
                <TableRow key={`${row.kind}-${index}`}>
                  <TableCell className="max-w-[200px]">
                    <p className="truncate" title={labelOf(row)}>{labelOf(row)}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.orders.toLocaleString(locale)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatBRL(row.value, locale)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums hidden sm:table-cell">
                    {row.avgTicket === null ? "—" : formatBRL(row.avgTicket, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("store.panel.cities.total")}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{cities.totalOrders.toLocaleString(locale)}</TableCell>
                <TableCell className="text-right whitespace-nowrap font-semibold tabular-nums">{formatBRL(cities.totalValue, locale)}</TableCell>
                <TableCell className="text-right whitespace-nowrap font-semibold tabular-nums hidden sm:table-cell">
                  {totalAvg === null ? "—" : formatBRL(totalAvg, locale)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </AnalysisCard>
  );
}
