import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import {
  useListCommercialOpportunityOwners,
  useUpdateCommercialOpportunity,
  type CommercialOpportunity,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLang } from "@/contexts/language";
import { useAccess } from "@/contexts/access";
import { isSofiaOwned } from "@/lib/formalizacao";
import { errorText } from "../atendimento-errors";
import { useClaimOpportunity } from "../use-claim-opportunity";
import { useCardRefresh } from "../use-card-refresh";

interface Props {
  opp: CommercialOpportunity;
  /** Oportunidade encerrada: nada pode ser alterado (só reativar, no menu do cartão). */
  closed: boolean;
}

/** Responsável do cartão e acesso à ficha da pessoa. */
export function CardControles({ opp, closed }: Props) {
  const { t } = useLang();
  const { canPath } = useAccess();
  const refresh = useCardRefresh(opp.id);
  const { data: owners } = useListCommercialOpportunityOwners();
  const updateMut = useUpdateCommercialOpportunity();
  const { claim, isClaiming } = useClaimOpportunity();

  const [owner, setOwner] = useState("0");

  useEffect(() => {
    setOwner(opp.ownerUserId ? opp.ownerUserId.toString() : "0");
  }, [opp]);

  const salvar = () => {
    updateMut.mutate({
      id: opp.id,
      data: {
        ownerUserId: owner !== "0" ? parseInt(owner, 10) : null,
        expectedVersion: opp.version,
      },
    }, {
      onSuccess: () => { toast.success(t("crm.atend.salvo")); refresh(); },
      onError: err => { toast.error(errorText(err, t)); refresh(); },
    });
  };

  return (
    <section className="space-y-4" data-testid="crm-controles">
      <h3 className="text-sm font-bold tracking-widest text-muted-foreground uppercase">{t("crm.form.controls")}</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <label className="text-xs font-medium">{t("crm.form.owner")}</label>
          <Select value={owner} onValueChange={setOwner} disabled={closed}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{isSofiaOwned(opp) ? t("crm.owner.sofia") : t("crm.form.owner_none")}</SelectItem>
              {owners?.map(u => <SelectItem key={u.id} value={u.id.toString()}>{u.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {opp.ownerUserId == null && !closed && (
            <Button type="button" size="sm" className="w-full h-8 text-xs" onClick={() => claim(opp.id)} disabled={isClaiming} data-testid="crm-drawer-claim">
              {t("crm.action.claim")}
            </Button>
          )}
          {owner === "0" && !isSofiaOwned(opp) && (
            <p className="text-[11px] text-amber-700" data-testid="crm-owner-required-hint">{t("crm.form.owner_required_hint")}</p>
          )}
        </div>
        {canPath("/pessoas") && (
          <div className="flex items-center">
            <Link
              href={`/pessoas/${opp.pessoaId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              data-testid="crm-card-abrir-ficha"
            >
              <ExternalLink className="h-4 w-4" />
              {t("crm.chat.fichas.abrir")}
            </Link>
          </div>
        )}
      </div>

      {!closed && (
        <Button className="w-full" onClick={salvar} disabled={updateMut.isPending}>
          {updateMut.isPending ? t("common.salvando") : t("common.salvar")}
        </Button>
      )}
    </section>
  );
}
