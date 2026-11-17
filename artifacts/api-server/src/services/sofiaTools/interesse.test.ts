import { describe, expect, it, vi } from "vitest";

vi.mock("../sofiaEventCatalog.js", () => ({ getOfficialEventCatalog: vi.fn() }));
vi.mock("@workspace/db", () => ({
  db: { select: () => { throw new Error("sem banco no teste"); } },
  sofiaEventAliasesTable: {},
  videoEventosTable: {},
  videosTable: {},
  eventoFormularios: {},
  commercialOpportunities: {},
  OPPORTUNITY_NUCLEI: ["EDUCATION", "EXPERIENCES"],
}));

import { ALIASES_PADRAO } from "./eventos.js";
import { montarContextoConversa } from "./interesseContexto.js";
import { enviarInteresseCom, interesseDoPedidoDeValor, type AbrirCartaoParams, type InteresseDeps } from "./interesse.js";
import { fatosPermitidos, urlsPermitidas } from "../sofiaSimpleGuards.js";

function item(eventId: number, name: string, startDate: string, extra: Record<string, unknown> = {}) {
  return {
    eventId, slug: `e-${eventId}`, name, description: null, startDate, endDate: null,
    location: "São Paulo", nucleus: "EDUCATION", eventType: "CURSO", classId: null, courseId: null,
    modality: null, workload: null,
    sourceUrl: `https://www.soundfulness.online/event-details/e-${eventId}`,
    ...extra,
  };
}

const catalogo = [
  item(4, "CICLO TERRA - Sound Healing Avançado", "2026-10-29"),
  item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13"),
  item(5, "CICLO FOGO - Ritual de Som e Musicalidade intuitiva", "2027-03-24"),
  item(11, "CICLO ÁGUA - Sound Healing Individual", "2027-05-26"),
];

function criarDeps(extra: Partial<InteresseDeps> = {}) {
  const cartoes: AbrirCartaoParams[] = [];
  const deps: InteresseDeps = {
    catalogo: async () => catalogo,
    aliases: async () => [...ALIASES_PADRAO],
    formulario: async eventoId => `form-${eventoId}-interesse`,
    baseUrl: () => "https://soundfulness.net",
    contexto: async (_pessoaId, conversationId, now) => montarContextoConversa({
      conversationId,
      now,
      mensagensDaPessoa: ["Tenho interesse no Ciclo Água", "Quero saber como participar"],
      ficha: { cidade: "Campinas", profissao: null, servicoInteresse: "Sound Healing", objetivosDeclarados: ["Atender clientes"] },
    }),
    // Padrão: conversa do chat interno, que não tem ficha por canal externo.
    pessoaDoCanal: async () => ({ status: "fora_do_instagram", pessoaId: null }),
    abrirCartao: async params => { cartoes.push(params); return "criado"; },
    ...extra,
  };
  return { deps, cartoes };
}

const base = { pessoaId: 77, conversationId: 3072 };

