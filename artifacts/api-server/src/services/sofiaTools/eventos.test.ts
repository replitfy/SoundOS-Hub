import { beforeEach, describe, expect, it, vi } from "vitest";

const getOfficialEventCatalog = vi.hoisted(() => vi.fn());
vi.mock("../sofiaEventCatalog.js", () => ({ getOfficialEventCatalog }));
vi.mock("@workspace/db", () => ({
  db: { select: () => { throw new Error("sem banco no teste"); } },
  sofiaEventAliasesTable: {},
  videoEventosTable: {},
  videosTable: {},
}));

import {
  ALIASES_PADRAO,
  CICLOS_DA_FORMACAO,
  deduplicarEdicoes,
  detalhesEvento,
  escolherVideos,
  eventoChave,
  listarEventos,
  montarDetalhes,
  paraEdicao,
  pessoaDisseQueJaFezCiclo,
  proximoEvento,
  resolverChaves,
  type EdicaoEvento,
} from "./eventos.js";

function item(eventId: number, name: string, startDate: string, extra: Record<string, unknown> = {}) {
  return {
    eventId, slug: `e-${eventId}`, name, description: `Sobre ${name}`, startDate, endDate: null,
    location: "São Paulo", nucleus: "education", eventType: "CURSO", classId: null, courseId: null,
    modality: null, workload: null,
    sourceUrl: `https://www.soundfulness.online/event-details/e-${eventId}`,
    ...extra,
  };
}

function edicao(id: number, nome: string, data: string, extra: Partial<EdicaoEvento> = {}): EdicaoEvento {
  return {
    id, evento_chave: eventoChave(nome), nome, tipo_evento: "CURSO", data_inicio: data, data_fim: null,
    local: "São Paulo", descricao: `Sobre ${nome}`, url_evento: `https://www.soundfulness.online/event-details/e-${id}`,
    horario: null, vagas: null, ...extra,
  };
}

