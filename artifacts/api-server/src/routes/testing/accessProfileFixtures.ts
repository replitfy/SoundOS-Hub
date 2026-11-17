import { SYSTEM_PROFILES } from "@workspace/access-areas";

/** Linhas dos 4 perfis do sistema, como o servidor as grava, para testes que não usam o banco. */
export const SYSTEM_PROFILE_ROWS = SYSTEM_PROFILES.map((profile, index) => ({
  id: index + 1,
  systemKey: profile.key,
  name: profile.name,
  description: profile.description,
  isAdmin: profile.isAdmin,
  areas: [...profile.areas],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  updatedByUserId: null,
  updatedByName: "Sistema",
}));

export function profileIdFor(key: string): number {
  const row = SYSTEM_PROFILE_ROWS.find(profile => profile.systemKey === key);
  if (!row) throw new Error(`Perfil de teste desconhecido: ${key}`);
  return row.id;
}

export function profileMaps() {
  const byId = new Map(SYSTEM_PROFILE_ROWS.map(row => [row.id, row]));
  const byKey = new Map(SYSTEM_PROFILE_ROWS.map(row => [row.systemKey, row]));
  return { byId, byKey };
}
