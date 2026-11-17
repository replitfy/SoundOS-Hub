import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BrainCircuit, MoreVertical, Pause, Play, XCircle } from "lucide-react";
import {
  getGetCommercialOpportunityAtendimentoQueryKey,
  getGetCommercialOpportunityQueryKey,
  useGetCommercialOpportunity,
  useGetCommercialOpportunityAtendimento,
  usePauseCommercialOpportunity,
  useReactivateCommercialOpportunity,
  type CommercialOpportunity,
  type OpportunityStage,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useLang } from "@/contexts/language";
import { useAccess } from "@/contexts/access";
import { errorText } from "../atendimento-errors";
import { useCardRefresh } from "../use-card-refresh";
import { CardChat } from "./card-chat";
import { CardCompromissos } from "./card-compromissos";
import { CardContato } from "./card-contato";
import { CardControles } from "./card-controles";
import { CardEntendimento } from "./card-entendimento";
import { CardHistorico } from "./card-historico";
import { CardInformacoes } from "./card-informacoes";
import { CardTarefas } from "./card-tarefas";
import { TransitionDialog } from "./transition-dialog";

interface Props {
  /** `null` = fechado. */
  opportunityId: number | null;
  onClose: () => void;
  onChangeStage: (id: number, stage: OpportunityStage, current: { stage: OpportunityStage; version: number }) => void;
}

function Origem({ opp }: { opp: CommercialOpportunity }) {
  const { t } = useLang();
  const partes = [
    opp.origem?.grupoLabel ?? opp.origem?.grupo ? `${t("crm.origem.grupo")}: ${opp.origem?.grupoLabel ?? opp.origem?.grupo}` : null,
    opp.origem?.curso ? `${t("crm.origem.curso")}: ${opp.origem.curso.name}` : null,
    opp.origem?.evento ? `${t("crm.origem.evento")}: ${opp.origem.evento.name}` : null,
  ].filter((p): p is string => p !== null);
  if (partes.length === 0) return null;
  return <p className="text-xs text-muted-foreground" data-testid="crm-modal-origem">{partes.join(" · ")}</p>;
}

