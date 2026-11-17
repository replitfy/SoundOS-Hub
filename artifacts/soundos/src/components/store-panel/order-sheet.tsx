import type { ReactNode } from "react";
import {
  getGetStorePanelOrderQueryKey,
  useGetStorePanelOrder,
  type StoreOrderDetail,
  type StoreOrderPessoaLink,
  type StorePanelOrderRow,
} from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatBRL, formatOrderDateTime, formatPhone } from "@/lib/store-panel";
import { DELIVERY_KEYS, PAYMENT_KEYS, PAYMENT_VARIANT, SITUATION_KEYS } from "./shared";

interface OrderSheetProps {
  /** Linha clicada na lista: o título aparece na hora, antes de o detalhe chegar. */
  row: StorePanelOrderRow | null;
  /** Só quem tem a área Pessoas vê a seção da ficha. */
  canSeePessoas: boolean;
  onClose: () => void;
  /** Devolve o foco para a linha que abriu a ficha. */
  onCloseAutoFocus: (event: Event) => void;
}

export function OrderSheet({ row, canSeePessoas, onClose, onCloseAutoFocus }: OrderSheetProps) {
  const { t } = useLang();
  return (
    <Sheet open={row !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t("store.panel.order.close")}
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-full overflow-y-auto sm:max-w-xl"
        data-testid="store-panel-order-sheet"
      >
        {row && (
          <>
            <SheetHeader className="pr-6">
              <SheetTitle>
                {t("store.panel.order.title")} #{row.number}
              </SheetTitle>
              <SheetDescription className="sr-only">{row.customerName ?? ""}</SheetDescription>
            </SheetHeader>
            <OrderSheetBody orderId={row.id} canSeePessoas={canSeePessoas} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function OrderSheetBody({ orderId, canSeePessoas }: { orderId: string; canSeePessoas: boolean }) {
  const { t } = useLang();
  const query = useGetStorePanelOrder(orderId, {
    query: {
      queryKey: getGetStorePanelOrderQueryKey(orderId),
      // Cada abertura lê de novo o que está salvo; nunca reaproveita a ligação de uma abertura anterior.
      gcTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    },
  });

  if (query.isLoading) {
    return (
      <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground" data-testid="order-sheet-loading">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("store.panel.order.loading")}
      </div>
    );
  }
  if (query.isError || !query.data) {
    const notFound = (query.error as { status?: number } | null)?.status === 404;
    return (
      <div className="mt-6 space-y-3 text-sm" role="alert" data-testid={notFound ? "order-sheet-not-found" : "order-sheet-error"}>
        <p className="text-muted-foreground">
          {notFound ? t("store.panel.order.not_found") : t("store.panel.order.error")}
        </p>
        {!notFound && (
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("store.panel.order.retry")}
          </Button>
        )}
      </div>
    );
  }
  return <OrderDetail order={query.data} canSeePessoas={canSeePessoas} />;
}

function Section({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 text-sm">
      <dt className="pt-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function OrderDetail({ order, canSeePessoas }: { order: StoreOrderDetail; canSeePessoas: boolean }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const pending = <span className="text-muted-foreground">{t("store.panel.order.after_refresh")}</span>;
  const empty = <span className="text-muted-foreground">{t("store.panel.order.not_informed")}</span>;
  const place = order.customer.city
    ? `${order.customer.city}${order.customer.region ? `/${order.customer.region}` : ""}`
    : null;
  const money = (value: number | null) => (value === null ? "—" : formatBRL(value, locale));

  return (
    <div className="mt-5 space-y-6" data-testid="order-sheet-detail">
      <Section title={t("store.panel.order.situation")} testId="order-sheet-summary">
        <dl className="space-y-1.5">
          <Field label={t("store.panel.orders.date")}>{formatOrderDateTime(order.createdAt, locale)}</Field>
          <Field label={t("store.panel.order.situation")}>{t(SITUATION_KEYS[order.situation])}</Field>
          <Field label={t("store.panel.order.payment")}>
            <Badge variant={PAYMENT_VARIANT[order.payment]} className="whitespace-nowrap font-normal">
              {t(PAYMENT_KEYS[order.payment])}
            </Badge>
          </Field>
          <Field label={t("store.panel.order.delivery")}>{t(DELIVERY_KEYS[order.delivery])}</Field>
          <Field label={t("store.panel.order.confirmed")}>
            <span data-testid="order-sheet-confirmed">
              {order.confirmedSale ? t("store.panel.order.confirmed_yes") : t("store.panel.order.confirmed_no")}
            </span>
          </Field>
        </dl>
      </Section>

      <Section title={t("store.panel.order.customer")} testId="order-sheet-customer">
        <dl className="space-y-1.5">
          <Field label={t("store.panel.order.name")}>{order.customer.name ?? t("store.panel.orders.no_customer")}</Field>
          <Field label={t("store.panel.order.email")}>
            {!order.contactAvailable ? pending : (order.customer.email ?? empty)}
          </Field>
          <Field label={t("store.panel.order.phone")}>
            {!order.contactAvailable ? pending : order.customer.phone ? formatPhone(order.customer.phone) : empty}
          </Field>
          <Field label={t("store.panel.order.city")}>{place ?? empty}</Field>
        </dl>
      </Section>

      {canSeePessoas && order.pessoa && (
        <Section title={t("store.panel.pessoa.title")} testId="order-sheet-pessoa">
          <PessoaLink link={order.pessoa} orderName={order.customer.name} />
        </Section>
      )}

      <Section title={t("store.panel.order.items")} testId="order-sheet-items">
        {order.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("store.panel.order.items_empty")}</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {order.items.map((item, index) => (
              <li key={index} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 break-words">
                  <span className="tabular-nums text-muted-foreground">{item.quantity}× </span>
                  {item.name}
                </span>
                <span className="shrink-0 tabular-nums">{formatBRL(item.value, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("store.panel.order.amounts")} testId="order-sheet-amounts">
        <dl className="space-y-1.5 text-sm">
          <AmountRow label={t("store.panel.order.subtotal")} value={money(order.amounts.subtotal)} />
          <AmountRow
            label={t("store.panel.order.discount")}
            value={order.amounts.discount === null ? "—" : `− ${formatBRL(order.amounts.discount, locale)}`}
          />
          <AmountRow
            label={t("store.panel.order.shipping")}
            hint={order.amounts.shippingMethod}
            value={formatBRL(order.amounts.shipping, locale)}
          />
          <AmountRow label={t("store.panel.order.tax")} value={money(order.amounts.tax)} />
          <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-2 font-semibold">
            <dt>{t("store.panel.order.total")}</dt>
            <dd className="tabular-nums" data-testid="order-sheet-total">{formatBRL(order.amounts.total, locale)}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

function AmountRow({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">
        {label}
        {hint ? <span className="ml-1.5 text-xs">({hint})</span> : null}
      </dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

const FOUND_BY_KEYS: Record<NonNullable<StoreOrderPessoaLink["mode"]>, TranslationKey> = {
  email: "store.panel.pessoa.by_email",
  phone: "store.panel.pessoa.by_phone",
  both: "store.panel.pessoa.by_both",
  name: "store.panel.pessoa.by_name",
};

function PessoaLink({ link, orderName }: { link: StoreOrderPessoaLink; orderName: string | null }) {
  const { t } = useLang();
  const open = (id: number) => (
    <Button asChild size="sm" variant="outline" className="shrink-0">
      <Link href={`/pessoas/${id}`}>{t("store.panel.pessoa.open")}</Link>
    </Button>
  );
  const pct = (value: number | null | undefined) => (value ?? 0).toString();

  switch (link.state) {
    case "linked": {
      if (!link.person || !link.mode) return null;
      const byName = link.mode === "name";
      return (
        <div className="space-y-2.5" data-testid="order-pessoa-linked" data-mode={link.mode}>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2.5">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">{link.person.nome}</p>
              <p className="text-xs text-muted-foreground">
                {t("store.panel.pessoa.code")} {link.person.codigo}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t(FOUND_BY_KEYS[link.mode])}</p>
            </div>
            {open(link.person.id)}
          </div>
          {byName && (
            <div
              className="space-y-1 rounded-md bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
              data-testid="order-pessoa-name-notice"
            >
              <p>{t("store.panel.pessoa.name_notice").replace("{pct}", pct(link.similarity))}</p>
              <p>
                <span className="font-medium">{t("store.panel.pessoa.order_name")}:</span> {orderName ?? "—"}
              </p>
              <p>
                <span className="font-medium">{t("store.panel.pessoa.ficha_name")}:</span> {link.person.nome}
              </p>
            </div>
          )}
        </div>
      );
    }
    case "review": {
      const explanation =
        link.source === "name"
          ? "store.panel.pessoa.review_name"
          : link.reason === "contradictory"
            ? "store.panel.pessoa.review_contradictory"
            : "store.panel.pessoa.review_ambiguous";
      return (
        <div className="space-y-2.5" data-testid="order-pessoa-review">
          <p className="text-sm text-muted-foreground">{t(explanation)}</p>
          <p className="text-xs font-medium">{t("store.panel.pessoa.candidates")}</p>
          <ul className="space-y-2">
            {(link.candidates ?? []).map(candidate => (
              <li
                key={candidate.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                data-testid={`order-pessoa-candidate-${candidate.id}`}
              >
                <div className="min-w-0">
                  <p className="break-words text-sm">{candidate.nome}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("store.panel.pessoa.code")} {candidate.codigo}
                    {candidate.similarity !== null && candidate.similarity !== undefined
                      ? ` · ${t("store.panel.pessoa.similarity").replace("{pct}", pct(candidate.similarity))}`
                      : ""}
                  </p>
                </div>
                {open(candidate.id)}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "unidentifiable":
      return (
        <p className="text-sm text-muted-foreground" data-testid="order-pessoa-unidentifiable">
          {t("store.panel.pessoa.unidentifiable")}
        </p>
      );
    case "contact_pending":
      return (
        <p className="text-sm text-muted-foreground" data-testid="order-pessoa-pending">
          {t("store.panel.order.after_refresh")}
        </p>
      );
    default:
      return (
        <p className="text-sm text-muted-foreground" data-testid="order-pessoa-none">
          {t("store.panel.pessoa.none")}
        </p>
      );
  }
}
