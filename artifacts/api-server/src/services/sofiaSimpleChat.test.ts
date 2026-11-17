import { describe, expect, it } from "vitest";
import {
  SIMPLE_COMERCIAL_BLOCK,
  SIMPLE_FALLBACK_PROMPT,
  SIMPLE_FORBIDDEN_BLOCK,
  aplicarGuardas,
  dataHojeSaoPaulo,
  montarContexto,
  montarSystemPrompt,
} from "./sofiaSimpleChat";
import { VALOR_NAO_CONFIRMADO } from "./sofiaSimpleGuards";
import type { HistoricoPessoa } from "./sofiaPessoa";
import { descreverFormularioRecente } from "./sofiaTools/cartaoDoFormulario";
import { REGRA_CONTATO_APOS_FORMULARIO } from "./sofiaTools/contatoAposFormulario";
import { SOFIA_PROMPT_PADRAO_BODY } from "./sofiaPromptPadrao";

const AGORA = new Date("2026-10-07T02:30:00Z"); // 23:30 de 06/10 em São Paulo

const historico: HistoricoPessoa = {
  primeiro_nome: "Bruna",
  ficha: {
    cidade: "Campinas", profissao: "Professora", servico_interesse: null, objetivos_declarados: ["dormir melhor"],
    intencao_principal: null, preferred_language: null, idade_declarada: 41, idade_declarada_em: "2026-09-01",
  },
  ultima_conversa_em: "2026-09-20T15:00:00.000Z",
  resumos_anteriores: [],
  mensagens_recentes: [{ papel: "pessoa", texto: "Quero saber do Ciclo Água" }],
};

describe("data de hoje", () => {
  it("usa o fuso de São Paulo, não UTC", () => {
    expect(dataHojeSaoPaulo(AGORA).iso).toBe("2026-10-06");
  });
});

describe("montarContexto", () => {
  it("pessoa conhecida: primeiro nome, campos conhecidos e assunto anterior", () => {
    const ctx = montarContexto({ estado: "reconhecida", pessoaId: 7, nomeInformado: "Bruna Lima", historico, now: AGORA });
    expect(ctx).toContain("ficha: conhecida");
    expect(ctx).toContain("nome: Bruna");
    expect(ctx).toContain("cidade=Campinas");
    expect(ctx).toContain("idade=41");
    expect(ctx).toContain("ultima_conversa_em: 2026-09-20");
    expect(ctx).toContain("pessoa: Quero saber do Ciclo Água");
    expect(ctx).toContain("(2026-10-06)");
  });

  it("traz o formulário recente do cartão quando a pessoa tem ficha, e nunca para conversa sem ficha", () => {
    const linha = 'formulario_recente: preencheu o formulário de interesse "Lista de interesse — Água" em 06/10/2026.';
    const comFicha = montarContexto({ estado: "vinculada", pessoaId: 7, nomeInformado: null, historico, now: AGORA, formularioRecente: linha });
    expect(comFicha).toContain(linha);
    const semFicha = montarContexto({ estado: "sem_celular", pessoaId: null, nomeInformado: null, historico: null, now: AGORA, formularioRecente: linha });
    expect(semFicha).not.toContain("formulario_recente");
  });

  it("ficha recém-criada não traz histórico", () => {
    const ctx = montarContexto({ estado: "criada", pessoaId: 8, nomeInformado: "Ana Souza", historico: null, now: AGORA });
    expect(ctx).toContain("ficha: nova");
    expect(ctx).toContain("nome: Ana");
    expect(ctx).not.toContain("resumo_ultimas_conversas");
  });

  it.each(["nome_divergente", "celular_compartilhado", "erro", "sem_celular"] as const)(
    "%s: anônima, sem nenhum dado de ficha",
    estado => {
      const ctx = montarContexto({ estado, pessoaId: null, nomeInformado: "Carlos", historico, now: AGORA });
      expect(ctx).toContain("ficha: nenhuma");
      expect(ctx).not.toContain("Bruna");
      expect(ctx).not.toContain("Campinas");
      expect(ctx).not.toContain("Ciclo Água");
    },
  );
});

