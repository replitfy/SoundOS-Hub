import { useState, useMemo } from "react";
import {
  useGetOmieResumoFinanceiro,
  getGetOmieResumoFinanceiroQueryKey,
  useRefreshOmieResumoFinanceiro,
  useListPersistedFinancialAccounts,
  getListPersistedFinancialAccountsQueryKey,
  ApiError,
  type GetOmieResumoFinanceiroParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  ArrowUpRight, TrendingUp, TrendingDown, AlertCircle, ChevronDown, RefreshCw, Loader2, Eye, EyeOff,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { useUserSession } from "@/contexts/user-session";

const PT_MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const FR_MONTHS = ["Jan", "Fév", "Mars", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];
const TEN_MIN_MS = 10 * 60 * 1000;

// ── Period preset helpers ─────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function presetMesAtual() {
  const now = new Date();
  return {
    dataDe: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    dataAte: isoDate(now),
  };
}
function presetMesAnterior() {
  const now = new Date();
  return {
    dataDe: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    dataAte: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
}
function presetYtd() {
  const now = new Date();
  return {
    dataDe: `${now.getFullYear()}-01-01`,
    dataAte: isoDate(now),
  };
}
function preset12Meses() {
  const now = new Date();
  const from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1);
  return { dataDe: isoDate(from), dataAte: isoDate(now) };
}

const PERIOD_PRESETS = [
  { key: "mes_atual",    labelKey: "fin.periodo.mes_atual",    fn: presetMesAtual },
  { key: "mes_anterior", labelKey: "fin.periodo.mes_anterior", fn: presetMesAnterior },
  { key: "ytd",          labelKey: "fin.periodo.ytd",          fn: presetYtd },
  { key: "12meses",      labelKey: "fin.periodo.12meses",      fn: preset12Meses },
] as const;

type OmieBase = "education" | "store";

// ── Component ─────────────────────────────────────────────────────────────────

