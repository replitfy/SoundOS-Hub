import { describe, it, expect, vi } from "vitest";
import {
  detectModuloComPrerequisito,
  detectTodosModulosComPrerequisito,
  detectTodosModulosSemAncora,
  resolveOfertaModulo,
  checkModuleEligibility,
  matchCursoCanonico,
  MODULE_PREREQUISITES,
  safeRecordDecisionRun,
  detectDeclaredModuleNonCompletion,
} from "./decisionEngine";

// Estas são as garantias deterministas do gate de elegibilidade (Documento
// 14A): não dependem de LLM, então cobrem tanto o caminho "sem tool" (a
// mensagem da pessoa já nomeia o módulo) quanto o caminho "com tool"
// (recommendVideos chamada com o módulo em qualquer argumento).

describe("detectModuloComPrerequisito", () => {
  it("detecta módulos nomeados em texto livre quando há um termo-âncora do domínio por perto, com ou sem acento", () => {
    expect(detectModuloComPrerequisito("quero saber sobre o módulo Fogo")).toBe("fogo");
    expect(detectModuloComPrerequisito("posso fazer o Ciclo Fogo?")).toBe("fogo");
    expect(detectModuloComPrerequisito("já fiz o curso de Água presencial")).toBe("agua");
    expect(detectModuloComPrerequisito("quero fazer o modulo Fogo agora, pode ser?")).toBe("fogo");
    expect(detectModuloComPrerequisito("manda um vídeo do módulo Ar")).toBe("ar");
    expect(detectModuloComPrerequisito("pode liberar o módulo Terra?")).toBe("terra");
  });

  it("não confunde palavras comuns com o módulo Ar (evita falso positivo por substring)", () => {
    expect(detectModuloComPrerequisito("quero participar de um evento")).toBeNull();
    expect(detectModuloComPrerequisito("nada relacionado aqui")).toBeNull();
  });

  it("NÃO trata água/fogo/ar/terra como o produto quando aparecem como palavras comuns do português, sem contexto de curso/módulo", () => {
    // Estas são exatamente o tipo de frase cotidiana que usa as mesmas
    // palavras dos quatro elementos sem ter nenhuma relação com a Soundfulness.
    expect(detectModuloComPrerequisito("quero saber mais sobre ar")).toBeNull();
    expect(detectModuloComPrerequisito("onde fica o ar condicionado?")).toBeNull();
    expect(detectModuloComPrerequisito("vou regar a terra do jardim")).toBeNull();
    expect(detectModuloComPrerequisito("copo d'água por favor")).toBeNull();
    expect(detectModuloComPrerequisito("acendi o fogo da lareira")).toBeNull();
  });

  it("retorna null para texto vazio ou ausente", () => {
    expect(detectModuloComPrerequisito(undefined)).toBeNull();
    expect(detectModuloComPrerequisito(null)).toBeNull();
    expect(detectModuloComPrerequisito("   ")).toBeNull();
  });
});

describe("detectTodosModulosComPrerequisito", () => {
  it("retorna TODOS os módulos citados numa frase, não só o primeiro — evita que citar Água (nunca bloqueado) mascare uma menção posterior a um módulo bloqueado", () => {
    const modulos = detectTodosModulosComPrerequisito("a sequência da jornada é Água → Fogo → Ar → Terra");
    expect(modulos).toEqual(["agua", "fogo", "ar", "terra"]);
  });

  it("retorna lista vazia sem termo-âncora", () => {
    expect(detectTodosModulosComPrerequisito("ar e água por todo lado")).toEqual([]);
  });
});

describe("detectTodosModulosSemAncora", () => {
  it("detecta menção de módulo em frase de oferta sem termo-âncora de domínio (bypass reportado: 'Você pode fazer Fogo')", () => {
    expect(detectTodosModulosSemAncora("Você pode fazer Fogo")).toEqual(["fogo"]);
    expect(detectTodosModulosSemAncora("Recomendo Fogo para você")).toEqual(["fogo"]);
  });

  it("ainda detecta todos os módulos citados numa sequência", () => {
    expect(detectTodosModulosSemAncora("Água → Fogo → Ar → Terra")).toEqual(["agua", "fogo", "ar", "terra"]);
  });

  it("retorna vazio quando nenhum módulo é citado", () => {
    expect(detectTodosModulosSemAncora("tudo bem, como posso ajudar?")).toEqual([]);
  });
});

describe("matchCursoCanonico", () => {
  it("casa o valor cadastrado de curso (dado estruturado, não frase livre) sem exigir termo-âncora", () => {
    expect(matchCursoCanonico("Ar")).toBe("ar");
    expect(matchCursoCanonico("Água")).toBe("agua");
    expect(matchCursoCanonico("Fogo - turma 2025")).toBe("fogo");
  });

  it("retorna null quando o valor não corresponde a nenhum módulo conhecido", () => {
    expect(matchCursoCanonico("Yoga básico")).toBeNull();
    expect(matchCursoCanonico(null)).toBeNull();
  });
});

