import { OpportunityRuleError, type DbClient } from "./commercialOpportunities";
import { registrarContatoDoSistema } from "./contatoAutorizacao";
import { registrarAcao } from "./crmAtendimento";

// Consentimento do WhatsApp nos formulários públicos de interesse. A caixa vem desmarcada; só quem marca
// recebe o primeiro contato automático da Sofia. O texto é uma constante do servidor (a tela o recebe do
// servidor), e é ele que fica gravado com a autorização: o que a pessoa leu é o que foi registrado.

export const TEXTO_CONSENTIMENTO_WHATSAPP = "Aceito receber mensagens da Soundfulness pelo WhatsApp";

/** Só `true` de verdade conta: texto, número ou ausência da chave são "não marcou". */
export function lerConsentimentoWhatsapp(valor: unknown): boolean {
  return valor === true;
}

export function consentimentoParaOFormulario() {
  return { texto: TEXTO_CONSENTIMENTO_WHATSAPP };
}

/**
 * Dentro da transação do formulário e ANTES de abrir ou atualizar o cartão (a trava de contato vem antes das
 * travas de cartão): registra a autorização da pessoa, com origem Formulário, a data e o texto exato.
 * Identidade em conferência não registra nada, porque ainda não se sabe de quem é o consentimento.
 * Devolve o id do registro novo (nulo quando nada foi gravado). Nunca derruba o formulário por regra.
 */
export async function registrarConsentimentoDoFormulario(tx: DbClient, input: {
  pessoaId: number; consentiu: boolean; conferencia: boolean;
}): Promise<number | null> {
  if (!input.consentiu || input.conferencia) return null;
  try {
    const { registroId } = await registrarContatoDoSistema(tx, {
      pessoaId: input.pessoaId, kind: "AUTORIZOU", origem: "FORMULARIO",
      origemTexto: TEXTO_CONSENTIMENTO_WHATSAPP, actor: { kind: "SYSTEM" },
    });
    return registroId;
  } catch (erro) {
    // Regra de negócio (ficha unida etc.): o formulário segue sem autorização e o envio automático não sai.
    if (erro instanceof OpportunityRuleError) return null;
    throw erro;
  }
}

/** Mostra a autorização no histórico do cartão que esta mesma submissão acabou de abrir. */
export async function registrarConsentimentoNoCartaoNovo(tx: DbClient, opportunityId: number, registroId: number | null): Promise<void> {
  if (registroId === null) return;
  await registrarAcao(tx, opportunityId, { kind: "SYSTEM" }, "CONTACT_AUTHORIZED", {
    registroId, origem: "FORMULARIO", origemTexto: TEXTO_CONSENTIMENTO_WHATSAPP,
  });
}
