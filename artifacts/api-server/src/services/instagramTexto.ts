// O Instagram mostra texto puro: markdown aparece com os símbolos soltos.
// A Sofia escreve para o chat do SoundOS (que renderiza markdown); aqui
// convertemos para texto simples e dividimos em mensagens de tamanho seguro.

export const LIMITE_MENSAGEM_INSTAGRAM = 900;

export function markdownParaTextoSimples(texto: string): string {
  return texto
    .replace(/\r\n/g, "\n")
    // Blocos de código e código em linha: fica só o conteúdo.
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    // Títulos.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    // Marcadores de lista com asterisco viram bolinha antes de tratar o negrito.
    .replace(/^(\s*)[*+]\s+/gm, "$1• ")
    // Link [texto](url) → "texto: url" (se o texto já for a própria URL, só a URL).
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, rotulo: string, url: string) =>
      rotulo.trim() === url ? url : `${rotulo}: ${url}`)
    // Negrito e itálico.
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cortarEm(texto: string, limite: number): [string, string] {
  if (texto.length <= limite) return [texto, ""];
  const janela = texto.slice(0, limite);
  const ponto = janela.lastIndexOf(". ");
  // Posição onde a primeira parte termina (exclusive).
  const fins = [janela.lastIndexOf("\n\n"), janela.lastIndexOf("\n"), ponto === -1 ? -1 : ponto + 1, janela.lastIndexOf(" ")];
  const corte = fins.find(posicao => posicao >= limite * 0.4) ?? limite;
  return [texto.slice(0, corte).trimEnd(), texto.slice(corte).trimStart()];
}

/**
 * Divide um texto já formatado em partes de até `limite` caracteres, preferindo quebrar em
 * parágrafos e nunca no meio de uma palavra (nem de um link) quando há onde quebrar.
 */
export function dividirEmPartes(textoFormatado: string, limite: number): string[] {
  const partes: string[] = [];
  let resto = textoFormatado;
  while (resto.length > 0) {
    const [parte, sobra] = cortarEm(resto, limite);
    if (parte.length > 0) partes.push(parte);
    resto = sobra;
  }
  return partes;
}

/** Divide em partes de até `limite` caracteres, preferindo quebrar em parágrafos. */
export function dividirParaInstagram(texto: string, limite = LIMITE_MENSAGEM_INSTAGRAM): string[] {
  return dividirEmPartes(markdownParaTextoSimples(texto), limite);
}
