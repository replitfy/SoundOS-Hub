import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, accessProfilesTable, type AccessProfile } from "@workspace/db";
import {
  ADMIN_MASTER_KEY,
  SYSTEM_PROFILE_KEYS,
  isAccessAreaId,
  isAdminOnlyArea,
  sanitizeAreas,
  type AccessAreaId,
} from "@workspace/access-areas";
import {
  CreateAccessProfileBody,
  UpdateAccessProfileBody,
  UpdateAccessProfileParams,
} from "@workspace/api-zod";
import { requireArea, requireAuth, type AuthedRequest } from "../middlewares/roleAuth";
import {
  ACCESS_MANAGEMENT_LOCK_ID,
  ManagerLossError,
  assertStillManaged,
  countActiveManagers,
  toResolvedAccess,
} from "../services/accessProfiles";

const router: IRouter = Router();

/** Erro de regra de negócio com código estável, para o app traduzir a mensagem. */
class AccessProfileError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AccessProfileError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof AccessProfileError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return;
  }
  if (err instanceof ManagerLossError) {
    res.status(409).json({ error: err.message, code: "LAST_MANAGER" });
    return;
  }
  if (isUniqueViolation(err)) {
    res.status(409).json({ error: "Já existe um perfil com esse nome.", code: "NAME_TAKEN" });
    return;
  }
  throw err;
}

function serializeProfile(profile: AccessProfile, userCount: number) {
  const resolved = toResolvedAccess(profile);
  return {
    id: profile.id,
    systemKey: profile.systemKey,
    name: profile.name,
    description: profile.description,
    isAdmin: resolved.isAdmin,
    isSystem: profile.systemKey !== null,
    locked: profile.systemKey === ADMIN_MASTER_KEY,
    areas: resolved.areas,
    userCount,
    updatedAt: profile.updatedAt.toISOString(),
    updatedByName: profile.updatedByName,
  };
}

/** Usuários ativos por perfil (usuários antigos sem perfil contam pelo papel antigo). */
async function activeUserCounts(): Promise<Map<number, number>> {
  const result = await db.execute(sql`
    SELECT COALESCE(u.profile_id, (SELECT s.id FROM access_profiles s WHERE s.system_key = u.role::text)) AS profile_id,
           count(*)::int AS n
    FROM soundos_users u
    WHERE u.active = true
    GROUP BY 1
  `);
  const counts = new Map<number, number>();
  for (const row of result.rows as Array<{ profile_id: number | null; n: number }>) {
    if (row.profile_id !== null) counts.set(Number(row.profile_id), Number(row.n));
  }
  return counts;
}

function validateAreas(rawAreas: readonly string[], isAdmin: boolean): AccessAreaId[] {
  const unknown = rawAreas.filter(area => !isAccessAreaId(area));
  if (unknown.length > 0) {
    throw new AccessProfileError(400, "INVALID_AREA", `Áreas desconhecidas: ${unknown.join(", ")}.`);
  }
  const areas = sanitizeAreas(rawAreas);
  const adminOnly = areas.filter(isAdminOnlyArea);
  if (!isAdmin && adminOnly.length > 0) {
    throw new AccessProfileError(
      400,
      "ADMIN_ONLY_AREAS",
      "Usuários, Perfis de acesso, Backup e Conduta Comercial só podem ser liberados a perfis administradores.",
      { areas: adminOnly },
    );
  }
  return areas;
}

function parseProfileId(req: Request): number {
  const parsed = UpdateAccessProfileParams.safeParse(req.params);
  if (!parsed.success) throw new AccessProfileError(400, "INVALID_ID", "ID inválido.");
  return parsed.data.id;
}

const LAST_MANAGER_MESSAGE =
  "Esta alteração deixaria a plataforma sem nenhum usuário ativo que possa gerenciar perfis e usuários.";

// ── GET /auth/me ────────────────────────────────────────────────
// Perfil e áreas do usuário logado, lidos do banco a cada chamada. O app usa
// isto para montar o menu; quem protege os dados é o servidor, rota a rota.
router.get("/auth/me", requireAuth, (req, res): void => {
  const user = (req as AuthedRequest).authedUser!;
  res.json({
    userId: user.id,
    profileId: user.profileId ?? 0,
    profileName: user.profileName,
    isAdmin: user.isAdmin,
    areas: user.areas,
  });
});

// Lista usada por duas telas (Perfis de acesso e o seletor de perfil em Usuários).
router.get("/admin/access-profiles", requireArea("perfis", "usuarios"), async (_req, res): Promise<void> => {
  const [profiles, counts] = await Promise.all([
    db.select().from(accessProfilesTable),
    activeUserCounts(),
  ]);

  const systemOrder = (profile: AccessProfile) =>
    profile.systemKey ? (SYSTEM_PROFILE_KEYS as readonly string[]).indexOf(profile.systemKey) : Number.MAX_SAFE_INTEGER;

  profiles.sort((a, b) => {
    const byOrder = systemOrder(a) - systemOrder(b);
    return byOrder !== 0 ? byOrder : a.name.localeCompare(b.name, "pt-BR");
  });

  res.json(profiles.map(profile => serializeProfile(profile, counts.get(profile.id) ?? 0)));
});

