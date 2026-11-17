import { describe, expect, it, vi } from "vitest";

process.env["SESSION_SECRET"] = "test-secret-that-is-long-enough-for-hmac";

const loadAuthedUser = vi.fn();
vi.mock("./roleAuth", async importOriginal => {
  const actual = await importOriginal<typeof import("./roleAuth")>();
  return { ...actual, loadAuthedUser: (req: unknown) => loadAuthedUser(req) };
});

import type { Request, Response } from "express";
import { ALL_AREA_IDS, type AccessAreaId } from "@workspace/access-areas";
import { ACCESS_GUARD_MARK } from "./roleAuth";
import { AREA_RULES, AUTH_ONLY_ROUTES, areaGuard, findAreaRule } from "./areaGuard";
import router from "../routes";

function userWith(areas: AccessAreaId[], isAdmin = false) {
  return {
    ok: true as const,
    user: { id: 1, role: "usuario", name: "T", email: "t@example.test", profileId: 9, profileName: "P", isAdmin, areas },
  };
}

async function runGuard(method: string, path: string) {
  const req = { method, path } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  let nextCalled = false;
  areaGuard(req, res as unknown as Response, () => { nextCalled = true; });
  await new Promise(resolve => setImmediate(resolve));
  return { res, nextCalled, req };
}

describe("areaGuard — regras de caminho", () => {
  it("combina sem diferenciar maiúsculas, barra final ou barras duplicadas, como o Express", () => {
    expect(findAreaRule("GET", "/PESSOAS")?.anyOf).toEqual(["pessoas"]);
    expect(findAreaRule("GET", "/pessoas/")?.anyOf).toEqual(["pessoas"]);
    expect(findAreaRule("GET", "//pessoas//12")?.anyOf).toEqual(["pessoas"]);
    expect(findAreaRule("GET", "/pessoas/12/instrumentos-loja")?.anyOf).toEqual(["pessoas"]);
    expect(findAreaRule("GET", "/Sofia/Conduta")?.anyOf).toEqual(["conduta"]);
  });

  it("não deixa um prefixo parecido herdar a regra de outro caminho", () => {
    expect(findAreaRule("GET", "/pessoas-publicas")).toBeUndefined();
    expect(findAreaRule("GET", "/public/pessoas/lookup")).toBeUndefined();
    expect(findAreaRule("POST", "/auth/login")).toBeUndefined();
    expect(findAreaRule("POST", "/webhooks/hablla/instagram")).toBeUndefined();
  });

  it("trata HEAD como GET e escolhe a regra mais específica", () => {
    expect(findAreaRule("HEAD", "/cursos-inscricao")?.anyOf).toContain("crm");
    expect(findAreaRule("POST", "/cursos-inscricao")?.anyOf).toEqual(["eventos", "painel-escola"]);
    expect(findAreaRule("GET", "/cursos-inscricao/12")?.anyOf).toEqual(["eventos", "painel-escola"]);
    expect(findAreaRule("GET", "/sofia/videos/envios")?.anyOf).toEqual(["videos-envios"]);
    expect(findAreaRule("GET", "/sofia/videos/template")?.anyOf).toEqual(["videos"]);
    expect(findAreaRule("GET", "/admin/access-profiles")?.anyOf).toEqual(["perfis", "usuarios"]);
    expect(findAreaRule("POST", "/admin/access-profiles")?.anyOf).toEqual(["perfis"]);
  });

  it("só usa áreas que existem no catálogo", () => {
    for (const rule of AREA_RULES) {
      for (const area of rule.anyOf) expect(ALL_AREA_IDS).toContain(area);
    }
  });
});

