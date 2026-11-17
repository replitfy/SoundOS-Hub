import { ApiError } from "@workspace/api-client-react";

const USER_SESSION_KEY = "soundos_user_session";

/**
 * Detecta uma resposta 401 (sessão expirada ou inválida) vinda de qualquer
 * chamada feita via @workspace/api-client-react.
 */
export function isSessionExpiredError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * Trata uma sessão expirada de forma centralizada: limpa a sessão guardada
 * e manda o usuário de volta para o login (preservando a página atual para
 * retomar depois). Retorna `true` quando tratou o erro (era um 401), para
 * que o chamador possa evitar mostrar um toast genérico de "erro" por cima.
 */
export function handleSessionExpired(err: unknown): boolean {
  if (!isSessionExpiredError(err)) return false;
  redirectToLoginExpired();
  return true;
}

/**
 * Mesmo efeito de `handleSessionExpired`, mas sem depender de um `ApiError`.
 * Necessário para as chamadas feitas com `fetch` cru — o download do backup
 * (blob) e o upload do arquivo de restauração não passam pelo cliente gerado
 * e portanto nunca produzem um `ApiError` para inspecionar. Sem isto, um 401
 * deixaria o token expirado no sessionStorage e o AuthGuard continuaria
 * tratando o usuário como autenticado.
 */
export function redirectToLoginExpired(): void {
  sessionStorage.removeItem(USER_SESSION_KEY);
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  window.location.href = `${base}/login?next=${next}&expired=1`;
}
