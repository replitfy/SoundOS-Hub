/**
 * Catálogo único das áreas do menu do SoundOS e das regras de acesso que
 * dependem dele. É usado pelo servidor (bloqueio de rotas e perfis do sistema)
 * e pelo app (menu, bloqueio por endereço e tela "Perfis de acesso"), para que
 * os dois lados nunca discordem sobre o que existe.
 */

export const ACCESS_SECTIONS = ["dashboard", "cockpit", "sofia", "administracao"] as const;
export type AccessSection = (typeof ACCESS_SECTIONS)[number];

export interface AccessAreaDef {
  /** Identificador estável gravado nos perfis. Nunca renomear. */
  id: string;
  section: AccessSection;
  /** Tela inicial da área (primeira rota do menu). */
  href: string;
  /** Só pode ser liberada a perfis marcados como administrador. */
  adminOnly: boolean;
}

/** A ordem desta lista é a ordem do menu. */
export const ACCESS_AREAS = [
  { id: "visao-geral", section: "dashboard", href: "/", adminOnly: false },
  { id: "visao-financeira", section: "dashboard", href: "/financeiro", adminOnly: false },
  { id: "painel-loja", section: "dashboard", href: "/store", adminOnly: false },
  { id: "painel-escola", section: "dashboard", href: "/education", adminOnly: false },

  { id: "pessoas", section: "cockpit", href: "/pessoas", adminOnly: false },
  { id: "crm", section: "cockpit", href: "/crm", adminOnly: false },
  { id: "produtos", section: "cockpit", href: "/store/produtos", adminOnly: false },
  { id: "eventos", section: "cockpit", href: "/education/cursos", adminOnly: false },

  { id: "chat", section: "sofia", href: "/sofia", adminOnly: false },
  { id: "memoria", section: "sofia", href: "/sofia/memoria", adminOnly: false },
  { id: "prompt", section: "sofia", href: "/sofia/prompt", adminOnly: false },
  { id: "conduta", section: "sofia", href: "/sofia/conduta", adminOnly: true },
  { id: "conversas", section: "sofia", href: "/sofia/conversas", adminOnly: false },
  { id: "videos", section: "sofia", href: "/sofia/videos", adminOnly: false },
  { id: "videos-envios", section: "sofia", href: "/sofia/videos/envios", adminOnly: false },

  { id: "usuarios", section: "administracao", href: "/admin/usuarios", adminOnly: true },
  { id: "perfis", section: "administracao", href: "/admin/perfis", adminOnly: true },
  { id: "backup", section: "administracao", href: "/admin/backup", adminOnly: true },
  { id: "carga-airtable", section: "administracao", href: "/admin/manutencao/airtable", adminOnly: true },
] as const satisfies readonly AccessAreaDef[];

export type AccessAreaId = (typeof ACCESS_AREAS)[number]["id"];

export const ALL_AREA_IDS: readonly AccessAreaId[] = ACCESS_AREAS.map(area => area.id);
export const ADMIN_ONLY_AREA_IDS: readonly AccessAreaId[] = ACCESS_AREAS.filter(area => area.adminOnly).map(area => area.id);

const AREA_BY_ID: ReadonlyMap<string, AccessAreaDef> = new Map<string, AccessAreaDef>(
  ACCESS_AREAS.map(area => [area.id, area] as [string, AccessAreaDef]),
);

export function isAccessAreaId(value: unknown): value is AccessAreaId {
  return typeof value === "string" && AREA_BY_ID.has(value);
}

export function getAccessArea(id: string): AccessAreaDef | undefined {
  return AREA_BY_ID.get(id);
}

export function isAdminOnlyArea(id: string): boolean {
  return AREA_BY_ID.get(id)?.adminOnly === true;
}

/** Remove duplicados e ids desconhecidos, e devolve na ordem do menu. */
export function sanitizeAreas(input: unknown): AccessAreaId[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(input.filter((value): value is string => typeof value === "string"));
  return ALL_AREA_IDS.filter(id => wanted.has(id));
}

export type AccessArea = (typeof ACCESS_AREAS)[number];

export function areasBySection(section: AccessSection): AccessArea[] {
  return ACCESS_AREAS.filter(area => area.section === section);
}

// ── Perfis do sistema ─────────────────────────────────────────────────────

export const ADMIN_MASTER_KEY = "admin_master";
export const SYSTEM_PROFILE_KEYS = ["admin_master", "admin", "usuario", "assistente"] as const;
export type SystemProfileKey = (typeof SYSTEM_PROFILE_KEYS)[number];

export interface SystemProfileDefault {
  key: SystemProfileKey;
  name: string;
  description: string;
  isAdmin: boolean;
  areas: AccessAreaId[];
}

/**
 * O que cada perfil de equipe pode abrir logo após a publicação. Bate com o
 * acesso que a equipe tinha antes de existirem perfis: tudo, menos o que o
 * servidor já restringia a administradores (telas exclusivas de administrador
 * e a visão financeira, que lê o Omie).
 */
const STAFF_DEFAULT_AREAS: AccessAreaId[] = ACCESS_AREAS
  .filter(area => !area.adminOnly && area.id !== "visao-financeira")
  .map(area => area.id);

