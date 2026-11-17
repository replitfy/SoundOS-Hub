import { useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Pencil, Trash2, X, Check } from "lucide-react";
import {
  useCreateCommercialOpportunityTask,
  useDeleteCommercialOpportunityTask,
  useSetCommercialOpportunityTaskDone,
  useUpdateCommercialOpportunityTask,
  type CommercialTask,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { errorText } from "../atendimento-errors";
import { useCardRefresh } from "../use-card-refresh";

const LIMITE_TAREFA = 500;

const paraCampoData = (iso: string | null | undefined) => (iso ? format(new Date(iso), "yyyy-MM-dd'T'HH:mm") : "");
const paraIso = (campo: string) => (campo ? new Date(campo).toISOString() : null);

interface Props {
  opportunityId: number;
  closed: boolean;
  tarefas: CommercialTask[];
}

export function CardTarefas({ opportunityId, closed, tarefas }: Props) {
  const { t } = useLang();
  const refresh = useCardRefresh(opportunityId);
  const createMut = useCreateCommercialOpportunityTask();
  const updateMut = useUpdateCommercialOpportunityTask();
  const doneMut = useSetCommercialOpportunityTaskDone();
  const deleteMut = useDeleteCommercialOpportunityTask();

  const [texto, setTexto] = useState("");
  const [prazo, setPrazo] = useState("");
  const [editando, setEditando] = useState<{ id: number; texto: string; prazo: string } | null>(null);
  const [apagando, setApagando] = useState<CommercialTask | null>(null);

  const onError = (err: unknown) => toast.error(errorText(err, t));

  const criar = () => {
    if (!texto.trim()) return;
    createMut.mutate({ id: opportunityId, data: { texto: texto.trim(), prazo: paraIso(prazo) } }, {
      onSuccess: () => { setTexto(""); setPrazo(""); refresh(); },
      onError,
    });
  };

  const salvarEdicao = () => {
    if (!editando || !editando.texto.trim()) return;
    updateMut.mutate({ id: opportunityId, taskId: editando.id, data: { texto: editando.texto.trim(), prazo: paraIso(editando.prazo) } }, {
      onSuccess: () => { setEditando(null); refresh(); },
      onError,
    });
  };

  const alternar = (tarefa: CommercialTask, executada: boolean) => {
    doneMut.mutate({ id: opportunityId, taskId: tarefa.id, data: { executada } }, { onSuccess: refresh, onError });
  };

  const apagar = () => {
    if (!apagando) return;
    deleteMut.mutate({ id: opportunityId, taskId: apagando.id }, {
      onSuccess: () => { setApagando(null); refresh(); },
      onError: err => { setApagando(null); onError(err); },
    });
  };

  return (
    <section className="space-y-2" data-testid="crm-tarefas">
      <h3 className="text-sm font-bold tracking-widest text-muted-foreground uppercase">{t("crm.tarefas.titulo")}</h3>
      {!closed && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_190px_auto] gap-2">
          <Input value={texto} onChange={e => setTexto(e.target.value)} maxLength={LIMITE_TAREFA}
            placeholder={t("crm.tarefas.placeholder")} aria-label={t("crm.tarefas.placeholder")} />
          <Input type="datetime-local" value={prazo} onChange={e => setPrazo(e.target.value)} aria-label={t("crm.tarefas.prazo")} />
          <Button size="sm" variant="outline" onClick={criar} disabled={!texto.trim() || createMut.isPending} data-testid="crm-tarefa-adicionar">
            {t("crm.tarefas.adicionar")}
          </Button>
        </div>
      )}
      {tarefas.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{t("crm.tarefas.vazio")}</p>
      ) : (
        <ul className="space-y-2">
          {tarefas.map(tarefa => {
            const feita = tarefa.doneAt != null;
            const atrasada = !feita && tarefa.dueAt != null && new Date(tarefa.dueAt) < new Date();
            if (editando?.id === tarefa.id) {
              return (
                <li key={tarefa.id} className="grid grid-cols-1 sm:grid-cols-[1fr_190px_auto] gap-2 rounded-md border p-2">
                  <Input value={editando.texto} onChange={e => setEditando({ ...editando, texto: e.target.value })} maxLength={LIMITE_TAREFA} aria-label={t("crm.tarefas.placeholder")} />
                  <Input type="datetime-local" value={editando.prazo} onChange={e => setEditando({ ...editando, prazo: e.target.value })} aria-label={t("crm.tarefas.prazo")} />
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" className="h-9 w-9" onClick={salvarEdicao} disabled={updateMut.isPending} aria-label={t("common.salvar")}><Check className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setEditando(null)} aria-label={t("common.cancelar")}><X className="h-4 w-4" /></Button>
                  </div>
                </li>
              );
            }
            return (
              <li key={tarefa.id} className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm" data-testid={`crm-tarefa-${tarefa.id}`}>
                <Checkbox checked={feita} disabled={closed || doneMut.isPending} onCheckedChange={v => alternar(tarefa, v === true)}
                  aria-label={feita ? t("crm.tarefas.reabrir") : t("crm.tarefas.concluir")} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className={`whitespace-pre-wrap break-words ${feita ? "line-through text-muted-foreground" : ""}`}>{tarefa.text}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {tarefa.dueAt && (
                      <span className={atrasada ? "text-destructive font-medium" : ""}>
                        {t("crm.tarefas.prazo")}: {formatDateTimeBR(tarefa.dueAt)}{atrasada ? ` · ${t("crm.tarefas.atrasada")}` : ""} ·{" "}
                      </span>
                    )}
                    {feita
                      ? `${t("crm.tarefas.concluida_por")} ${tarefa.doneByName ?? t("crm.ator.desconhecido")} · ${formatDateTimeBR(tarefa.doneAt)}`
                      : `${t("crm.tarefas.criada_por")} ${tarefa.createdByName ?? t("crm.ator.desconhecido")}`}
                  </p>
                </div>
                {!closed && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("common.editar")}
                      onClick={() => setEditando({ id: tarefa.id, texto: tarefa.text, prazo: paraCampoData(tarefa.dueAt) })}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" aria-label={t("common.excluir")}
                      onClick={() => setApagando(tarefa)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={apagando !== null} onOpenChange={open => { if (!open) setApagando(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("crm.tarefas.excluir_titulo")}</AlertDialogTitle>
            <AlertDialogDescription>{t("crm.tarefas.excluir_texto")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={apagar} disabled={deleteMut.isPending}>{t("common.excluir")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
