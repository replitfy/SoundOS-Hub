import {
  getGetDashboardSnapshotQueryKey,
  useGetDashboardSnapshot,
  useRefreshDashboardSnapshot,
  type PeopleDistribution,
} from "@workspace/api-client-react";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, ArrowDownRight, AlertTriangle, MessageSquare, RefreshCw, Clock, Loader2, ShoppingBag, Users } from "lucide-react";
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";

export default function Dashboard() {
  const queryClient = useQueryClient();
  const automaticRefreshStarted = useRef(false);
  const snapshotQuery = useGetDashboardSnapshot({
    query: {
      // Re-read the persisted snapshot when the dashboard mounts (including
      // after login), but never turn passive browser events into a refresh.
      queryKey: getGetDashboardSnapshotQueryKey(),
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });
  const refreshMutation = useRefreshDashboardSnapshot({
    mutation: {
      onSuccess: (snapshot) => {
        queryClient.setQueryData(getGetDashboardSnapshotQueryKey(), snapshot);
      },
    },
  });

  useEffect(() => {
    if (automaticRefreshStarted.current) return;
    automaticRefreshStarted.current = true;
    void refreshMutation.mutateAsync().catch(() => {
      // The mutation state renders the error while preserving any cached snapshot.
    });
  }, [refreshMutation.mutateAsync]);

  const snapshot = snapshotQuery.data;
  const kpis = snapshot?.data?.kpis;
  const finance = snapshot?.data?.financeSummary;
  const peopleAnalytics = snapshot?.data?.peopleAnalytics;
  const hasData = Boolean(snapshot?.data);
  const isFetching = refreshMutation.isPending;
  const requestFailed = snapshotQuery.isError || refreshMutation.isError;
  const loadingSnapshot = snapshotQuery.isLoading || (isFetching && !hasData);
  const kpisLoading = loadingSnapshot;
  const financeLoading = loadingSnapshot;
  const lastUpdatedAt = snapshot?.collectedAt ? new Date(snapshot.collectedAt) : null;

  async function handleRefresh() {
    try {
      await refreshMutation.mutateAsync();
    } catch {
      // The mutation state renders the error while preserving any cached snapshot.
    }
  }

  const { t, lang } = useLang();
  const numLocale = lang === "fr" ? "fr-FR" : "pt-BR";
  const dayTick = (value: string) => {
    const date = new Date(`${value}T12:00:00`);
    return date.toLocaleDateString(numLocale, { day: "2-digit", month: "short" });
  };

  const omieStatus = finance?.omieStatus;
  const showOmieWarning =
    !financeLoading &&
    (requestFailed || snapshot?.status === "error" || Boolean(omieStatus && omieStatus !== "ok"));

  return (
    <div className="space-y-7 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground mb-0.5">{t("dashboard.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dashboard.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Button onClick={handleRefresh} disabled={isFetching} size="sm" variant="outline">
            {isFetching ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Atualizar
          </Button>
          {lastUpdatedAt && (
            <span className="text-[10px] text-muted-foreground">
              {lang === "fr" ? "Mis à jour le" : "Atualizado em"}{" "}
              {formatDateTimeBR(lastUpdatedAt)}
            </span>
          )}
        </div>
      </div>
      {!hasData && !isFetching && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          {snapshot?.status === "error" || requestFailed ? (
            <AlertTriangle className="h-10 w-10 text-amber-500/60 mb-4" />
          ) : (
            <RefreshCw className="h-10 w-10 text-muted-foreground/25 mb-4" />
          )}
          <p className="text-sm text-muted-foreground">
            {snapshot?.lastError ??
              (requestFailed
                ? "Não foi possível carregar o Dashboard. Tente novamente."
                : "Carregando dados atualizados…")}
          </p>
        </div>
      )}
      {(hasData || isFetching) && (
        <>
        {showOmieWarning && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
            {omieStatus === "timeout" ? (
              <Clock className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <p className="text-xs leading-relaxed">
              {snapshot?.lastError ??
                (requestFailed
                  ? "Não foi possível atualizar o Dashboard. Os dados anteriores foram mantidos."
                  : omieStatus === "timeout"
                    ? t("dashboard.omie_timeout")
                    : t("dashboard.omie_error"))}
            </p>
          </div>
        )}
        {finance?.avisos?.map((aviso) => (
          <div
            key={aviso}
            data-testid="dashboard-aviso-titulos"
            className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">{aviso}</p>
          </div>
        ))}

      <section>
        <SectionLabel>{t("dashboard.kpis")}</SectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
          {kpisLoading ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
          ) : kpis ? (
            <>
              <KpiCard
                title={t("dashboard.conversas_abertas")}
                value={String(kpis.openConversations)}
                change={kpis.openConversationsChange}
                suffix={t("dashboard.vs_mes_ant")}
                inverse
                color="#D94A3A"
                icon={<MessageSquare className="h-4 w-4" />}
              />
              <KpiCard
                title={t("dashboard.pedidos_mes")}
                value={kpis.storeOrdersCurrentMonth == null ? "—" : String(kpis.storeOrdersCurrentMonth)}
                change={kpis.storeOrdersCurrentMonth != null && kpis.storeOrdersPreviousMonth != null && kpis.storeOrdersPreviousMonth > 0
                  ? Math.round(((kpis.storeOrdersCurrentMonth ?? 0) - kpis.storeOrdersPreviousMonth) / kpis.storeOrdersPreviousMonth * 100)
                  : undefined}
                suffix={kpis.storeOrdersCurrentMonth != null && kpis.storeOrdersPreviousMonth != null
                  ? t("dashboard.vs_mes_ant")
                  : undefined}
                color="#8A4E2E"
                icon={<ShoppingBag className="h-4 w-4" />}
                detail={kpis.storeOrdersCurrentMonth != null && kpis.storeOrdersPreviousMonth != null
                  ? `${kpis.storeOrdersPreviousMonth.toLocaleString(numLocale)} ${t("dashboard.pedidos_mes_anterior")}${kpis.storeOrdersCollectedAt
                    ? ` · ${t("dashboard.pedidos_atualizados")} ${formatDateTimeBR(new Date(kpis.storeOrdersCollectedAt))}`
                    : ""}`
                  : t("dashboard.pedidos_sem_dados")}
                testId="dashboard-kpi-orders"
              />
              {peopleAnalytics && (
                <PeopleKpiCard
                  total={peopleAnalytics.totalPeople}
                  distribution={peopleAnalytics.sex}
                  locale={numLocale}
                  t={t}
                />
              )}
            </>
          ) : null}
        </div>
      </section>

      <section>
        <SectionLabel>Inteligência de Pessoas</SectionLabel>
        <div className="mt-3 rounded-xl border border-primary/10 bg-primary/[0.035] px-4 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Os percentuais de cada categoria são calculados somente sobre as fichas que possuem
            aquela informação preenchida. Registros sem informação aparecem separadamente em cinza
            claro e não entram nos gráficos de pizza.
          </p>
        </div>
        {loadingSnapshot ? (
          <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-[340px] rounded-xl" />
            ))}
          </div>
        ) : peopleAnalytics ? (
          <>
            <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
              <PieDistributionCard
                title="Pessoas por sexo"
                distribution={peopleAnalytics.sex}
                locale={numLocale}
              />
              <BarDistributionCard
                title="Como conheceu a Soundfulness"
                distribution={peopleAnalytics.referralSources}
                locale={numLocale}
                color="#8A4E2E"
              />
              <BarDistributionCard
                title="Pessoas por estado"
                distribution={peopleAnalytics.states}
                locale={numLocale}
                color="#5777A6"
              />
              <BarDistributionCard
                title="Principais cidades"
                distribution={peopleAnalytics.cities}
                locale={numLocale}
                color="#7C9B72"
              />
            </div>
          </>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-5">
        <Card className="shadow-sm border-border/50">
          <CardHeader className="pb-0">
            <CardTitle className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted-foreground">
              {t("dashboard.crescimento")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="h-[180px]">
              {financeLoading ? (
                <Skeleton className="h-full w-full" />
              ) : finance?.leadGrowth ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={finance.leadGrowth} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="interestGrad" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#5777A6" />
                        <stop offset="100%" stopColor="#5A78A8" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="day" tickFormatter={dayTick} minTickGap={16} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", fontSize: 12 }}
                      formatter={(value: number) => [
                        value.toLocaleString(numLocale),
                        t("dashboard.lead_forms"),
                      ]}
                    />
                    <Line type="monotone" dataKey="leads" name="leads" stroke="url(#interestGrad)" strokeWidth={2.5} dot={{ r: 2, fill: "#5777A6" }} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
        </>
      )}
    </div>
  );
}

const DISTRIBUTION_COLORS = ["#5777A6", "#C9A45D", "#8A4E2E", "#7C9B72", "#9A6FA8", "#D37B62"];

function DistributionHeader({
  title,
  distribution,
  locale,
}: {
  title: string;
  distribution: PeopleDistribution;
  locale: string;
}) {
  return (
    <CardHeader className="pb-2">
      <CardTitle className="text-sm font-semibold text-foreground">{title}</CardTitle>
      <p className="text-[11px] text-muted-foreground">
        {distribution.filledCount.toLocaleString(locale)} fichas com informação preenchida
      </p>
    </CardHeader>
  );
}

function MissingDataFooter({
  distribution,
  locale,
}: {
  distribution: PeopleDistribution;
  locale: string;
}) {
  return (
    <div className="mt-3 flex items-center justify-between rounded-lg bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" />
        Não informado
      </span>
      <span className="tabular-nums">
        {distribution.missingCount.toLocaleString(locale)} fichas · {distribution.missingPercentage.toLocaleString(locale)}% da base
      </span>
    </div>
  );
}

function PieDistributionCard({
  title,
  distribution,
  locale,
}: {
  title: string;
  distribution: PeopleDistribution;
  locale: string;
}) {
  return (
    <Card className="border-border/50 shadow-sm">
      <DistributionHeader title={title} distribution={distribution} locale={locale} />
      <CardContent className="pt-0">
        <div className="grid min-h-[220px] grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_1fr]">
          <div className="h-[210px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={distribution.items}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={54}
                  outerRadius={82}
                  paddingAngle={2}
                  stroke="transparent"
                >
                  {distribution.items.map((item, index) => (
                    <Cell key={item.label} fill={DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(_value: number, _name: string, entry) => {
                    const item = entry.payload as { count: number; percentage: number };
                    return [
                      `${item.count.toLocaleString(locale)} · ${item.percentage.toLocaleString(locale)}%`,
                      "Fichas preenchidas",
                    ];
                  }}
                  contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", fontSize: 12 }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-3">
            {distribution.items.map((item, index) => (
              <div key={item.label} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length] }}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {item.percentage.toLocaleString(locale)}%
                </span>
              </div>
            ))}
          </div>
        </div>
        <MissingDataFooter distribution={distribution} locale={locale} />
      </CardContent>
    </Card>
  );
}

function BarDistributionCard({
  title,
  distribution,
  locale,
  color,
}: {
  title: string;
  distribution: PeopleDistribution;
  locale: string;
  color: string;
}) {
  const chartHeight = Math.max(220, distribution.items.length * 30);
  return (
    <Card className="border-border/50 shadow-sm">
      <DistributionHeader title={title} distribution={distribution} locale={locale} />
      <CardContent className="pt-1">
        <div style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={distribution.items}
              layout="vertical"
              margin={{ top: 0, right: 34, left: 22, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-border)" />
              <XAxis
                type="number"
                domain={[0, "dataMax"]}
                tickFormatter={(value: number) => `${value}%`}
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={112}
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(_value: number, _name: string, entry) => {
                  const item = entry.payload as { count: number; percentage: number };
                  return [
                    `${item.percentage.toLocaleString(locale)}% · ${item.count.toLocaleString(locale)} fichas`,
                    "Entre preenchidos",
                  ];
                }}
                contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", fontSize: 12 }}
              />
              <Bar dataKey="percentage" fill={color} radius={[0, 4, 4, 0]} maxBarSize={15} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <MissingDataFooter distribution={distribution} locale={locale} />
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary border-b border-border pb-1.5">
      {children}
    </h2>
  );
}
function KpiCard({
  title, value, change, suffix, inverse = false, color, icon, detail, testId,
}: {
  title: string; value: string; change?: number; suffix?: string; inverse?: boolean; color: string;
  icon?: React.ReactNode; detail?: string; testId?: string;
}) {
  const isPositive = change !== undefined && change > 0;
  const isGood = inverse ? !isPositive : isPositive;
  return (
    <Card className="shadow-sm border-border/50 hover:shadow-md transition-shadow" data-testid={testId}>
      <CardContent className="p-4 flex justify-between items-start">
        <div className="space-y-1.5 min-w-0">
          <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-muted-foreground">{title}</p>
          <p className="text-xl font-bold font-display text-foreground truncate">{value}</p>
          <div className="flex items-center gap-1 text-[10px]">
            {change !== undefined && (
              <span className={`flex items-center font-semibold ${isGood ? "text-terra" : "text-destructive"}`}>
                {isPositive ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
                {Math.abs(change)}%
              </span>
            )}
            {suffix && <span className="text-muted-foreground">{suffix}</span>}
          </div>
          {detail && <p className="text-[10px] leading-snug text-muted-foreground">{detail}</p>}
        </div>
        <div className="w-7 h-7 rounded-full flex items-center justify-center opacity-25 shrink-0" style={{ backgroundColor: color }}>
          <span style={{ color }}>{icon}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function PeopleKpiCard({
  total, distribution, locale, t,
}: {
  total: number;
  distribution: PeopleDistribution;
  locale: string;
  t: ReturnType<typeof useLang>["t"];
}) {
  return (
    <Card className="shadow-sm border-border/50 hover:shadow-md transition-shadow" data-testid="dashboard-kpi-active-people">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold tracking-[0.16em] uppercase text-muted-foreground">{t("dashboard.base_ativa")}</p>
            <p className="mt-1.5 text-xl font-bold font-display text-foreground">{total.toLocaleString(locale)}</p>
          </div>
          <div className="w-7 h-7 rounded-full flex items-center justify-center opacity-25 shrink-0 bg-primary">
            <span className="text-primary"><Users className="h-4 w-4" /></span>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border/60 pt-2">
          {distribution.items.map((item) => (
            <div key={item.label} className="flex items-center justify-between gap-2 text-[10px]">
              <span className="truncate text-muted-foreground">{item.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{item.count.toLocaleString(locale)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="truncate text-muted-foreground">{t("dashboard.nao_informado")}</span>
            <span className="font-semibold tabular-nums text-foreground">{distribution.missingCount.toLocaleString(locale)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