export const SYSTEM_PROFILES: readonly SystemProfileDefault[] = [
  {
    key: "admin_master",
    name: "Admin Master",
    description: "Acesso total e fixo. Não pode ser editado nem excluído.",
    isAdmin: true,
    areas: [...ALL_AREA_IDS],
  },
  {
    key: "admin",
    name: "Admin",
    description: "Administra a plataforma e vê todas as áreas.",
    isAdmin: true,
    areas: [...ALL_AREA_IDS],
  },
  {
    key: "usuario",
    name: "Usuário",
    description: "Equipe com acesso às áreas de trabalho, sem as telas de administração.",
    isAdmin: false,
    areas: [...STAFF_DEFAULT_AREAS],
  },
  {
    key: "assistente",
    name: "Assistente",
    description: "Equipe de apoio com acesso às áreas de trabalho, sem as telas de administração.",
    isAdmin: false,
    areas: [...STAFF_DEFAULT_AREAS],
  },
];

export function getSystemProfileDefault(key: string): SystemProfileDefault | undefined {
  return SYSTEM_PROFILES.find(profile => profile.key === key);
}

export interface ProfileAccessInput {
  systemKey?: string | null;
  isAdmin: boolean;
  areas: readonly string[];
}

/**
 * Áreas que o perfil realmente concede. O Admin Master é fixo: sempre tem
 * todas, mesmo que a linha no banco esteja diferente. Áreas exclusivas de
 * administrador nunca valem para perfis que não são administradores, mesmo que
 * tenham sido gravadas por engano.
 */
export function effectiveAreas(profile: ProfileAccessInput): AccessAreaId[] {
  if (profile.systemKey === ADMIN_MASTER_KEY) return [...ALL_AREA_IDS];
  return sanitizeAreas(profile.areas).filter(id => profile.isAdmin || !isAdminOnlyArea(id));
}

// ── Rotas do app ──────────────────────────────────────────────────────────

/**
 * Para abrir a tela basta ter UMA das áreas listadas (telas que aparecem a
 * partir de mais de um item do menu aceitam todos eles). `null` = aberta a
 * qualquer usuário logado.
 */
export const APP_ROUTE_RULES: ReadonlyArray<{ pattern: string; anyOf: readonly AccessAreaId[] | null }> = [
  { pattern: "/", anyOf: ["visao-geral"] },
  { pattern: "/dashboard", anyOf: ["visao-geral"] },
  { pattern: "/financeiro", anyOf: ["visao-financeira"] },
  { pattern: "/calendario", anyOf: ["painel-escola", "eventos"] },

  { pattern: "/store", anyOf: ["painel-loja"] },
  { pattern: "/store/pedidos", anyOf: ["painel-loja"] },
  { pattern: "/store/clientes", anyOf: ["painel-loja"] },
  { pattern: "/store/produtos", anyOf: ["produtos"] },

  { pattern: "/education", anyOf: ["painel-escola"] },
  { pattern: "/education/cursos", anyOf: ["eventos"] },
  { pattern: "/education/cursos/:id", anyOf: ["eventos", "painel-escola"] },
  { pattern: "/education/interesse", anyOf: ["eventos"] },
  { pattern: "/education/turmas", anyOf: ["eventos"] },
  { pattern: "/education/alunos", anyOf: ["eventos"] },
  { pattern: "/education/matriculas", anyOf: ["eventos"] },

  { pattern: "/pessoas", anyOf: ["pessoas"] },
  { pattern: "/pessoas/:id", anyOf: ["pessoas"] },
  { pattern: "/crm", anyOf: ["crm"] },

  { pattern: "/sofia", anyOf: ["chat"] },
  { pattern: "/sofia/memoria", anyOf: ["memoria"] },
  { pattern: "/sofia/prompt", anyOf: ["prompt"] },
  { pattern: "/sofia/conduta", anyOf: ["conduta"] },
  { pattern: "/sofia/governanca", anyOf: ["conduta"] },
  { pattern: "/sofia/conversas", anyOf: ["conversas"] },
  { pattern: "/sofia/videos", anyOf: ["videos"] },
  { pattern: "/sofia/videos/envios", anyOf: ["videos-envios"] },

  { pattern: "/meu-perfil", anyOf: null },

  { pattern: "/admin/usuarios", anyOf: ["usuarios"] },
  { pattern: "/admin/perfis", anyOf: ["perfis"] },
  { pattern: "/admin/backup", anyOf: ["backup"] },
  { pattern: "/admin/manutencao/airtable", anyOf: ["carga-airtable"] },
];

function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/)[0] ?? "";
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
  return trimmed === "" ? "/" : trimmed;
}

function patternMatches(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) => segment.startsWith(":") || segment === pathSegments[index]);
}

export type RouteRequirement =
  /** Rota conhecida que exige uma destas áreas. */
  | { kind: "areas"; anyOf: readonly AccessAreaId[] }
  /** Rota conhecida aberta a qualquer usuário logado (ex.: Meu perfil). */
  | { kind: "open" }
  /** Endereço que o app não conhece: renderiza a página "não encontrada". */
  | { kind: "unknown" };

export function requirementForPath(pathname: string): RouteRequirement {
  const path = normalizePath(pathname);
  const rule = APP_ROUTE_RULES.find(candidate => patternMatches(candidate.pattern, path));
  if (!rule) return { kind: "unknown" };
  return rule.anyOf === null ? { kind: "open" } : { kind: "areas", anyOf: rule.anyOf };
}

export function canAccessPath(pathname: string, areas: readonly string[]): boolean {
  const requirement = requirementForPath(pathname);
  if (requirement.kind !== "areas") return true;
  return requirement.anyOf.some(area => areas.includes(area));
}

/** Primeira tela permitida na ordem do menu, ou null se o perfil não tem nenhuma. */
export function firstAllowedHref(areas: readonly string[]): string | null {
  const first = ACCESS_AREAS.find(area => areas.includes(area.id));
  return first ? first.href : null;
}
