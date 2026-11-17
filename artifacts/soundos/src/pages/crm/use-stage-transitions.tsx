import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetCommercialOpportunityQueryKey,
  getListCommercialOpportunitiesQueryKey,
  useListCommercialOpportunities,
  useTransitionCommercialOpportunity,
  type ListCommercialOpportunitiesParams,
  type OpportunityStage,
} from "@workspace/api-client-react";
import { useLang } from "@/contexts/language";
import { TransitionDialog } from "./components/transition-dialog";

/** Mudanças de etapa compartilhadas pelo quadro (arrastar) e pelo cartão aberto (encerrar). */
export function useStageTransitions(filters: ListCommercialOpportunitiesParams): {
  requestTransition: (id: number, toStage: OpportunityStage, current?: { stage: OpportunityStage; version: number }) => void;
  dialog: ReactNode;
} {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: opportunities } = useListCommercialOpportunities(filters);
  const transitionMut = useTransitionCommercialOpportunity();
  const [prompt, setPrompt] = useState<{ id: number; toStage: OpportunityStage; version: number } | null>(null);

  const refresh = (id: number) => {
    queryClient.invalidateQueries({ queryKey: getListCommercialOpportunitiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityQueryKey(id) });
  };

  const requestTransition = (id: number, toStage: OpportunityStage, current?: { stage: OpportunityStage; version: number }) => {
    const known = current ?? opportunities?.find(o => o.id === id);
    if (!known || known.stage === toStage) return;

    if (toStage === "CLOSED" || toStage === "NURTURE" || toStage === "CONFIRMED") {
      setPrompt({ id, toStage, version: known.version });
      return;
    }

    transitionMut.mutate({ id, data: { toStage, expectedVersion: known.version } }, {
      onSuccess: () => { toast.success(t("crm.msg.moved" as any)); refresh(id); },
      onError: () => { toast.error(t("crm.msg.move_error" as any)); refresh(id); },
    });
  };

  const confirm = (result: { reason: string; confirmation?: any }) => {
    if (!prompt) return;
    const { id, toStage, version } = prompt;
    transitionMut.mutate({ id, data: { toStage, reason: result.reason, confirmation: result.confirmation, expectedVersion: version } }, {
      onSuccess: () => { toast.success(t("crm.msg.updated" as any)); refresh(id); setPrompt(null); },
      // O diálogo continua aberto para a pessoa ler a recusa do servidor.
      onError: () => { toast.error(t("crm.msg.update_error" as any)); refresh(id); },
    });
  };

  const dialog = (
    <TransitionDialog
      open={!!prompt}
      opportunityId={prompt?.id}
      toStage={prompt?.toStage}
      actionType={prompt?.toStage === "CLOSED" ? "close" : "transition"}
      onCancel={() => setPrompt(null)}
      onConfirm={confirm}
      isPending={transitionMut.isPending}
      error={transitionMut.isError ? "Verifique as informações fornecidas e tente novamente." : undefined}
    />
  );

  return { requestTransition, dialog };
}
