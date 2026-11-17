import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  getGetStorePanelQueryKey,
  useGetStorePanel,
  useRefreshStorePanel,
  type GetStorePanelParams,
  type StoreSituation,
} from "@workspace/api-client-react";
import { AlertTriangle, Loader2, RefreshCw, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelCities, PanelProducts } from "@/components/store-panel/panel-analysis";
import { PanelKpis } from "@/components/store-panel/panel-kpis";
import { PanelMonthly } from "@/components/store-panel/panel-monthly";
import { PanelOrders } from "@/components/store-panel/panel-orders";
import { PanelSituations } from "@/components/store-panel/panel-situations";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { shouldTryAutomaticRefresh } from "@/lib/store-panel";

type Period = NonNullable<GetStorePanelParams["period"]>;
type PeriodSelection = Period | "custom";

const PERIODS: PeriodSelection[] = ["30d", "90d", "12m", "all"];
const DEFAULT_PERIOD: Period = "12m";
const POLL_WHILE_REFRESHING_MS = 3000;

function saoPauloToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodDates(period: Period): { start: string; end: string } {
  const end = saoPauloToday();
  if (period === "all") return { start: "", end: "" };
  if (period === "30d") return { start: shiftIsoDate(end, -29), end };
  if (period === "90d") return { start: shiftIsoDate(end, -89), end };
  const [year, month] = end.split("-").map(Number) as [number, number, number?];
  const start = new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10);
  return { start, end };
}

const KNOWN_ERROR_CODES = new Set([
  "not_configured",
  "credential_refused",
  "wix_unavailable",
  "too_many_orders",
  "unexpected_response",
  "unsupported_currency",
  "interrupted",
  "unknown",
]);

