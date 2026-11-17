// Constantes do cartão "Conversa no WhatsApp" que outros módulos precisam sem carregar o banco.

export const CONVERSA_ROTULO = "Conversa no WhatsApp";

/**
 * Identidade de oferta do cartão da conversa: a mesma que `buildOfferIdentity` calcula para o núcleo EDUCATION
 * e este rótulo. Escrita por extenso para o filtro do formulário não depender do módulo de oportunidades;
 * `cartaoDaConversa.ts` confere a igualdade ao carregar.
 */
export const CONVERSA_IDENTIDADE = "label:conversa no whatsapp";
