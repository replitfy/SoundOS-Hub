import { useRef, useState, type KeyboardEvent } from "react";
import type {
  StoreSituation,
  StorePanelData,
  StorePanelOrderRow,
} from "@workspace/api-client-react";
import { StoreSituation as Situations } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";
import { formatBRL, formatOrderDate, fullOrderItems, summarizeOrderItems } from "@/lib/store-panel";
import { OrderSheet } from "./order-sheet";
import { DELIVERY_KEYS, PAYMENT_KEYS, PAYMENT_VARIANT, SITUATION_KEYS } from "./shared";

const ALL = "all";

interface PanelOrdersProps {
  orders: StorePanelData["orders"];
  situation: StoreSituation | null;
  loading: boolean;
  onSituationChange: (situation: StoreSituation | null) => void;
  onPageChange: (page: number) => void;
}

export function PanelOrders({ orders, situation, loading, onSituationChange, onPageChange }: PanelOrdersProps) {
  const { t, lang } = useLang();
  const { can } = useAccess();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const canSeePessoas = can("pessoas");
  const [openRow, setOpenRow] = useState<StorePanelOrderRow | null>(null);
  // A linha que abriu a ficha recebe o foco de volta ao fechar (teclado e leitor de tela).
  const openerRef = useRef<HTMLElement | null>(null);

  function openOrder(order: StorePanelOrderRow, element: HTMLElement) {
    openerRef.current = element;
    setOpenRow(order);
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, order: StorePanelOrderRow) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOrder(order, event.currentTarget);
    }
  }

  function linkLabel(link: NonNullable<StorePanelOrderRow["pessoaLink"]>): string {
    if (link.mode === "name") return t("store.panel.orders.linked_name").replace("{pct}", String(link.similarity ?? 0));
    if (link.mode === "phone") return t("store.panel.orders.linked_phone");
    if (link.mode === "both") return t("store.panel.orders.linked_both");
    return t("store.panel.orders.linked_email");
  }

  return (
    <Card className="shadow-sm border-border/50" data-testid="store-panel-orders">
      <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-sm font-semibold">{t("store.panel.orders.title")}</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {orders.total.toLocaleString(locale)} {t("store.panel.orders.count")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("store.panel.orders.filter")}</span>
          <Select
            value={situation ?? ALL}
            onValueChange={value => onSituationChange(value === ALL ? null : (value as StoreSituation))}
          >
            <SelectTrigger className="h-8 w-[200px] text-xs" aria-label={t("store.panel.orders.filter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("store.panel.orders.all")}</SelectItem>
              {Object.values(Situations).map(value => (
                <SelectItem key={value} value={value}>{t(SITUATION_KEYS[value])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {orders.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground" data-testid="store-panel-orders-empty">
            {situation ? t("store.panel.orders.empty_filtered") : t("store.panel.orders.empty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("store.panel.orders.number")}</TableHead>
                <TableHead>{t("store.panel.orders.date")}</TableHead>
                <TableHead>{t("store.panel.orders.customer")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("store.panel.orders.items")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("store.panel.orders.city")}</TableHead>
                <TableHead className="text-right">{t("store.panel.orders.value")}</TableHead>
                <TableHead>{t("store.panel.orders.payment")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("store.panel.orders.delivery")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.rows.map(order => (
                <TableRow
                  key={order.id}
                  data-testid={`order-${order.number}`}
                  tabIndex={0}
                  aria-haspopup="dialog"
                  aria-label={`${t("store.panel.orders.open")} #${order.number}`}
                  className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={event => openOrder(order, event.currentTarget)}
                  onKeyDown={event => onRowKeyDown(event, order)}
                >
                  <TableCell className="font-medium tabular-nums">#{order.number}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatOrderDate(order.createdAt, locale)}</TableCell>
                  <TableCell className="max-w-[200px]">
                    <p className="flex items-center gap-1.5">
                      <span className="truncate">{order.customerName ?? t("store.panel.orders.no_customer")}</span>
                      {canSeePessoas && order.pessoaLink && (
                        <span
                          className={`inline-flex shrink-0 ${order.pessoaLink.mode === "name" ? "text-muted-foreground/40" : "text-primary/70"}`}
                          title={linkLabel(order.pessoaLink)}
                          role="img"
                          aria-label={linkLabel(order.pessoaLink)}
                          data-testid={`order-link-${order.number}`}
                          data-mode={order.pessoaLink.mode}
                        >
                          <Link2 className="h-3 w-3" />
                        </span>
                      )}
                    </p>
                    <p className="lg:hidden truncate text-[11px] text-muted-foreground" title={fullOrderItems(order.items)}>
                      {summarizeOrderItems(order.items)}
                    </p>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell max-w-[280px]">
                    <p className="truncate text-muted-foreground" title={fullOrderItems(order.items)}>
                      {summarizeOrderItems(order.items)}
                    </p>
                  </TableCell>
                  <TableCell className="hidden md:table-cell whitespace-nowrap">
                    {order.city ? `${order.city}${order.region ? `/${order.region}` : ""}` : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatBRL(order.total, locale)}</TableCell>
                  <TableCell>
                    <Badge variant={PAYMENT_VARIANT[order.payment]} className="whitespace-nowrap font-normal">
                      {t(PAYMENT_KEYS[order.payment])}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell whitespace-nowrap text-muted-foreground">
                    {t(DELIVERY_KEYS[order.delivery])}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {orders.totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={orders.page <= 1 || loading}
              onClick={() => onPageChange(orders.page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5 mr-1" />
              {t("store.panel.orders.prev")}
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums" data-testid="store-panel-page">
              {t("store.panel.orders.page")} {orders.page} {t("store.panel.orders.of")} {orders.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={orders.page >= orders.totalPages || loading}
              onClick={() => onPageChange(orders.page + 1)}
            >
              {t("store.panel.orders.next")}
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        )}
      </CardContent>
      <OrderSheet
        row={openRow}
        canSeePessoas={canSeePessoas}
        onClose={() => setOpenRow(null)}
        onCloseAutoFocus={event => {
          event.preventDefault();
          openerRef.current?.focus();
        }}
      />
    </Card>
  );
}
