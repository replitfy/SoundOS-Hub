import { describe, expect, it } from "vitest";
import { buildInteresseIframe, buildInteresseUrl, normalizeGrupo, parseCor } from "./interesse-embed";

describe("interesse-embed", () => {
  it("normaliza o grupo como o servidor", () => {
    expect(normalizeGrupo("Água")).toBe("agua");
    expect(normalizeGrupo("  Ciclo  do Fogo! ")).toBe("ciclo-do-fogo");
    expect(normalizeGrupo("<script>alert(1)</script>")).toBe("script-alert-1-script");
    expect(normalizeGrupo("a".repeat(60))).toHaveLength(40);
    expect(normalizeGrupo("---")).toBe("");
    expect(normalizeGrupo(null)).toBe("");
  });

  it("aceita cor com ou sem #", () => {
    expect(parseCor("2ba8e0")).toBe("#2BA8E0");
    expect(parseCor("#2BA8E0")).toBe("#2BA8E0");
    expect(parseCor("azul")).toBeNull();
    expect(parseCor("#fff")).toBeNull();
  });

  it("monta o link com o prefixo da aplicação e sem # na cor", () => {
    expect(buildInteresseUrl({ origin: "https://x.dev", base: "/", grupo: "Água", embed: true }))
      .toBe("https://x.dev/interesse?embed=1&grupo=agua");
    expect(buildInteresseUrl({ origin: "https://x.dev", base: "/app/", grupo: "terra", cor: "#8cc63f", embed: true }))
      .toBe("https://x.dev/app/interesse?embed=1&grupo=terra&cor=8CC63F");
    expect(buildInteresseUrl({ origin: "https://x.dev", base: "/" })).toBe("https://x.dev/interesse");
  });

  it("inclui o vínculo opcional com o curso ou evento", () => {
    expect(buildInteresseUrl({ origin: "https://x.dev", base: "/", grupo: "agua", eventoId: 42 }))
      .toBe("https://x.dev/interesse?grupo=agua&eventoId=42");
    expect(buildInteresseUrl({ origin: "https://x.dev", base: "/", eventoId: "invalid" }))
      .toBe("https://x.dev/interesse");
  });

  it("gera o iframe com o link informado", () => {
    const code = buildInteresseIframe("https://x.dev/interesse?embed=1&grupo=ar");
    expect(code).toContain('src="https://x.dev/interesse?embed=1&grupo=ar"');
    expect(code).toContain("<iframe");
  });
});
