import { useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Pencil, Trash2, X, Check, ExternalLink } from "lucide-react";
import {
  useCreateCommercialOpportunityAppointment,
  useDeleteCommercialOpportunityAppointment,
  useUpdateCommercialOpportunityAppointment,
  type CommercialAppointment,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { errorText } from "../atendimento-errors";
import { useCardRefresh } from "../use-card-refresh";

const LIMITE_TITULO = 200;

interface Campos { titulo: string; dataHora: string; link: string }
const VAZIO: Campos = { titulo: "", dataHora: "", link: "" };

const paraCampoData = (iso: string) => format(new Date(iso), "yyyy-MM-dd'T'HH:mm");

interface Props {
  opportunityId: number;
  closed: boolean;
  compromissos: CommercialAppointment[];
}

function FormularioDeCompromisso({ valor, onChange }: { valor: Campos; onChange: (v: Campos) => void }) {
  const { t } = useLang();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <Input value={valor.titulo} onChange={e => onChange({ ...valor, titulo: e.target.value })} maxLength={LIMITE_TITULO}
        placeholder={t("crm.compromissos.titulo_placeholder")} aria-label={t("crm.compromissos.titulo_placeholder")} />
      <Input type="datetime-local" value={valor.dataHora} onChange={e => onChange({ ...valor, dataHora: e.target.value })} aria-label={t("crm.compromissos.data_hora")} />
      <Input className="sm:col-span-2" value={valor.link} onChange={e => onChange({ ...valor, link: e.target.value })} inputMode="url"
        placeholder={t("crm.compromissos.link_placeholder")} aria-label={t("crm.compromissos.link_placeholder")} />
    </div>
  );
}

export function CardCompromissos({ opportunityId, closed, compromissos }: Props) {
  const { t } = useLang();
  const refresh = useCardRefresh(opportunityId);
  const createMut = useCreateCommercialOpportunityAppointment();
  const updateMut = useUpdateCommercialOpportunityAppointment();
  const deleteMut = useDeleteCommercialOpportunityAppointment();

  const [novo, setNovo] = useState<Campos>(VAZIO);
  const [editando, setEditando] = useState<{ id: number; campos: Campos } | null>(null);
  const [apagando, setApagando] = useState<CommercialAppointment | null>(null);

  const onError = (err: unknown) => toast.error(errorText(err, t));
  const corpo = (c: Campos) => ({ titulo: c.titulo.trim(), dataHora: new Date(c.dataHora).toISOString(), link: c.link.trim() || null });
  const completo = (c: Campos) => c.titulo.trim() !== "" && c.dataHora !== "";

  const criar = () => {
    if (!completo(novo)) return;
    createMut.mutate({ id: opportunityId, data: corpo(novo) }, { onSuccess: () => { setNovo(VAZIO); refresh(); }, onError });
  };
  const salvarEdicao = () => {
    if (!editando || !completo(editando.campos)) return;
    updateMut.mutate({ id: opportunityId, appointmentId: editando.id, data: corpo(editando.campos) }, {
      onSuccess: () => { setEditando(null); refresh(); }, onError,
    });
  };
  const apagar = () => {
    if (!apagando) return;
    deleteMut.mutate({ id: opportunityId, appointmentId: apagando.id }, {
      onSuccess: () => { setApagando(null); refresh(); },
      onError: err => { setApagando(null); onError(err); },
    });
  };

  return (
    <section className="space-y-2" data-testid="crm-compromissos">
      <h3 className="text-sm font-bold tracking-widest text-muted-foreground uppercase">{t("crm.compromissos.titulo")}</h3>
      {!closed && (
        <div className="space-y-2">
          <FormularioDeCompromisso valor={novo} onChange={setNovo} />
          <Button size="sm" variant="outline" onClick={criar} disabled={!completo(novo) || createMut.isPending} data-testid="crm-compromisso-adicionar">
            {t("crm.compromissos.adicionar")}
          </Button>
        </div>
      )}
      {compromissos.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{t("crm.compromissos.vazio")}</p>
      ) : (
        <ul className="space-y-2">
          {compromissos.map(c => editando?.id === c.id ? (
            <li key={c.id} className="space-y-2 rounded-md border p-2">
              <FormularioDeCompromisso valor={editando.campos} onChange={campos => setEditando({ id: c.id, campos })} />
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={salvarEdicao} disabled={updateMut.isPending} aria-label={t("common.salvar")}><Check className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditando(null)} aria-label={t("common.cancelar")}><X className="h-4 w-4" /></Button>
              </div>
            </li>
          ) : (
            <li key={c.id} className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm" data-testid={`crm-compromisso-${c.id}`}>
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">{c.title}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatDateTimeBR(c.startsAt)} · {t("crm.compromissos.criado_por")} {c.createdByName ?? t("crm.ator.desconhecido")}
                </p>
                {c.link && (
                  <a href={c.link} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline break-all">
                    <ExternalLink className="h-3 w-3 shrink-0" />{c.link}
                  </a>
                )}
              </div>
              {!closed && (
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("common.editar")}
                    onClick={() => setEditando({ id: c.id, campos: { titulo: c.title, dataHora: paraCampoData(c.startsAt), link: c.link ?? "" } })}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" aria-label={t("common.excluir")}
                    onClick={() => setApagando(c)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={apagando !== null} onOpenChange={open => { if (!open) setApagando(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("crm.compromissos.excluir_titulo")}</AlertDialogTitle>
            <AlertDialogDescription>{t("crm.compromissos.excluir_texto")}</AlertDialogDescription>
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
