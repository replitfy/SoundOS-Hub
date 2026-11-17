import {
  useGetCommercialOpportunityContact,
  useRegisterCommercialOpportunityContact,
} from "@workspace/api-client-react";
import { useCardRefresh } from "../use-card-refresh";
import { ContatoAutorizacao } from "./contato-autorizacao";

/** Autorização de contato da pessoa, vista e registrada a partir do cartão. */
export function CardContato({ opportunityId, closed }: { opportunityId: number; closed: boolean }) {
  const refresh = useCardRefresh(opportunityId);
  const { data } = useGetCommercialOpportunityContact(opportunityId);
  const registrar = useRegisterCommercialOpportunityContact();
  return (
    <ContatoAutorizacao
      estado={data}
      readOnly={closed}
      pending={registrar.isPending}
      onRegister={async input => {
        await registrar.mutateAsync({ id: opportunityId, data: input });
        refresh();
      }}
    />
  );
}
