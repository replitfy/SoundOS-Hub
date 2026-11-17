/**
 * Guardas aplicadas ao texto final do modo simples. Nunca substituem a
 * resposta inteira: removem só a URL não permitida e trocam só o valor ou a
 * data que não veio de uma tool deste turno.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_~>]+$/;

export const VALOR_NAO_CONFIRMADO = "esse valor eu confirmo com o time interno";
export const DATA_NAO_CONFIRMADA = "essa data eu confirmo com o time interno";

function limparUrl(raw: string): string {
  let url = raw;
  while (TRAILING_PUNCTUATION.test(url)) url = url.replace(TRAILING_PUNCTUATION, "");
  return url;
}

export function normalizarUrl(raw: string): string | null {
  try {
    const url = new URL(limparUrl(raw));
    const caminho = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${caminho}${url.search}`;
  } catch {
    return null;
  }
}

function percorrer(valor: unknown, visitar: (valor: string | number) => void): void {
  if (typeof valor === "string" || typeof valor === "number") { visitar(valor); return; }
  if (Array.isArray(valor)) { for (const item of valor) percorrer(item, visitar); return; }
  if (valor && typeof valor === "object") for (const item of Object.values(valor)) percorrer(item, visitar);
}

function parseSaida(saida: string): unknown {
  try { return JSON.parse(saida); } catch { return saida; }
}

/** URLs presentes nos resultados das tools do turno — a única whitelist. */
export function urlsPermitidas(saidasDasTools: string[]): Set<string> {
  const permitidas = new Set<string>();
  for (const saida of saidasDasTools) {
    percorrer(parseSaida(saida), valor => {
      if (typeof valor !== "string") return;
      for (const match of valor.match(URL_PATTERN) ?? []) {
        const normalizada = normalizarUrl(match);
        if (normalizada) permitidas.add(normalizada);
      }
    });
  }
  return permitidas;
}

const LINHA_SO_ROTULO = /^[\s\-–—•*_>📹🔗🛍️👉➡️:]*([\p{L}\s]{0,30}:)?[\s\-–—•*_>📹🔗🛍️👉➡️:]*$/u;

export function sanitizeUrls(texto: string, permitidas: Set<string>): { texto: string; removidas: number } {
  let removidas = 0;
  const linhas = texto.split("\n").map(linha => {
    let mudou = false;
    // Link em markdown inválido vira só o rótulo.
    let nova = linha.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (inteiro, rotulo: string, url: string) => {
      const normalizada = normalizarUrl(url);
      if (normalizada && permitidas.has(normalizada)) return inteiro;
      removidas++; mudou = true;
      return rotulo;
    });
    nova = nova.replace(URL_PATTERN, raw => {
      const url = limparUrl(raw);
      const normalizada = normalizarUrl(url);
      if (normalizada && permitidas.has(normalizada)) return raw;
      removidas++; mudou = true;
      return raw.slice(url.length);
    });
    if (!mudou) return linha;
    nova = nova.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;!?])/g, "$1").trimEnd();
    return LINHA_SO_ROTULO.test(nova) ? null : nova;
  });
  const resultado = linhas.filter((linha): linha is string => linha !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { texto: resultado, removidas };
}

const VALOR_PATTERN = /R\$\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|R\$\s?\d+(?:[.,]\d{1,2})?/g;
const DATA_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

function parseValor(texto: string): number | null {
  const limpo = texto.replace(/R\$\s?/, "");
  const normalizado = /,\d{1,2}$/.test(limpo)
    ? limpo.replace(/\./g, "").replace(",", ".")
    : /\.\d{3}(\.|$)/.test(limpo) ? limpo.replace(/\./g, "") : limpo;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? Math.round(numero * 100) / 100 : null;
}

function isoDeDataBr(dia: string, mes: string, ano: string): string {
  return `${ano}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
}

/** Valores e datas que as tools do turno trouxeram. */
export function fatosPermitidos(saidasDasTools: string[], hojeIso?: string): { valores: Set<number>; datas: Set<string> } {
  const valores = new Set<number>();
  const datas = new Set<string>(hojeIso ? [hojeIso] : []);
  for (const saida of saidasDasTools) {
    percorrer(parseSaida(saida), valor => {
      if (typeof valor === "number") { valores.add(Math.round(valor * 100) / 100); return; }
      for (const match of valor.match(/\d{4}-\d{2}-\d{2}/g) ?? []) datas.add(match);
      for (const match of valor.matchAll(DATA_PATTERN)) datas.add(isoDeDataBr(match[1]!, match[2]!, match[3]!));
      for (const match of valor.match(VALOR_PATTERN) ?? []) {
        const numero = parseValor(match);
        if (numero !== null) valores.add(numero);
      }
      if (/^\d+(\.\d+)?$/.test(valor.trim())) valores.add(Math.round(Number(valor) * 100) / 100);
    });
  }
  return { valores, datas };
}

export function validarValoresEDatas(
  texto: string,
  permitidos: { valores: Set<number>; datas: Set<string> },
): { texto: string; valoresTrocados: number; datasTrocadas: number } {
  let valoresTrocados = 0;
  let datasTrocadas = 0;
  let resultado = texto.replace(VALOR_PATTERN, match => {
    const numero = parseValor(match);
    if (numero !== null && permitidos.valores.has(numero)) return match;
    valoresTrocados++;
    return VALOR_NAO_CONFIRMADO;
  });
  resultado = resultado.replace(DATA_PATTERN, (match, dia: string, mes: string, ano: string) => {
    if (permitidos.datas.has(isoDeDataBr(dia, mes, ano))) return match;
    datasTrocadas++;
    return DATA_NAO_CONFIRMADA;
  });
  return { texto: resultado, valoresTrocados, datasTrocadas };
}
