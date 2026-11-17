import { createHmac, timingSafeEqual } from "node:crypto";

// Sessões assinadas com SESSION_SECRET: o servidor é a única fonte de verdade
// sobre "quem é o usuário" (o cliente não pode mais forjar um X-User-Id
// arbitrário e se passar por outro usuário/atendente).
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function getSecret(): string {
  const secret = process.env["SESSION_SECRET"];
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required but was not provided.");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

/** Gera um token de sessão assinado para o usuário autenticado no login. */
export function createSessionToken(userId: number): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verifica um token de sessão (assinatura + expiração) e retorna o userId
 * codificado nele. Retorna null se o token for inválido, expirado ou ausente
 * — nunca confia em um userId enviado sem uma assinatura válida do servidor.
 */
export function verifySessionToken(token: string | undefined | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdRaw, expiresAtRaw, signature] = parts;
  const payload = `${userIdRaw}.${expiresAtRaw}`;
  const expected = sign(payload);

  const sigBuf = Buffer.from(signature ?? "", "base64url");
  const expectedBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  const userId = Number(userIdRaw);
  return Number.isInteger(userId) ? userId : null;
}