describe("enviar_interesse", () => {
  it("manda o link da edição pedida, sem nenhum valor, e abre o cartão uma vez", async () => {
    const { deps, cartoes } = criarDeps();
    const r = await enviarInteresseCom({ ...base, evento: "Qual o preço do workshop Água?" }, deps);
    expect(r.status).toBe("ok");
    expect(r.evento).toMatchObject({ nome: "CICLO ÁGUA - Sound Healing Individual", data_inicio: "2027-01-13" });
    expect(r.link_interesse).toBe("https://soundfulness.net/interesse/form-3-interesse");
    expect(r.outras_edicoes.map(e => e.data_inicio)).toEqual(["2027-05-26"]);
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ pessoaId: 77, nucleus: "EDUCATION", eventoId: 3, conversationId: 3072 });
    expect(cartoes[0]!.rotulo).toContain("13/01/2027");

    const saida = JSON.stringify(r);
    expect(saida).not.toMatch(/preco|price|R\$|2800|4800/i);
    // Nenhum número solto vira "valor permitido" para a guarda de preços do turno.
    expect(fatosPermitidos([saida]).valores.size).toBe(0);
    expect(urlsPermitidas([saida]).has("https://soundfulness.net/interesse/form-3-interesse")).toBe(true);
  });

  it("usa a data pedida para escolher outra edição do mesmo evento", async () => {
    const { deps, cartoes } = criarDeps();
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Água", data: "2027-05" }, deps);
    expect(r.evento?.data_inicio).toBe("2027-05-26");
    expect(r.link_interesse).toContain("form-11-interesse");
    expect(cartoes[0]?.eventoId).toBe(11);
  });

  it("sem evento citado não escolhe nenhum: devolve candidatos para a Sofia perguntar e não abre cartão", async () => {
    const { deps, cartoes } = criarDeps();
    for (const evento of [null, undefined, "   "]) {
      const r = await enviarInteresseCom({ ...base, evento }, deps);
      expect(r.status).toBe("evento_nao_identificado");
      expect(r.evento).toBeNull();
      expect(r.link_interesse).toBeNull();
      expect(r.candidatos.map(c => c.data_inicio)).toEqual(["2026-10-29", "2027-01-13", "2027-03-24"]);
      expect(r.instrucao).toMatch(/Pergunte qual/);
    }
    expect(cartoes).toHaveLength(0);
  });

  it("interesse sem pergunta de preço abre o cartão com o contexto da conversa", async () => {
    const { deps, cartoes } = criarDeps();
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Água" }, deps);
    expect(r.status).toBe("ok");
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]!.contexto).toMatchObject({
      conversationId: 3072,
      mensagens: ["Tenho interesse no Ciclo Água", "Quero saber como participar"],
      ficha: { cidade: "Campinas", servicoInteresse: "Sound Healing", objetivos: ["Atender clientes"] },
    });
    expect(cartoes[0]!.contexto.ficha).not.toHaveProperty("profissao");
  });

  it("o contexto guardado no cartão nunca traz preço de evento nem texto da Sofia", async () => {
    const { deps, cartoes } = criarDeps();
    await enviarInteresseCom({ ...base, evento: "Ciclo Água" }, deps);
    expect(JSON.stringify(cartoes[0]!.contexto)).not.toMatch(/R\$|preco|preço|price|2800|4800/i);
  });

  it("sem conseguir ler o contexto o cartão abre mesmo assim, só com a referência da conversa", async () => {
    const { deps, cartoes } = criarDeps({ contexto: async () => { throw new Error("leitura falhou"); } });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Água" }, deps);
    expect(r.status).toBe("ok");
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]!.contexto).toMatchObject({ conversationId: 3072, mensagens: [], ficha: {} });
  });

  it("sem ficha envia só o link e não abre cartão", async () => {
    const { deps, cartoes } = criarDeps();
    const r = await enviarInteresseCom({ ...base, pessoaId: null, evento: "Ciclo Fogo" }, deps);
    expect(r.link_interesse).toContain("form-5-interesse");
    expect(cartoes).toHaveLength(0);
    expect(r.instrucao).toMatch(/cadastro de interesse é o caminho/);
  });

  it("sem formulário ativo não inventa link, mas ainda abre o cartão avisando o time", async () => {
    const { deps, cartoes } = criarDeps({ formulario: async () => null });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Fogo" }, deps);
    expect(r.link_interesse).toBeNull();
    expect(r.instrucao).toMatch(/não invente link/);
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]!.textoProximaAcao).toMatch(/link/i);
  });

  it("sem endereço público conhecido não monta link", async () => {
    const { deps } = criarDeps({ baseUrl: () => null });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Fogo" }, deps);
    expect(r.link_interesse).toBeNull();
  });

  it("falha ao abrir o cartão não impede o link nem aparece para a pessoa", async () => {
    const { deps } = criarDeps({ abrirCartao: async () => { throw new Error("banco fora"); } });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Fogo" }, deps);
    expect(r.status).toBe("ok");
    expect(r.link_interesse).toContain("form-5-interesse");
    expect(JSON.stringify(r)).not.toMatch(/banco fora|falhou/i);
  });

  it("cartão já existente não duplica e a instrução continua igual", async () => {
    const { deps } = criarDeps({ abrirCartao: async () => "ja_existia" });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Fogo" }, deps);
    expect(r.instrucao).toMatch(/time interno vai retornar/);
  });

  it("pede esclarecimento quando o evento é ambíguo ou desconhecido, sem abrir cartão", async () => {
    const { deps, cartoes } = criarDeps();
    const ambiguo = await enviarInteresseCom({ ...base, evento: "ciclo" }, deps);
    expect(ambiguo.status).toBe("ambiguo");
    expect(ambiguo.candidatos.length).toBeGreaterThan(1);
    const desconhecido = await enviarInteresseCom({ ...base, evento: "aula de violão" }, deps);
    expect(desconhecido.status).toBe("evento_nao_identificado");
    expect(desconhecido.link_interesse).toBeNull();
    expect(cartoes).toHaveLength(0);
  });

  it("falou da formação em Sound Healing sem dizer o curso: só Água e Fogo viram candidatos, sem cartão nem link", async () => {
    const { deps, cartoes } = criarDeps();
    for (const evento of ["Curso de Sound Healing", "formação", "ciclos"]) {
      const r = await enviarInteresseCom({ ...base, evento }, deps);
      expect(r.status).toBe("ambiguo");
      expect(r.candidatos.map(c => c.nome)).toEqual([
        "CICLO ÁGUA - Sound Healing Individual",
        "CICLO FOGO - Ritual de Som e Musicalidade intuitiva",
      ]);
      expect(r.instrucao).toMatch(/Não ofereça Terra nem Ar/);
      expect(r.link_interesse).toBeNull();
    }
    expect(cartoes).toHaveLength(0);
  });

  it("pedir o ciclo avançado pelo nome continua abrindo o interesse do Ciclo Terra", async () => {
    const { deps } = criarDeps();
    const r = await enviarInteresseCom({ ...base, evento: "avançado" }, deps);
    expect(r.status).toBe("ok");
    expect(r.evento?.nome).toMatch(/TERRA/);
  });

  it("data sem edição correspondente lista as datas existentes", async () => {
    const { deps, cartoes } = criarDeps();
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Água", data: "2028-01" }, deps);
    expect(r.status).toBe("edicao_nao_encontrada");
    expect(r.outras_edicoes.map(e => e.data_inicio)).toEqual(["2027-01-13", "2027-05-26"]);
    expect(cartoes).toHaveLength(0);
  });

  it("agenda vazia não abre cartão", async () => {
    const { deps, cartoes } = criarDeps({ catalogo: async () => [] });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Água" }, deps);
    expect(r.status).toBe("sem_evento");
    expect(cartoes).toHaveLength(0);
  });

  it("evento sem núcleo válido não abre cartão, mas entrega o link", async () => {
    const { deps, cartoes } = criarDeps({ catalogo: async () => [item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13", { nucleus: "outro" })] });
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Água" }, deps);
    expect(r.link_interesse).toContain("form-3-interesse");
    expect(cartoes).toHaveLength(0);
  });
});

describe("interesse dentro do handoff de pagamento", () => {
  it("preço + parcelamento de um evento: abre o cartão e devolve a frase com o link, sem valor", async () => {
    const { deps, cartoes } = criarDeps();
    const frase = await interesseDoPedidoDeValor(
      { mensagem: "Quanto custa o Ciclo Água? Dá pra parcelar?", pessoaId: 77, conversationId: 3072 },
      deps,
    );
    expect(frase).toBe("Para agilizar, deixe seu interesse no cadastro da edição de 13/01/2027: https://soundfulness.net/interesse/form-3-interesse");
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ pessoaId: 77, eventoId: 3 });
  });

  it("sem ficha só entrega o link; sem evento citado não abre cartão nem escolhe uma edição qualquer", async () => {
    const semFicha = criarDeps();
    expect(await interesseDoPedidoDeValor({ mensagem: "Quanto custa o Ciclo Fogo? Aceita pix?", pessoaId: null, conversationId: null }, semFicha.deps))
      .toContain("form-5-interesse");
    expect(semFicha.cartoes).toHaveLength(0);

    const semEvento = criarDeps();
    expect(await interesseDoPedidoDeValor({ mensagem: "Dá pra parcelar no cartão de crédito?", pessoaId: 77, conversationId: 3072 }, semEvento.deps)).toBeNull();
    expect(semEvento.cartoes).toHaveLength(0);
  });

  it("Terra e Ar no handoff de pagamento: sem frase de que já fez um ciclo, nem link nem cartão; o time assume", async () => {
    const { deps, cartoes } = criarDeps();
    for (const mensagem of [
      "Dá para parcelar o Ciclo Terra?",
      "Posso pagar o Sound Healing Avançado no pix?",
      "Não fiz nenhum ciclo ainda. Dá pra parcelar o Terra?",
      "Quero parcelar o Terra, nunca fiz o Água",
    ]) {
      expect(await interesseDoPedidoDeValor({ mensagem, pessoaId: 77, conversationId: 3072 }, deps)).toBeNull();
    }
    expect(cartoes).toHaveLength(0);
    const r = await enviarInteresseCom({ ...base, evento: "Ciclo Terra", semCicloFeito: true }, deps);
    expect(r).toMatchObject({ status: "etapa_posterior", link_interesse: null, evento: null });
    expect(r.instrucao).toMatch(/Não envie link/);
  });

  it("Terra no handoff de pagamento de quem disse que já fez um ciclo (na mensagem ou antes) segue com link e cartão", async () => {
    const { deps, cartoes } = criarDeps();
    expect(await interesseDoPedidoDeValor({ mensagem: "Já sou aluna da Soundfulness. Dá pra parcelar o Terra?", pessoaId: 77, conversationId: 3072 }, deps))
      .toBe("Para agilizar, deixe seu interesse no cadastro da edição de 29/10/2026: https://soundfulness.net/interesse/form-4-interesse");
    expect(await interesseDoPedidoDeValor({
      mensagem: "Dá para parcelar o Ciclo Terra?", pessoaId: 77, conversationId: 3072,
      mensagensDaPessoa: ["Oi!", "Eu fiz o Ciclo Fogo ano passado"],
    }, deps)).toContain("form-4-interesse");
    expect(cartoes).toHaveLength(2);
    expect(cartoes[0]).toMatchObject({ eventoId: 4 });
  });

  it("Água e Fogo no handoff de pagamento seguem como sempre, mesmo sem ciclo feito", async () => {
    const { deps, cartoes } = criarDeps();
    expect(await interesseDoPedidoDeValor({ mensagem: "Dá para parcelar o Ciclo Fogo?", pessoaId: 77, conversationId: 3072 }, deps))
      .toContain("form-5-interesse");
    expect(cartoes).toHaveLength(1);
  });

  it("quem já pagou ou tem problema com cobrança segue só o handoff", async () => {
    const { deps, cartoes } = criarDeps();
    for (const mensagem of [
      "Paguei o Ciclo Água no pix e não recebi nada",
      "Já fiz o pagamento do Ciclo Água, segue o comprovante",
    ]) {
      expect(await interesseDoPedidoDeValor({ mensagem, pessoaId: 77, conversationId: 3072 }, deps)).toBeNull();
    }
    expect(cartoes).toHaveLength(0);
  });

  it("sem formulário ativo não inventa link, mas o cartão avisa o time", async () => {
    const { deps, cartoes } = criarDeps({ formulario: async () => null });
    expect(await interesseDoPedidoDeValor({ mensagem: "Qual o valor do Ciclo Água?", pessoaId: 77, conversationId: 3072 }, deps)).toBeNull();
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]!.textoProximaAcao).toContain("não conseguiu enviar o link");
  });
});

