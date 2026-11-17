import type { StorePanelData } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLang } from "@/contexts/language";
import { formatBRL } from "@/lib/store-panel";
import { SITUATION_DOT, SITUATION_KEYS } from "./shared";

export function PanelSituations({ situations }: { situations: StorePanelData["situations"] }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";

  return (
    <Card className="shadow-sm border-border/50" data-testid="store-panel-situations">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{t("store.panel.situations.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("store.panel.situations.situation")}</TableHead>
              <TableHead className="text-right">{t("store.panel.situations.orders")}</TableHead>
              <TableHead className="text-right">{t("store.panel.situations.value")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {situations.map(row => (
              <TableRow key={row.situation} data-testid={`situation-${row.situation}`}>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${SITUATION_DOT[row.situation]}`} />
                    {t(SITUATION_KEYS[row.situation])}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.orders.toLocaleString(locale)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBRL(row.value, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