describe("montarContexto no WhatsApp: cartão da conversa", () => {
  const fichaNova: HistoricoPessoa = { ...historico, primeiro_nome: null, ultima_conversa_em: null, resumos_anteriores: [], mensagens_recentes: [] };

  it("traz a regra do cartão e o que já foi anotado; sem o canal, nada disso aparece", () => {
    const linha = "cartao_no_crm: intencao=Quer o Ciclo Água";
    const zap = montarContexto({ estado: "vinculada", pessoaId: 8, nomeInformado: null, historico: fichaNova, now: AGORA, canal: "whatsapp", entendimento: linha });
    expect(zap).toContain("atualizar_cartao");
    expect(zap).toContain(linha);
    const fora = montarContexto({ estado: "vinculada", pessoaId: 8, nomeInformado: null, historico: fichaNova, now: AGORA });
    expect(fora).not.toContain("atualizar_cartao");
  });

  it("conversa sem ficha também recebe a regra, mas nunca o que está anotado", () => {
    const ctx = montarContexto({ estado: "sem_celular", pessoaId: null, nomeInformado: null, historico: null, now: AGORA, canal: "whatsapp" });
    expect(ctx).toContain("atualizar_cartao");
    expect(ctx).not.toContain("cartao_no_crm:");
    expect(ctx).not.toContain("como gosta de ser chamada");
  });

  it("ficha aberta nesta conversa e ainda sem nome: é nova e a Sofia pergunta o nome uma vez", () => {
    const ctx = montarContexto({ estado: "vinculada", pessoaId: 8, nomeInformado: null, historico: fichaNova, now: AGORA, canal: "whatsapp" });
    expect(ctx).toContain("ficha: nova");
    expect(ctx).not.toContain("nome: ");
    expect(ctx).toContain("como gosta de ser chamada");
    expect(ctx).toContain("não insista");
  });

  it("com nome conhecido não pergunta de novo", () => {
    const ctx = montarContexto({ estado: "vinculada", pessoaId: 8, nomeInformado: null, historico: { ...fichaNova, primeiro_nome: "Bruna" }, now: AGORA, canal: "whatsapp" });
    expect(ctx).toContain("nome: Bruna");
    expect(ctx).not.toContain("como gosta de ser chamada");
  });

  it("conversa ligada à ficha com conversa anterior continua conhecida", () => {
    const ctx = montarContexto({ estado: "vinculada", pessoaId: 7, nomeInformado: null, historico, now: AGORA, canal: "whatsapp" });
    expect(ctx).toContain("ficha: conhecida");
  });

  it("outros canais não recebem a pergunta do nome", () => {
    const ctx = montarContexto({ estado: "vinculada", pessoaId: 8, nomeInformado: null, historico: fichaNova, now: AGORA });
    expect(ctx).not.toContain("como gosta de ser chamada");
  });
});

describe("montarSystemPrompt", () => {
  it("anexa os blocos do modo simples e o CONTEXTO ao prompt ativo", () => {
    const prompt = montarSystemPrompt("PROMPT ATIVO", "CONTEXTO\nficha: nenhuma");
    expect(prompt.startsWith("PROMPT ATIVO")).toBe(true);
    expect(prompt).toContain(SIMPLE_COMERCIAL_BLOCK);
    expect(prompt).toContain(SIMPLE_FORBIDDEN_BLOCK);
    expect(prompt.endsWith("CONTEXTO\nficha: nenhuma")).toBe(true);
  });

  it("sem prompt ativo usa o fallback", () => {
    expect(montarSystemPrompt(null, "CONTEXTO").startsWith(SIMPLE_FALLBACK_PROMPT)).toBe(true);
  });

  it("a regra confirmada de formulário vem depois até de um prompt editado que manda enviar a página", () => {
    const ativo = "PROMPT DA EQUIPE: apresente o evento e sempre passe o link da página.";
    const contexto = montarContexto({
      estado: "vinculada", pessoaId: 7, nomeInformado: null, historico, now: AGORA, canal: "whatsapp",
      formularioRecente: descreverFormularioRecente({
        titulo: "Retiro do Mestre Interior", grupo: "Retiro", paginaOrigem: null, quando: AGORA,
      }),
    });
    const prompt = montarSystemPrompt(ativo, contexto);
    expect(prompt.startsWith(ativo)).toBe(true);
    expect(prompt.indexOf(REGRA_CONTATO_APOS_FORMULARIO)).toBeGreaterThan(prompt.indexOf(SIMPLE_COMERCIAL_BLOCK));
    expect(prompt).toContain("prioridade sobre orientações gerais");
  });

  it("sem formulário confirmado não acrescenta a exceção contextual nem usa dados sem ficha", () => {
    const semFormulario = montarContexto({ estado: "vinculada", pessoaId: 7, nomeInformado: null, historico, now: AGORA });
    const semFicha = montarContexto({
      estado: "sem_celular", pessoaId: null, nomeInformado: null, historico: null, now: AGORA,
      formularioRecente: REGRA_CONTATO_APOS_FORMULARIO,
    });
    for (const ctx of [semFormulario, semFicha]) {
      expect(montarSystemPrompt("PROMPT ATIVO", ctx)).not.toContain(REGRA_CONTATO_APOS_FORMULARIO);
    }
  });

  it("o prompt padrão documenta a exceção somente quando há formulario_recente", () => {
    expect(SOFIA_PROMPT_PADRAO_BODY).toContain("Quando houver `formulario_recente`");
    expect(SOFIA_PROMPT_PADRAO_BODY).toContain("Sem esse contexto, mantenha o atendimento normal.");
    expect(SOFIA_PROMPT_PADRAO_BODY).toContain(REGRA_CONTATO_APOS_FORMULARIO);
  });
});

describe("aplicarGuardas", () => {
  const saida = JSON.stringify({ edicao: { url_evento: "https://www.soundfulness.online/event-details/x", data_inicio: "2027-02-10", preco: 4800 } });

  it("mantém fatos das tools e remove só a URL inventada", () => {
    const r = aplicarGuardas(
      "Custa R$ 4.800,00, começa em 10/02/2027. Link: https://www.soundfulness.online/event-details/x\nVeja https://fake.example/y também.",
      [saida], "2026-10-06",
    );
    expect(r.texto).toContain("R$ 4.800,00");
    expect(r.texto).toContain("10/02/2027");
    expect(r.texto).toContain("https://www.soundfulness.online/event-details/x");
    expect(r.texto).not.toContain("fake.example");
    expect(r.urlsRemovidas).toBe(1);
  });

  it("troca valor inventado pela frase de confirmação", () => {
    const r = aplicarGuardas("Sai por R$ 3.999,00.", [saida], "2026-10-06");
    expect(r.texto).toContain(VALOR_NAO_CONFIRMADO);
    expect(r.valoresTrocados).toBe(1);
  });
});
