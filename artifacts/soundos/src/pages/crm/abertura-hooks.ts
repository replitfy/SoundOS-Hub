import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCommercialOpportunityOpeningTemplateQueryKey,
  getGetPessoaOpeningTemplateQueryKey,
  useGetCommercialOpportunityOpeningTemplate,
  useGetPessoaOpeningTemplate,
  useLinkCommercialOpportunityConversation,
  useLinkPessoaConversation,
  useSendCommercialOpportunityOpeningTemplate,
  useSendPessoaOpeningTemplate,
  type OpeningTemplatePreview,
} from "@workspace/api-client-react";

/** O que o diálogo do modelo de abertura precisa, venha o envio de um cartão ou da ficha da pessoa. */
export interface AberturaController {
  preview: OpeningTemplatePreview | undefined;
  isLoading: boolean;
  isError: boolean;
  /** Envia (uma tentativa). Rejeita com o erro da API. */
  send: () => Promise<unknown>;
  sending: boolean;
  /** Confirma o vínculo da conversa proposta pelo servidor. */
  link: (conversationId: number) => Promise<unknown>;
  linking: boolean;
}

// A prévia é sempre buscada de novo ao abrir: o estado do modelo na Meta e a autorização mudam fora daqui.
const FRESH = { staleTime: 0, gcTime: 0, refetchOnWindowFocus: false } as const;

export function useCardAbertura(opportunityId: number, open: boolean): AberturaController {
  const queryClient = useQueryClient();
  const preview = useGetCommercialOpportunityOpeningTemplate(opportunityId, {
    query: { queryKey: getGetCommercialOpportunityOpeningTemplateQueryKey(opportunityId), enabled: open, ...FRESH },
  });
  const sendMut = useSendCommercialOpportunityOpeningTemplate();
  const linkMut = useLinkCommercialOpportunityConversation();
  const refreshPreview = () => queryClient.invalidateQueries({ queryKey: getGetCommercialOpportunityOpeningTemplateQueryKey(opportunityId) });
  return {
    preview: preview.data,
    isLoading: preview.isLoading,
    isError: preview.isError,
    send: () => sendMut.mutateAsync({ id: opportunityId }).finally(refreshPreview),
    sending: sendMut.isPending,
    link: () => linkMut.mutateAsync({ id: opportunityId }).finally(refreshPreview),
    linking: linkMut.isPending,
  };
}

export function usePessoaAbertura(pessoaId: number, open: boolean): AberturaController {
  const queryClient = useQueryClient();
  const preview = useGetPessoaOpeningTemplate(pessoaId, {
    query: { queryKey: getGetPessoaOpeningTemplateQueryKey(pessoaId), enabled: open, ...FRESH },
  });
  const sendMut = useSendPessoaOpeningTemplate();
  const linkMut = useLinkPessoaConversation();
  const refreshPreview = () => queryClient.invalidateQueries({ queryKey: getGetPessoaOpeningTemplateQueryKey(pessoaId) });
  return {
    preview: preview.data,
    isLoading: preview.isLoading,
    isError: preview.isError,
    send: () => sendMut.mutateAsync({ id: pessoaId }).finally(refreshPreview),
    sending: sendMut.isPending,
    link: conversationId => linkMut.mutateAsync({ id: pessoaId, data: { conversationId } }).finally(refreshPreview),
    linking: linkMut.isPending,
  };
}
