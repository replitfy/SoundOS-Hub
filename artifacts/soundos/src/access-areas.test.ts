import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCESS_AREAS,
  ALL_AREA_IDS,
  SYSTEM_PROFILES,
  canAccessPath,
  effectiveAreas,
  firstAllowedHref,
  requirementForPath,
  sanitizeAreas,
} from "@workspace/access-areas";

describe("catálogo de áreas de acesso", () => {
  it("tem ids e endereços únicos", () => {
    expect(new Set(ALL_AREA_IDS).size).toBe(ALL_AREA_IDS.length);
    expect(new Set(ACCESS_AREAS.map(area => area.href)).size).toBe(ACCESS_AREAS.length);
  });

  it("todo endereço de menu é uma rota conhecida do app que exige a própria área", () => {
    for (const area of ACCESS_AREAS) {
      const requirement = requirementForPath(area.href);
      expect(requirement.kind, area.href).toBe("areas");
      if (requirement.kind === "areas") expect(requirement.anyOf, area.href).toContain(area.id);
    }
  });

  it("os perfis do sistema só usam áreas do catálogo", () => {
    for (const profile of SYSTEM_PROFILES) {
      expect(sanitizeAreas(profile.areas)).toEqual(profile.areas);
    }
  });
});

describe("áreas efetivas de um perfil", () => {
  it("o Admin Master tem todas as áreas mesmo se a linha do banco estiver diferente", () => {
    expect(effectiveAreas({ systemKey: "admin_master", isAdmin: false, areas: [] })).toEqual([...ALL_AREA_IDS]);
  });

  it("áreas de administrador não valem para perfil comum, mesmo gravadas por engano", () => {
    const areas = effectiveAreas({ systemKey: null, isAdmin: false, areas: ["pessoas", "backup", "usuarios", "perfis", "conduta", "carga-airtable"] });
    expect(areas).toEqual(["pessoas"]);
  });

  it("ignora áreas desconhecidas e repetidas", () => {
    expect(effectiveAreas({ systemKey: null, isAdmin: true, areas: ["crm", "crm", "inventada"] })).toEqual(["crm"]);
  });

  it("Usuário e Assistente começam sem telas de administração nem visão financeira", () => {
    for (const key of ["usuario", "assistente"]) {
      const profile = SYSTEM_PROFILES.find(candidate => candidate.key === key)!;
      expect(profile.isAdmin).toBe(false);
      expect(profile.areas).not.toContain("visao-financeira");
      for (const adminOnly of ["usuarios", "perfis", "backup", "conduta", "carga-airtable"]) expect(profile.areas).not.toContain(adminOnly);
      expect(profile.areas).toContain("pessoas");
    }
  });
});

describe("acesso por endereço", () => {
  it("bloqueia o endereço digitado quando a área não está no perfil", () => {
    expect(canAccessPath("/crm", ["pessoas"])).toBe(false);
    expect(canAccessPath("/crm", ["crm"])).toBe(true);
    expect(canAccessPath("/admin/perfis", ["usuarios"])).toBe(false);
  });

  it("ignora barra final e parâmetros de busca", () => {
    expect(canAccessPath("/pessoas/", ["pessoas"])).toBe(true);
    expect(canAccessPath("/pessoas/12?aba=notas", ["pessoas"])).toBe(true);
    expect(canAccessPath("/pessoas/12?aba=notas", ["crm"])).toBe(false);
  });

  it("telas alcançadas por mais de um item aceitam qualquer um deles", () => {
    expect(canAccessPath("/education/cursos/5", ["painel-escola"])).toBe(true);
    expect(canAccessPath("/education/cursos/5", ["eventos"])).toBe(true);
    expect(canAccessPath("/education/cursos/5", ["crm"])).toBe(false);
    expect(canAccessPath("/calendario", ["painel-escola"])).toBe(true);
  });

  it("a página do formulário de interesse pertence à área Eventos", () => {
    expect(canAccessPath("/education/interesse", ["eventos"])).toBe(true);
    expect(canAccessPath("/education/interesse", ["painel-escola"])).toBe(false);
    expect(canAccessPath("/education/interesse", ["crm"])).toBe(false);
  });

  it("Meu perfil e endereços desconhecidos não dependem de área", () => {
    expect(canAccessPath("/meu-perfil", [])).toBe(true);
    expect(requirementForPath("/meu-perfil")).toEqual({ kind: "open" });
    expect(requirementForPath("/nao-existe")).toEqual({ kind: "unknown" });
    expect(canAccessPath("/nao-existe", [])).toBe(true);
  });

  it("a página inicial exige Visão Geral; sem ela, a primeira tela permitida vira a inicial", () => {
    expect(canAccessPath("/", ["crm"])).toBe(false);
    expect(firstAllowedHref(["crm", "pessoas"])).toBe("/pessoas");
    expect(firstAllowedHref(["visao-geral", "crm"])).toBe("/");
  });

  it("perfil sem nenhuma área não tem tela inicial", () => {
    expect(firstAllowedHref([])).toBeNull();
  });
});

describe("menu lateral x catálogo de áreas", () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const layoutSource = readFileSync(resolve(srcDir, "components/layout.tsx"), "utf8");
  const appSource = readFileSync(resolve(srcDir, "App.tsx"), "utf8");

  it("cada item do menu tem o mesmo id e endereço de uma área do catálogo, na mesma ordem", () => {
    const items = [...layoutSource.matchAll(/\{ id: "([a-z-]+)",\s+label: t\("[^"]+"\),\s+href: "([^"]+)"/g)]
      .map(match => ({ id: match[1], href: match[2] }));
    expect(items).toEqual(ACCESS_AREAS.map(area => ({ id: area.id, href: area.href })));
  });

  it("o menu é filtrado pelo perfil e a página de perfis está registrada", () => {
    expect(layoutSource).toContain("access.can(item.id)");
    expect(appSource).toContain('path="/admin/perfis"');
    expect(appSource).toContain("<AccessGate>");
  });
});
