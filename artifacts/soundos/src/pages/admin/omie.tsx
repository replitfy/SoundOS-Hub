import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import {
  useGetOmieStatus,
  useListOmieClientes,
  useListOmieContasCorrentes,
  useGetOmieContasReceberResumo,
  useGetOmieContasPagarResumo,
  getGetOmieStatusQueryKey,
  getListOmieClientesQueryKey,
  getListOmieContasCorrentesQueryKey,
  getGetOmieContasReceberResumoQueryKey,
  getGetOmieContasPagarResumoQueryKey,
} from "@workspace/api-client-react";
import type { OmieBaseStatus, OmieContasResumo } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Database, CheckCircle2, XCircle, GraduationCap, ShoppingBag, ChevronLeft, ChevronRight, AlertTriangle, CheckCircle, RefreshCw, Loader2 } from "lucide-react";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { formatDateTimeBR } from "@/lib/date";

const PAGE_SIZE = 20;
const TEN_MIN_MS = 10 * 60 * 1000;

type OmieBase = "education" | "store";

function StatusCard({ status, active, onClick }: { status: OmieBaseStatus; active: boolean; onClick: () => void }) {
  const { t } = useLang();
  const Icon = status.base === "education" ? GraduationCap : ShoppingBag;
  return (
    <Card
      onClick={onClick}
      data-testid={`card-omie-${status.base}`}
      className={`cursor-pointer transition-all shadow-sm ${active ? "border-primary ring-1 ring-primary" : "border-border/50 hover:border-border"}`}
    >
      <CardHeader className="flex flex-row items-center gap-4 pb-2">
        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <CardTitle className="text-lg font-bold">{status.name}</CardTitle>
          <div className="text-sm text-muted-foreground">Omie ERP</div>
        </div>
        {status.connected ? (
          <Badge className="bg-terra gap-1"><CheckCircle2 className="h-3 w-3" /> {t("admin.omie.conectado")}</Badge>
        ) : (
          <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> {t("admin.omie.erro")}</Badge>
        )}
      </CardHeader>
      <CardContent>
        {status.connected ? (
          <div className="text-sm text-muted-foreground">
            {t("admin.omie.total_clientes")} <span className="font-semibold text-foreground">{status.totalClientes ?? 0}</span>
          </div>
        ) : (
          <div className="text-sm text-destructive break-words">{status.error}</div>
        )}
      </CardContent>
    </Card>
  );
}