export default function Financeiro() {
  const { t, lang } = useLang();
  const { authHeader } = useUserSession();
  const queryClient = useQueryClient();
  const numLocale = lang === "fr" ? "fr-FR" : "pt-BR";

  // Default to YTD on first load
  const ytdDefault = presetYtd();
  const [dataDe, setDataDe] = useState(ytdDefault.dataDe);
  const [dataAte, setDataAte] = useState(ytdDefault.dataAte);
  const [accountKeys, setAccountKeys] = useState<string[]>([]);
  const [filterBase, setFilterBase] = useState<OmieBase | undefined>(undefined);
  const [excludeNonConsidered, setExcludeNonConsidered] = useState(true);
  const [showFinancialValues, setShowFinancialValues] = useState(false);

  const request = { headers: authHeader };

  const accountsQuery = useListPersistedFinancialAccounts(undefined, {
    request,
    query: {
      queryKey: getListPersistedFinancialAccountsQueryKey(),
      staleTime: TEN_MIN_MS,
      gcTime: TEN_MIN_MS,
    },
  });

  // Numeric account codes can repeat between Omie bases.
  const todasContas = useMemo(() => {
    const result = (accountsQuery.data?.contas ?? []).map(cc => ({
      codigo: cc.codigo,
      key: `${cc.base}:${cc.codigo}`,
      label: cc.banco ? `${cc.descricao} — ${cc.banco}` : cc.descricao,
      base: cc.base,
      excluida: cc.excluida,
    }));
    return result.sort((a, b) =>
      a.base.localeCompare(b.base) || a.label.localeCompare(b.label)
    );
  }, [accountsQuery.data]);

  // Filter contas shown in dropdown by selected empresa
  const filteredContas = useMemo(
    () => todasContas.filter(cc =>
      (!filterBase || cc.base === filterBase)
      && (!excludeNonConsidered || !cc.excluida)
    ),
    [todasContas, filterBase, excludeNonConsidered],
  );

  // Detect active period preset for button highlight
  const activePreset = useMemo<string | null>(() => {
    for (const p of PERIOD_PRESETS) {
      const { dataDe: pDe, dataAte: pAte } = p.fn();
      if (pDe === dataDe && pAte === dataAte) return p.key;
    }
    return null;
  }, [dataDe, dataAte]);

  // Build API params — nCodCC is a comma-separated string; base restricts to one Omie base
  const params: GetOmieResumoFinanceiroParams = {
    ...(dataDe ? { dataDe } : {}),
    ...(dataAte ? { dataAte } : {}),
    ...(accountKeys.length > 0 ? { nCodCC: accountKeys.join(",") } : {}),
    ...(filterBase ? { base: filterBase } : {}),
    ...(!excludeNonConsidered ? { excludeNonConsidered: false } : {}),
  };

  const snapshotQuery = useGetOmieResumoFinanceiro(params, {
    request,
    query: {
      queryKey: getGetOmieResumoFinanceiroQueryKey(params),
      staleTime: TEN_MIN_MS,
      gcTime: TEN_MIN_MS,
      refetchInterval: (query) =>
        query.state.data?.status === "refreshing" ? 2_000 : false,
    },
  });
  const refreshMutation = useRefreshOmieResumoFinanceiro({
    request,
    mutation: {
      onSuccess: (snapshot) => {
        queryClient.setQueryData(getGetOmieResumoFinanceiroQueryKey(params), snapshot);
        void queryClient.invalidateQueries({
          queryKey: getGetOmieResumoFinanceiroQueryKey(),
        });
        void queryClient.invalidateQueries({ queryKey: getListPersistedFinancialAccountsQueryKey() });
      },
    },
  });
  const snapshot = snapshotQuery.data;
  const resumo = snapshot?.data ?? undefined;
  const error = snapshotQuery.error ?? refreshMutation.error;

  const isFetching = accountsQuery.isFetching || snapshotQuery.isFetching || refreshMutation.isPending;
  const hasData = resumo !== undefined;
  const lastUpdatedAt = snapshot?.collectedAt ? new Date(snapshot.collectedAt) : null;

  async function handleRefresh() {
    await refreshMutation.mutateAsync({ params });
  }

  let errorMessage: string | null = null;
  if (error) {
    const data: unknown = error instanceof ApiError ? error.data : null;
    if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
      errorMessage = (data as { error: string }).error;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = String(error);
    }
  }
  const snapshotWarning = snapshot?.lastError ?? null;
  const snapshotRefreshing = snapshot?.status === "refreshing";

  const monthLabel = (mes: string) => {
    const m = /^(\d{4})-(\d{2})$/.exec(mes);
    if (!m) return mes;
    const idx = parseInt(m[2], 10) - 1;
    const names = lang === "fr" ? FR_MONTHS : PT_MONTHS;
    return `${names[idx] ?? m[2]}/${m[1].slice(2)}`;
  };

  const totalRevenue = resumo?.receitaTotal ?? 0;
  const totalExpenses = resumo?.despesaTotal ?? 0;
  const resultado = resumo?.resultado ?? 0;
  const saldoInicial = resumo?.saldoInicial ?? 0;
  const ajustes = resumo?.ajustes ?? 0;
  const saldoFinal = resumo?.saldoFinal ?? 0;
  const monthlyHistory = (resumo?.meses ?? []).map((m) => ({
    month: monthLabel(m.mes),
    receita: m.receita,
    despesa: m.despesa,
    resultado: m.resultado,
    receitaPlanejada: m.receitaPlanejada ?? 0,
    despesaPlanejada: m.despesaPlanejada ?? 0,
    resultadoPlanejado: m.resultadoPlanejado ?? 0,
    saldoInicial: m.saldoInicial,
    ajustes: m.ajustes,
    saldoFinal: m.saldoFinal,
  }));
  const porBase = resumo?.porBase ?? [];
  const accountBreakdown = resumo?.contas ?? [];
  const selectedAccountLabel = accountKeys.length === 1
    ? todasContas.find(account => account.key === accountKeys[0])?.label
    : null;

  const totalRevenuePlanned = resumo?.receitaPlanejadaTotal ?? 0;
  const totalExpensesPlanned = resumo?.despesaPlanejadaTotal ?? 0;
  const resultadoPlanned = resumo?.resultadoPlanejado ?? 0;

  const resultadoIsPositive = resultado >= 0;
  const margemLiquida = totalRevenue > 0 ? Math.round((resultado / totalRevenue) * 100) : 0;
  
  const resultadoPlannedIsPositive = resultadoPlanned >= 0;
  const margemLiquidaPlanned = totalRevenuePlanned > 0 ? Math.round((resultadoPlanned / totalRevenuePlanned) * 100) : 0;

  // Dynamic KPI titles & badge based on active empresa filter
  const kpiTitleReceita  = filterBase === "education" ? t("fin.receita_education")
    : filterBase === "store" ? t("fin.receita_store") : t("fin.receita_total");
  const kpiTitleDespesas = filterBase === "education" ? t("fin.despesas_education")
    : filterBase === "store" ? t("fin.despesas_store") : t("fin.despesas_totais");
  const kpiTitleResultado = t("fin.resultado_operacional");

  const empresaBadge = filterBase ? (
    <span
      className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full border"
      style={
        filterBase === "education"
          ? { color: "#5A78A8", borderColor: "#5A78A8", background: "#5A78A810" }
          : { color: "#8A4E2E", borderColor: "#8A4E2E", background: "#8A4E2E10" }
      }
    >
      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: filterBase === "education" ? "#5A78A8" : "#8A4E2E" }} />
      {filterBase === "education" ? t("fin.empresa.education") : t("fin.empresa.store")}
    </span>
  ) : null;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function applyPreset(key: (typeof PERIOD_PRESETS)[number]["key"]) {
    const p = PERIOD_PRESETS.find(x => x.key === key)!;
    const { dataDe: de, dataAte: ate } = p.fn();
    setDataDe(de);
    setDataAte(ate);
  }

  function toggleEmpresa(base: OmieBase | undefined) {
    setFilterBase(base);
    setAccountKeys([]); // reset conta filter when company changes
  }

  function toggleConta(key: string, checked: boolean) {
    setAccountKeys(prev => checked ? [...prev, key] : prev.filter(value => value !== key));
  }

  function toggleNonConsidered(checked: boolean) {
    setExcludeNonConsidered(checked);
    if (checked) {
      const excludedKeys = new Set(todasContas.filter(cc => cc.excluida).map(cc => cc.key));
      setAccountKeys(prev => prev.filter(key => !excludedKeys.has(key)));
    }
  }

  function formatMoney(value: number, minimumFractionDigits = 2, showPositiveSign = false) {
    if (!showFinancialValues) return "R$ ••••••";
    const sign = showPositiveSign && value >= 0 ? "+" : "";
    return `${sign}R$ ${value.toLocaleString(numLocale, { minimumFractionDigits })}`;
  }

  function formatPercentage(value: number) {
    return showFinancialValues ? `${value}%` : "••%";
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-7 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header + Filters */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground mb-0.5">{t("fin.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("fin.resumo_fonte")}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setShowFinancialValues(visible => !visible)}
                size="sm"
                variant="outline"
                aria-pressed={showFinancialValues}
                aria-label={showFinancialValues
                  ? (lang === "fr" ? "Masquer les valeurs financières" : "Ocultar valores financeiros")
                  : (lang === "fr" ? "Afficher les valeurs financières" : "Mostrar valores financeiros")}
                title={showFinancialValues
                  ? (lang === "fr" ? "Masquer les valeurs" : "Ocultar valores")
                  : (lang === "fr" ? "Afficher les valeurs" : "Mostrar valores")}
                data-testid="button-toggle-financial-values"
              >
                {showFinancialValues ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button onClick={handleRefresh} disabled={isFetching} size="sm" variant="outline">
                {isFetching ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Atualizar
              </Button>
            </div>
            {lastUpdatedAt && (
              <span className="text-[10px] text-muted-foreground">
                {lang === "fr" ? "Mis à jour le" : "Atualizado em"}{" "}
                {formatDateTimeBR(lastUpdatedAt)}
              </span>
            )}
            {snapshot?.availableFrom && snapshot.availableTo && (
              <span className="text-[10px] text-muted-foreground" data-testid="text-fin-periodo-disponivel">
                {lang === "fr" ? "Période disponible" : "Período disponível"}:{" "}
                {snapshot.availableFrom.split("-").reverse().join("/")} –{" "}
                {snapshot.availableTo.split("-").reverse().join("/")}
              </span>
            )}
          </div>
        </div>

        {/* Period preset buttons + date pickers */}
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIOD_PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={`h-7 px-2.5 rounded-md text-xs font-medium border transition-colors
                ${activePreset === p.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-input bg-background text-foreground hover:bg-muted"}`}
            >
              {t(p.labelKey)}
            </button>
          ))}
          <span className="text-xs text-muted-foreground mx-0.5">·</span>
          <label className="text-xs text-muted-foreground" htmlFor="fin-data-de">{t("fin.cr.filtro_de")}</label>
          <input
            id="fin-data-de"
            type="date"
            value={dataDe}
            onChange={(e) => setDataDe(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            data-testid="input-fin-data-de"
          />
          <label className="text-xs text-muted-foreground" htmlFor="fin-data-ate">{t("fin.cr.filtro_ate")}</label>
          <input
            id="fin-data-ate"
            type="date"
            value={dataAte}
            onChange={(e) => setDataAte(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            data-testid="input-fin-data-ate"
          />
        </div>

        {/* Empresa + Conta filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t("fin.empresa.label")}:</span>
          {([undefined, "education", "store"] as const).map((v) => (
            <button
              key={v ?? "ambas"}
              onClick={() => toggleEmpresa(v)}
              className={`h-7 px-2.5 rounded-md text-xs font-medium border transition-colors
                ${filterBase === v
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-input bg-background text-foreground hover:bg-muted"}`}
            >
              {v === undefined
                ? t("fin.empresa.ambas")
                : v === "education"
                ? t("fin.empresa.education")
                : t("fin.empresa.store")}
            </button>
          ))}

          {filteredContas.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground ml-1">{t("fin.cc.filtro_label")}:</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="h-7 px-2.5 rounded-md text-xs font-medium border border-input bg-background text-foreground hover:bg-muted flex items-center gap-1"
                    data-testid="select-fin-cc"
                  >
                    {accountKeys.length === 0
                      ? `${filteredContas.length} ${t(excludeNonConsidered
                        ? "fin.cc.filtro_consideradas"
                        : "fin.cc.filtro_disponiveis")}`
                      : selectedAccountLabel ?? `${accountKeys.length} ${t("fin.cc.filtro_selecionadas")}`}
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-64 overflow-y-auto min-w-[220px]">
                  {accountKeys.length > 0 && (
                    <button
                      className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                      onClick={() => setAccountKeys([])}
                    >
                      ✕ {t("fin.cc.filtro_todas")}
                    </button>
                  )}
                  {filteredContas.map((cc) => (
                    <DropdownMenuCheckboxItem
                      key={cc.key}
                      checked={accountKeys.includes(cc.key)}
                      onCheckedChange={(checked) => toggleConta(cc.key, checked)}
                      className="text-xs"
                    >
                      <span className="flex w-full items-center justify-between gap-3">
                        <span>{cc.label}</span>
                        <span className="text-[10px] uppercase text-muted-foreground">
                          {cc.base === "education"
                            ? t("fin.empresa.education")
                            : t("fin.empresa.store")}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <div className="ml-1 flex h-7 items-center gap-2 rounded-md border border-input bg-background px-2.5">
            <Switch
              id="exclude-non-considered"
              checked={excludeNonConsidered}
              onCheckedChange={toggleNonConsidered}
              aria-label={t("fin.cc.excluir_nao_consideradas")}
            />
            <label
              htmlFor="exclude-non-considered"
              className="cursor-pointer text-xs font-medium text-foreground"
            >
              {t("fin.cc.excluir_nao_consideradas")}
            </label>
          </div>
        </div>
      </div>

      {!hasData && !isFetching && !errorMessage && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <RefreshCw className="h-10 w-10 text-muted-foreground/25 mb-4" />
          <p className="text-sm text-muted-foreground">
            {lang === "fr"
              ? <>Aucune donnée enregistrée pour ces filtres. Cliquez sur <strong>Actualiser</strong>.</>
              : <>Nenhum dado salvo para estes filtros. Clique em <strong>Atualizar</strong>.</>}
          </p>
        </div>
      )}

      {errorMessage && (
        <div
          className="flex items-start gap-2 text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-lg p-4"
          data-testid="text-fin-resumo-error"
        >
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="break-words">{t("fin.erro")} {errorMessage}</span>
        </div>
      )}

      {snapshotWarning && (
        <div className="flex items-start gap-2 text-sm text-amber-800 border border-amber-300 bg-amber-50 rounded-lg p-4 dark:text-amber-300 dark:border-amber-800/50 dark:bg-amber-950/20">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="break-words">{snapshotWarning}</span>
        </div>
      )}

      {snapshotRefreshing && (
        <div className="flex items-start gap-2 text-sm text-blue-800 border border-blue-300 bg-blue-50 rounded-lg p-4 dark:text-blue-300 dark:border-blue-800/50 dark:bg-blue-950/20">
          <RefreshCw className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
          <span>
            {lang === "fr"
              ? "Mise à jour en cours. Les dernières données enregistrées restent visibles."
              : "Atualização em andamento. Os últimos dados salvos continuam visíveis."}
          </span>
        </div>
      )}

      {/* KPI Cards */}
      {(hasData || isFetching) && <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {snapshotQuery.isLoading && !resumo ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)
        ) : errorMessage ? null : (
          <>
            {/* Realizado */}
            <Card className="shadow-sm border-border/50 border-t-[3px]" style={{ borderTopColor: "#5A78A8" }}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold tracking-[0.18em] uppercase text-muted-foreground">{t("fin.receita_realizada")}</p>
                  {empresaBadge}
                </div>
                <p className="text-3xl font-bold font-display text-foreground" data-testid="text-fin-receita-realizada">
                  {formatMoney(totalRevenue)}
                </p>
                <div className="flex items-center gap-1 mt-2 text-xs text-terra font-medium">
                  <ArrowUpRight className="h-3 w-3" />
                  {t("fin.no_periodo")}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-sm border-border/50 border-t-[3px]" style={{ borderTopColor: "#D94A3A" }}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold tracking-[0.18em] uppercase text-muted-foreground">{t("fin.despesa_realizada")}</p>
                  {empresaBadge}
                </div>
                <p className="text-3xl font-bold font-display text-foreground" data-testid="text-fin-despesa-realizada">
                  {formatMoney(totalExpenses)}
                </p>
                <div className="mt-3 h-1 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-destructive"
                    style={{ width: `${Math.min(100, Math.round((totalExpenses / (totalRevenue || 1)) * 100))}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {formatPercentage(Math.round((totalExpenses / (totalRevenue || 1)) * 100))} {t("fin.pct_receita")}
                </p>
              </CardContent>
            </Card>

            <Card
              className="shadow-sm border-border/50 border-t-[3px]"
              style={{ borderTopColor: resultadoIsPositive ? "#5F7F3F" : "#D94A3A" }}
            >
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold tracking-[0.18em] uppercase text-muted-foreground">{t("fin.resultado_realizado")}</p>
                  {empresaBadge}
                </div>
                <p
                  className="text-3xl font-bold font-display"
                  style={{ color: resultadoIsPositive ? "#5F7F3F" : "#D94A3A" }}
                  data-testid="text-fin-resultado-realizado"
                >
                  {formatMoney(resultado, 0)}
                </p>
                <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${resultadoIsPositive ? "text-terra" : "text-destructive"}`}>
                  {resultadoIsPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {t("fin.margem_liquida")}: {formatPercentage(margemLiquida)}
                </div>
              </CardContent>
            </Card>

            {/* Planejado */}
            <Card className="shadow-sm border-border/50 border-t-[3px] opacity-90" style={{ borderTopColor: "#5A78A880" }}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold tracking-[0.18em] uppercase text-muted-foreground">{t("fin.receita_planejada")}</p>
                  {empresaBadge}
                </div>
                <p className="text-3xl font-bold font-display text-muted-foreground" data-testid="text-fin-receita-planejada">
                  {formatMoney(totalRevenuePlanned)}
                </p>
                <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground font-medium">
                  <ArrowUpRight className="h-3 w-3" />
                  {t("fin.no_periodo")}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-sm border-border/50 border-t-[3px] opacity-90" style={{ borderTopColor: "#D94A3A80" }}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold tracking-[0.18em] uppercase text-muted-foreground">{t("fin.despesa_planejada")}</p>
                  {empresaBadge}
                </div>
                <p className="text-3xl font-bold font-display text-muted-foreground" data-testid="text-fin-despesa-planejada">
                  {formatMoney(totalExpensesPlanned)}
                </p>
                <div className="mt-3 h-1 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-destructive/50"
                    style={{ width: `${Math.min(100, Math.round((totalExpensesPlanned / (totalRevenuePlanned || 1)) * 100))}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {formatPercentage(Math.round((totalExpensesPlanned / (totalRevenuePlanned || 1)) * 100))} {t("fin.pct_receita")}
                </p>
              </CardContent>
            </Card>

            <Card
              className="shadow-sm border-border/50 border-t-[3px] opacity-90"
              style={{ borderTopColor: resultadoPlannedIsPositive ? "#5F7F3F80" : "#D94A3A80" }}
            >
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold tracking-[0.18em] uppercase text-muted-foreground">{t("fin.resultado_planejado")}</p>
                  {empresaBadge}
                </div>
                <p
                  className="text-3xl font-bold font-display text-muted-foreground"
                  data-testid="text-fin-resultado-planejado"
                >
                  {formatMoney(resultadoPlanned, 0)}
                </p>
                <div className="flex items-center gap-1 mt-2 text-xs font-medium text-muted-foreground">
                  {resultadoPlannedIsPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {t("fin.margem_liquida")}: {formatPercentage(margemLiquidaPlanned)}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>}

      {(hasData || isFetching) && (<>
      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted-foreground">
            {t("fin.resultado_acumulado_realizado")}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              [t("fin.saldo_inicial"), saldoInicial],
              [t("fin.resultado_operacional"), resultado],
              [t("fin.transferencias_ajustes"), ajustes],
              [t("fin.resultado_acumulado_realizado"), saldoFinal],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg border border-border/60 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
                <p className="mt-1 text-lg font-bold text-foreground">
                  {formatMoney(Number(value))}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("fin.saldo_inicial")} + {t("fin.resultado_operacional")} + {t("fin.transferencias_ajustes")} = {t("fin.resultado_acumulado_realizado")}.
          </p>
        </CardContent>
      </Card>

      {/* Monthly bar chart */}
      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-0">
          <CardTitle className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted-foreground">
            {t("fin.historico_mensal")}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {snapshotQuery.isLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : errorMessage || monthlyHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">{t("fin.sem_dados")}</p>
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyHistory} margin={{ top: 4, right: 8, left: -10, bottom: 0 }} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                   <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} tickFormatter={(v) => showFinancialValues ? `R$${v / 1000}k` : "••••"} />
                  <Tooltip
                    contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.1)", fontSize: 12 }}
                    formatter={(v: number, name: string) => [
                       showFinancialValues ? `R$ ${v.toLocaleString(numLocale)}` : "R$ ••••••",
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="receita" name={t("fin.receita_realizada")} fill="#5A78A8" radius={[3,3,0,0]} />
                  <Bar dataKey="receitaPlanejada" name={t("fin.receita_planejada")} fill="#5A78A8" radius={[3,3,0,0]} opacity={0.4} />
                  <Bar dataKey="despesa" name={t("fin.despesa_realizada")} fill="#D94A3A" radius={[3,3,0,0]} opacity={0.85} />
                  <Bar dataKey="despesaPlanejada" name={t("fin.despesa_planejada")} fill="#D94A3A" radius={[3,3,0,0]} opacity={0.35} />
                  <Bar dataKey="resultado" name={t("fin.resultado_realizado")} fill="#5F7F3F" radius={[3,3,0,0]} opacity={0.9} />
                  <Bar dataKey="resultadoPlanejado" name={t("fin.resultado_planejado")} fill="#5F7F3F" radius={[3,3,0,0]} opacity={0.4} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-base breakdown */}
      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted-foreground">
            {t("fin.por_base")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {snapshotQuery.isLoading ? (
            Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
          ) : errorMessage || porBase.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("fin.sem_dados")}</p>
          ) : (
            <>
              {porBase.map((item: any) => {
                const pctRealizado = Math.round((item.receita / (totalRevenue || 1)) * 100);
                const pctPlanejado = Math.round((item.receitaPlanejada / (totalRevenuePlanned || 1)) * 100);
                const color = item.base === "education" ? "#5A78A8" : "#B08A4F";
                return (
                  <div key={item.base} className="space-y-2 py-1" data-testid={`row-fin-base-${item.base}`}>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="font-medium text-foreground text-sm">{item.nome}</span>
                    </div>
                    
                    {/* Realizado Row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs gap-1 pl-4">
                      <span className="font-semibold text-muted-foreground w-20">{t("fin.realizado")}</span>
                      <div className="flex items-center gap-4 flex-wrap">
                         <span className="text-muted-foreground">{t("fin.receita")}: <span className="font-bold text-foreground">{formatMoney(item.receita)}</span></span>
                         <span className="text-muted-foreground">{t("fin.despesa")}: <span className="font-bold text-destructive">{formatMoney(item.despesa)}</span></span>
                        <span className={`font-bold w-28 text-right ${item.resultado >= 0 ? "text-terra" : "text-destructive"}`}>
                           {formatMoney(item.resultado, 2, true)}
                        </span>
                      </div>
                    </div>
                    
                    {/* Planejado Row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs gap-1 pl-4 opacity-80">
                      <span className="font-semibold text-muted-foreground w-20">{t("fin.planejado")}</span>
                      <div className="flex items-center gap-4 flex-wrap">
                         <span className="text-muted-foreground">{t("fin.receita")}: <span className="font-medium text-foreground">{formatMoney(item.receitaPlanejada ?? 0)}</span></span>
                         <span className="text-muted-foreground">{t("fin.despesa")}: <span className="font-medium text-destructive">{formatMoney(item.despesaPlanejada ?? 0)}</span></span>
                        <span className={`font-medium w-28 text-right ${(item.resultadoPlanejado ?? 0) >= 0 ? "text-terra" : "text-destructive"}`}>
                           {formatMoney(item.resultadoPlanejado ?? 0, 2, true)}
                        </span>
                      </div>
                    </div>
                    
                    <div className="h-1.5 rounded-full bg-border overflow-hidden mt-1 ml-4">
                      <div className="h-full rounded-full" style={{ width: `${pctRealizado}%`, backgroundColor: color }} />
                    </div>
                  </div>
                );
              })}
              <div className="pt-2 border-t border-border flex flex-col gap-1 text-xs">
                <div className="flex justify-between pl-4">
                  <span className="font-bold text-foreground">{t("common.total")} {t("fin.realizado")}</span>
                  <span className={`font-bold ${resultadoIsPositive ? "text-terra" : "text-destructive"}`}>
                     {formatMoney(resultado, 2, true)}
                  </span>
                </div>
                <div className="flex justify-between pl-4 opacity-80">
                  <span className="font-bold text-muted-foreground">{t("common.total")} {t("fin.planejado")}</span>
                  <span className={`font-bold ${(resultadoPlanned ?? 0) >= 0 ? "text-terra" : "text-destructive"}`}>
                     {formatMoney(resultadoPlanned ?? 0, 2, true)}
                  </span>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Per-account balance composition */}
      <Card className="shadow-sm border-border/50">
        <Accordion type="single" collapsible>
          <AccordionItem value="account-composition" className="border-b-0">
            <AccordionTrigger className="px-6 py-4 hover:no-underline">
              <CardTitle className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted-foreground">
                Composição por empresa e conta
              </CardTitle>
            </AccordionTrigger>
            <AccordionContent className="pb-0">
              <CardContent className="overflow-x-auto">
                {snapshotQuery.isLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : accountBreakdown.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">{t("fin.sem_dados")}</p>
                ) : (
                  <table className="w-full min-w-[900px] text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-2 pr-4 text-left font-bold tracking-wider">Empresa / conta</th>
                        <th className="py-2 pr-4 text-left font-bold tracking-wider">Tipo</th>
                        <th className="py-2 pr-4 text-right font-bold tracking-wider">Saldo inicial</th>
                        <th className="py-2 pr-4 text-right font-bold tracking-wider">Receitas</th>
                        <th className="py-2 pr-4 text-right font-bold tracking-wider">Despesas</th>
                        <th className="py-2 pr-4 text-right font-bold tracking-wider">Ajustes</th>
                        <th className="py-2 text-right font-bold tracking-wider">Saldo final</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountBreakdown.map((account: any) => (
                        <tr key={`${account.base}:${account.codigo}`} className="border-b border-border/50 hover:bg-muted/30">
                          <td className="py-2.5 pr-4 text-foreground">
                            <span className="font-medium">{account.nome}</span>
                            <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                              {account.base === "education"
                                ? t("fin.empresa.education")
                                : t("fin.empresa.store")}
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{account.tipo ?? "—"}</td>
                           <td className="py-2.5 pr-4 text-right">{formatMoney(account.saldoInicial)}</td>
                          <td className="py-2.5 pr-4 text-right">
                             <div className="font-medium">{formatMoney(account.receita)}</div>
                            {account.receitaPlanejada !== undefined && (
                              <div className="text-[10px] text-muted-foreground">
                                 {t("fin.planejado")}: {formatMoney(account.receitaPlanejada)}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-right text-destructive">
                             <div className="font-medium">{formatMoney(account.despesa)}</div>
                            {account.despesaPlanejada !== undefined && (
                              <div className="text-[10px] text-muted-foreground/70">
                                 {t("fin.planejado")}: {formatMoney(account.despesaPlanejada)}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-right">
                             {formatMoney(account.ajustes, 2, true)}
                          </td>
                           <td className="py-2.5 text-right font-bold">{formatMoney(account.saldoFinal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  Transferências entre contas aparecem nas contas de origem e destino, mas se anulam no total consolidado.
                </p>
              </CardContent>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>

      {/* Monthly statement */}
      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted-foreground">
            {t("fin.extrato")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {snapshotQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : errorMessage || monthlyHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("fin.sem_dados")}</p>
          ) : (
            <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left py-2 pr-4 font-bold tracking-wider">{t("fin.mes")}</th>
                  <th className="text-right py-2 pr-4 font-bold tracking-wider">{t("fin.saldo_inicial")}</th>
                  <th className="text-right py-2 pr-4 font-bold tracking-wider">{t("fin.transferencias_ajustes")}</th>
                  <th className="text-right py-2 pr-4 font-bold tracking-wider">{t("fin.receita")}</th>
                  <th className="text-right py-2 pr-4 font-bold tracking-wider">{t("fin.despesa")}</th>
                  <th className="text-right py-2 font-bold tracking-wider">{t("fin.resultado_acumulado_realizado")}</th>
                </tr>
              </thead>
              <tbody>
                {monthlyHistory.map((row: any, i: number) => {
                  const isCurrentMonth = i === monthlyHistory.length - 1;
                  return (
                    <tr
                      key={row.month}
                      className={`border-b border-border/50 transition-colors ${isCurrentMonth ? "bg-accent/30 font-semibold" : "hover:bg-muted/30"}`}
                    >
                      <td className="py-2.5 pr-4 text-foreground">
                        {row.month} {isCurrentMonth && <span className="ml-1 text-[9px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">{t("fin.atual")}</span>}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-foreground">
                         {formatMoney(row.saldoInicial, 0)}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-foreground">
                         {formatMoney(row.ajustes, 0, true)}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-foreground">
                         <div>{formatMoney(row.receita, 0)}</div>
                        <div className="text-[10px] text-muted-foreground font-normal">
                           {t("fin.planejado")}: {formatMoney(row.receitaPlanejada ?? 0, 0)}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-right text-destructive">
                         <div>{formatMoney(row.despesa, 0)}</div>
                        <div className="text-[10px] text-muted-foreground/70 font-normal">
                           {t("fin.planejado")}: {formatMoney(row.despesaPlanejada ?? 0, 0)}
                        </div>
                      </td>
                      <td className="py-2.5 text-right font-bold text-foreground">
                         {formatMoney(row.saldoFinal, 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      </>)}
    </div>
  );
}
