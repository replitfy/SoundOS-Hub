// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { ApiError } from "@workspace/api-client-react";
import { LanguageProvider, useLang, type Lang } from "@/contexts/language";
import { describeProfileError } from "./profile-errors";

function translator(lang: Lang) {
  localStorage.setItem("soundos_lang", lang);
  const { result } = renderHook(() => useLang(), { wrapper: ({ children }) => <LanguageProvider>{children}</LanguageProvider> });
  return result.current.t;
}

function apiError(status: number, data: unknown) {
  return new ApiError(new Response(null, { status }), data, { method: "PUT", url: "/api/admin/access-profiles/1" });
}

describe("describeProfileError", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("traduz o aviso de perfil em uso com a contagem e o singular/plural", () => {
    const pt = translator("pt");
    expect(describeProfileError(apiError(409, { code: "PROFILE_IN_USE", userCount: 1 }), pt)).toContain("1 usuário e");
    expect(describeProfileError(apiError(409, { code: "PROFILE_IN_USE", userCount: 4 }), pt)).toContain("4 usuários");
    expect(describeProfileError(apiError(409, { code: "PROFILE_IN_USE", userCount: 2, onlyDeactivated: true }), pt)).toContain("2 usuários desativados");
    const fr = translator("fr");
    expect(describeProfileError(apiError(409, { code: "PROFILE_IN_USE", userCount: 4 }), fr)).toContain("4 utilisateurs");
  });

  it("traduz regras conhecidas para os dois idiomas e cai numa mensagem genérica no resto", () => {
    const pt = translator("pt");
    expect(describeProfileError(apiError(409, { code: "LAST_MANAGER" }), pt)).toContain("sem nenhum usuário ativo");
    expect(describeProfileError(apiError(409, { code: "NAME_TAKEN" }), pt)).toBe("Já existe um perfil com esse nome.");
    expect(describeProfileError(new Error("boom"), pt)).toBe("Não foi possível concluir a ação. Tente novamente.");
    const fr = translator("fr");
    expect(describeProfileError(apiError(409, { code: "LAST_MANAGER" }), fr)).toContain("sans aucun utilisateur actif");
  });
});
