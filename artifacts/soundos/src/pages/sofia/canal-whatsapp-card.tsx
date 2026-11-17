import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetCanalWhatsappQueryKey,
  getListEventosCanalWhatsappQueryKey,
  getVerificarCredenciaisHabllaQueryKey,
  useGerarTokenWebhookWhatsapp,
  useGetCanalWhatsapp,
  useListEventosCanalWhatsapp,
  useUpdateCanalWhatsapp,
  useVerificarCredenciaisHablla,
} from "@workspace/api-client-react";
import { MessageCircle, Copy, KeyRound, AlertTriangle, RefreshCw } from "lucide-react";
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

/** "+55 11 99999-9999" para números do Brasil; "+dígitos" para os demais. */
export function telefoneParaExibir(telefone: string): string {
  if (!/^55\d{10,11}$/.test(telefone)) return `+${telefone}`;
  const nacional = telefone.slice(2);
  const numero = nacional.slice(2);
  return `+55 ${nacional.slice(0, 2)} ${numero.slice(0, numero.length - 4)}-${numero.slice(-4)}`;
}

/** Códigos da Meta que têm texto próprio (nas duas línguas); os demais mostram só o número. */
const CODIGOS_COM_TEXTO = new Set([131037, 131030, 131047, 131026, 190]);
/** Falhas que não se resolvem sozinhas: precisam de uma ação de quem administra a Meta ou o Hablla. */
const CODIGOS_COM_ACAO = new Set([131037, 190]);

type Traduzir = ReturnType<typeof useLang>["t"];

/** Motivo da falha mais recente, só a partir do código da Meta (nunca texto do provedor). */
export function motivoDaFalhaDeEnvio(t: Traduzir, codigo: number | null): string {
  if (codigo === null) return t("sofia.wa.falha.motivo_sem_codigo");
  if (!CODIGOS_COM_TEXTO.has(codigo)) return t("sofia.wa.falha.motivo_outro").replace("{codigo}", String(codigo));
  return t(`sofia.wa.falha.motivo.${codigo}` as TKey);
}

export function acaoDaFalhaDeEnvio(t: Traduzir, codigo: number | null): string | null {
  return codigo !== null && CODIGOS_COM_ACAO.has(codigo) ? t(`sofia.wa.falha.acao.${codigo}` as TKey) : null;
}

/** Motivos que carregam o estado depois dos dois pontos ("entrega:entregue"). */
const MOTIVOS_COM_ESTADO = new Set(["entrega", "entrega_sem_mudanca", "resultado_de_envio", "resultado_de_envio_falhou"]);

