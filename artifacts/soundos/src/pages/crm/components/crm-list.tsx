import { useListCommercialOpportunities, type CommercialOpportunity, type ListCommercialOpportunitiesParams } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { isSofiaOwned } from "@/lib/formalizacao";
import { prazoDoCartao } from "../prazo-primeiro-contato";

interface Props {
  filters: ListCommercialOpportunitiesParams;
  onOpen: (id: number) => void;
}

function origemTexto(opp: CommercialOpportunity): string {
  const partes = [opp.origem?.grupoLabel ?? opp.origem?.grupo, opp.origem?.curso?.name, opp.origem?.evento?.name, opp.offerLabel]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return [...new Set(partes)].join(" · ");
}

/** Próxima ação com data. Usa a mesma regra de prazo do quadro, então atrasado (vermelho) significa o mesmo nas duas visões. */
function ProximaAcao({ opp }: { opp: CommercialOpportunity }) {
  const { t } = useLang();
  if (!opp.nextTaskType || opp.nextTaskType === "NONE") return <TableCell className="max-w-[260px] truncate" data-testid={`crm-lista-acao-${opp.id}`}>—</TableCell>;

  const prazo = prazoDoCartao(opp);
  const atrasado = prazo?.atrasado ?? false;
  const rotuloDoPrazo = atrasado ? `${t("crm.overdue")} ` : prazo?.emPrazoDePrimeiroContato ? `${t("crm.prazo")} ` : "";
  const texto = [
    t(`crm.task.${opp.nextTaskType}` as any),
    opp.nextTaskText,
    prazo ? `${rotuloDoPrazo}${formatDateTimeBR(prazo.limite)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <TableCell
      className={`max-w-[260px] truncate ${atrasado ? "font-semibold text-destructive" : ""}`}
      title={texto}
      data-testid={`crm-lista-acao-${opp.id}`}
      data-atrasado={atrasado ? "true" : undefined}
    >
      {texto}
    </TableCell>
  );
}

/** Os mesmos cartões do quadro, em linhas. Clicar abre o mesmo cartão em janela. */
export function CrmList({ filters, onOpen }: Props) {
  const { t } = useLang();
  const { data, isLoading, isError } = useListCommercialOpportunities(filters);

  if (isLoading) {
    return <div className="space-y-2 p-2">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  }
  if (isError) return <div className="p-8 text-center text-destructive">{t("crm.lista.erro")}</div>;
  if (!data || data.length === 0) return <div className="p-8 text-center text-sm text-muted-foreground" data-testid="crm-lista-vazia">{t("crm.lista.vazia")}</div>;

  return (
    <div className="h-full overflow-auto rounded-lg border bg-card" data-testid="crm-lista">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("crm.lista.pessoa")}</TableHead>
            <TableHead>{t("crm.form.nucleus")}</TableHead>
            <TableHead>{t("crm.lista.origem")}</TableHead>
            <TableHead>{t("crm.lista.etapa")}</TableHead>
            <TableHead>{t("crm.form.owner")}</TableHead>
            <TableHead>{t("crm.form.next_action")}</TableHead>
            <TableHead>{t("crm.lista.ultima_interacao")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map(opp => (
            <TableRow
              key={opp.id}
              tabIndex={0}
              role="button"
              className="cursor-pointer"
              onClick={() => onOpen(opp.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(opp.id); } }}
              data-testid={`crm-lista-linha-${opp.id}`}
            >
              <TableCell className="font-medium">{opp.person?.name || `${t("crm.form.person")} #${opp.pessoaId}`}</TableCell>
              <TableCell>{t(`crm.nucleus.${opp.nucleus}` as any)}</TableCell>
              <TableCell className="max-w-[260px] truncate" title={origemTexto(opp)}>{origemTexto(opp)}</TableCell>
              <TableCell>{t(`crm.stage.${opp.stage}` as any)}</TableCell>
              <TableCell>{opp.owner?.name ?? (isSofiaOwned(opp) ? t("crm.owner.sofia") : t("crm.form.owner_none"))}</TableCell>
              <ProximaAcao opp={opp} />
              <TableCell className="whitespace-nowrap">{opp.lastInteractionAt ? formatDateTimeBR(opp.lastInteractionAt) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
