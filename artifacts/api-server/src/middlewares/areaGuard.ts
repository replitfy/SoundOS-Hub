import type { Request, Response, NextFunction } from "express";
import type { AccessAreaId } from "@workspace/access-areas";
import { loadAuthedUser, type AuthedRequest } from "./roleAuth";

/**
 * Bloqueio por área no servidor. Cada prefixo de rota que alimenta uma tela do
 * menu exige que o perfil do usuário tenha UMA das áreas listadas. O app só
 * esconde o menu; quem decide é esta tabela.
 *
 * A primeira regra que combinar vence, então as mais específicas vêm antes.
 * Rotas sem regra aqui não são de tela: ou são públicas (login, formulários,
 * webhooks) ou exigem só a identidade (Meu perfil). O teste de cobertura
 * garante que nenhuma rota autenticada fique de fora sem estar numa lista
 * explícita.
 */
export interface AreaRule {
  /** Caminho (sem /api), minúsculo, sem barra no fim. Combina com ele e com tudo abaixo dele. */
  prefix: string;
  /** Combina só com o caminho exato (sem subcaminhos). */
  exact?: boolean;
  /** Se informado, a regra vale só para estes métodos (HEAD conta como GET). */
  methods?: readonly string[];
  anyOf: readonly AccessAreaId[];
}

export const AREA_RULES: readonly AreaRule[] = [
  // Dashboard
  { prefix: "/dashboard", anyOf: ["visao-geral"] },
  { prefix: "/admin/omie", anyOf: ["visao-financeira"] },

  // Loja
  { prefix: "/store/panel", anyOf: ["painel-loja"] },
  { prefix: "/store/orders", anyOf: ["painel-loja"] },
  { prefix: "/store/customers", anyOf: ["painel-loja"] },
  { prefix: "/store/products", anyOf: ["produtos", "painel-loja"] },
  { prefix: "/store", anyOf: ["painel-loja", "produtos"] },

  // Education / eventos
  { prefix: "/education/event-summary", anyOf: ["painel-escola", "eventos"] },
  { prefix: "/education/kpis", anyOf: ["painel-escola", "eventos"] },
  { prefix: "/education/calendar", anyOf: ["painel-escola", "eventos"] },
  { prefix: "/education/pessoa-options", anyOf: ["eventos", "painel-escola", "crm", "pessoas"] },
  { prefix: "/education", anyOf: ["eventos", "painel-escola"] },
  // A lista de eventos também alimenta o cartão de novo interesse do CRM e a ficha.
  { prefix: "/cursos-inscricao", exact: true, methods: ["GET"], anyOf: ["eventos", "painel-escola", "crm", "pessoas"] },
  { prefix: "/cursos-inscricao", anyOf: ["eventos", "painel-escola"] },

  // Cockpit
  { prefix: "/pessoas", anyOf: ["pessoas"] },
  { prefix: "/admin/catalogos", anyOf: ["pessoas"] },
  { prefix: "/crm", anyOf: ["crm"] },

  // Sofia
  { prefix: "/sofia/knowledge", anyOf: ["memoria"] },
  // O Chat só lê o prompt ativo (modelo e versão); criar e ativar prompts é da tela Prompt.
  { prefix: "/sofia/prompts", methods: ["GET"], anyOf: ["prompt", "chat"] },
  { prefix: "/sofia/prompts", anyOf: ["prompt"] },
  { prefix: "/sofia/conduta", anyOf: ["conduta"] },
  { prefix: "/sofia/entity-registry", anyOf: ["conduta"] },
  { prefix: "/sofia/canais", anyOf: ["conduta"] },
  { prefix: "/sofia/conversations", anyOf: ["chat", "conversas"] },
  // Arquivos recebidos e enviados pelo WhatsApp: só quem vê as conversas.
  { prefix: "/anexos", anyOf: ["conversas"] },
  { prefix: "/sofia/chat", anyOf: ["chat"] },
  { prefix: "/sofia/videos/envios", anyOf: ["videos-envios"] },
  { prefix: "/sofia/videos", anyOf: ["videos"] },

  // Administração
  { prefix: "/admin/users", anyOf: ["usuarios"] },
  { prefix: "/admin/access-profiles", methods: ["GET"], anyOf: ["perfis", "usuarios"] },
  { prefix: "/admin/access-profiles", anyOf: ["perfis"] },
  { prefix: "/admin/backup", anyOf: ["backup"] },
  { prefix: "/admin/restore", anyOf: ["backup"] },
  { prefix: "/admin/airtable-carga", anyOf: ["carga-airtable"] },
];

/**
 * Rotas autenticadas que NÃO pertencem a nenhuma tela e por isso não têm
 * regra de área: qualquer usuário logado pode chamá-las.
 */
export const AUTH_ONLY_ROUTES: readonly string[] = [
  "/auth/profile",
  "/auth/me",
  "/admin/connectors",
];

function normalizePath(path: string): string {
  const collapsed = path.toLowerCase().replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

export function findAreaRule(method: string, rawPath: string): AreaRule | undefined {
  const path = normalizePath(rawPath);
  const effectiveMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return AREA_RULES.find(rule => {
    if (rule.methods && !rule.methods.includes(effectiveMethod)) return false;
    if (rule.exact) return path === rule.prefix;
    return path === rule.prefix || path.startsWith(`${rule.prefix}/`);
  });
}

export function areaGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  const rule = findAreaRule(req.method, req.path);
  if (!rule) {
    next();
    return;
  }

  void loadAuthedUser(req).then(result => {
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    if (!rule.anyOf.some(area => result.user.areas.includes(area))) {
      res.status(403).json({ error: "Você não tem acesso a esta área." });
      return;
    }
    (req as AuthedRequest).authedUser = result.user;
    next();
  });
}
