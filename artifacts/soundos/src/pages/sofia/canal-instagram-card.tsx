import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetCanalInstagramQueryKey,
  getListEventosCanalInstagramQueryKey,
  getVerificarCredenciaisHabllaQueryKey,
  useGerarTokenWebhookInstagram,
  useGetCanalInstagram,
  useListEventosCanalInstagram,
  useUpdateCanalInstagram,
  useVerificarCredenciaisHablla,
} from "@workspace/api-client-react";
import { Instagram, Copy, KeyRound, AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { LinhaVerificacao, STATUS_CLASSES, TIPOS_CONEXAO } from "./canal-card-comum";

type TKey = Parameters<ReturnType<typeof useLang>["t"]>[0];

export function CanalInstagramCard() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: canal, isLoading, isError } = useGetCanalInstagram();
  const [mostrarEventos, setMostrarEventos] = useState(false);
  const [tokenNovo, setTokenNovo] = useState<string | null>(null);
  const { data: eventos, isLoading: carregandoEventos } = useListEventosCanalInstagram({
    query: { queryKey: getListEventosCanalInstagramQueryKey(), enabled: mostrarEventos, refetchInterval: mostrarEventos ? 15_000 : false },
  });

  const { data: verificacao, isLoading: verificando, isFetching: reverificando, isError: erroVerificacao, refetch: verificarDeNovo } =
    useVerificarCredenciaisHablla({
      query: { queryKey: getVerificarCredenciaisHabllaQueryKey(), staleTime: 60_000, refetchOnWindowFocus: false },
    });

  const recarregar = () => {
    void queryClient.invalidateQueries({ queryKey: getGetCanalInstagramQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListEventosCanalInstagramQueryKey() });
  };

  const atualizar = useUpdateCanalInstagram({
    mutation: {
      onSuccess: data => {
        recarregar();
        toast.success(t(data.respondeAtivo ? "sofia.canal.ligado" : "sofia.canal.desligado"));
      },
      onError: error => {
        const detalhe = error instanceof ApiError ? (error.data as { error?: string } | null)?.error : undefined;
        toast.error(detalhe ?? t("sofia.canal.erro_salvar"));
      },
    },
  });
  const gerarToken = useGerarTokenWebhookInstagram({
    mutation: {
      onSuccess: data => { setTokenNovo(data.token); recarregar(); },
      onError: () => toast.error(t("sofia.canal.erro_token")),
    },
  });

  const copiar = (valor: string) => {
    void navigator.clipboard.writeText(valor).then(
      () => toast.success(t("sofia.canal.copiado")),
      () => toast.error(t("sofia.canal.erro_copiar")),
    );
  };

  const pedirNovoToken = () => {
    if (canal?.tokenConfigurado && !window.confirm(t("sofia.canal.confirmar_novo_token"))) return;
    gerarToken.mutate();
  };

  const motivoTexto = (motivo: string | null | undefined): string => {
    if (!motivo) return "—";
    const chave = motivo.split(":")[0] ?? motivo;
    const rotulo = t(`sofia.canal.motivo.${chave}` as TKey);
    return rotulo === `sofia.canal.motivo.${chave}` ? motivo : rotulo;
  };

  return (
    <Card className="shadow-sm border-border/40" data-testid="card-canal-instagram">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="bg-pink-500/10 p-2 rounded-md shrink-0">
              <Instagram className="h-5 w-5 text-pink-600" />
            </div>
            <div>
              <CardTitle className="text-sm font-bold tracking-tight text-foreground">{t("sofia.canal.titulo")}</CardTitle>
              <p className="text-xs text-muted-foreground mt-1 max-w-xl">{t("sofia.canal.desc")}</p>
            </div>
          </div>
          {canal && (
            <div className="flex items-center gap-2 shrink-0">
              <label htmlFor="switch-instagram-responde" className="text-xs font-medium text-foreground">
                {t("sofia.canal.responde")}
              </label>
              <Switch
                id="switch-instagram-responde"
                data-testid="switch-instagram-responde"
                checked={canal.respondeAtivo}
                disabled={atualizar.isPending}
                onCheckedChange={valor => atualizar.mutate({ data: { respondeAtivo: valor } })}
              />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : isError || !canal ? (
          <p className="text-sm text-destructive">{t("sofia.canal.erro_carregar")}</p>
        ) : (
          <>
            {!canal.respondeAtivo && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/50 rounded px-2.5 py-1.5">
                {t("sofia.canal.desligado_aviso")}
              </p>
            )}

            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">{t("sofia.canal.passo_url")}</p>
              {canal.webhookUrl ? (
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-muted/60 rounded px-2 py-1 break-all" data-testid="text-webhook-url">{canal.webhookUrl}</code>
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1" onClick={() => copiar(canal.webhookUrl!)}>
                    <Copy className="h-3 w-3" />{t("sofia.canal.copiar")}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("sofia.canal.sem_url")}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{t("sofia.canal.url_dica")}</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground">{t("sofia.canal.passo_token")}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={canal.tokenConfigurado ? STATUS_CLASSES.respondido : STATUS_CLASSES.recebido}>
                  {canal.tokenConfigurado
                    ? `${t("sofia.canal.token_ok")}${canal.tokenGeradoEm ? ` — ${formatDateTimeBR(canal.tokenGeradoEm)}` : ""}`
                    : t("sofia.canal.token_falta")}
                </Badge>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1" disabled={gerarToken.isPending} onClick={pedirNovoToken} data-testid="button-gerar-token">
                  <KeyRound className="h-3 w-3" />{t(canal.tokenConfigurado ? "sofia.canal.gerar_novo" : "sofia.canal.gerar")}
                </Button>
              </div>
              {tokenNovo && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2" data-testid="box-token-novo">
                  <p className="text-xs text-amber-800 font-medium">{t("sofia.canal.token_uma_vez")}</p>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-white rounded px-2 py-1 break-all border">{tokenNovo}</code>
                    <Button type="button" size="sm" variant="outline" className="h-7 gap-1" onClick={() => copiar(tokenNovo)}>
                      <Copy className="h-3 w-3" />{t("sofia.canal.copiar")}
                    </Button>
                  </div>
                  <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setTokenNovo(null)}>
                    {t("sofia.canal.ja_copiei")}
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-1.5" data-testid="box-verificacao-hablla">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-medium text-foreground">{t("sofia.canal.passo_api")}</p>
                <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 text-xs px-1.5" disabled={reverificando} onClick={() => void verificarDeNovo()} data-testid="button-verificar-hablla">
                  <RefreshCw className={`h-3 w-3 ${reverificando ? "animate-spin" : ""}`} />{t("sofia.canal.verif.verificar")}
                </Button>
              </div>
              {verificando ? (
                <Skeleton className="h-10 w-full" />
              ) : erroVerificacao || !verificacao ? (
                <div className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />{t("sofia.canal.verif.erro")}
                </div>
              ) : (
                <>
                  <LinhaVerificacao ok={verificacao.token === "ok"}>
                    {t(`sofia.canal.verif.token.${verificacao.token}` as TKey)}
                  </LinhaVerificacao>
                  <LinhaVerificacao ok={verificacao.conexoes.instagram.estado === "ok"}>
                    {verificacao.conexoes.instagram.estado === "ok"
                      ? `${t("sofia.canal.verif.conexao.ok")} ${verificacao.conexoes.instagram.nome ?? ""}`.trim()
                      : t(`sofia.canal.verif.conexao.${verificacao.conexoes.instagram.estado}` as TKey)}
                  </LinhaVerificacao>
                  {verificacao.conexoesNoWorkspace.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("sofia.canal.verif.conexoes")}{" "}
                      {verificacao.conexoesNoWorkspace
                        .map(c => `${c.nome} (${(c.tipo && TIPOS_CONEXAO[c.tipo]) || c.tipo || "?"})`)
                        .join(" · ")}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="pt-2 border-t border-border/30">
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs px-0" onClick={() => setMostrarEventos(v => !v)} data-testid="button-eventos-instagram">
                {t(mostrarEventos ? "sofia.canal.ocultar_eventos" : "sofia.canal.ver_eventos")}
              </Button>
              {mostrarEventos && (
                carregandoEventos ? <Skeleton className="h-16 w-full mt-2" />
                : !eventos || eventos.length === 0 ? <p className="text-xs text-muted-foreground mt-2">{t("sofia.canal.sem_eventos")}</p>
                : (
                  <Table className="mt-2">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("common.data")}</TableHead>
                        <TableHead>{t("sofia.canal.col_usuario")}</TableHead>
                        <TableHead>{t("sofia.canal.col_mensagem")}</TableHead>
                        <TableHead>{t("sofia.conv.status")}</TableHead>
                        <TableHead>{t("sofia.canal.col_motivo")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {eventos.map(e => (
                        <TableRow key={e.id}>
                          <TableCell className="text-xs whitespace-nowrap">{formatDateTimeBR(e.createdAt)}</TableCell>
                          <TableCell className="text-xs">{e.usuario ? `@${e.usuario}` : "—"}</TableCell>
                          <TableCell className="text-xs max-w-[260px] truncate">{e.texto ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={STATUS_CLASSES[e.status] ?? ""}>{t(`sofia.canal.status.${e.status}` as TKey)}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[260px] truncate" title={e.motivo ?? undefined}>{motivoTexto(e.motivo)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
