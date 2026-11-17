import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getListConversationsAwaitingStaffQueryKey, getListConversationsQueryKey, useListConversationsAwaitingStaff,
} from "@workspace/api-client-react";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";

/** Frequência com que o menu confere se algum cliente do WhatsApp/Instagram passou para a equipe. */
export const INTERVALO_DO_AVISO_MS = 15_000;
const DURACAO_DO_TOAST_MS = 20_000;
const ID_DO_TOAST = "conversas-aguardando-equipe";

type Traduzir = (chave: "sofia.aviso.um" | "sofia.aviso.varias" | "sofia.aviso.nao_entregue.um" | "sofia.aviso.nao_entregue.varias") => string;

export function textoAguardandoEquipe(t: Traduzir, total: number): string {
  return total === 1 ? t("sofia.aviso.um") : t("sofia.aviso.varias").replace("{total}", String(total));
}

/** Texto do contador de conversas cuja última resposta da Sofia não foi entregue (outro problema, outra ação). */
export function textoRespostasNaoEntregues(t: Traduzir, total: number): string {
  return total === 1 ? t("sofia.aviso.nao_entregue.um") : t("sofia.aviso.nao_entregue.varias").replace("{total}", String(total));
}

export interface ContagensDoAviso {
  /** Conversas de canais externos aguardando a equipe. */
  aguardando: number;
  /** Conversas de canais externos cuja última resposta da Sofia não foi entregue. */
  naoEntregues: number;
}

const SEM_AVISO: ContagensDoAviso = { aguardando: 0, naoEntregues: 0 };

/**
 * Quantas conversas de canais externos aguardam a equipe e quantas têm a última resposta não entregue
 * (a segunda contagem não gera aviso na tela, só o contador do menu). Confere periodicamente (mesmo com a aba em
 * segundo plano) e, quando chega uma conversa nova, mostra um aviso na tela com atalho para Conversas.
 * Só vale para quem tem a área Conversas: para os demais não consulta nada e a contagem é sempre 0.
 * A primeira leitura só preenche o contador; o aviso na tela é só para o que chega depois.
 */
export function useConversasAguardandoEquipe(abrirConversas: () => void): ContagensDoAviso {
  const access = useAccess();
  const { t } = useLang();
  const queryClient = useQueryClient();
  const habilitado = access.status === "ready" && access.can("conversas");

  const { data } = useListConversationsAwaitingStaff({
    query: {
      queryKey: getListConversationsAwaitingStaffQueryKey(),
      enabled: habilitado,
      refetchInterval: INTERVALO_DO_AVISO_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: "always",
      staleTime: 0,
    },
  });

  const conhecidas = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!habilitado) { conhecidas.current = null; return; }
    if (!data) return;
    const anteriores = conhecidas.current;
    const agora = new Set(data.conversations.map(c => c.id));
    conhecidas.current = agora;
    if (anteriores === null) return;

    const novas = data.conversations.filter(c => !anteriores.has(c.id));
    const sairam = [...anteriores].some(id => !agora.has(id));
    if (novas.length === 0 && !sairam) return;

    // A lista de Conversas, se estiver aberta, acompanha o que mudou sem esperar a próxima conferência dela.
    void queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
    if (novas.length === 0) return;
    toast.warning(
      novas.length === 1 ? t("sofia.aviso.toast_titulo") : t("sofia.aviso.toast_titulo_varios").replace("{total}", String(novas.length)),
      {
        id: ID_DO_TOAST,
        description: novas.length === 1 ? novas[0]!.title : undefined,
        duration: DURACAO_DO_TOAST_MS,
        action: { label: t("sofia.aviso.toast_abrir"), onClick: abrirConversas },
      },
    );
  }, [data, habilitado, queryClient, t, abrirConversas]);

  if (!habilitado) return SEM_AVISO;
  return { aguardando: data?.total ?? 0, naoEntregues: data?.respostasNaoEntregues ?? 0 };
}