export default function StorePanel() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<PeriodSelection>(DEFAULT_PERIOD);
  const [dateRange, setDateRange] = useState(() => periodDates(DEFAULT_PERIOD));
  const [productKey, setProductKey] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [situation, setSituation] = useState<StoreSituation | null>(null);
  const [page, setPage] = useState(1);

  const params: GetStorePanelParams = {
    period: period === "custom" ? "all" : period,
    page,
    ...(dateRange.start ? { dataDe: dateRange.start } : {}),
    ...(dateRange.end ? { dataAte: dateRange.end } : {}),
    ...(productKey ? { product: productKey } : {}),
    ...(situation ? { situation } : {}),
  };
  const panelQuery = useGetStorePanel(params, {
    query: {
      queryKey: getGetStorePanelQueryKey(params),
      // Troca de filtro mantém a tela anterior até a nova chegar, sem piscar.
      placeholderData: keepPreviousData,
      // Reabrir a tela sempre relê o que está salvo; foco e reconexão nunca viram atualização.
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: query => (query.state.data?.status === "refreshing" ? POLL_WHILE_REFRESHING_MS : false),
    },
  });
  const refreshMutation = useRefreshStorePanel({
    mutation: {
      onSettled: () => queryClient.invalidateQueries({ queryKey: getGetStorePanelQueryKey() }),
    },
  });

  // Uma tentativa automática por abertura da tela, só depois de ler o estado salvo. O servidor
  // aplica a regra de "uma por dia" de forma definitiva; aqui só evitamos chamadas que ele recusaria.
  const automaticChecked = useRef(false);
  const { data: panel, isFetching, isSuccess, isPlaceholderData } = panelQuery;
  const { mutate: refresh } = refreshMutation;
  useEffect(() => {
    if (automaticChecked.current || !isSuccess || isFetching || isPlaceholderData || !panel) return;
    automaticChecked.current = true;
    if (shouldTryAutomaticRefresh(panel)) refresh({ params: { trigger: "automatic" } });
  }, [isSuccess, isFetching, isPlaceholderData, panel, refresh]);

  const data = panel?.data ?? null;
  const normalizedProductSearch = productSearch.trim().toLocaleLowerCase("pt-BR");
  const visibleProducts = (data?.productOptions ?? []).filter(product =>
    product.key === productKey || product.name.toLocaleLowerCase("pt-BR").includes(normalizedProductSearch),
  );
  const refreshing = refreshMutation.isPending || panel?.status === "refreshing";
  const loadingFirst = panelQuery.isLoading;
  const filtersLoading = isPlaceholderData;

  const serverErrorMessage = panel?.lastErrorCode
    ? KNOWN_ERROR_CODES.has(panel.lastErrorCode)
      ? t(`store.panel.err.${panel.lastErrorCode}` as TranslationKey)
      : (panel.lastError ?? t("store.panel.err.unknown"))
    : (panel?.lastError ?? null);
  const errorMessage = refreshMutation.isError
    ? t("store.panel.err.request")
    : panel?.status === "error" || serverErrorMessage
      ? (serverErrorMessage ?? t("store.panel.err.unknown"))
      : panelQuery.isError && !panel
        ? t("store.panel.err.load")
        : null;
  const collectedAt = panel?.collectedAt ? new Date(panel.collectedAt) : null;

  function changePeriod(value: string) {
    if (value === "custom") {
      setPeriod("custom");
    } else {
      const nextPeriod = value as Period;
      setPeriod(nextPeriod);
      setDateRange(periodDates(nextPeriod));
    }
    setPage(1);
  }

  function changeDateRange(field: "start" | "end", value: string) {
    setPeriod("custom");
    setDateRange(current => ({ ...current, [field]: value }));
    setPage(1);
  }

  function changeProduct(value: string) {
    setProductKey(value === "__all__" ? "" : value);
    setProductSearch("");
    setPage(1);
  }

  function changeSituation(value: StoreSituation | null) {
    setSituation(value);
    setPage(1);
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground mb-0.5">{t("store.panel.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("store.panel.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={changePeriod} disabled={!data}>
              <SelectTrigger className="h-8 w-[170px] text-xs" aria-label={t("store.panel.period.label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map(value => (
                  <SelectItem key={value} value={value}>
                    {t(`store.panel.period.${value}` as TranslationKey)}
                  </SelectItem>
                ))}
                {period === "custom" && (
                  <SelectItem value="custom">{t("store.panel.period.custom")}</SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={() => refresh({ params: { trigger: "manual" } })}
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              {t("store.panel.refresh")}
            </Button>
          </div>
          {collectedAt && (
            <span className="text-[10px] text-muted-foreground" data-testid="store-panel-updated-at">
              {t("store.panel.updated_at")} {formatDateTimeBR(collectedAt)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card px-3 py-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("store.panel.filter.start")}
          <input
            type="date"
            aria-label={t("store.panel.filter.start")}
            data-testid="store-panel-date-start"
            value={dateRange.start}
            max={dateRange.end || undefined}
            onChange={event => changeDateRange("start", event.currentTarget.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("store.panel.filter.end")}
          <input
            type="date"
            aria-label={t("store.panel.filter.end")}
            data-testid="store-panel-date-end"
            value={dateRange.end}
            min={dateRange.start || undefined}
            onChange={event => changeDateRange("end", event.currentTarget.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{t("store.panel.filter.product")}</span>
          <input
            type="search"
            aria-label={t("store.panel.filter.search_product")}
            data-testid="store-panel-product-search"
            placeholder={t("store.panel.filter.search_product")}
            value={productSearch}
            onChange={event => setProductSearch(event.currentTarget.value)}
            disabled={!data}
            className="h-9 w-[230px] max-w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
          />
          <Select value={productKey || "__all__"} onValueChange={changeProduct} disabled={!data}>
            <SelectTrigger className="h-9 w-[230px] max-w-full text-sm" aria-label={t("store.panel.filter.product")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("store.panel.filter.all_products")}</SelectItem>
              {visibleProducts.map(product => (
                <SelectItem key={product.key} value={product.key}>{product.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {normalizedProductSearch && visibleProducts.length === 0 && (
            <span className="text-xs" role="status">{t("store.panel.filter.no_product_match")}</span>
          )}
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="text-xs leading-relaxed" data-testid="store-panel-error">
            {t("store.panel.failed")} {errorMessage}
            {collectedAt ? ` ${t("store.panel.kept_data")} ${formatDateTimeBR(collectedAt)}.` : ""}{" "}
            {t("store.panel.failed_hint")}
          </p>
        </div>
      )}

      {refreshing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="store-panel-refreshing">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("store.panel.refreshing")}
        </div>
      )}

      {loadingFirst && <PanelSkeleton label={t("store.panel.loading")} />}

      {!loadingFirst && !data && !refreshing && panel && (
        <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="store-panel-empty">
          <Store className="h-10 w-10 text-muted-foreground/30 mb-4" />
          <p className="text-base font-semibold text-foreground">{t("store.panel.empty.title")}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">{t("store.panel.empty.body")}</p>
        </div>
      )}

      {!loadingFirst && !data && refreshing && <PanelSkeleton label={t("store.panel.refreshing")} />}

      {data && (
        <div className="space-y-5">
          <PanelKpis kpis={data.kpis} />
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <PanelSituations situations={data.situations} />
            <div className="xl:col-span-2 min-w-0">
              <PanelMonthly monthly={data.monthly} />
            </div>
          </div>
          <PanelOrders
            orders={data.orders}
            situation={situation}
            loading={filtersLoading}
            onSituationChange={changeSituation}
            onPageChange={setPage}
          />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <PanelProducts products={data.products} />
            <PanelCities cities={data.cities} />
          </div>
          <Card className="shadow-sm border-border/50 bg-muted/30" data-testid="store-panel-note">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold">{t("store.panel.note.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("store.panel.note.body")}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-5" aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-[92px] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
      <p className="text-center text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
