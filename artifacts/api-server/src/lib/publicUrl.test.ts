import { describe, expect, it } from "vitest";
import { publicAppBaseUrl } from "./publicUrl.js";

describe("publicAppBaseUrl", () => {
  it("prefere PUBLIC_APP_URL e remove barra final", () => {
    expect(publicAppBaseUrl({ PUBLIC_APP_URL: "https://soundfulness.net/", REPLIT_DOMAINS: "x.replit.app" })).toBe("https://soundfulness.net");
  });

  it("aceita PUBLIC_APP_URL sem protocolo", () => {
    expect(publicAppBaseUrl({ PUBLIC_APP_URL: "soundfulness.net" })).toBe("https://soundfulness.net");
  });

  it("entre os domínios publicados prefere o próprio ao temporário", () => {
    expect(publicAppBaseUrl({ REPLIT_DOMAINS: "sound-os-hub.replit.app,soundfulness.net" })).toBe("https://soundfulness.net");
  });

  it("usa o domínio temporário quando é o único", () => {
    expect(publicAppBaseUrl({ REPLIT_DOMAINS: "abc.picard.replit.dev" })).toBe("https://abc.picard.replit.dev");
  });

  it("sem configuração devolve null em vez de inventar endereço", () => {
    expect(publicAppBaseUrl({})).toBeNull();
    expect(publicAppBaseUrl({ PUBLIC_APP_URL: "   ", REPLIT_DOMAINS: "" })).toBeNull();
  });
});