const agenda: EdicaoEvento[] = [
  edicao(4, "CICLO TERRA - Sound Healing Avançado", "2026-10-29"),
  edicao(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13"),
  edicao(5, "CICLO FOGO - Ritual de Som e Musicalidade intuitiva", "2027-03-24"),
  edicao(11, "CICLO ÁGUA - Sound Healing Individual", "2027-05-26"),
];

beforeEach(() => getOfficialEventCatalog.mockReset());

describe("chave e duplicados", () => {
  it("deriva a chave do nome antes do subtítulo", () => {
    expect(eventoChave("CICLO ÁGUA - Sound Healing Individual")).toBe("ciclo-agua");
    expect(eventoChave("CONCERTO MEDITATIVO - Banho de Gongs com Cacau / São Paulo")).toBe("concerto-meditativo");
  });

  it("no mesmo dia, mantém a linha do mesmo evento que tem link oficial", () => {
    const resultado = deduplicarEdicoes([
      edicao(130, "CONCERTO MEDITATIVO - Banho de Gongs / São Paulo", "2026-10-28", { url_evento: null }),
      edicao(210, "CONCERTO MEDITATIVO - Banho de Gongs", "2026-10-28"),
    ]);
    expect(resultado.map(e => e.id)).toEqual([210]);
  });
});

describe("detalhes_evento", () => {
  it("resolve 'workshop água' para o Ciclo Água com próxima edição, outras datas e link", () => {
    const r = montarDetalhes("O que é o workshop Água?", agenda, ALIASES_PADRAO);
    expect(r.evento_chave).toBe("ciclo-agua");
    expect(r.proxima_edicao?.data_inicio).toBe("2027-01-13");
    expect(r.outras_edicoes.map(e => e.data_inicio)).toEqual(["2027-05-26"]);
    expect(r.url_evento).toContain("/event-details/e-3");
    expect(r.candidatos).toEqual([]);
  });

  it("responde 'link do Ciclo Fogo' e 'quanto custa o Ciclo Terra' sem lista vazia", () => {
    expect(montarDetalhes("link do Ciclo Fogo", agenda, ALIASES_PADRAO).url_evento).toContain("e-5");
    const terra = montarDetalhes("quanto custa o Ciclo Terra", agenda, ALIASES_PADRAO);
    expect(terra.proxima_edicao?.nome).toMatch(/TERRA/);
  });

  it("nunca devolve preço e manda chamar enviar_interesse para valores", () => {
    const terra = montarDetalhes("quanto custa o Ciclo Terra", agenda, ALIASES_PADRAO);
    expect(JSON.stringify(terra)).not.toMatch(/preco|price|R\$|2800|4800/i);
    expect(terra.instrucao).toMatch(/enviar_interesse/);
  });

  it("devolve candidatos quando mais de um evento casa", () => {
    const r = montarDetalhes("água e fogo", agenda, ALIASES_PADRAO);
    expect(r.evento_chave).toBeNull();
    expect(r.candidatos.map(c => c.evento_chave)).toEqual(["ciclo-agua", "ciclo-fogo"]);
  });

  it("não inventa evento para nome desconhecido", () => {
    const r = montarDetalhes("aula de violão", agenda, ALIASES_PADRAO);
    expect(r).toMatchObject({ evento_chave: null, proxima_edicao: null, candidatos: [] });
    expect(r.instrucao).toBeTruthy();
  });

  it("alias desligado na tabela deixa de resolver", () => {
    const semWorkshop = ALIASES_PADRAO.filter(a => !a.alias.includes("agua"));
    expect(montarDetalhes("workshop", agenda, semWorkshop).evento_chave).toBeNull();
  });
});

describe("formação em Sound Healing (os 4 ciclos)", () => {
  const agendaCompleta: EdicaoEvento[] = [
    ...agenda,
    edicao(8, "CICLO AR - Retiro de Imersão em Arte Cerimonial", "2027-10-12"),
  ];

  it.each([
    "Curso de Sound Healing",
    "sound healing",
    "formação em Sound Healing",
    "quero saber do curso",
    "ciclos",
    "ciclo",
    "Qual o link da formação da Soundfulness?",
  ])("'%s' fala da formação inteira: os quatro ciclos, não só os títulos com essas palavras", texto => {
    expect(resolverChaves(texto, agendaCompleta, ALIASES_PADRAO).sort())
      .toEqual(CICLOS_DA_FORMACAO.map(c => c.evento_chave).sort());
    const r = montarDetalhes(texto, agendaCompleta, ALIASES_PADRAO);
    expect(r.evento_chave).toBeNull();
    expect(r.candidatos).toEqual([]);
    expect(r.formacao?.total_de_cursos).toBe(4);
    expect(r.formacao?.ciclos.map(c => [c.evento_chave, c.etapa])).toEqual([
      ["ciclo-agua", "entrada"], ["ciclo-fogo", "entrada"], ["ciclo-terra", "depois"], ["ciclo-ar", "depois"],
    ]);
  });

  it("traz a próxima edição de cada ciclo e marca sem edição como nula, sem inventar", () => {
    const r = montarDetalhes("Curso de Sound Healing", agenda, ALIASES_PADRAO);
    const porChave = Object.fromEntries((r.formacao?.ciclos ?? []).map(c => [c.evento_chave, c.proxima_edicao?.data_inicio ?? null]));
    expect(porChave).toEqual({ "ciclo-agua": "2027-01-13", "ciclo-fogo": "2027-03-24", "ciclo-terra": "2026-10-29", "ciclo-ar": null });
  });

  it("a instrução propõe só Água ou Fogo e não oferece Terra nem Ar a quem está começando", () => {
    const { instrucao } = montarDetalhes("Curso de Sound Healing", agendaCompleta, ALIASES_PADRAO);
    expect(instrucao).toMatch(/4 cursos/);
    expect(instrucao).toMatch(/Água ou Fogo/);
    expect(instrucao).toMatch(/Não ofereça os ciclos de etapa "depois"/);
    expect(instrucao).toMatch(/enviar_interesse/);
  });

  it.each([
    ["Ritual de Som", "ciclo-fogo"],
    ["curso Fogo", "ciclo-fogo"],
    ["Sound Healing Individual", "ciclo-agua"],
    ["curso de Sound Healing Avançado", "ciclo-terra"],
    ["avançado", "ciclo-terra"],
    ["Retiro de Imersão em Arte Cerimonial", "ciclo-ar"],
  ])("nome específico '%s' continua levando a um único ciclo", (texto, chave) => {
    expect(resolverChaves(texto, agendaCompleta, ALIASES_PADRAO)).toEqual([chave]);
    const r = montarDetalhes(texto, agendaCompleta, ALIASES_PADRAO);
    expect(r.evento_chave).toBe(chave);
    expect(r.formacao).toBeUndefined();
  });

  it("outro curso ou termo desconhecido não vira formação", () => {
    expect(resolverChaves("curso de violão", agendaCompleta, ALIASES_PADRAO)).toEqual([]);
    expect(resolverChaves("curso de cacau", agendaCompleta, ALIASES_PADRAO)).toEqual(["concerto-meditativo"]);
    expect(resolverChaves("quero saber mais", agendaCompleta, ALIASES_PADRAO)).toEqual([]);
  });

  it("ciclo de depois avisa na instrução que vem depois e que o começo é Água ou Fogo; ciclo de entrada não", () => {
    const terra = montarDetalhes("Ciclo Terra", agendaCompleta, ALIASES_PADRAO);
    expect(terra.proxima_edicao?.nome).toMatch(/TERRA/);
    expect(terra.instrucao).toMatch(/etapa posterior/);
    expect(terra.instrucao).toMatch(/Água ou pelo Ciclo Fogo/);
    expect(terra.instrucao).toMatch(/enviar_interesse/);
    const agua = montarDetalhes("Ciclo Água", agendaCompleta, ALIASES_PADRAO);
    expect(agua.instrucao).not.toMatch(/etapa posterior/);
  });

  it("a edição de cada ciclo carrega a etapa; evento de fora da formação não", () => {
    expect(paraEdicao(item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13")).etapa_da_formacao).toBe("entrada");
    expect(paraEdicao(item(5, "CICLO FOGO - Ritual de Som e Musicalidade intuitiva", "2027-03-24")).etapa_da_formacao).toBe("entrada");
    expect(paraEdicao(item(4, "CICLO TERRA - Sound Healing Avançado", "2026-10-29")).etapa_da_formacao).toBe("depois");
    expect(paraEdicao(item(8, "CICLO AR - Retiro de Imersão em Arte Cerimonial", "2027-10-12")).etapa_da_formacao).toBe("depois");
    expect(paraEdicao(item(9, "CONCERTO MEDITATIVO - Banho de Gongs", "2026-10-28"))).not.toHaveProperty("etapa_da_formacao");
  });

  it("não devolve valor nem preço em nenhuma resposta da formação", () => {
    const saida = JSON.stringify(montarDetalhes("Curso de Sound Healing", agendaCompleta, ALIASES_PADRAO));
    expect(saida).not.toMatch(/preco|price|R\$|2800|4800/i);
  });
});

describe("pessoa disse que já fez um ciclo", () => {
  it.each([
    "Já fiz o Ciclo Água",
    "Eu fiz o Água ano passado",
    "fiz o curso de Sound Healing com vocês",
    "Sou aluna da Soundfulness",
    "Fui aluno do Ciclo Fogo",
    "Participei do ciclo fogo em 2025",
  ])("'%s' conta", texto => {
    expect(pessoaDisseQueJaFezCiclo(["Oi", texto])).toBe(true);
  });

  it.each([
    "Não fiz nenhum ciclo ainda",
    "Ainda não fiz o Água",
    "Nunca fiz nenhum curso de Sound Healing",
    "Quero fazer o Ciclo Terra",
    "Já fiz um curso de violão",
    "Já fiz",
    "Dá para parcelar o Ciclo Terra?",
  ])("'%s' não conta", texto => {
    expect(pessoaDisseQueJaFezCiclo(["Oi", texto])).toBe(false);
  });

  it("sem mensagens, a pessoa está começando", () => {
    expect(pessoaDisseQueJaFezCiclo([])).toBe(false);
  });
});

describe("proximo_evento e listar_eventos", () => {
  it("devolve o evento da menor data e os demais do mesmo dia, com link e sem horário", async () => {
    getOfficialEventCatalog.mockResolvedValueOnce({ items: [
      item(210, "CONCERTO MEDITATIVO - Banho de Gongs", "2026-10-28"),
      item(7, "VIVÊNCIA - Gongs", "2026-10-28", { sourceUrl: null }),
    ] });
    const r = await proximoEvento();
    expect(r.evento).toMatchObject({ id: 210, horario: null, url_evento: expect.stringContaining("event-details") });
    expect(r.outros_mesmo_dia.map(e => e.id)).toEqual([7]);
  });

  it("nunca devolve preço de evento, mesmo quando o curso tem valor cadastrado", async () => {
    getOfficialEventCatalog.mockResolvedValue({ items: [
      item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13", { price: 2800 }),
    ] });
    const saida = JSON.stringify([await proximoEvento(), await listarEventos({}), await detalhesEvento({ nome: "Ciclo Água" })]);
    expect(saida).not.toMatch(/preco|price|R\$|2800/i);
    getOfficialEventCatalog.mockReset();
  });

  it("mascara valor escrito na descrição, no nome ou no local antes de chegar ao modelo", async () => {
    getOfficialEventCatalog.mockResolvedValue({ items: [
      item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13", {
        description: "Cinco dias de vivência. Investimento: R$ 4.800,00 ou 4800 reais em 12x.",
        location: "São Paulo (estacionamento R$ 90)",
      }),
    ] });
    const saida = JSON.stringify([await proximoEvento(), await listarEventos({}), await detalhesEvento({ nome: "Ciclo Água" })]);
    expect(saida).toContain("Cinco dias de vivência.");
    expect(saida).not.toMatch(/R\$|4\.800|4800|reais|\b90\b/);
    getOfficialEventCatalog.mockReset();
  });

  it("devolve evento nulo quando não há agenda", async () => {
    getOfficialEventCatalog.mockResolvedValueOnce({ items: [] });
    expect(await proximoEvento()).toEqual({ evento: null, outros_mesmo_dia: [] });
  });

  it("listar_eventos com 'sound healing' traz os quatro ciclos, com a etapa de cada um e a instrução da formação", async () => {
    getOfficialEventCatalog.mockResolvedValueOnce({ items: [
      item(4, "CICLO TERRA - Sound Healing Avançado", "2026-10-29"),
      item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13"),
      item(5, "CICLO FOGO - Ritual de Som e Musicalidade intuitiva", "2027-03-24"),
      item(8, "CICLO AR - Retiro de Imersão em Arte Cerimonial", "2027-10-12"),
      item(9, "CONCERTO MEDITATIVO - Banho de Gongs", "2026-10-28"),
    ] });
    const r = await listarEventos({ ciclo: "sound healing" });
    expect(r.eventos.map(e => [e.evento_chave, e.etapa_da_formacao])).toEqual([
      ["ciclo-terra", "depois"], ["ciclo-agua", "entrada"], ["ciclo-fogo", "entrada"], ["ciclo-ar", "depois"],
    ]);
    expect(r.instrucao).toMatch(/Água e Fogo/);
  });

  it("listar_eventos sem ciclo da formação não traz a instrução da formação", async () => {
    getOfficialEventCatalog.mockResolvedValueOnce({ items: [item(9, "CONCERTO MEDITATIVO - Banho de Gongs", "2026-10-28")] });
    expect((await listarEventos({})).instrucao).toBeUndefined();
  });

  it("lista todas as datas futuras de uma cidade, aceitando a sigla SP", async () => {
    getOfficialEventCatalog.mockResolvedValueOnce({ items: [
      item(4, "CICLO TERRA - Sound Healing Avançado", "2026-10-29"),
      item(3, "CICLO ÁGUA - Sound Healing Individual", "2027-01-13"),
    ] });
    const r = await listarEventos({ cidade: "SP" });
    expect(getOfficialEventCatalog).toHaveBeenCalledWith(expect.objectContaining({ allDates: true, location: "sao paulo" }));
    expect(r.eventos.map(e => e.id)).toEqual([4, 3]);
  });
});

describe("video_do_evento", () => {
  const video = (id: number, titulo: string, tipo: string | null = null) =>
    ({ id, codigo: `V${id}`, titulo, tipo, link: `https://youtu.be/v${id}` });

  it("sem candidato devolve lista vazia", () => {
    expect(escolherVideos([])).toEqual([]);
  });

  it("com um candidato devolve o texto pronto", () => {
    expect(escolherVideos([video(1, "Ciclo Água")])).toEqual([
      { codigo: "V1", titulo: "Ciclo Água", link: "https://youtu.be/v1", texto: "📹 *Ciclo Água*\nhttps://youtu.be/v1" },
    ]);
  });

  it("com três candidatos devolve no máximo 2, preferindo Video SFS e excluindo linguagem de cura", () => {
    const r = escolherVideos([
      video(1, "Taças"),
      video(2, "Cura da ansiedade com som"),
      video(3, "Institucional", "Video SFS"),
      { ...video(4, "Sem link"), link: "nao-e-url" },
    ]);
    expect(r.map(v => v.codigo)).toEqual(["V3", "V1"]);
  });
});
