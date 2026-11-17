import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { MessageSquare, MessageCircle, ChevronLeft, ChevronRight, Users, Instagram, AlertTriangle, BellRing, Paperclip } from "lucide-react";
import { telefoneParaExibir } from "./canal-whatsapp-card";
import { format, formatDistanceStrict, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { fr } from "date-fns/locale";
import {
  useListConversations, useAssumeConversationHandoff, useResolveConversationHandoff,
  useUpdateConversationVisibility,
  getListConversationsQueryKey, getListConversationsAwaitingStaffQueryKey,
  type Conversation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useLang } from "@/contexts/language";
import { useAccess } from "@/contexts/access";
import { textoAguardandoEquipe } from "@/hooks/use-conversas-aguardando";

const PAGE_SIZE = 15;

interface HandoffSummary {
  motivoLabel?: string;
  intentoPercebido?: string;
  nivelConfianca?: string;
  evidenciasRelevantes?: string[];
  contextoSensivel?: string | null;
  proximosPassosSugeridos?: string[];
  geradoEm?: string;
}

/** WhatsApp com arquivo recebido que ninguém da equipe viu ainda. */
const temArquivoNaoVisto = (c: Conversation): boolean => c.canal === "whatsapp" && (c.arquivosNaoVistos ?? 0) > 0;

/**
 * Cliente do WhatsApp ou do Instagram que a Sofia passou para a equipe e ninguém assumiu, ou do WhatsApp com
 * arquivo recebido ainda não visto (a mesma conversa conta uma vez só). O chat interno não conta.
 */
function aguardaAEquipe(c: Conversation): boolean {
  if ((c.canal ?? "interno") === "interno") return false;
  return c.status === "aguardando_humano" || temArquivoNaoVisto(c);
}

/** Desde quando a conversa espera: o mais antigo entre o horário do handoff (sem ele, a criação) e o arquivo não visto. */
function esperaDesde(c: Conversation): string {
  const candidatos: string[] = [];
  if (c.status === "aguardando_humano") candidatos.push(c.handoffTriggeredAt ?? c.createdAt);
  if (temArquivoNaoVisto(c) && c.primeiroArquivoNaoVistoEm) candidatos.push(c.primeiroArquivoNaoVistoEm);
  return candidatos.length > 0 ? candidatos.reduce((a, b) => (a <= b ? a : b)) : c.createdAt;
}

/** Atualiza o "há X minutos" sem precisar de nova consulta ao servidor. */
function useAgora(intervaloMs = 30_000): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => window.clearInterval(id);
  }, [intervaloMs]);
  return agora;
}

function parseSummary(raw: string | null | undefined): HandoffSummary | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as HandoffSummary; } catch { return null; }
}