describe("interesse de quem conversa pelo Instagram sem telefone", () => {
  const instagram = { pessoaId: null, conversationId: 4100 };
  const fichaDoInstagram = (pessoaId: number | null, status: "criada" | "reconhecida" | "usuario_compartilhado" | "ficha_inativa" = "criada") =>
    async () => ({ status, pessoaId });

  it("evento específico: acha a ficha da conversa e abre o cartão pelo mesmo caminho, com a conversa", async () => {
    const { deps, cartoes } = criarDeps({ pessoaDoCanal: fichaDoInstagram(900) });
    const r = await enviarInteresseCom({ ...instagram, evento: "Ciclo Água" }, deps);
    expect(r.status).toBe("ok");
    expect(r.link_interesse).toBe("https://soundfulness.net/interesse/form-3-interesse");
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ pessoaId: 900, nucleus: "EDUCATION", eventoId: 3, conversationId: 4100 });
    expect(cartoes[0]!.contexto).toMatchObject({ conversationId: 4100, mensagens: ["Tenho interesse no Ciclo Água", "Quero saber como participar"] });
    expect(r.instrucao).toMatch(/time interno vai retornar/);
    // Nada de valor de evento na resposta nem no contexto do cartão.
    expect(JSON.stringify(r)).not.toMatch(/preco|price|R\$|2800|4800/i);
    expect(JSON.stringify(cartoes[0]!.contexto)).not.toMatch(/R\$|preco|preço|price|2800|4800/i);
  });

  it("pessoa que já tem ficha com o mesmo usuário: o cartão vai para essa ficha, sem criar outra", async () => {
    const chamadas: number[] = [];
    const { deps, cartoes } = criarDeps({
      pessoaDoCanal: async conversationId => { chamadas.push(conversationId); return { status: "reconhecida", pessoaId: 55 }; },
    });
    await enviarInteresseCom({ ...instagram, evento: "Ciclo Água" }, deps);
    expect(chamadas).toEqual([4100]);
    expect(cartoes.map(c => c.pessoaId)).toEqual([55]);
  });

  it("sem ficha segura (usuário em várias fichas ou ficha arquivada) entrega só o link e não abre cartão", async () => {
    for (const status of ["usuario_compartilhado", "ficha_inativa"] as const) {
      const { deps, cartoes } = criarDeps({ pessoaDoCanal: fichaDoInstagram(null, status) });
      const r = await enviarInteresseCom({ ...instagram, evento: "Ciclo Água" }, deps);
      expect(r.link_interesse).toContain("form-3-interesse");
      expect(r.instrucao).toMatch(/cadastro de interesse é o caminho/);
      expect(cartoes).toHaveLength(0);
    }
  });

  it("falha ao identificar a pessoa não derruba a resposta: o link segue e o cartão não abre", async () => {
    const { deps, cartoes } = criarDeps({ pessoaDoCanal: async () => { throw new Error("banco fora do ar"); } });
    const r = await enviarInteresseCom({ ...instagram, evento: "Ciclo Água" }, deps);
    expect(r.status).toBe("ok");
    expect(r.link_interesse).toContain("form-3-interesse");
    expect(cartoes).toHaveLength(0);
  });

  it("só identifica (e portanto só cria ficha) quando há evento específico e núcleo válido", async () => {
    const semEvento = criarDeps({ pessoaDoCanal: fichaDoInstagram(900) });
    for (const evento of [null, "   ", "aula de violão", "ciclo"]) {
      await enviarInteresseCom({ ...instagram, evento }, semEvento.deps);
    }
    await enviarInteresseCom({ ...instagram, evento: "Ciclo Água", data: "2028-01" }, semEvento.deps);
    expect(semEvento.cartoes).toHaveLength(0);

    const chamadas: number[] = [];
    const nucleoInvalido = criarDeps({
      catalogo: async () => [item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13", { nucleus: "outro" })],
      pessoaDoCanal: async id => { chamadas.push(id); return { status: "criada", pessoaId: 900 }; },
    });
    await enviarInteresseCom({ ...instagram, evento: "Ciclo Água" }, nucleoInvalido.deps);
    const agendaVazia = criarDeps({
      catalogo: async () => [],
      pessoaDoCanal: async id => { chamadas.push(id); return { status: "criada", pessoaId: 900 }; },
    });
    await enviarInteresseCom({ ...instagram, evento: "Ciclo Água" }, agendaVazia.deps);
    expect(chamadas).toEqual([]);
    expect(nucleoInvalido.cartoes).toHaveLength(0);
  });

  it("conversa com ficha não consulta o canal; conversa sem id também não", async () => {
    const chamadas: number[] = [];
    const pessoaDoCanal: InteresseDeps["pessoaDoCanal"] = async id => { chamadas.push(id); return { status: "criada", pessoaId: 900 }; };
    const comFicha = criarDeps({ pessoaDoCanal });
    await enviarInteresseCom({ pessoaId: 77, conversationId: 4100, evento: "Ciclo Água" }, comFicha.deps);
    expect(comFicha.cartoes.map(c => c.pessoaId)).toEqual([77]);
    const semConversa = criarDeps({ pessoaDoCanal });
    await enviarInteresseCom({ pessoaId: null, conversationId: null, evento: "Ciclo Água" }, semConversa.deps);
    expect(semConversa.cartoes).toHaveLength(0);
    expect(chamadas).toEqual([]);
  });

  it("pedido de preço no Instagram segue o mesmo caminho: link para a pessoa, cartão para o time, sem valor", async () => {
    const { deps, cartoes } = criarDeps({ pessoaDoCanal: fichaDoInstagram(900) });
    const frase = await interesseDoPedidoDeValor({ mensagem: "Quanto custa o Ciclo Água?", ...instagram }, deps);
    expect(frase).toBe("Para agilizar, deixe seu interesse no cadastro da edição de 13/01/2027: https://soundfulness.net/interesse/form-3-interesse");
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ pessoaId: 900, eventoId: 3, conversationId: 4100 });
  });
});
