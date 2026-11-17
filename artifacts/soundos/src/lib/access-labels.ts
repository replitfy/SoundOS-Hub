import type { AccessAreaId, AccessSection, SystemProfileKey } from "@workspace/access-areas";
import type { TranslationKey } from "@/contexts/language";

/** Chave de tradução do nome de cada área (o mesmo rótulo do item de menu). */
export const AREA_LABEL_KEYS = {
  "visao-geral": "nav.dashboard",
  "visao-financeira": "nav.financeiro",
  "painel-loja": "nav.painel-loja",
  "painel-escola": "nav.painel-escola",
  pessoas: "nav.pessoas",
  crm: "nav.crm",
  produtos: "nav.produtos",
  eventos: "nav.eventos",
  chat: "nav.chat",
  memoria: "nav.memoria",
  prompt: "nav.prompt",
  conduta: "nav.conduta",
  conversas: "nav.conversas",
  videos: "nav.videos",
  "videos-envios": "nav.videos_envios",
  usuarios: "nav.usuarios",
  perfis: "nav.perfis",
  backup: "nav.backup",
  "carga-airtable": "nav.carga_airtable",
} as const satisfies Record<AccessAreaId, string>;

/** Chave de tradução do título de cada seção do menu. */
export const SECTION_LABEL_KEYS = {
  dashboard: "nav.section.overview",
  cockpit: "nav.section.cockpit",
  sofia: "nav.section.sofia",
  administracao: "nav.section.admin",
} as const satisfies Record<AccessSection, string>;

/**
 * Os nomes dos perfis do sistema são fixos (não podem ser renomeados nem
 * repetidos), então o nome identifica o perfil para traduzi-lo.
 */
const SYSTEM_PROFILE_KEY_BY_NAME: Record<string, SystemProfileKey> = {
  "Admin Master": "admin_master",
  Admin: "admin",
  "Usuário": "usuario",
  Assistente: "assistente",
};

export function systemProfileKeyForName(name: string): SystemProfileKey | null {
  return SYSTEM_PROFILE_KEY_BY_NAME[name] ?? null;
}

/** Nome do perfil no idioma atual; perfis criados pelo administrador mantêm o nome digitado. */
export function profileLabel(name: string, t: (key: TranslationKey) => string): string {
  const key = systemProfileKeyForName(name);
  return key ? t(`perfis.system.${key}.name`) : name;
}