export function CanalWhatsappCard() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: canal, isLoading, isError } = useGetCanalWhatsapp();
  const [mostrarEventos, setMostrarEventos] = useState(false);
  const [tokenNovo, setTokenNovo] = useState<string | null>(null);
  const { data: eventos, isLoading: carregandoEventos } = useListEventosCanalWhatsapp({
    query: { queryKey: getListEventosCanalWhatsappQueryKey(), enabled: mostrarEventos, refetchInterval: mostrarEventos ? 15_000 : false },
  });

  const { data: verificacao, isLoading: verificando, isFetching: reverificando, isError: erroVerificacao, refetch: verificarDeNovo } =
    useVerificarCredenciaisHablla({
      query: { queryKey: getVerificarCredenciaisHabllaQueryKey(), staleTime: 60_000, refetchOnWindowFocus: false },
    });

  const recarregar = () => {
    void queryClient.invalidateQueries({ queryKey: getGetCanalWhatsappQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListEventosCanalWhatsappQueryKey() });
  };

  const atualizar = useUpdateCanalWhatsapp({
    mutation: {
      onSuccess: (data, variables) => {
        recarregar();
        // O aviso é sobre a chave que a pessoa mexeu.
        if (variables.data.iniciaConversaAtivo !== undefined) {
          toast.success(t(data.iniciaConversaAtivo ? "sofia.wa.inicia_ligado" : "sofia.wa.inicia_desligado"));
        } else {
          toast.success(t(data.respondeAtivo ? "sofia.wa.ligado" : "sofia.wa.desligado"));
        }
      },
      onError: error => {
        const detalhe = error instanceof ApiError ? (error.data as { error?: string } | null)?.error : undefined;
        toast.error(detalhe ?? t("sofia.canal.erro_salvar"));
      },
    },
  });
  const gerarToken = useGerarTokenWebhookWhatsapp({
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

  const rotuloDoEstado = (estado: string): string => {
    const chave = `sofia.wa.entrega.${estado}`;
    const rotulo = t(chave as TKey);
    return rotulo === chave ? estado : rotulo;
  };

  const motivoTexto = (motivo: string | null | undefined): string => {
    if (!motivo) return "—";
    const [chave = motivo, estado] = motivo.split(":");
    const rotulo = t(`sofia.canal.motivo.${chave}` as TKey);
    if (rotulo === `sofia.canal.motivo.${chave}`) return motivo;
    return MOTIVOS_COM_ESTADO.has(chave) && estado ? `${rotulo}: ${rotuloDoEstado(estado)}` : rotulo;
  };

  const conexao = verificacao?.conexoes.whatsapp;

  return (
    <Card className="shadow-sm border-border/40" data-testid="card-canal-whatsapp">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/10 p-2 rounded-md shrink-0">
              <MessageCircle className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <CardTitle className="text-sm font-bold tracking-tight text-foreground">{t("sofia.wa.titulo")}</CardTitle>
              <p className="text-xs text-muted-foreground mt-1 max-w-xl">{t("sofia.wa.desc")}</p>
            </div>
          </div>
          {canal && (
            <div className="flex items-center gap-2 shrink-0">
              <label htmlFor="switch-whatsapp-responde" className="text-xs font-medium text-foreground">
                {t("sofia.wa.responde")}
              </label>
              <Switch
                id="switch-whatsapp-responde"
                data-testid="switch-whatsapp-responde"
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
          <p className="text-sm text-destructive">{t("sofia.wa.erro_carregar")}</p>
        ) : (
          <>
            {canal.ultimaFalhaDeEnvio && (
              <div className="space-y-1 rounded border border-destructive/40 bg-destructive/5 p-3" role="alert" data-testid="box-whatsapp-ultima-falha">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />{t("sofia.wa.falha.titulo")}
                </p>
                <p className="text-xs text-foreground" data-testid="text-whatsapp-falha-motivo">{motivoDaFalhaDeEnvio(t, canal.ultimaFalhaDeEnvio.codigo)}</p>
                <p className="text-[11px] text-muted-foreground" data-testid="text-whatsapp-falha-quando">
                  {t("sofia.wa.falha.quando").replace("{data}", formatDateTimeBR(canal.ultimaFalhaDeEnvio.falhouEm))}
                </p>
                {acaoDaFalhaDeEnvio(t, canal.ultimaFalhaDeEnvio.codigo) && (
                  <p className="text-xs text-foreground" data-testid="text-whatsapp-falha-acao">{acaoDaFalhaDeEnvio(t, canal.ultimaFalhaDeEnvio.codigo)}</p>
                )}
                <p className="text-[11px] text-muted-foreground">{t("sofia.wa.falha.sozinha")}</p>
              </div>
            )}

            {!canal.respondeAtivo && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/50 rounded px-2.5 py-1.5">
                {t("sofia.wa.desligado_aviso")}
              </p>
            )}

            <div className="space-y-1.5 rounded border border-border/50 p-3" data-testid="box-whatsapp-inicia">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <label htmlFor="switch-whatsapp-inicia" className="text-xs font-medium text-foreground">
                  {t("sofia.wa.inicia")}
                </label>
                <Switch
                  id="switch-whatsapp-inicia"
                  data-testid="switch-whatsapp-inicia"
                  checked={canal.iniciaConversaAtivo}
                  disabled={atualizar.isPending || (!canal.iniciaConversaAtivo && !canal.respondeAtivo)}
                  onCheckedChange={valor => atualizar.mutate({ data: { iniciaConversaAtivo: valor } })}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{t("sofia.wa.inicia_desc")}</p>
              <p className="text-[11px] text-muted-foreground" data-testid="text-whatsapp-inicia-limites">
                {t("sofia.wa.inicia_limites")
                  .replace("{hora}", String(canal.limiteIniciosPorHora))
                  .replace("{dia}", String(canal.limiteIniciosPorDia))}
              </p>
              {!canal.respondeAtivo && !canal.iniciaConversaAtivo && (
                <p className="text-[11px] text-amber-700">{t("sofia.wa.inicia_exige_responde")}</p>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">{t("sofia.canal.passo_url")}</p>
              {canal.webhookUrl ? (
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-muted/60 rounded px-2 py-1 break-all" data-testid="text-webhook-url-whatsapp">{canal.webhookUrl}</code>
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1" onClick={() => copiar(canal.webhookUrl!)}>
                    <Copy className="h-3 w-3" />{t("sofia.canal.copiar")}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("sofia.canal.sem_url")}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{t("sofia.wa.url_dica")}</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground">{t("sofia.canal.passo_token")}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={canal.tokenConfigurado ? STATUS_CLASSES.respondido : STATUS_CLASSES.recebido}>
                  {canal.tokenConfigurado
                    ? `${t("sofia.canal.token_ok")}${canal.tokenGeradoEm ? ` — ${formatDateTimeBR(canal.tokenGeradoEm)}` : ""}`
                    : t("sofia.canal.token_falta")}
                </Badge>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1" disabled={gerarToken.isPending} onClick={pedirNovoToken} data-testid="button-gerar-token-whatsapp">
                  <KeyRound className="h-3 w-3" />{t(canal.tokenConfigurado ? "sofia.canal.gerar_novo" : "sofia.canal.gerar")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("sofia.wa.token_separado")}</p>
              {tokenNovo && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2" data-testid="box-token-novo-whatsapp">
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

            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">{t("sofia.wa.passo_eventos")}</p>
              <ul className="text-[11px] text-muted-foreground list-disc pl-4 space-y-0.5">
                <li>{t("sofia.wa.evento_recebida")}</li>
                <li>{t("sofia.wa.evento_status")}</li>
                <li>{t("sofia.wa.evento_envio")}</li>
              </ul>
            </div>

            <div className="space-y-1.5" data-testid="box-verificacao-hablla-whatsapp">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-medium text-foreground">{t("sofia.wa.passo_api")}</p>
                <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 text-xs px-1.5" disabled={reverificando} onClick={() => void verificarDeNovo()} data-testid="button-verificar-hablla-whatsapp">
                  <RefreshCw className={`h-3 w-3 ${reverificando ? "animate-spin" : ""}`} />{t("sofia.canal.verif.verificar")}
                </Button>
              </div>
              {verificando ? (
                <Skeleton className="h-10 w-full" />
              ) : erroVerificacao || !verificacao || !conexao ? (
                <div className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />{t("sofia.canal.verif.erro")}
                </div>
              ) : (
                <>
                  <LinhaVerificacao ok={verificacao.token === "ok"}>
                    {t(`sofia.canal.verif.token.${verificacao.token}` as TKey)}
                  </LinhaVerificacao>
                  <LinhaVerificacao ok={conexao.estado === "ok"}>
                    {conexao.estado === "ok"
                      ? `${t("sofia.wa.verif.conexao.ok")} ${conexao.nome ?? ""}`.trim()
                      : t(`sofia.wa.verif.conexao.${conexao.estado}` as TKey)}
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
              {conexao?.numeroDeTeste === true && (
                <p className="text-[11px] text-muted-foreground" data-testid="text-aviso-numero-teste">{t("sofia.wa.numero_teste")}</p>
              )}
            </div>

            <div className="pt-2 border-t border-border/30">
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs px-0" onClick={() => setMostrarEventos(v => !v)} data-testid="button-eventos-whatsapp">
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
                        <TableHead>{t("sofia.wa.col_numero")}</TableHead>
                        <TableHead>{t("sofia.canal.col_mensagem")}</TableHead>
                        <TableHead>{t("sofia.conv.status")}</TableHead>
                        <TableHead>{t("sofia.canal.col_motivo")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {eventos.map(e => (
                        <TableRow key={e.id}>
                          <TableCell className="text-xs whitespace-nowrap">{formatDateTimeBR(e.createdAt)}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{e.telefone ? telefoneParaExibir(e.telefone) : "—"}</TableCell>
                          <TableCell className="text-xs max-w-[260px] truncate">{e.texto ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={STATUS_CLASSES[e.status] ?? ""}>{t(`sofia.canal.status.${e.status}` as TKey)}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[260px]" title={e.falha ?? e.motivo ?? undefined}>
                            <span className="block truncate">{motivoTexto(e.motivo)}</span>
                            {e.falha && <span className="block text-destructive whitespace-normal" data-testid={`text-evento-falha-${e.id}`}>{e.falha}</span>}
                          </TableCell>
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
