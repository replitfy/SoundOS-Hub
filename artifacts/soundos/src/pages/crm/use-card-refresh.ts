import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCommercialOpportunityAtendimentoQueryKey,
  getGetCommercialOpportunityChatQueryKey,
  getGetCommercialOpportunityContactQueryKey,
  getGetCommercialOpportunityOpeningTemplateQueryKey,
  getGetCommercialOpportunityQueryKey,
  getListCommercialOpportunitiesQueryKey,
} from "@workspace/api-client-react";

/** Recarrega tudo que o cartão mostra (detalhe e histórico, atendimento, contato, conversa e a lista). */
export function useCardRefresh(opportunityId: number) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityQueryKey(opportunityId) });
    void queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityAtendimentoQueryKey(opportunityId) });
    void queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityContactQueryKey(opportunityId) });
    void queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityChatQueryKey(opportunityId) });
    void queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityOpeningTemplateQueryKey(opportunityId) });
    void queryClient.invalidateQueries({ queryKey: getListCommercialOpportunitiesQueryKey() });
  }, [queryClient, opportunityId]);
}
