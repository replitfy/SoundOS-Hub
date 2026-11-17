import type { CommercialOpportunity } from "@workspace/api-client-react";

/** Horas que a equipe tem, desde que o cartão nasce, para falar com quem demonstrou interesse. */
export const PRAZO_PRIMEIRO_CONTATO_HORAS = 34;

const HORA_EM_MS = 60 * 60 * 1000;

type CartaoComPrazo = Pick<CommercialOpportunity, "contactStatus" | "nextTaskAt" | "createdAt">;

export interface PrazoDoCartao {
  /** Data a partir da qual o cartão está atrasado. */
  limite: Date;
  atrasado: boolean;
  /** Contato ainda não iniciado e ainda sem atraso: o quadro mostra "Prazo" em vez de uma data solta. */
  emPrazoDePrimeiroContato: boolean;
}

function lerData(valor: string | Date | null | undefined): Date | null {
  if (valor === null || valor === undefined) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * Prazo da próxima ação do cartão. A data da próxima ação nasce igual à criação do cartão, então, enquanto
 * o contato não começou, vale a maior entre ela e a criação mais o prazo de primeiro contato. Depois que
 * o contato começa, vale só a data da próxima ação. Sem data da próxima ação, não há prazo.
 */
export function prazoDoCartao(cartao: CartaoComPrazo, agora: Date = new Date()): PrazoDoCartao | null {
  const proximaAcao = lerData(cartao.nextTaskAt);
  if (!proximaAcao) return null;

  const contatoNaoIniciado = cartao.contactStatus === "NOT_STARTED";
  const criacao = lerData(cartao.createdAt);
  const fimDoPrimeiroContato = contatoNaoIniciado && criacao
    ? new Date(criacao.getTime() + PRAZO_PRIMEIRO_CONTATO_HORAS * HORA_EM_MS)
    : null;
  const limite = fimDoPrimeiroContato && fimDoPrimeiroContato > proximaAcao ? fimDoPrimeiroContato : proximaAcao;
  const atrasado = limite < agora;

  return { limite, atrasado, emPrazoDePrimeiroContato: contatoNaoIniciado && !atrasado };
}
