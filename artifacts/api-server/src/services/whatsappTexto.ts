import { dividirEmPartes } from "./instagramTexto";

// O WhatsApp não renderiza markdown: negrito é *um asterisco*, itálico é _sublinhado_, e títulos,
// tabelas e links [texto](url) aparecem com os símbolos soltos. A Sofia escreve para o chat do
// SoundOS; aqui convertemos para o jeito do WhatsApp e dividimos em mensagens de tamanho seguro.

/** O limite do WhatsApp é 4096; partes menores leem melhor e deixam margem para o negrito. */
export const LIMITE_MENSAGEM_WHATSAPP = 1500;

const ABRE_NEGRITO = "\u0001";
const FECHA_NEGRITO = "\u0002";

export function markdownParaWhatsapp(texto: string): string {
  return texto
    .replace(/\r\n/g, "\n")
    .replace(/[\u0001\u0002]/g, "")
    // Blocos de código e código em linha: fica só o conteúdo.
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    // Títulos viram uma linha em negrito.
    .replace(/^[ ]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_m, titulo: string) => `${ABRE_NEGRITO}${titulo.replace(/\*\*|__/g, "")}${FECHA_NEGRITO}`)
    // Marcadores de lista com asterisco ou mais viram hífen (o asterisco inicial abriria um negrito).
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    // Link [texto](url) → "texto: url" (se o texto já for a própria URL, só a URL).
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, rotulo: string, url: string) =>
      rotulo.trim() === url ? url : `${rotulo}: ${url}`)
    // Negrito do markdown vira marcador provisório; depois o itálico de um asterisco vira _itálico_.
    .replace(/\*\*([^*\n]+)\*\*/g, `${ABRE_NEGRITO}$1${FECHA_NEGRITO}`)
    .replace(/__([^_\n]+)__/g, `${ABRE_NEGRITO}$1${FECHA_NEGRITO}`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1_$2_")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(new RegExp(ABRE_NEGRITO, "g"), "*")
    .replace(new RegExp(FECHA_NEGRITO, "g"), "*")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Divide em partes de até `limite` caracteres, preferindo quebrar em parágrafos. */
export function dividirParaWhatsapp(texto: string, limite = LIMITE_MENSAGEM_WHATSAPP): string[] {
  return dividirEmPartes(markdownParaWhatsapp(texto), limite);
}