const ContasCorrentesCard = forwardRef<{ refetch: () => void }, { base: OmieBase; request: object }>(
function ContasCorrentesCard({ base, request }, ref) {
  const { t } = useLang();

  const {
    data: ccData,
    isLoading: ccLoading,
    error: ccError,
    refetch: refetchCC,
  } = useListOmieContasCorrentes(base, {
    request,
    query: {
      queryKey: getListOmieContasCorrentesQueryKey(base),
      enabled: false,
      staleTime: TEN_MIN_MS,
      gcTime: TEN_MIN_MS,
    },
  });

  useImperativeHandle(ref, () => ({ refetch: () => { void refetchCC(); } }), [refetchCC]);

  const contas = ccData?.contas ?? [];
  const excluidas = contas.filter((c) => c.excluida);

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader>
        <CardTitle className="text-xl font-bold">{t("admin.omie.cc.title")}</CardTitle>
        <CardDescription>{t("admin.omie.cc.subtitle")}</CardDescription>
        {ccData && (
          <div className="flex gap-3 mt-1">
            <span className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{contas.length}</span> {t("admin.omie.cc.total")}
            </span>
            {excluidas.length > 0 && (
              <span className="text-sm text-destructive font-medium flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                {excluidas.length} {t("admin.omie.cc.excluidas")}
              </span>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {ccData === undefined && !ccLoading ? null : ccLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : ccError ? (
          <div className="text-sm text-destructive py-4">{t("admin.omie.cc.erro")}</div>
        ) : (
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">{t("admin.omie.cc.col_codigo")}</TableHead>
                <TableHead>{t("admin.omie.cc.col_descricao")}</TableHead>
                <TableHead className="w-32">{t("admin.omie.cc.col_tipo")}</TableHead>
                <TableHead className="w-28">{t("admin.omie.cc.col_banco")}</TableHead>
                <TableHead className="w-28">{t("admin.omie.cc.col_situacao")}</TableHead>
                <TableHead className="w-24">{t("admin.omie.cc.col_agencia")}</TableHead>
                <TableHead className="w-36">{t("admin.omie.cc.col_conta")}</TableHead>
                <TableHead className="w-32 text-right">{t("admin.omie.cc.col_saldo")}</TableHead>
                <TableHead className="w-44">{t("admin.omie.cc.col_status")}</TableHead>
                <TableHead className="w-28">{t("admin.omie.cc.col_boleto")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contas.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    {t("admin.omie.cc.sem_contas")}
                  </TableCell>
                </TableRow>
              ) : (
                contas.map((cc) => (
                  <TableRow key={cc.codigo} data-testid={`row-cc-${cc.codigo}`}>
                    <TableCell className="font-mono text-xs">{cc.codigo}</TableCell>
                    <TableCell className="font-medium">{cc.descricao}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{cc.tipo ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{cc.banco ?? "—"}</TableCell>
                    <TableCell>
                      {cc.ativa ? (
                        <Badge className="gap-1 text-xs bg-emerald-600 hover:bg-emerald-700">{t("common.ativo")}</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">{t("common.inativo")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{cc.agencia ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">{cc.numeroConta ?? "—"}</TableCell>
                    <TableCell className="text-xs text-right font-medium">
                      {cc.saldo.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                    </TableCell>
                    <TableCell>
                      {cc.excluida ? (
                        <Badge variant="destructive" className="gap-1 text-xs">
                          <XCircle className="h-3 w-3" /> {t("admin.omie.cc.excluida")}
                        </Badge>
                      ) : (
                        <Badge className="gap-1 text-xs bg-emerald-600 hover:bg-emerald-700">
                          <CheckCircle className="h-3 w-3" /> {t("admin.omie.cc.considerada")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {cc.emiteBoleto ? t("common.sim") : t("common.nao")}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function ResumoTotais({
  tipo,
  title,
  realizadoLabel,
  resumo,
  loading,
  error,
  errorLabel,
}: {
  tipo: "receber" | "pagar";
  title: string;
  realizadoLabel: string;
  resumo: OmieContasResumo | undefined;
  loading: boolean;
  error: unknown;
  errorLabel: string;
}) {
  const { t } = useLang();
  if (resumo === undefined && !loading && !error) return null;

  return (
    <div className="space-y-2" data-testid={`omie-resumo-${tipo}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {resumo && (
          <span className="text-xs text-muted-foreground">
            {resumo.quantidade} {t("admin.omie.titulos.quantidade")}
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : error ? (
        <div className="text-sm text-destructive py-2" data-testid={`omie-resumo-${tipo}-erro`}>{errorLabel}</div>
      ) : resumo ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{realizadoLabel}</div>
            <div className="text-lg font-bold" data-testid={`omie-resumo-${tipo}-realizado`}>{formatBRL(resumo.totalRecebido)}</div>
          </div>
          <div className="rounded-lg border border-border/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("admin.omie.titulos.a_vencer")}</div>
            <div className="text-lg font-bold" data-testid={`omie-resumo-${tipo}-a-vencer`}>{formatBRL(resumo.totalAVencer)}</div>
          </div>
          <div className="rounded-lg border border-border/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("admin.omie.titulos.atrasado")}</div>
            <div className="text-lg font-bold text-destructive" data-testid={`omie-resumo-${tipo}-atrasado`}>{formatBRL(resumo.totalAtrasado)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ResumoQueryState = { data: OmieContasResumo | undefined; isLoading: boolean; error: unknown };

function TitulosResumoCard({ receber, pagar }: { receber: ResumoQueryState; pagar: ResumoQueryState }) {
  const { t } = useLang();

  const avisos = [
    ...(receber.data?.avisos ?? []).map((texto) => ({ tipo: "receber", texto })),
    ...(pagar.data?.avisos ?? []).map((texto) => ({ tipo: "pagar", texto })),
  ];

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader>
        <CardTitle className="text-xl font-bold">{t("admin.omie.titulos.title")}</CardTitle>
        <CardDescription>{t("admin.omie.titulos.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {avisos.map((aviso, i) => (
          <div
            key={`${aviso.tipo}-${i}`}
            data-testid="omie-aviso-titulos"
            className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">{aviso.texto}</p>
          </div>
        ))}
        <ResumoTotais
          tipo="receber"
          title={t("admin.omie.titulos.receber")}
          realizadoLabel={t("admin.omie.titulos.recebido")}
          resumo={receber.data}
          loading={receber.isLoading}
          error={receber.error}
          errorLabel={t("admin.omie.titulos.erro_receber")}
        />
        <ResumoTotais
          tipo="pagar"
          title={t("admin.omie.titulos.pagar")}
          realizadoLabel={t("admin.omie.titulos.pago")}
          resumo={pagar.data}
          loading={pagar.isLoading}
          error={pagar.error}
          errorLabel={t("admin.omie.titulos.erro_pagar")}
        />
      </CardContent>
    </Card>
  );
}

export default function OmiePage() {
  const { t } = useLang();
  const { user, authHeader } = useUserSession();
  const [base, setBase] = useState<OmieBase>("education");
  const [pagina, setPagina] = useState(1);
  const ccRef = useRef<{ refetch: () => void }>(null);

  const request = { headers: authHeader };

  const { data: statuses, isLoading: statusLoading, isFetching: statusFetching, error: statusError, refetch: refetchStatus } = useGetOmieStatus({
    request,
    query: { queryKey: getGetOmieStatusQueryKey(), enabled: false, staleTime: TEN_MIN_MS, gcTime: TEN_MIN_MS },
  });
  const activeStatus = statuses?.find((s) => s.base === base);

  const {
    data: page,
    isLoading: clientesLoading,
    isFetching,
    error: clientesError,
    refetch: refetchClientes,
  } = useListOmieClientes(base, { pagina, registrosPorPagina: PAGE_SIZE }, {
    request,
    query: {
      queryKey: getListOmieClientesQueryKey(base, { pagina, registrosPorPagina: PAGE_SIZE }),
      enabled: false,
      staleTime: TEN_MIN_MS,
      gcTime: TEN_MIN_MS,
    },
  });

  const resumoQuery = { enabled: false, staleTime: TEN_MIN_MS, gcTime: TEN_MIN_MS };
  const {
    data: receberResumo,
    isLoading: receberLoading,
    error: receberError,
    refetch: refetchReceber,
  } = useGetOmieContasReceberResumo(base, undefined, {
    request,
    query: { ...resumoQuery, queryKey: getGetOmieContasReceberResumoQueryKey(base) },
  });
  const {
    data: pagarResumo,
    isLoading: pagarLoading,
    error: pagarError,
    refetch: refetchPagar,
  } = useGetOmieContasPagarResumo(base, undefined, {
    request,
    query: { ...resumoQuery, queryKey: getGetOmieContasPagarResumoQueryKey(base) },
  });

  const isRefreshing = statusFetching || isFetching;
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  // When pagina changes and data has been loaded before, refetch clients for the new page
  const paginaInitRef = useRef(true);
  useEffect(() => {
    if (paginaInitRef.current) { paginaInitRef.current = false; return; }
    if (page !== undefined) void refetchClientes();
  }, [pagina]);

  async function handleRefresh() {
    const { data: freshStatuses } = await refetchStatus();
    const freshActive = freshStatuses?.find((s) => s.base === base);
    if (freshActive?.connected) {
      await Promise.all([
        refetchClientes(),
        refetchReceber(),
        refetchPagar(),
        new Promise<void>((res) => { ccRef.current?.refetch(); res(); }),
      ]);
    }
    setLastUpdatedAt(new Date());
  }

  const selectBase = (b: OmieBase) => {
    setBase(b);
    setPagina(1);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1 flex items-center gap-2">
            <Database className="h-7 w-7 text-primary" /> {t("admin.omie.title")}
          </h1>
          <p className="text-muted-foreground">{t("admin.omie.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 mt-1">
          <Button onClick={handleRefresh} disabled={isRefreshing} size="sm" variant="outline">
            {isRefreshing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Atualizar
          </Button>
          {lastUpdatedAt && (
            <span className="text-[10px] text-muted-foreground">
              Atualizado em {formatDateTimeBR(lastUpdatedAt)}
            </span>
          )}
        </div>
      </div>

      {statuses === undefined && !statusLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <RefreshCw className="h-10 w-10 text-muted-foreground/25 mb-4" />
          <p className="text-sm text-muted-foreground">Clique em <strong>Atualizar</strong> para conectar e carregar os dados do Omie.</p>
        </div>
      )}

      {(statuses !== undefined || statusLoading) && (
        <>
        {statusLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : statusError ? (
          <Card className="border-destructive/50">
            <CardContent className="py-6 text-destructive text-sm">
              {t("admin.omie.erro_status")}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {statuses?.map((s) => (
              <StatusCard key={s.base} status={s} active={s.base === base} onClick={() => selectBase(s.base as OmieBase)} />
            ))}
          </div>
        )}

        <TitulosResumoCard
          receber={{ data: receberResumo, isLoading: receberLoading, error: receberError }}
          pagar={{ data: pagarResumo, isLoading: pagarLoading, error: pagarError }}
        />

        <ContasCorrentesCard
          base={base}
          request={request}
          ref={ccRef}
        />

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-xl font-bold">
            {t("admin.omie.clientes_de")} {activeStatus?.name ?? ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeStatus && !activeStatus.connected ? (
            <div className="text-sm text-destructive py-4">{activeStatus.error}</div>
          ) : clientesLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : clientesError ? (
            <div className="text-sm text-destructive py-4">{t("admin.omie.erro_clientes")}</div>
          ) : page ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("admin.omie.col_codigo")}</TableHead>
                    <TableHead>{t("admin.omie.col_razao")}</TableHead>
                    <TableHead>{t("admin.omie.col_fantasia")}</TableHead>
                    <TableHead>{t("admin.omie.col_email")}</TableHead>
                    <TableHead>{t("admin.omie.col_cnpj")}</TableHead>
                    <TableHead>{t("admin.omie.col_cidade")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.clientes.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        {t("admin.omie.sem_clientes")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    page.clientes.map((c) => (
                      <TableRow key={c.codigo} data-testid={`row-cliente-${c.codigo}`}>
                        <TableCell className="font-mono text-xs">{c.codigo}</TableCell>
                        <TableCell className="font-medium">{c.razaoSocial}</TableCell>
                        <TableCell>{c.nomeFantasia ?? "—"}</TableCell>
                        <TableCell>{c.email ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{c.cnpjCpf ?? "—"}</TableCell>
                        <TableCell>{c.cidade ?? "—"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between mt-4">
                <div className="text-sm text-muted-foreground">
                  {t("admin.omie.pagina")} {page.pagina} {t("admin.omie.de")} {page.totalDePaginas} · {page.totalDeRegistros} {t("admin.omie.registros")}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagina <= 1 || isFetching}
                    onClick={() => setPagina((p) => Math.max(1, p - 1))}
                    data-testid="button-omie-prev"
                  >
                    <ChevronLeft className="h-4 w-4" /> {t("admin.omie.anterior")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagina >= page.totalDePaginas || isFetching}
                    onClick={() => setPagina((p) => p + 1)}
                    data-testid="button-omie-next"
                  >
                    {t("admin.omie.proxima")} <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
        </>
      )}
    </div>
  );
}
