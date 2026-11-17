/**
 * A Sofia nunca informa preço de evento, ciclo ou curso. Todo texto vindo de
 * catálogo, página oficial ou base de conhecimento passa por aqui antes de
 * chegar a uma ferramenta ou a uma resposta, porque a guarda de números do
 * modo simples aceita qualquer valor que apareça na saída de uma ferramenta.
 */

const NUMERO = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

const VALOR_EM_REAIS = new RegExp(
  [
    String.raw`R\$\s?(?:${NUMERO})(?:\s?mil\b)?`,
    String.raw`\bBRL\s?(?:${NUMERO})`,
    String.raw`(?:${NUMERO})(?:\s?mil)?\s+reais\b`,
  ].join("|"),
  "gi",
);

export function ocultarValoresEmReais(texto: string): string {
  return texto.replace(VALOR_EM_REAIS, "[valor omitido]");
}

export function ocultarValoresOpcional(texto: string | null | undefined): string | null {
  return typeof texto === "string" ? ocultarValoresEmReais(texto) : null;
}
