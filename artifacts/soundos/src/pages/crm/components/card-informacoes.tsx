import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAddCommercialOpportunityNote, useSaveCommercialOpportunityInformacoes, type CommercialNote } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { errorText } from "../atendimento-errors";
import { useCardRefresh } from "../use-card-refresh";

const LIMITE_INFORMACOES = 10_000;
const LIMITE_OBSERVACAO = 5_000;

interface Props {
  opportunityId: number;
  /** Oportunidade encerrada: só leitura. */
  closed: boolean;
  informacoes: string | null;
  notas: CommercialNote[];
}

export function CardInformacoes({ opportunityId, closed, informacoes, notas }: Props) {
  const { t } = useLang();
  const refresh = useCardRefresh(opportunityId);
  const saveMut = useSaveCommercialOpportunityInformacoes();
  const noteMut = useAddCommercialOpportunityNote();

  const [value, setValue] = useState(informacoes ?? "");
  const baseRef = useRef(informacoes ?? "");
  // Uma atualização vinda do servidor só substitui o texto quando a pessoa não está no meio de uma edição.
  useEffect(() => {
    const next = informacoes ?? "";
    setValue(current => (current === baseRef.current ? next : current));
    baseRef.current = next;
  }, [informacoes]);
  const dirty = value.trim() !== (informacoes ?? "").trim();

  const [novaNota, setNovaNota] = useState("");

  const salvar = () => {
    saveMut.mutate({ id: opportunityId, data: { informacoes: value } }, {
      onSuccess: () => { toast.success(t("crm.atend.salvo")); refresh(); },
      onError: err => toast.error(errorText(err, t)),
    });
  };

  const adicionarNota = () => {
    const texto = novaNota.trim();
    if (!texto) return;
    noteMut.mutate({ id: opportunityId, data: { texto } }, {
      onSuccess: () => { setNovaNota(""); toast.success(t("crm.nota.adicionada")); refresh(); },
      onError: err => toast.error(errorText(err, t)),
    });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2" data-testid="crm-informacoes">
        <h3 className="text-sm font-bold tracking-widest text-muted-foreground uppercase">{t("crm.informacoes.titulo")}</h3>
        <Textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={t("crm.informacoes.placeholder")}
          rows={4}
          maxLength={LIMITE_INFORMACOES}
          disabled={closed}
          aria-label={t("crm.informacoes.titulo")}
        />
        {!closed && (
          <Button size="sm" onClick={salvar} disabled={!dirty || saveMut.isPending} data-testid="crm-informacoes-salvar">
            {saveMut.isPending ? t("common.salvando") : t("crm.informacoes.salvar")}
          </Button>
        )}
      </section>

      <section className="space-y-2" data-testid="crm-notas">
        <h3 className="text-sm font-bold tracking-widest text-muted-foreground uppercase">{t("crm.notas.titulo")}</h3>
        {!closed && (
          <div className="space-y-2">
            <Textarea
              value={novaNota}
              onChange={e => setNovaNota(e.target.value)}
              placeholder={t("crm.notas.placeholder")}
              rows={2}
              maxLength={LIMITE_OBSERVACAO}
              aria-label={t("crm.notas.titulo")}
            />
            <Button size="sm" variant="outline" onClick={adicionarNota} disabled={!novaNota.trim() || noteMut.isPending} data-testid="crm-nota-adicionar">
              {t("crm.notas.adicionar")}
            </Button>
          </div>
        )}
        {notas.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">{t("crm.notas.vazio")}</p>
        ) : (
          <ul className="space-y-2">
            {notas.map(nota => (
              <li key={nota.id} className="rounded-md border bg-muted/30 p-3 text-sm">
                <p className="whitespace-pre-wrap break-words">{nota.text}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {nota.authorName ?? t("crm.ator.desconhecido")} · {formatDateTimeBR(nota.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
