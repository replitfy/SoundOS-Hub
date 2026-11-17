import { ApiError } from "@workspace/api-client-react";
import type { TranslationKey } from "@/contexts/language";

/** Código estável que a API devolve em `code` (o texto do servidor não é mostrado à pessoa). */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data as { code?: unknown } | null;
  return typeof data?.code === "string" ? data.code : null;
}

/** Bloqueios que o servidor lista em `details.bloqueios` quando recusa o modelo de abertura. */
export function apiErrorBlockers(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const data = err.data as { details?: { bloqueios?: unknown } } | null;
  const lista = data?.details?.bloqueios;
  return Array.isArray(lista) ? lista.filter((item): item is string => typeof item === "string") : [];
}

/** Mensagem traduzida para o código do erro; sem tradução específica, a mensagem genérica. */
export function errorText(err: unknown, t: (key: TranslationKey) => string): string {
  const code = apiErrorCode(err);
  if (code) {
    const key = `crm.err.${code}` as TranslationKey;
    const text = t(key);
    if (text !== key) return text;
  }
  return t("crm.err.generic");
}