function InformacoesDoCartao({ opp }: { opp: CommercialOpportunity }) {
  const { t } = useLang();
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div className="bg-muted/30 p-3 rounded-lg border">
          <span className="block text-xs font-medium text-muted-foreground mb-1">{t("crm.form.offer")}</span>
          <span className="font-medium">{opp.offerLabel || t("crm.form.general")}</span>
        </div>
        <div className="bg-muted/30 p-3 rounded-lg border">
          <span className="block text-xs font-medium text-muted-foreground mb-1">{t("crm.form.interest_status")}</span>
          <span className="font-medium">{t(`crm.interest.${opp.offerInterestStatus}` as any)}</span>
        </div>
      </div>

      {opp.sofia && (
        <div className="bg-blue-500/5 border border-blue-500/20 p-4 rounded-lg space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-blue-600/80 flex items-center">
            <BrainCircuit className="h-3.5 w-3.5 mr-1.5" />Sofia Intelligence
          </h4>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="block text-[10px] text-muted-foreground mb-0.5">{t("crm.sofia.eligibility")}</span>
              <span className="font-medium">{t(`crm.eligibility.${opp.sofia.eligibilityStatus}` as any)}</span>
            </div>
            <div>
              <span className="block text-[10px] text-muted-foreground mb-0.5">{t("crm.sofia.handoff")}</span>
              <span className="font-medium">{opp.sofia.handoffActive ? t("crm.status.active") : t("crm.status.inactive")}</span>
            </div>
            {opp.sofia.decisionRunId && (
              <div>
                <span className="block text-[10px] text-muted-foreground mb-0.5">Decision Run</span>
                <span className="font-medium text-xs font-mono">#{opp.sofia.decisionRunId}</span>
              </div>
            )}
            {opp.humanCaseReference && (
              <div>
                <span className="block text-[10px] text-muted-foreground mb-0.5">Human Reference</span>
                <span className="font-medium text-xs font-mono">{opp.humanCaseReference}</span>
              </div>
            )}
            {opp.sofia.nextBestAction && (
              <div className="col-span-2">
                <span className="block text-[10px] text-muted-foreground mb-0.5">Next Best Action</span>
                <span className="font-medium text-blue-700/90 bg-blue-500/10 px-2 py-1 rounded inline-block w-full">{opp.sofia.nextBestAction}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Cartão do CRM em janela central: dados e ações à esquerda; conversa de WhatsApp e histórico à direita.
 * Oportunidade encerrada fica só para leitura (a reativação está no menu).
 */
export function CardModal({ opportunityId, onClose, onChangeStage }: Props) {
  const { t } = useLang();
  const { can, canPath } = useAccess();
  const open = opportunityId !== null;
  const id = opportunityId ?? 0;
  const refresh = useCardRefresh(id);

  const { data: detail, isLoading } = useGetCommercialOpportunity(id, { query: { enabled: open, queryKey: getGetCommercialOpportunityQueryKey(id) } });
  const { data: atendimento } = useGetCommercialOpportunityAtendimento(id, { query: { enabled: open, queryKey: getGetCommercialOpportunityAtendimentoQueryKey(id) } });
  const pauseMut = usePauseCommercialOpportunity();
  const reactivateMut = useReactivateCommercialOpportunity();
  const [pausando, setPausando] = useState(false);
  // Aba à vista: arquivos novos da conversa só são dados como vistos com a aba da conversa aberta.
  const [aba, setAba] = useState<"conversa" | "historico" | null>(null);
  useEffect(() => { setAba(null); }, [opportunityId]);

  const opp = detail?.opportunity;
  const events = detail?.events ?? [];
  const closed = opp?.stage === "CLOSED";
  const podeConversar = can("crm") && can("conversas");
  const abaAtual = aba ?? (podeConversar ? "conversa" : "historico");

  const pausar = (res: { reason: string }) => {
    if (!opp) return;
    pauseMut.mutate({ id: opp.id, data: { reason: res.reason } }, {
      onSuccess: () => { toast.success(t("crm.atend.salvo")); refresh(); setPausando(false); },
      onError: err => toast.error(errorText(err, t)),
    });
  };

  const reativar = () => {
    if (!opp) return;
    reactivateMut.mutate({ id: opp.id, data: { expectedVersion: opp.version } as any }, {
      onSuccess: () => { toast.success(t("crm.atend.salvo")); refresh(); },
      onError: err => { toast.error(errorText(err, t)); refresh(); },
    });
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent
        className="flex h-[92vh] w-[96vw] max-w-6xl flex-col gap-0 overflow-hidden p-0"
        data-testid="crm-card-modal"
      >
        {isLoading || !opp ? (
          <div className="space-y-4 p-6">
            <DialogTitle className="sr-only">{t("crm.modal.carregando")}</DialogTitle>
            <DialogDescription className="sr-only">{t("crm.modal.carregando")}</DialogDescription>
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-6 h-32 w-full" />
          </div>
        ) : (
          <>
            <DialogHeader className="space-y-1 border-b bg-muted/20 p-5 pr-12 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <DialogTitle className="truncate">{opp.person?.name || `${t("crm.form.person")} #${opp.pessoaId}`}</DialogTitle>
                  <DialogDescription className="flex flex-wrap gap-x-3 text-xs">
                    <span>{opp.person?.email}</span>
                    <span>{opp.person?.phone}</span>
                  </DialogDescription>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t("crm.modal.acoes")} data-testid="crm-modal-menu">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {opp.stage === "NURTURE" || opp.stage === "CLOSED" ? (
                      <DropdownMenuItem onClick={reativar}><Play className="h-4 w-4 mr-2" />{t("crm.action.reactivate")}</DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setPausando(true)}><Pause className="h-4 w-4 mr-2" />{t("crm.action.pause")}</DropdownMenuItem>
                    )}
                    {opp.stage !== "CLOSED" && (
                      <DropdownMenuItem onClick={() => onChangeStage(opp.id, "CLOSED", { stage: opp.stage, version: opp.version })} className="text-destructive focus:bg-destructive/10">
                        <XCircle className="h-4 w-4 mr-2" />{t("crm.action.close")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${opp.nucleus === "EDUCATION" ? "bg-blue-500/10 text-blue-600" : "bg-orange-500/10 text-orange-600"}`}>
                  {t(`crm.nucleus.${opp.nucleus}` as any)}
                </span>
                <span className="bg-muted px-2 py-0.5 rounded text-xs font-medium text-foreground">{t(`crm.stage.${opp.stage}` as any)}</span>
                {closed && <span className="text-xs text-muted-foreground" data-testid="crm-modal-encerrado">{t("crm.modal.encerrado")}</span>}
              </div>
              <Origem opp={opp} />
            </DialogHeader>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-2 lg:overflow-hidden">
              <div className="space-y-6 p-5 lg:overflow-y-auto lg:border-r" data-testid="crm-modal-esquerda">
                <InformacoesDoCartao opp={opp} />
                <CardEntendimento events={events} />
                <CardControles opp={opp} closed={closed} />
                <CardInformacoes opportunityId={opp.id} closed={closed} informacoes={atendimento?.informacoes ?? opp.informacoes ?? null} notas={atendimento?.notas ?? []} />
                <CardTarefas opportunityId={opp.id} closed={closed} tarefas={atendimento?.tarefas ?? []} />
                <CardCompromissos opportunityId={opp.id} closed={closed} compromissos={atendimento?.compromissos ?? []} />
                <CardContato opportunityId={opp.id} closed={closed} />
              </div>

              <div className="flex min-h-[560px] flex-col p-5 lg:min-h-0 lg:overflow-hidden" data-testid="crm-modal-direita">
                <Tabs value={abaAtual} onValueChange={valor => setAba(valor === "conversa" ? "conversa" : "historico")} className="flex min-h-0 flex-1 flex-col">
                  <TabsList className="self-start">
                    {podeConversar && <TabsTrigger value="conversa" data-testid="crm-tab-conversa">{t("crm.modal.aba_conversa")}</TabsTrigger>}
                    <TabsTrigger value="historico" data-testid="crm-tab-historico">{t("crm.history.title")}</TabsTrigger>
                  </TabsList>
                  {podeConversar && (
                    // Montada o tempo todo (só escondida) para a conversa seguir atualizando e o rascunho não se perder.
                    <TabsContent value="conversa" forceMount className="mt-3 min-h-0 flex-1 data-[state=inactive]:hidden">
                      <CardChat key={opp.id} opportunityId={opp.id} closed={closed} ativa={abaAtual === "conversa"} />
                    </TabsContent>
                  )}
                  <TabsContent value="historico" className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                    <CardHistorico events={events} pessoaId={opp.pessoaId} canOpenConversation={canPath("/sofia")} />
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </>
        )}
      </DialogContent>

      <TransitionDialog open={pausando} actionType="pause" onCancel={() => setPausando(false)} onConfirm={pausar} isPending={pauseMut.isPending} />
    </Dialog>
  );
}
