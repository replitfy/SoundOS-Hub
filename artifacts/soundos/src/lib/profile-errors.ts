import { ApiError } from "@workspace/api-client-react";
import type { TranslationKey } from "@/contexts/language";

type Translate = (key: TranslationKey) => string;

const ERROR_KEYS: Record<string, TranslationKey> = {
  NAME_TAKEN: "perfis.err.NAME_TAKEN",
  LOCKED_PROFILE: "perfis.err.LOCKED_PROFILE",
  SYSTEM_PROFILE: "perfis.err.SYSTEM_PROFILE",
  SYSTEM_PROFILE_NAME: "perfis.err.SYSTEM_PROFILE_NAME",
  ADMIN_ONLY_AREAS: "perfis.err.ADMIN_ONLY_AREAS",
  LAST_MANAGER: "perfis.err.LAST_MANAGER",
  INVALID_AREA: "perfis.err.INVALID_AREA",
  INVALID_BODY: "perfis.err.INVALID_BODY",
  NOT_FOUND: "perfis.err.NOT_FOUND",
};

export interface ServerErrorBody {
  code?: string;
  error?: string;
  userCount?: number;
  onlyDeactivated?: boolean;
}

/** Traduz o código estável enviado pelo servidor; sem código conhecido, cai numa mensagem genérica. */
export function describeProfileError(err: unknown, t: Translate): string {
  const body = err instanceof ApiError ? (err.data as ServerErrorBody | null) : null;
  const code = body?.code;
  if (code === "PROFILE_IN_USE") {
    const count = Math.max(1, Number(body?.userCount ?? 1));
    const base = body?.onlyDeactivated ? "perfis.err.PROFILE_IN_USE_deactivated" : "perfis.err.PROFILE_IN_USE";
    const key = `${base}_${count === 1 ? "one" : "many"}` as TranslationKey;
    return t(key).replace("{count}", String(count));
  }
  if (code && ERROR_KEYS[code]) return t(ERROR_KEYS[code]);
  return t("perfis.err.generico");
}