export default function Conversas() {
  const [showHidden, setShowHidden] = useState(false);
  const { data: conversations, isLoading, error } = useListConversations(
    { includeHidden: showHidden ? "true" : "false" },
    { query: {
      queryKey: getListConversationsQueryKey({ includeHidden: showHidden ? "true" : "false" }),
      refetchInterval: 30_000,
    } },
  );
  const [, navigate] = useLocation();
  const [page, setPage] = useState(0);
  const [summaryConvId, setSummaryConvId] = useState<number | null>(null);
  const { t, lang } = useLang();
  const dateLocale = lang === "fr" ? fr : ptBR;
  const queryClient = useQueryClient();
  const { can } = useAccess();
  const podeAbrirCartao = can("crm");

  // Assumir ou resolver tira a conversa do aviso do menu na hora, sem esperar a próxima conferência.
  const invalidateList = () => {
    void queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListConversationsAwaitingStaffQueryKey() });
  };
  const assumeMutation = useAssumeConversationHandoff({ mutation: { onSuccess: invalidateList } });
  const resolveMutation = useResolveConversationHandoff({ mutation: { onSuccess: invalidateList } });
  const visibilityMutation = useUpdateConversationVisibility({ mutation: {
    onSuccess: invalidateList,
    onError: () => toast.error(t("common.erro")),
  } });
  const visibilityText = {
    toggle: lang === "fr" ? "Afficher les conversations masquées" : "Mostrar conversas ocultas",
    hide: lang === "fr" ? "Masquer" : "Ocultar",
    restore: lang === "fr" ? "Restaurer" : "Restaurar",
    hidden: lang === "fr" ? "Masquée" : "Oculta",
  };

  const agora = useAgora();
  // Quem espera a equipe vem primeiro (o mais antigo no topo) para nunca ficar numa página escondida.
  const { ordenadas, aguardando } = useMemo(() => {
    const lista = (conversations ?? []).filter(c => showHidden || !c.hidden);
    const esperando = lista.filter(c => !c.hidden && aguardaAEquipe(c)).sort((a, b) => esperaDesde(a).localeCompare(esperaDesde(b)));
    return { ordenadas: [...esperando, ...lista.filter(c => c.hidden || !aguardaAEquipe(c))], aguardando: esperando };
  }, [conversations, showHidden]);
  const tempoDeEspera = (c: Conversation) => formatDistanceStrict(parseISO(esperaDesde(c)), agora, { locale: dateLocale });

  const total = ordenadas.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = ordenadas.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const summaryConv = conversations?.find(c => c.id === summaryConvId) ?? null;
  const summary = parseSummary(summaryConv?.handoffSummary);

  const statusBadge = (status?: string | null) => {
    if (status === "aguardando_humano") {
      return <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 gap-1"><Users className="h-3 w-3" />{t("sofia.conv.status.aguardando")}</Badge>;
    }
    if (status === "atendimento_humano") {
      return <Badge variant="outline" className="border-blue-400 text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 gap-1"><Users className="h-3 w-3" />{t("sofia.conv.status.atendimento")}</Badge>;
    }
    return null;
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.conv.title")}</h1>
        <p className="text-muted-foreground">{t("sofia.conv.subtitle")}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={showHidden} onCheckedChange={value => { setShowHidden(value); setPage(0); }}
          aria-label={visibilityText.toggle} />
        {visibilityText.toggle}
      </label>

      {aguardando.length > 0 && (
        <div
          role="status"
          data-testid="banner-conversas-aguardando"
          className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <BellRing className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">{textoAguardandoEquipe(t, aguardando.length)}</p>
            <p>{t("sofia.aviso.mais_antiga").replace("{tempo}", tempoDeEspera(aguardando[0]!))}</p>
          </div>
        </div>
      )}

      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              {t("common.erro")}
            </div>
          ) : total === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-muted-foreground">
              <MessageSquare className="h-10 w-10 opacity-30" />
              <p className="text-sm">{t("sofia.conv.nenhuma")}</p>
              <p className="text-xs">{t("sofia.conv.aparece")}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("common.titulo")}</TableHead>
                    <TableHead>{t("common.pessoa")}</TableHead>
                    <TableHead>{t("common.primeiro_msg")}</TableHead>
                    <TableHead>{t("sofia.conv.status")}</TableHead>
                    <TableHead>{t("common.data")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slice.map((c) => (
                    <TableRow
                      key={c.id}
                      className={`cursor-pointer transition-colors ${aguardaAEquipe(c) ? "bg-amber-50/80 hover:bg-amber-100/70 dark:bg-amber-950/20 dark:hover:bg-amber-950/30" : "hover:bg-muted/50"}`}
                      data-aguardando-equipe={aguardaAEquipe(c) ? "true" : undefined}
                      onClick={() => navigate(c.pessoaId ? `/sofia?pessoa=${c.pessoaId}&conv=${c.id}` : `/sofia?conv=${c.id}`)}
                    >
                      <TableCell className={`font-medium max-w-[240px] ${aguardaAEquipe(c) ? "border-l-4 border-l-amber-500" : ""}`}>
                        <div className="truncate">{c.title || `${t("sofia.conv.conversa_prefixo")}${c.id}`}</div>
                        {c.hidden && <Badge variant="secondary">{visibilityText.hidden}</Badge>}
                        {c.canal === "whatsapp" && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <Badge variant="outline" className="border-emerald-300 text-emerald-700 bg-emerald-50 gap-1 font-normal" data-testid={`badge-canal-whatsapp-${c.id}`}>
                              <MessageCircle className="h-3 w-3" />{t("sofia.conv.canal.whatsapp")}
                            </Badge>
                            {c.canalUsuario && <span className="text-xs text-muted-foreground font-normal">{telefoneParaExibir(c.canalUsuario)}</span>}
                            {c.ultimoEnvioFalhou && (
                              <Badge variant="outline" className="border-destructive/50 text-destructive bg-destructive/5 gap-1 font-normal" title={c.ultimoEnvioErro ?? undefined} data-testid={`badge-envio-falhou-${c.id}`}>
                                <AlertTriangle className="h-3 w-3" />{t("sofia.conv.envio_falhou")}
                              </Badge>
                            )}
                            {temArquivoNaoVisto(c) && (
                              <Badge variant="outline" className="border-amber-400 text-amber-800 bg-amber-50 gap-1 font-normal" data-testid={`badge-arquivo-novo-${c.id}`}>
                                <Paperclip className="h-3 w-3" />
                                {(c.arquivosNaoVistos ?? 0) > 1 ? t("sofia.conv.arquivos_novos").replace("{n}", String(c.arquivosNaoVistos)) : t("sofia.conv.arquivo_novo")}
                              </Badge>
                            )}
                          </div>
                        )}
                        {c.canal === "instagram" && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <Badge variant="outline" className="border-pink-300 text-pink-700 bg-pink-50 gap-1 font-normal" data-testid={`badge-canal-instagram-${c.id}`}>
                              <Instagram className="h-3 w-3" />{t("sofia.conv.canal.instagram")}
                            </Badge>
                            {c.canalUsuario && <span className="text-xs text-muted-foreground font-normal">@{c.canalUsuario}</span>}
                            {c.ultimoEnvioFalhou && (
                              <Badge variant="outline" className="border-destructive/50 text-destructive bg-destructive/5 gap-1 font-normal" title={c.ultimoEnvioErro ?? undefined} data-testid={`badge-envio-falhou-${c.id}`}>
                                <AlertTriangle className="h-3 w-3" />{t("sofia.conv.envio_falhou")}
                              </Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.pessoaNome ? (
                          <button
                            className="text-primary hover:underline truncate max-w-[160px] text-left"
                            onClick={e => { e.stopPropagation(); navigate(`/pessoas/${c.pessoaId}`); }}
                          >
                            {c.pessoaNome}
                          </button>
                        ) : (
                          <span className="italic text-muted-foreground opacity-50">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[280px] truncate text-sm">
                        {c.firstMessage
                          ? c.firstMessage.slice(0, 80) + (c.firstMessage.length > 80 ? "…" : "")
                          : c.primeiraMensagemEhArquivo
                            ? <span className="italic">{t("sofia.conv.primeiro_arquivo")}</span>
                            : <span className="italic opacity-50">—</span>}
                      </TableCell>
                      <TableCell>
                        {statusBadge(c.status) ?? <span className="text-xs text-muted-foreground/50">—</span>}
                        {aguardaAEquipe(c) && (
                          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid={`espera-${c.id}`}>
                            {t("sofia.aviso.espera").replace("{tempo}", tempoDeEspera(c))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                        {format(parseISO(c.createdAt), "dd/MM/yyyy HH:mm", { locale: dateLocale })}
                      </TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Button size="sm" variant="ghost" className="mb-1.5 h-7 text-xs"
                          disabled={visibilityMutation.isPending}
                          data-testid={`visibilidade-conversa-${c.id}`}
                          onClick={() => visibilityMutation.mutate({ id: c.id, data: { hidden: !c.hidden } })}>
                          {c.hidden ? visibilityText.restore : visibilityText.hide}
                        </Button>
                        {temArquivoNaoVisto(c) && podeAbrirCartao && c.cartaoAbertoId != null && (
                          <Button size="sm" variant="outline" className="mb-1.5 h-7 text-xs"
                            data-testid={`abrir-cartao-${c.id}`}
                            onClick={() => navigate(`/crm?card=${c.cartaoAbertoId}`)}>
                            {t("sofia.conv.abrir_cartao")}
                          </Button>
                        )}
                        {c.status === "aguardando_humano" && (
                          <div className="flex gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 text-xs"
                              onClick={() => setSummaryConvId(c.id)}>
                              {t("sofia.conv.resumo.title")}
                            </Button>
                            <Button size="sm" variant="default" className="h-7 text-xs"
                              disabled={assumeMutation.isPending}
                              onClick={() => assumeMutation.mutate({ id: c.id })}>
                              {t("sofia.conv.assumir")}
                            </Button>
                          </div>
                        )}
                        {c.status === "atendimento_humano" && (
                          <div className="flex gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 text-xs"
                              onClick={() => setSummaryConvId(c.id)}>
                              {t("sofia.conv.resumo.title")}
                            </Button>
                            <Button size="sm" variant="default" className="h-7 text-xs"
                              disabled={resolveMutation.isPending}
                              onClick={() => resolveMutation.mutate({ id: c.id })}>
                              {t("sofia.conv.resolver")}
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border/40">
                  <span className="text-xs text-muted-foreground">
                    {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, total)} / {total}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={safePage === 0}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs px-2 tabular-nums text-muted-foreground">
                      {safePage + 1} / {totalPages}
                    </span>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={safePage >= totalPages - 1}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={summaryConvId !== null} onOpenChange={(open) => { if (!open) setSummaryConvId(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("sofia.conv.resumo.title")}</DialogTitle>
          </DialogHeader>
          {summary ? (
            <div className="space-y-3 text-sm">
              <div><span className="font-medium text-muted-foreground">{t("sofia.conv.resumo.motivo")}:</span> {summary.motivoLabel ?? "—"}</div>
              <div><span className="font-medium text-muted-foreground">{t("sofia.conv.resumo.intencao")}:</span> {summary.intentoPercebido ?? "—"}</div>
              <div><span className="font-medium text-muted-foreground">{t("sofia.conv.resumo.confianca")}:</span> {summary.nivelConfianca ?? "—"}</div>
              {summary.contextoSensivel && (
                <div><span className="font-medium text-muted-foreground">{t("sofia.conv.resumo.sensivel")}:</span> {summary.contextoSensivel}</div>
              )}
              {summary.evidenciasRelevantes && summary.evidenciasRelevantes.length > 0 && (
                <div>
                  <span className="font-medium text-muted-foreground">{t("sofia.conv.resumo.evidencias")}:</span>
                  <ul className="list-disc list-inside mt-1 text-muted-foreground">
                    {summary.evidenciasRelevantes.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              {summary.proximosPassosSugeridos && summary.proximosPassosSugeridos.length > 0 && (
                <div>
                  <span className="font-medium text-muted-foreground">{t("sofia.conv.resumo.proximos")}:</span>
                  <ul className="list-disc list-inside mt-1 text-muted-foreground">
                    {summary.proximosPassosSugeridos.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
              {summary.geradoEm && (
                <div className="text-xs text-muted-foreground/70 pt-1">
                  {t("sofia.conv.resumo.disparado_em")}: {format(parseISO(summary.geradoEm), "dd/MM/yyyy HH:mm", { locale: dateLocale })}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("common.erro")}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSummaryConvId(null)}>{t("sofia.conv.fechar")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
