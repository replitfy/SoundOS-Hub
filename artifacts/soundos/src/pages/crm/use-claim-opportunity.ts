import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  getGetCommercialOpportunityQueryKey,
  getListCommercialOpportunitiesQueryKey,
  useClaimCommercialOpportunity,
} from "@workspace/api-client-react";
import { useLang } from "@/contexts/language";

/** Código que a API devolve quando outra pessoa assumiu o cartão antes. */
export const ALREADY_CLAIMED_CODE = "OPPORTUNITY_ALREADY_CLAIMED";

export function isAlreadyClaimedError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const data = err.data as { code?: unknown } | null;
  return data?.code === ALREADY_CLAIMED_CODE;
}

/**
 * Ação "Assumir" compartilhada pelo cartão e pelo painel lateral.
 * Em qualquer desfecho a lista e o detalhe são recarregados, de modo que se
 * outra pessoa assumiu primeiro o cartão já aparece com o novo responsável.
 */
export function useClaimOpportunity() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const mutation = useClaimCommercialOpportunity();

  const refresh = (id: number) => {
    queryClient.invalidateQueries({ queryKey: getListCommercialOpportunitiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityQueryKey(id) });
  };

  const claim = (id: number) => {
    if (mutation.isPending) return;
    mutation.mutate({ id }, {
      onSuccess: () => {
        toast.success(t("crm.msg.claimed" as any));
        refresh(id);
      },
      onError: (err) => {
        toast.error(t(isAlreadyClaimedError(err) ? "crm.msg.claim_taken" as any : "crm.msg.claim_error" as any));
        refresh(id);
      },
    });
  };

  return {
    claim,
    isClaiming: mutation.isPending,
    claimingId: mutation.isPending ? mutation.variables?.id ?? null : null,
  };
}