describe("areaGuard — decisão", () => {
  it("responde 403 quando o perfil não tem nenhuma das áreas da rota", async () => {
    loadAuthedUser.mockResolvedValueOnce(userWith(["chat"]));
    const { res, nextCalled } = await runGuard("GET", "/pessoas");
    expect(res.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("deixa passar quando o perfil tem uma das áreas, guardando o usuário para a rota", async () => {
    loadAuthedUser.mockResolvedValueOnce(userWith(["pessoas"]));
    const { nextCalled, req } = await runGuard("GET", "/pessoas");
    expect(nextCalled).toBe(true);
    expect((req as unknown as { authedUser: { id: number } }).authedUser.id).toBe(1);
  });

  it("Chat lê os prompts, mas só quem tem a área Prompt cria ou ativa um prompt", async () => {
    loadAuthedUser.mockResolvedValueOnce(userWith(["chat"]));
    const read = await runGuard("GET", "/sofia/prompts");
    expect(read.nextCalled).toBe(true);

    for (const [method, path] of [["POST", "/sofia/prompts"], ["POST", "/sofia/prompts/3/activate"]] as const) {
      loadAuthedUser.mockResolvedValueOnce(userWith(["chat"]));
      const write = await runGuard(method, path);
      expect(write.res.statusCode).toBe(403);
      expect(write.nextCalled).toBe(false);

      loadAuthedUser.mockResolvedValueOnce(userWith(["prompt"]));
      expect((await runGuard(method, path)).nextCalled).toBe(true);
    }
  });

  it("o Painel Loja (leitura e atualização) exige a área painel-loja; Produtos não basta", async () => {
    for (const [method, path] of [["GET", "/store/panel"], ["GET", "/store/panel/orders/abc"], ["POST", "/store/panel/refresh"]] as const) {
      for (const outsider of [["chat"], ["produtos"], ["crm", "produtos"]] as AccessAreaId[][]) {
        loadAuthedUser.mockResolvedValueOnce(userWith(outsider));
        const denied = await runGuard(method, path);
        expect(denied.res.statusCode).toBe(403);
        expect(denied.nextCalled).toBe(false);
      }
      loadAuthedUser.mockResolvedValueOnce(userWith(["painel-loja"]));
      expect((await runGuard(method, path)).nextCalled).toBe(true);
    }
  });

  it("sem sessão, o Painel Loja responde 401 e nunca libera", async () => {
    loadAuthedUser.mockResolvedValueOnce({ ok: false, status: 401, error: "Não autenticado." });
    const { res, nextCalled } = await runGuard("GET", "/store/panel");
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("a carga do Airtable (prévia, carga e histórico) exige a área carga-airtable; as outras áreas não bastam", async () => {
    for (const [method, path] of [
      ["GET", "/admin/airtable-carga"],
      ["POST", "/admin/airtable-carga/previews"],
      ["POST", "/admin/airtable-carga/loads"],
    ] as const) {
      expect(findAreaRule(method, path)?.anyOf).toEqual(["carga-airtable"]);
      for (const outsider of [["backup"], ["usuarios", "perfis"], ["pessoas", "crm"]] as AccessAreaId[][]) {
        loadAuthedUser.mockResolvedValueOnce(userWith(outsider, true));
        const denied = await runGuard(method, path);
        expect(denied.res.statusCode).toBe(403);
        expect(denied.nextCalled).toBe(false);
      }
      loadAuthedUser.mockResolvedValueOnce(userWith(["carga-airtable"], true));
      expect((await runGuard(method, path)).nextCalled).toBe(true);
    }
  });

  it("as telas de Pedidos e Clientes seguem com as regras que já tinham", () => {
    expect(findAreaRule("GET", "/store/orders")?.anyOf).toEqual(["painel-loja"]);
    expect(findAreaRule("GET", "/store/customers")?.anyOf).toEqual(["painel-loja"]);
    expect(findAreaRule("GET", "/store/panel")?.anyOf).toEqual(["painel-loja"]);
    expect(findAreaRule("POST", "/store/panel/refresh")?.anyOf).toEqual(["painel-loja"]);
  });

  it("repassa 401 sem sessão e 500 quando não consegue consultar o perfil, nunca libera", async () => {
    loadAuthedUser.mockResolvedValueOnce({ ok: false, status: 401, error: "Não autenticado." });
    const unauthenticated = await runGuard("GET", "/crm/opportunities");
    expect(unauthenticated.res.statusCode).toBe(401);
    expect(unauthenticated.nextCalled).toBe(false);

    loadAuthedUser.mockResolvedValueOnce({ ok: false, status: 500, error: "Erro interno ao verificar permissões." });
    const failed = await runGuard("GET", "/crm/opportunities");
    expect(failed.res.statusCode).toBe(500);
    expect(failed.nextCalled).toBe(false);
  });

  it("não consulta perfil em rotas sem regra (públicas ou só de identidade)", async () => {
    loadAuthedUser.mockClear();
    const { nextCalled } = await runGuard("POST", "/auth/login");
    expect(nextCalled).toBe(true);
    expect(loadAuthedUser).not.toHaveBeenCalled();
  });
});

interface LayerLike {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle?: { stack?: LayerLike[] };
}

function collectRoutes(stack: LayerLike[]): Array<{ method: string; path: string; guarded: boolean }> {
  const routes: Array<{ method: string; path: string; guarded: boolean }> = [];
  for (const layer of stack) {
    if (layer.route) {
      const guarded = layer.route.stack.some(entry =>
        typeof entry.handle === "function" && (entry.handle as unknown as Record<string, unknown>)[ACCESS_GUARD_MARK] === true,
      );
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path, guarded });
      }
    } else if (layer.handle?.stack) {
      routes.push(...collectRoutes(layer.handle.stack));
    }
  }
  return routes;
}

describe("cobertura de áreas nas rotas reais", () => {
  const routes = collectRoutes((router as unknown as { stack: LayerLike[] }).stack);

  it("encontra as rotas registradas", () => {
    expect(routes.length).toBeGreaterThan(80);
  });

  it("toda rota que exige login tem regra de área, ou está na lista explícita de rotas só de identidade", () => {
    const uncovered = routes
      .filter(route => route.guarded)
      .filter(route => !AUTH_ONLY_ROUTES.includes(route.path))
      .filter(route => !findAreaRule(route.method, route.path.replace(/:[A-Za-z]+/g, "x")))
      .map(route => `${route.method} ${route.path}`);
    expect(uncovered).toEqual([]);
  });

  it("nenhuma rota pública cai sob uma regra de área (ficaria bloqueada para quem não tem login)", () => {
    const wronglyBlocked = routes
      .filter(route => !route.guarded)
      .filter(route => findAreaRule(route.method, route.path.replace(/:[A-Za-z]+/g, "x")))
      .map(route => `${route.method} ${route.path}`);
    // Rotas que fazem a própria checagem (ex.: o Express do CRM usa um middleware
    // próprio depois de requireAuth) entram aqui apenas se explicitamente aceitas.
    expect(wronglyBlocked).toEqual([]);
  });

  it("as rotas só de identidade realmente existem", () => {
    for (const path of AUTH_ONLY_ROUTES) {
      expect(routes.some(route => route.path === path)).toBe(true);
    }
  });
});