router.post("/admin/access-profiles", requireArea("perfis"), async (req, res): Promise<void> => {
  const parsed = CreateAccessProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_BODY" });
    return;
  }
  const actor = (req as AuthedRequest).authedUser!;

  try {
    const name = parsed.data.name.trim();
    if (name.length < 2) throw new AccessProfileError(400, "INVALID_BODY", "O nome deve ter ao menos 2 caracteres.");
    const isAdmin = parsed.data.isAdmin ?? false;
    const areas = validateAreas(parsed.data.areas, isAdmin);

    const [created] = await db
      .insert(accessProfilesTable)
      .values({
        name,
        description: parsed.data.description?.trim() ?? "",
        isAdmin,
        areas,
        updatedByUserId: actor.id,
        updatedByName: actor.name,
      })
      .returning();

    res.status(201).json(serializeProfile(created, 0));
  } catch (err) {
    sendError(res, err);
  }
});

router.put("/admin/access-profiles/:id", requireArea("perfis"), async (req, res): Promise<void> => {
  const parsed = UpdateAccessProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_BODY" });
    return;
  }
  const actor = (req as AuthedRequest).authedUser!;

  try {
    const id = parseProfileId(req);

    const updated = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCESS_MANAGEMENT_LOCK_ID})`);
      const [current] = await tx.select().from(accessProfilesTable).where(eq(accessProfilesTable.id, id)).limit(1);
      if (!current) throw new AccessProfileError(404, "NOT_FOUND", "Perfil não encontrado.");

      if (current.systemKey === ADMIN_MASTER_KEY) {
        throw new AccessProfileError(409, "LOCKED_PROFILE", "O perfil Admin Master é fixo e não pode ser alterado.");
      }

      const nextName = parsed.data.name !== undefined ? parsed.data.name.trim() : current.name;
      if (nextName.length < 2) throw new AccessProfileError(400, "INVALID_BODY", "O nome deve ter ao menos 2 caracteres.");
      if (current.systemKey !== null && nextName !== current.name) {
        throw new AccessProfileError(409, "SYSTEM_PROFILE_NAME", "O nome de um perfil do sistema não pode ser alterado.");
      }

      const nextIsAdmin = parsed.data.isAdmin ?? current.isAdmin;
      const nextAreas = validateAreas(parsed.data.areas ?? current.areas, nextIsAdmin);

      const managersBefore = await countActiveManagers(tx);

      const [saved] = await tx
        .update(accessProfilesTable)
        .set({
          name: nextName,
          description: parsed.data.description !== undefined ? parsed.data.description.trim() : current.description,
          isAdmin: nextIsAdmin,
          areas: nextAreas,
          updatedAt: new Date(),
          updatedByUserId: actor.id,
          updatedByName: actor.name,
        })
        .where(eq(accessProfilesTable.id, id))
        .returning();

      await assertStillManaged(tx, managersBefore, LAST_MANAGER_MESSAGE);
      return saved;
    });

    const counts = await activeUserCounts();
    res.json(serializeProfile(updated, counts.get(updated.id) ?? 0));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/admin/access-profiles/:id", requireArea("perfis"), async (req, res): Promise<void> => {
  try {
    const id = parseProfileId(req);

    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCESS_MANAGEMENT_LOCK_ID})`);
      const [current] = await tx.select().from(accessProfilesTable).where(eq(accessProfilesTable.id, id)).limit(1);
      if (!current) throw new AccessProfileError(404, "NOT_FOUND", "Perfil não encontrado.");

      if (current.systemKey !== null) {
        throw new AccessProfileError(409, "SYSTEM_PROFILE", "Perfis do sistema não podem ser excluídos.");
      }

      const usage = await tx.execute(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE active)::int AS active
        FROM soundos_users
        WHERE profile_id = ${id}
      `);
      const row = usage.rows[0] as { total?: number; active?: number } | undefined;
      const total = Number(row?.total ?? 0);
      const active = Number(row?.active ?? 0);
      if (total > 0) {
        const users = active > 0 ? active : total;
        throw new AccessProfileError(
          409,
          "PROFILE_IN_USE",
          `Este perfil está em uso por ${users} ${users === 1 ? "usuário" : "usuários"}${active === 0 ? " desativado" + (users === 1 ? "" : "s") : ""} e não pode ser excluído. Troque o perfil ${users === 1 ? "dele" : "deles"} antes.`,
          { userCount: users, onlyDeactivated: active === 0 },
        );
      }

      await tx.delete(accessProfilesTable).where(eq(accessProfilesTable.id, id));
    });

    res.status(204).send();
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
