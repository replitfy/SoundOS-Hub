import { eq, sql } from "drizzle-orm";
import { db, accessProfilesTable, type AccessProfile } from "@workspace/db";
import {
  ADMIN_MASTER_KEY,
  ALL_AREA_IDS,
  SYSTEM_PROFILES,
  effectiveAreas,
  getSystemProfileDefault,
  type AccessAreaId,
} from "@workspace/access-areas";

/**
 * Acesso efetivo de um usuário, já resolvido a partir do perfil dele. É a única
 * fonte para decidir o que alguém pode abrir: o campo legado `role` da tabela
 * de usuários só espelha o perfil para auditoria.
 */
export interface ResolvedAccess {
  profileId: number | null;
  profileName: string;
  systemKey: string | null;
  isAdmin: boolean;
  areas: AccessAreaId[];
}

export function toResolvedAccess(profile: Pick<AccessProfile, "id" | "name" | "systemKey" | "isAdmin" | "areas">): ResolvedAccess {
  const isMaster = profile.systemKey === ADMIN_MASTER_KEY;
  const isAdmin = isMaster ? true : profile.isAdmin;
  return {
    profileId: profile.id,
    profileName: profile.name,
    systemKey: profile.systemKey,
    isAdmin,
    areas: effectiveAreas({ systemKey: profile.systemKey, isAdmin, areas: profile.areas }),
  };
}

let ensuring: Promise<{ backfilled: number }> | null = null;

/**
 * Cria os 4 perfis do sistema se ainda não existirem e liga a eles os usuários
 * que ainda não têm perfil (pelo papel antigo). Idempotente: nunca altera um
 * perfil que já existe, para não desfazer ajustes feitos pelo administrador.
 *
 * Roda ao subir o servidor porque a publicação leva só a estrutura do banco,
 * não os dados criados no desenvolvimento.
 */
export function ensureSystemProfiles(): Promise<{ backfilled: number }> {
  if (!ensuring) {
    ensuring = runEnsureSystemProfiles().finally(() => {
      ensuring = null;
    });
  }
  return ensuring;
}

async function runEnsureSystemProfiles(): Promise<{ backfilled: number }> {
  for (const profile of SYSTEM_PROFILES) {
    await db
      .insert(accessProfilesTable)
      .values({
        systemKey: profile.key,
        name: profile.name,
        description: profile.description,
        isAdmin: profile.isAdmin,
        areas: [...profile.areas],
        updatedByName: "Sistema",
      })
      .onConflictDoNothing({ target: accessProfilesTable.systemKey });
  }

  const result = await db.execute(sql`
    UPDATE soundos_users u
    SET profile_id = p.id
    FROM access_profiles p
    WHERE u.profile_id IS NULL AND p.system_key = u.role::text
  `);
  return { backfilled: result.rowCount ?? 0 };
}

/**
 * Descobre o perfil do usuário. Retorna null quando não dá para ter certeza —
 * quem chama deve negar o acesso, nunca liberar.
 */
export async function resolveAccess(
  user: { role: string; profileId: number | null },
  retried = false,
): Promise<ResolvedAccess | null> {
  const [profile] = user.profileId != null
    ? await db.select().from(accessProfilesTable).where(eq(accessProfilesTable.id, user.profileId)).limit(1)
    : await db.select().from(accessProfilesTable).where(eq(accessProfilesTable.systemKey, user.role)).limit(1);

  if (profile) return toResolvedAccess(profile);

  // O Admin Master é fixo no código: nunca depende de a linha existir no banco.
  if (user.role === ADMIN_MASTER_KEY && user.profileId == null) {
    const master = getSystemProfileDefault(ADMIN_MASTER_KEY);
    return {
      profileId: null,
      profileName: master?.name ?? "Admin Master",
      systemKey: ADMIN_MASTER_KEY,
      isAdmin: true,
      areas: [...ALL_AREA_IDS],
    };
  }

  // Usuário antigo sem perfil e perfis do sistema ainda não criados (primeira
  // chamada após publicar, antes do boot terminar): cria e tenta uma vez mais.
  if (!retried && user.profileId == null) {
    await ensureSystemProfiles();
    return resolveAccess(user, true);
  }

  return null;
}

