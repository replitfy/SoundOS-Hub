import type { Request, Response, NextFunction, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { AccessAreaId } from "@workspace/access-areas";
import { verifySessionToken } from "../lib/session";
import { resolveAccess } from "../services/accessProfiles";

export interface AuthedUser {
  id: number;
  /** Espelho legado do perfil, só para auditoria. Nunca decida acesso por ele. */
  role: string;
  name: string;
  email: string;
  profileId: number | null;
  profileName: string;
  /** Perfil marcado como administrador (ações restritas a administradores). */
  isAdmin: boolean;
  /** Áreas do menu liberadas ao perfil, lidas do banco nesta chamada. */
  areas: AccessAreaId[];
}

export interface AuthedRequest extends Request {
  authedUser?: AuthedUser;
}

type LoadResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; status: 401 | 403 | 500; error: string };

/**
 * Extrai o userId de um token de sessão assinado (Authorization: Bearer <token>,
 * emitido por POST /auth/login). Nunca deriva identidade de um header bruto
 * como x-user-id — isso permitiria a qualquer cliente forjar ser outro usuário.
 */
function getVerifiedUserId(req: Request): number | null {
  const authHeader = req.headers["authorization"];
  const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : undefined;
  return verifySessionToken(token);
}

/**
 * Identifica o usuário pelo token assinado e lê o perfil dele do banco a cada
 * chamada, para que uma mudança de perfil valha na hora, sem novo login. Em
 * qualquer dúvida (perfil não encontrado, erro de banco) o resultado é negação.
 */
export async function loadAuthedUser(req: Request): Promise<LoadResult> {
  const cached = (req as AuthedRequest).authedUser;
  if (cached) return { ok: true, user: cached };

  const userId = getVerifiedUserId(req);
  if (userId === null) return { ok: false, status: 401, error: "Não autenticado." };

  try {
    const [user] = await db
      .select({
        id: usersTable.id,
        role: usersTable.role,
        profileId: usersTable.profileId,
        active: usersTable.active,
        name: usersTable.name,
        email: usersTable.email,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user || !user.active) return { ok: false, status: 401, error: "Usuário inativo ou não encontrado." };

    const access = await resolveAccess({ role: user.role, profileId: user.profileId });
    if (!access) {
      return { ok: false, status: 403, error: "Seu perfil de acesso não foi encontrado. Fale com um administrador." };
    }

    return {
      ok: true,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        profileId: access.profileId,
        profileName: access.profileName,
        isAdmin: access.isAdmin,
        areas: access.areas,
      },
    };
  } catch {
    return { ok: false, status: 500, error: "Erro interno ao verificar permissões." };
  }
}

/** Marca middlewares que protegem a rota, para o teste que confere a cobertura por área. */
export const ACCESS_GUARD_MARK = "__soundosAccessGuard";

function markAsGuard<T extends RequestHandler>(handler: T): T {
  Object.defineProperty(handler, ACCESS_GUARD_MARK, { value: true });
  return handler;
}

function buildGuard(
  isAllowed: (user: AuthedUser) => boolean,
  deniedMessage: string,
): RequestHandler {
  return markAsGuard((req: Request, res: Response, next: NextFunction): void => {
    void loadAuthedUser(req).then(result => {
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      if (!isAllowed(result.user)) {
        res.status(403).json({ error: deniedMessage });
        return;
      }
      (req as AuthedRequest).authedUser = result.user;
      next();
    });
  });
}

/**
 * Exige apenas um usuário ativo, com perfil válido — qualquer perfil. Usado em
 * rotas que precisam de uma identidade confiável para auditoria (ex.: quem
 * confirmou um campo da ficha). Rotas de tela devem ser cobertas por área em
 * areaGuard.ts.
 */
export const requireAuth: RequestHandler = buildGuard(() => true, "");

/** Exige que o perfil do usuário seja de administrador. */
export const requireAdminRole: RequestHandler = buildGuard(
  user => user.isAdmin,
  "Permissão insuficiente. Apenas administradores podem realizar esta ação.",
);

/** Exige pelo menos uma das áreas informadas liberada no perfil do usuário. */
export function requireArea(...areas: AccessAreaId[]): RequestHandler {
  return buildGuard(
    user => areas.some(area => user.areas.includes(area)),
    "Você não tem acesso a esta área.",
  );
}
