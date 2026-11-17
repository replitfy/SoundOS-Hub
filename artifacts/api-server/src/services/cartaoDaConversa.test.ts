import { describe, expect, it } from "vitest";
import {
  combinarEntendimento,
  CONVERSA_IDENTIDADE,
  descreverEntendimento,
  ENTENDIMENTO_VAZIO,
  entendimentoDoEvento,
  MAX_ITENS,
  type Entendimento,
} from "./cartaoDaConversa";

const base: Entendimento = { intencao: null, necessidades: [], informacoes: [] };

describe("combinarEntendimento", () => {
  it("primeira anotação: guarda intenção, necessidades e informações e diz o que mudou", () => {
    const r = combinarEntendimento(base, {
      intencao: "Quer fazer o Ciclo Água",
      necessidades: ["Aprender sound healing para atender clientes"],
      informacoes: ["Mora em Campinas"],
    });
    expect(r.mudou).toBe(true);
    expect(r.proximo).toEqual({
      intencao: "Quer fazer o Ciclo Água",
      necessidades: ["Aprender sound healing para atender clientes"],
      informacoes: ["Mora em Campinas"],
    });
    expect(r.mudancas).toEqual({
      intencao: "Quer fazer o Ciclo Água",
      necessidades: ["Aprender sound healing para atender clientes"],
      informacoes: ["Mora em Campinas"],
      removidos: [],
    });
    expect(r.rejeitados).toEqual([]);
  });

  it("repetir o que já está anotado não muda nada (nem com outra caixa ou pontuação)", () => {
    const atual: Entendimento = { intencao: "Quer fazer o Ciclo Água", necessidades: ["Aprender a tocar tigelas"], informacoes: ["Mora em Campinas"] };
    const r = combinarEntendimento(atual, {
      intencao: "quer fazer o ciclo agua!",
      necessidades: ["aprender a tocar tigelas."],
      informacoes: ["MORA EM CAMPINAS"],
    });
    expect(r.mudou).toBe(false);
    expect(r.proximo).toEqual(atual);
  });

  it("a intenção é substituída; necessidades e informações só crescem", () => {
    const atual: Entendimento = { intencao: "Quer saber do Ciclo Água", necessidades: ["Relaxar"], informacoes: [] };
    const r = combinarEntendimento(atual, {
      intencao: "Quer se inscrever no Ciclo Fogo",
      necessidades: ["Estudar à noite"],
      informacoes: ["Trabalha de dia"],
    });
    expect(r.proximo.intencao).toBe("Quer se inscrever no Ciclo Fogo");
    expect(r.proximo.necessidades).toEqual(["Relaxar", "Estudar à noite"]);
    expect(r.proximo.informacoes).toEqual(["Trabalha de dia"]);
  });

  it("remover tira o que deixou de valer e aceita troca no mesmo registro", () => {
    const atual: Entendimento = { intencao: null, necessidades: ["Curso presencial em São Paulo"], informacoes: ["Disponível aos sábados"] };
    const r = combinarEntendimento(atual, {
      necessidades: ["Curso on-line"],
      remover: ["curso presencial em são paulo"],
    });
    expect(r.proximo.necessidades).toEqual(["Curso on-line"]);
    expect(r.proximo.informacoes).toEqual(["Disponível aos sábados"]);
    expect(r.mudancas.removidos).toEqual(["Curso presencial em São Paulo"]);
  });

  it.each([
    ["e-mail", "escreva para ana@exemplo.com", "contato_ou_numero"],
    ["link", "veja https://exemplo.com/ana", "contato_ou_numero"],
    ["telefone", "o número dela é 11 98765-4321", "contato_ou_numero"],
    ["CPF", "cpf 123.456.789-09", "contato_ou_numero"],
    ["valor em reais", "pagou R$ 500 no curso", "valor"],
    ["valor por extenso", "acha que custa 300 reais", "valor"],
    ["diagnóstico", "tem diagnóstico de depressão", "saude"],
    ["medicação", "toma medicação controlada", "saude"],
  ])("recusa %s e nunca grava nem devolve o texto", (_nome, texto, motivo) => {
    const r = combinarEntendimento(base, { informacoes: [texto] });
    expect(r.mudou).toBe(false);
    expect(r.proximo.informacoes).toEqual([]);
    expect(r.rejeitados).toEqual([{ campo: "informacoes", motivo }]);
    expect(JSON.stringify(r.rejeitados)).not.toContain(texto);
  });

  it("recusa intenção com dado sensível e mantém a anterior", () => {
    const atual: Entendimento = { intencao: "Quer conhecer os cursos", necessidades: [], informacoes: [] };
    const r = combinarEntendimento(atual, { intencao: "Quer tratar a ansiedade" });
    expect(r.proximo.intencao).toBe("Quer conhecer os cursos");
    expect(r.rejeitados).toEqual([{ campo: "intencao", motivo: "saude" }]);
  });

  it("um item recusado não impede os válidos do mesmo registro", () => {
    const r = combinarEntendimento(base, { necessidades: ["Aprender a tocar tigela", "Seu e-mail é a@b.co"] });
    expect(r.proximo.necessidades).toEqual(["Aprender a tocar tigela"]);
    expect(r.rejeitados).toHaveLength(1);
  });

  it("respeita o limite de itens e avisa", () => {
    const cheio: Entendimento = {
      intencao: null,
      necessidades: Array.from({ length: MAX_ITENS }, (_v, i) => `Necessidade número ${i} bem distinta`),
      informacoes: [],
    };
    const r = combinarEntendimento(cheio, { necessidades: ["Mais uma necessidade totalmente nova"] });
    expect(r.proximo.necessidades).toHaveLength(MAX_ITENS);
    expect(r.rejeitados).toEqual([{ campo: "necessidades", motivo: "limite" }]);
  });

  it("entradas fora do formato são ignoradas sem quebrar", () => {
    const r = combinarEntendimento(base, { intencao: 42, necessidades: "texto solto", informacoes: [1, null, "  ", "Gosta de yoga"], remover: {} });
    expect(r.proximo).toEqual({ intencao: null, necessidades: [], informacoes: ["Gosta de yoga"] });
  });

  it("corta textos longos em vez de gravar tudo", () => {
    const r = combinarEntendimento(base, { necessidades: ["a".repeat(500)] });
    expect(r.proximo.necessidades[0]!.length).toBeLessThanOrEqual(160);
  });
});