// ── Proteção contra ficar sem quem gerencie ──────────────────────────────

/** Trava de transação compartilhada por tudo que pode reduzir quem gerencia perfis e usuários. */
export const ACCESS_MANAGEMENT_LOCK_ID = 734019314;

export class ManagerLossError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerLossError";
  }
}

type SqlExecutor = Pick<typeof db, "execute">;

/**
 * Usuários ativos que conseguem gerenciar perfis e usuários: Admin Master, ou
 * perfil administrador com as telas "Usuários" e "Perfis de acesso" liberadas.
 * Usuários antigos ainda sem perfil contam pelo papel antigo.
 */
export async function countActiveManagers(executor: SqlExecutor = db): Promise<number> {
  const result = await executor.execute(sql`
    SELECT count(*)::int AS n
    FROM soundos_users u
    LEFT JOIN access_profiles p
      ON p.id = COALESCE(u.profile_id, (SELECT s.id FROM access_profiles s WHERE s.system_key = u.role::text))
    WHERE u.active = true
      AND (
        p.system_key = 'admin_master'
        OR (p.is_admin = true AND p.areas @> ARRAY['perfis', 'usuarios']::text[])
        OR (p.id IS NULL AND u.profile_id IS NULL AND u.role::text = 'admin_master')
      )
  `);
  return Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/**
 * Chame ANTES de uma alteração (guardando o resultado) e DEPOIS dela, dentro da
 * mesma transação e sob a trava. Se havia quem gerenciasse e a alteração
 * zerou isso, lança ManagerLossError para a transação desfazer tudo.
 */
export async function assertStillManaged(
  executor: SqlExecutor,
  managersBefore: number,
  message: string,
): Promise<void> {
  if (managersBefore === 0) return; // já estava sem ninguém: não piora, e não impede o conserto
  const managersAfter = await countActiveManagers(executor);
  if (managersAfter === 0) throw new ManagerLossError(message);
}

// ── Perfis x usuários ─────────────────────────────────────────────────────

const LEGACY_ROLES = ["admin_master", "admin", "usuario", "assistente"] as const;
export type LegacyRole = (typeof LEGACY_ROLES)[number];

/** Papel legado gravado só para auditoria, derivado do perfil escolhido. */
export function legacyRoleFor(profile: Pick<AccessProfile, "systemKey" | "isAdmin">): LegacyRole {
  const key = profile.systemKey;
  if (key && (LEGACY_ROLES as readonly string[]).includes(key)) return key as LegacyRole;
  return profile.isAdmin ? "admin" : "usuario";
}

export interface UserProfileSummary {
  profileId: number;
  profileName: string;
  isAdmin: boolean;
}

/** Mapas de perfis para exibir o perfil de cada usuário numa lista. */
export async function loadProfileSummaries(): Promise<{
  byId: Map<number, AccessProfile>;
  byKey: Map<string, AccessProfile>;
}> {
  let profiles = await db.select().from(accessProfilesTable);
  if (!profiles.some(profile => profile.systemKey !== null)) {
    await ensureSystemProfiles();
    profiles = await db.select().from(accessProfilesTable);
  }
  const byId = new Map<number, AccessProfile>();
  const byKey = new Map<string, AccessProfile>();
  for (const profile of profiles) {
    byId.set(profile.id, profile);
    if (profile.systemKey) byKey.set(profile.systemKey, profile);
  }
  return { byId, byKey };
}

export function summarizeUserProfile(
  user: { role: string; profileId: number | null },
  maps: { byId: Map<number, AccessProfile>; byKey: Map<string, AccessProfile> },
): UserProfileSummary {
  const profile = user.profileId != null ? maps.byId.get(user.profileId) : maps.byKey.get(user.role);
  if (!profile) return { profileId: 0, profileName: "—", isAdmin: false };
  return {
    profileId: profile.id,
    profileName: profile.name,
    isAdmin: toResolvedAccess(profile).isAdmin,
  };
}
