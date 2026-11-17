import { describe, expect, it } from "vitest";
import { avaliarAnexoRecebido, enderecoDoProvedor, type AnexoDoCanal } from "./anexosRecebidos";

const anexo = (parcial: Partial<AnexoDoCanal> = {}): AnexoDoCanal => ({
  tipo: "image", mimeDeclarado: "image/jpeg", sha256: null, url: "https://cdn.astenir.com/midia/a.jpg", nome: null, metaId: "wamid.X", ...parcial,
});

describe("enderecoDoProvedor", () => {
  it.each([
    "https://cdn.astenir.com/a.jpg",
    "https://storage.googleapis.com/bucket/a.jpg",
    "https://midia.astenir.com/a.jpg",
    "https://bucket.storage.googleapis.com/a.jpg",
  ])("aceita %s", url => expect(enderecoDoProvedor(url, {})?.href).toBe(url));

  it.each([
    ["http sem TLS", "http://cdn.astenir.com/a.jpg"],
    ["host de outro dono", "https://evil.example.com/a.jpg"],
    ["sufixo enganoso", "https://astenir.com.evil.com/a.jpg"],
    ["domínio parecido", "https://notastenir.com/a.jpg"],
    ["com usuário e senha", "https://user:pass@cdn.astenir.com/a.jpg"],
    ["porta diferente", "https://cdn.astenir.com:8443/a.jpg"],
    ["IP interno", "https://127.0.0.1/a.jpg"],
    ["metadados da nuvem", "https://169.254.169.254/latest/meta-data"],
    ["não é URL", "isto não é endereço"],
    ["outro esquema", "file:///etc/passwd"],
  ])("recusa %s", (_nome, url) => expect(enderecoDoProvedor(url, {})).toBeNull());

  it("hosts extras só entram pela configuração do servidor", () => {
    expect(enderecoDoProvedor("https://midia.parceiro.com/a.jpg", {})).toBeNull();
    expect(enderecoDoProvedor("https://midia.parceiro.com/a.jpg", { HABLLA_MIDIA_HOSTS: " outro.com , MIDIA.parceiro.com " })).not.toBeNull();
  });
});

describe("avaliarAnexoRecebido — o que se confere antes de baixar", () => {
  it("formato e endereço certos ficam pendentes de cópia", () => {
    expect(avaliarAnexoRecebido(anexo(), {})).toEqual({ copia: "pendente", motivo: null });
    expect(avaliarAnexoRecebido(anexo({ mimeDeclarado: "audio/ogg; codecs=opus", tipo: "audio" }), {})).toEqual({ copia: "pendente", motivo: null });
  });

  it("formato fora da lista ou de outro tipo é recusado, mesmo com endereço certo", () => {
    expect(avaliarAnexoRecebido(anexo({ mimeDeclarado: "image/gif" }), {})).toEqual({ copia: "recusado", motivo: "tipo_nao_permitido" });
    expect(avaliarAnexoRecebido(anexo({ mimeDeclarado: null }), {})).toEqual({ copia: "recusado", motivo: "tipo_nao_permitido" });
    expect(avaliarAnexoRecebido(anexo({ tipo: "video", mimeDeclarado: "image/jpeg" }), {})).toEqual({ copia: "recusado", motivo: "tipo_nao_permitido" });
  });

  it("sem endereço fica indisponível; endereço de fora é recusado", () => {
    expect(avaliarAnexoRecebido(anexo({ url: null }), {})).toEqual({ copia: "indisponivel", motivo: "sem_endereco" });
    expect(avaliarAnexoRecebido(anexo({ url: "https://evil.example.com/a.jpg" }), {})).toEqual({ copia: "recusado", motivo: "endereco_nao_confiavel" });
  });
});
