import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accessProfilesTable, db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  ManagerLossError,
  assertStillManaged,
  countActiveManagers,
  ensureSystemProfiles,
} from "./accessProfiles";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rollback = new Error("ROLLBACK_ACCESS_PROFILES_FIXTURE");

async function inRolledBackTransaction(test: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async tx => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** Deixa só os usuários criados pelo teste valendo, dentro da transação que será desfeita. */
async function isolateUsers(tx: Tx): Promise<void> {
  await tx.update(usersTable).set({ active: false });
}

async function profileId(tx: Tx, systemKey: string): Promise<number> {
  const [profile] = await tx.select().from(accessProfilesTable).where(eq(accessProfilesTable.systemKey, systemKey));
  if (!profile) throw new Error(`Perfil ${systemKey} não existe`);
  return profile.id;
}

async function createUser(tx: Tx, input: { profileId: number; active?: boolean }) {
  const id = randomUUID();
  const [user] = await tx.insert(usersTable).values({
    name: `perfil-test-${id}`,
    email: `perfil-test-${id}@example.test`,
    role: "usuario",
    profileId: input.profileId,
    active: input.active ?? true,
  }).returning();
  return user!;
}

async function createProfile(tx: Tx, input: { isAdmin: boolean; areas: string[] }) {
  const [profile] = await tx.insert(accessProfilesTable).values({
    name: `perfil-test-${randomUUID()}`,
    isAdmin: input.isAdmin,
    areas: input.areas,
  }).returning();
  return profile!;
}

describe.sequential("proteção de quem gerencia perfis e usuários (banco real)", () => {
  it("os 4 perfis do sistema existem e a criação é repetível", async () => {
    await ensureSystemProfiles();
    await ensureSystemProfiles();
    const rows = await db.select().from(accessProfilesTable).where(sql`${accessProfilesTable.systemKey} IS NOT NULL`);
    expect(rows.map(row => row.systemKey).sort()).toEqual(["admin", "admin_master", "assistente", "usuario"]);
  });

  it("conta Admin Master ativo e perfil administrador com Usuários e Perfis; ignora o resto", async () => {
    await inRolledBackTransaction(async tx => {
      await isolateUsers(tx);
      expect(await countActiveManagers(tx)).toBe(0);

      await createUser(tx, { profileId: await profileId(tx, "usuario") });
      await createUser(tx, { profileId: await profileId(tx, "admin_master"), active: false });
      const soPerfis = await createProfile(tx, { isAdmin: true, areas: ["perfis"] });
      await createUser(tx, { profileId: soPerfis.id });
      const naoAdmin = await createProfile(tx, { isAdmin: false, areas: ["perfis", "usuarios"] });
      await createUser(tx, { profileId: naoAdmin.id });
      expect(await countActiveManagers(tx)).toBe(0);

      const completo = await createProfile(tx, { isAdmin: true, areas: ["perfis", "usuarios"] });
      await createUser(tx, { profileId: completo.id });
      expect(await countActiveManagers(tx)).toBe(1);

      await createUser(tx, { profileId: await profileId(tx, "admin_master") });
      expect(await countActiveManagers(tx)).toBe(2);
    });
  });

  it("recusa a alteração que deixaria o sistema sem ninguém para gerenciar", async () => {
    await inRolledBackTransaction(async tx => {
      await isolateUsers(tx);
      const unico = await createUser(tx, { profileId: await profileId(tx, "admin_master") });
      const before = await countActiveManagers(tx);
      expect(before).toBe(1);

      await tx.update(usersTable).set({ profileId: await profileId(tx, "usuario") }).where(eq(usersTable.id, unico.id));
      await expect(assertStillManaged(tx, before, "x")).rejects.toBeInstanceOf(ManagerLossError);
    });
  });

  it("aceita a alteração quando outra pessoa continua gerenciando", async () => {
    await inRolledBackTransaction(async tx => {
      await isolateUsers(tx);
      const primeiro = await createUser(tx, { profileId: await profileId(tx, "admin_master") });
      await createUser(tx, { profileId: await profileId(tx, "admin_master") });
      const before = await countActiveManagers(tx);
      expect(before).toBe(2);

      await tx.update(usersTable).set({ active: false }).where(eq(usersTable.id, primeiro.id));
      await expect(assertStillManaged(tx, before, "x")).resolves.toBeUndefined();
    });
  });

  it("tirar Usuários ou Perfis de um perfil administrador também conta como perder o gerenciamento", async () => {
    await inRolledBackTransaction(async tx => {
      await isolateUsers(tx);
      const perfil = await createProfile(tx, { isAdmin: true, areas: ["perfis", "usuarios"] });
      await createUser(tx, { profileId: perfil.id });
      const before = await countActiveManagers(tx);
      expect(before).toBe(1);

      await tx.update(accessProfilesTable).set({ areas: ["usuarios"] }).where(eq(accessProfilesTable.id, perfil.id));
      await expect(assertStillManaged(tx, before, "x")).rejects.toBeInstanceOf(ManagerLossError);
    });
  });

  it("não impede o conserto quando já não havia ninguém", async () => {
    await inRolledBackTransaction(async tx => {
      await isolateUsers(tx);
      await expect(assertStillManaged(tx, 0, "x")).resolves.toBeUndefined();
    });
  });
});
