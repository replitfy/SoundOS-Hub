import { describe, expect, it } from "vitest";
import { descreverFormato, interpretarEventoHablla } from "./habllaEvento";
import { dividirParaInstagram, markdownParaTextoSimples } from "./instagramTexto";

describe("interpretarEventoHablla", () => {
  it("reconhece uma DM recebida com remetente em objeto", () => {
    const e = interpretarEventoHablla({
      event: "message.received",
      data: { id: "m1", type: "text", text: "Oi, tudo bem?", direction: "inbound", sender: { id: "17841", username: "@maria.sound" } },
    });
    expect(e).toMatchObject({
      direcao: "entrada", contatoId: "17841", usuario: "maria.sound", texto: "Oi, tudo bem?", externoId: "msg:m1",
    });
  });

  it("reconhece formato plano com igsid e nomes em português", () => {
    const e = interpretarEventoHablla({ evento: "mensagem_recebida", messageId: "abc", igsid: 99, texto: "Quero saber do curso" });
    expect(e).toMatchObject({ direcao: "entrada", contatoId: "99", texto: "Quero saber do curso", externoId: "msg:abc" });
  });

  it("usa `from` como contato numa mensagem recebida", () => {
    const e = interpretarEventoHablla({ type: "incoming", from: "555", message: "Olá" });
    expect(e).toMatchObject({ direcao: "entrada", contatoId: "555", texto: "Olá" });
  });

  it.each([
    ["direção de saída", { direction: "outbound", text: "x", from: "1" }],
    ["tipo de remetente bot", { sender_type: "bot", text: "x", from: "1" }],
    ["tipo de remetente atendente", { message: { sender: { type: "user", id: "1" }, text: "x" } }],
    ["from_me verdadeiro", { from_me: true, text: "x", from: "1" }],
    ["evento de mensagem enviada", { event: "message.sent", text: "x", from: "1" }],
    ["evento de entrega", { event: "message.delivered", text: "x", from: "1" }],
    ["eco explícito", { is_echo: true, direction: "inbound", text: "x", from: "1" }],
  ])("trata %s como saída, mesmo com outras pistas de entrada", (_nome, payload) => {
    expect(interpretarEventoHablla(payload).direcao).toBe("saida");
  });

  it("saída vence entrada quando as pistas divergem", () => {
    const e = interpretarEventoHablla({ event: "message.received", sender_type: "agent", text: "x", from: "1" });
    expect(e.direcao).toBe("saida");
  });

  it("sem pistas de direção, a direção é desconhecida (nunca responde)", () => {
    expect(interpretarEventoHablla({ text: "oi", from: "1" }).direcao).toBe("desconhecida");
    expect(interpretarEventoHablla({ foo: "bar" }).direcao).toBe("desconhecida");
    expect(interpretarEventoHablla(null).direcao).toBe("desconhecida");
    expect(interpretarEventoHablla("texto solto").direcao).toBe("desconhecida");
  });

  it("detecta anexos sem texto", () => {
    const e = interpretarEventoHablla({ direction: "inbound", from: "1", attachments: [{ type: "image", url: "https://x" }] });
    expect(e).toMatchObject({ direcao: "entrada", texto: null, temAnexo: true });
  });

  it("sem id de mensagem usa hash estável do corpo (retentativa = mesmo id)", () => {
    const corpo = { direction: "inbound", from: "1", text: "oi" };
    const a = interpretarEventoHablla(corpo).externoId;
    expect(a).toMatch(/^sha256:/);
    expect(interpretarEventoHablla({ ...corpo }).externoId).toBe(a);
    expect(interpretarEventoHablla({ ...corpo, text: "outra" }).externoId).not.toBe(a);
  });
});

describe("descreverFormato", () => {
  it("devolve só chaves e tipos, sem valores", () => {
    const formato = JSON.stringify(descreverFormato({ data: { text: "segredo", n: 3, lista: [{ a: "x" }] } }));
    expect(formato).not.toContain("segredo");
    expect(formato).toContain("string");
    expect(formato).toContain("number");
  });
});

describe("texto para Instagram", () => {
  it("remove markdown que o Instagram não renderiza", () => {
    const saida = markdownParaTextoSimples("## Título\n**Negrito** e *itálico* e __outro__\n* item um\n- item dois\nVeja [o site](https://exemplo.com/x) e `código`.");
    expect(saida).toBe("Título\nNegrito e itálico e outro\n• item um\n- item dois\nVeja o site: https://exemplo.com/x e código.");
  });

  it("preserva URLs com underscore e não mexe em palavras com underscore", () => {
    const saida = markdownParaTextoSimples("Acesse https://exemplo.com/a_b_c e fale_com_a_gente");
    expect(saida).toBe("Acesse https://exemplo.com/a_b_c e fale_com_a_gente");
  });

  it("divide textos longos sem passar do limite e sem perder conteúdo", () => {
    const paragrafo = "Esta é uma frase de teste razoavelmente longa para o Instagram. ".repeat(6).trim();
    const texto = [paragrafo, paragrafo, paragrafo, paragrafo].join("\n\n");
    const partes = dividirParaInstagram(texto, 900);
    expect(partes.length).toBeGreaterThan(1);
    for (const parte of partes) expect(parte.length).toBeLessThanOrEqual(900);
    expect(partes.join(" ").replace(/\s+/g, " ")).toBe(texto.replace(/\s+/g, " "));
  });

  it("corta palavra gigante sem espaços no limite", () => {
    const partes = dividirParaInstagram("a".repeat(2000), 900);
    expect(partes.map(p => p.length)).toEqual([900, 900, 200]);
  });

  it("texto curto continua em uma mensagem", () => {
    expect(dividirParaInstagram("Oi!")).toEqual(["Oi!"]);
  });
});
