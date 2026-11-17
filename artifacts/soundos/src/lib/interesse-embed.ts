/** Formulário de interesse genérico: normalização do grupo e montagem do link e do iframe do Wix. */

/** Mesma regra do servidor: minúsculas, sem acento, só letras, números e hífen (até 40 caracteres). */
export function normalizeGrupo(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .slice(0, 200)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Aceita "2BA8E0" ou "#2BA8E0" e devolve "#2BA8E0"; qualquer outra coisa vira null. */
export function parseCor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : null;
}

/** Endereço público do formulário. `cor` vai sem "#", que quebraria a URL. */
export function buildInteresseUrl(input: {
  origin: string;
  base: string;
  grupo?: string | null;
  cor?: string | null;
  eventoId?: number | string | null;
  embed?: boolean;
}): string {
  const prefix = input.base.endsWith("/") ? input.base.slice(0, -1) : input.base;
  const params: string[] = [];
  if (input.embed) params.push("embed=1");
  const grupo = normalizeGrupo(input.grupo);
  if (grupo) params.push(`grupo=${encodeURIComponent(grupo)}`);
  const cor = parseCor(input.cor);
  if (cor) params.push(`cor=${cor.slice(1)}`);
  const eventoId = input.eventoId == null ? "" : String(input.eventoId);
  if (/^[1-9]\d*$/.test(eventoId) && Number.isSafeInteger(Number(eventoId))) {
    params.push(`eventoId=${eventoId}`);
  }
  return `${input.origin}${prefix}/interesse${params.length ? `?${params.join("&")}` : ""}`;
}

/** Altura que comporta os quatro campos, uma mensagem de erro e o botão sem barra de rolagem. */
export const INTERESSE_IFRAME_HEIGHT = 460;

export function buildInteresseIframe(url: string): string {
  return `<iframe src="${url}" width="100%" height="${INTERESSE_IFRAME_HEIGHT}" frameborder="0" style="border:none;" title="Formulário de interesse"></iframe>`;
}