describe("descreverEntendimento / entendimentoDoEvento", () => {
  it("resume o que já foi anotado para a Sofia só acrescentar o novo", () => {
    expect(descreverEntendimento({ intencao: "Quer o Ciclo Água", necessidades: ["Relaxar", "Aprender"], informacoes: [] }))
      .toBe("cartao_no_crm: intencao=Quer o Ciclo Água; necessidades=Relaxar | Aprender");
    expect(descreverEntendimento(ENTENDIMENTO_VAZIO)).toBe("cartao_no_crm: ainda sem anotações");
  });

  it("lê o retrato do evento e trata metadados fora do formato como vazio", () => {
    expect(entendimentoDoEvento({ sofiaEntendimento: { intencao: "Quer X", necessidades: ["a", 3], informacoes: "x" } }))
      .toEqual({ intencao: "Quer X", necessidades: ["a"], informacoes: [] });
    expect(entendimentoDoEvento(null)).toEqual(ENTENDIMENTO_VAZIO);
    expect(entendimentoDoEvento({ sofiaEntendimento: { intencao: "  " } })).toEqual(ENTENDIMENTO_VAZIO);
  });
});

describe("identidade do cartão da conversa", () => {
  it("não colide com o cartão de um evento nem com o do formulário geral", () => {
    expect(CONVERSA_IDENTIDADE).toBe("label:conversa no whatsapp");
    expect(CONVERSA_IDENTIDADE).not.toMatch(/^(curso:|label:interesse-geral)/);
  });
});