describe("resolveOfertaModulo", () => {
  it("trata `curso` como campo estruturado — 'Ar' sozinho já conta, sem precisar de termo-âncora (bug real corrigido: recommendVideos({curso:'Ar'}) tinha que ser bloqueado)", () => {
    expect(resolveOfertaModulo({ curso: "Ar" })).toBe("ar");
    expect(resolveOfertaModulo({ curso: "Fogo" })).toBe("fogo");
    expect(resolveOfertaModulo({ curso: "Água" })).toBe("agua");
  });

  it("encontra o módulo mesmo quando só aparece em textoAdicional/tipoConteudo, não em curso", () => {
    const modulo = resolveOfertaModulo({ curso: "vídeo didático", outrasFontes: [undefined, "quero saber mais sobre o módulo Fogo"] });
    expect(modulo).toBe("fogo");
  });

  it("não confunde 'ar' comum em tipoConteudo/textoAdicional sem âncora (texto livre continua exigindo contexto)", () => {
    expect(resolveOfertaModulo({ curso: undefined, outrasFontes: ["quero saber mais sobre ar"] })).toBeNull();
  });

  it("retorna null quando nenhuma fonte menciona um módulo com pré-requisito", () => {
    expect(resolveOfertaModulo({ curso: null, outrasFontes: [undefined, "quero saber sobre meditação em geral"] })).toBeNull();
  });
});

describe("checkModuleEligibility", () => {
  it("bloqueia Fogo sem Água concluída", () => {
    const result = checkModuleEligibility("fogo", new Set());
    expect(result.status).toBe("bloqueado");
    expect(result.faltando).toEqual(["agua"]);
  });

  it("libera Fogo quando Água já foi concluída", () => {
    const result = checkModuleEligibility("fogo", new Set(["agua"]));
    expect(result.status).toBe("elegivel");
    expect(result.faltando).toEqual([]);
  });

  it("bloqueia Terra faltando qualquer pré-requisito da cadeia Água→Fogo→Ar", () => {
    expect(checkModuleEligibility("terra", new Set()).status).toBe("bloqueado");
    expect(checkModuleEligibility("terra", new Set(["agua"])).status).toBe("bloqueado");
    expect(checkModuleEligibility("terra", new Set(["agua", "fogo"])).status).toBe("bloqueado");
  });

  it("libera Terra somente com Água, Fogo e Ar concluídos", () => {
    const result = checkModuleEligibility("terra", new Set(["agua", "fogo", "ar"]));
    expect(result.status).toBe("elegivel");
  });

  it("Água nunca é bloqueada — não tem pré-requisito", () => {
    expect(checkModuleEligibility("agua", new Set()).status).toBe("elegivel");
  });

  it("a mesma pessoa (mesmo Set de concluídos) recebe a mesma decisão de elegibilidade, "
    + "não importa se o módulo veio da mensagem da pessoa (gate de pré-geração) ou do argumento da tool recommendVideos",
  () => {
    const concluidos = new Set<"agua" | "fogo" | "ar" | "terra">(["agua"]);
    const moduloDaMensagem = detectModuloComPrerequisito("mesmo assim manda um vídeo do Ar");
    const moduloDaTool = resolveOfertaModulo({ curso: "Ar" });
    expect(moduloDaMensagem).toBe("ar");
    expect(moduloDaTool).toBe("ar");
    expect(checkModuleEligibility(moduloDaMensagem!, concluidos)).toEqual(
      checkModuleEligibility(moduloDaTool!, concluidos),
    );
    expect(checkModuleEligibility(moduloDaMensagem!, concluidos).status).toBe("bloqueado");
  });

  it("cadeia de pré-requisitos documentada permanece Água→Fogo→Ar→Terra", () => {
    expect(MODULE_PREREQUISITES.agua).toEqual([]);
    expect(MODULE_PREREQUISITES.fogo).toEqual(["agua"]);
    expect(MODULE_PREREQUISITES.ar).toEqual(["agua", "fogo"]);
    expect(MODULE_PREREQUISITES.terra).toEqual(["agua", "fogo", "ar"]);
  });
});

describe("detectDeclaredModuleNonCompletion", () => {
  it("reconhece negativas explícitas sem convertê-las em conclusão", () => {
    expect(detectDeclaredModuleNonCompletion("Nunca fiz o módulo Água")).toBe("agua");
    expect(detectDeclaredModuleNonCompletion("Ainda não concluí o curso de Água")).toBe("agua");
    expect(detectDeclaredModuleNonCompletion("Ainda não fiz o Água, o que preciso fazer primeiro?")).toBe("agua");
    expect(detectDeclaredModuleNonCompletion("Nunca fiz Fogo, mas concluí Água")).toBe("fogo");
    expect(detectDeclaredModuleNonCompletion("Fogo eu nunca fiz")).toBe("fogo");
  });

  it("não interpreta conclusão positiva nem uma palavra comum como negativa", () => {
    expect(detectDeclaredModuleNonCompletion("Já concluí o módulo Água")).toBeNull();
    expect(detectDeclaredModuleNonCompletion("não bebi água")).toBeNull();
    expect(detectDeclaredModuleNonCompletion("Quero fazer Fogo, nunca fiz nenhum ciclo")).toBeNull();
  });
});

describe("safeRecordDecisionRun", () => {
  it("nunca lança quando a gravação falha (ex.: pessoaId inexistente viola FK) — resposta da Sofia já foi entregue e não pode virar erro", async () => {
    const warn = vi.fn();
    const result = await safeRecordDecisionRun({
      pessoaId: 999_999_999, // não existe — viola a FK de sofia_decision_runs.pessoa_id
      conversationId: null,
      messageId: null,
      conduta: "triagem",
      promptId: null,
      model: "test-model",
      elegibilidadeStatus: "nao_avaliada",
      elegibilidadeMotivo: null,
      ofertaPrincipal: null,
      ofertaAlternativa: null,
      nbaCategoria: "conversar",
      nbaJustificativa: "teste de resiliência a falha de auditoria",
      nivelConfianca: "baixa",
    }, { warn });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
