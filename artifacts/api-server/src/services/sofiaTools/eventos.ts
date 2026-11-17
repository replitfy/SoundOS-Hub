import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, sofiaEventAliasesTable, videoEventosTable, videosTable } from "@workspace/db";
import { ocultarValoresEmReais, ocultarValoresOpcional } from "../ocultarValores.js";
import { getOfficialEventCatalog, type OfficialEventCatalogItem } from "../sofiaEventCatalog.js";
import { logger } from "../../lib/logger.js";

/**
 * Ferramentas de evento e vídeo do modo simples da Sofia.
 *
 * Fonte única: agenda oficial (`cursos_inscricao` ativos e futuros). Horário e
 * vagas não existem em fonte oficial e voltam sempre `null`.
 *
 * Preço de evento/ciclo NUNCA sai destas tools (decisão do dono): quem pergunta
 * valor recebe o link de cadastro de interesse (`enviar_interesse`) e o time
 * comercial retorna com valores e condições.
 */

export type EtapaDaFormacao = "entrada" | "depois";

export interface EdicaoEvento {
  id: number;
  evento_chave: string;
  nome: string;
  tipo_evento: string;
  data_inicio: string;
  data_fim: string | null;
  local: string | null;
  descricao: string | null;
  url_evento: string | null;
  horario: null;
  vagas: null;
  /** Só nos quatro ciclos da formação em Sound Healing; ausente nos demais eventos. */
  etapa_da_formacao?: EtapaDaFormacao;
}

export interface AliasEvento {
  alias: string;
  evento_chave: string;
}

/** Lista padrão; a tabela `sofia_event_aliases` acrescenta, corrige ou desliga (ativo=false). */
export const ALIASES_PADRAO: readonly AliasEvento[] = [
  { alias: "workshop agua", evento_chave: "ciclo-agua" },
  { alias: "formacao agua", evento_chave: "ciclo-agua" },
  { alias: "agua", evento_chave: "ciclo-agua" },
  { alias: "sound healing individual", evento_chave: "ciclo-agua" },
  { alias: "fogo", evento_chave: "ciclo-fogo" },
  { alias: "ritual de som", evento_chave: "ciclo-fogo" },
  { alias: "terra", evento_chave: "ciclo-terra" },
  { alias: "sound healing avancado", evento_chave: "ciclo-terra" },
  { alias: "ar", evento_chave: "ciclo-ar" },
  { alias: "retiro ciclo ar", evento_chave: "ciclo-ar" },
  { alias: "arte cerimonial", evento_chave: "ciclo-ar" },
  { alias: "concerto", evento_chave: "concerto-meditativo" },
  { alias: "banho de gongs", evento_chave: "concerto-meditativo" },
  { alias: "cacau", evento_chave: "concerto-meditativo" },
];

/**
 * A formação em Sound Healing da Soundfulness tem quatro cursos (ciclos). Todos são Sound Healing, mesmo quando o
 * nome fantasia não diz isso (Fogo é "Ritual de Som e Musicalidade Intuitiva"). Água e Fogo abrem o caminho; Terra
 * e Ar vêm depois. A classificação é decisão da equipe e fica aqui: o modelo nunca a deduz.
 */
export const CICLOS_DA_FORMACAO: ReadonlyArray<{ evento_chave: string; etapa: EtapaDaFormacao }> = [
  { evento_chave: "ciclo-agua", etapa: "entrada" },
  { evento_chave: "ciclo-fogo", etapa: "entrada" },
  { evento_chave: "ciclo-terra", etapa: "depois" },
  { evento_chave: "ciclo-ar", etapa: "depois" },
];

export function etapaDoCiclo(chave: string): EtapaDaFormacao | null {
  return CICLOS_DA_FORMACAO.find(ciclo => ciclo.evento_chave === chave)?.etapa ?? null;
}

/** As chaves são exatamente os quatro ciclos: a pessoa falou da formação, não de um ciclo só. */
export function ehConjuntoDaFormacao(chaves: readonly string[]): boolean {
  return chaves.length === CICLOS_DA_FORMACAO.length && CICLOS_DA_FORMACAO.every(ciclo => chaves.includes(ciclo.evento_chave));
}

/** Termos que, sozinhos, falam da formação inteira ("curso de Sound Healing", "formação", "ciclos"). */
const TERMOS_DA_FORMACAO = new Set([
  "sound", "healing", "soundfulness", "formacao", "formacoes", "curso", "cursos", "ciclo", "ciclos",
]);

/** O texto só tem palavras de pergunta e termos da formação, com pelo menos um termo da formação. */
function falaDaFormacaoInteira(normalizado: string): boolean {
  const termos = normalizado.split(" ");
  return termos.some(termo => TERMOS_DA_FORMACAO.has(termo))
    && termos.every(termo => PALAVRAS_DE_PERGUNTA.has(termo) || TERMOS_DA_FORMACAO.has(termo));
}

const TERMOS_DE_CICLO = new Set(["agua", "fogo", "ciclo", "ciclos", "sound", "healing", "soundfulness", "formacao"]);
const VERBOS_DE_CICLO_FEITO = new Set(["fiz", "fui", "cursei", "conclui", "terminei", "completei", "participei"]);
const NEGACOES = new Set(["nao", "nunca", "nem", "jamais", "nenhum", "nenhuma"]);

/**
 * A pessoa disse, em alguma destas mensagens, que já fez um ciclo da Soundfulness ("já fiz o Água", "sou aluna do Ciclo Fogo").
 * Heurística conservadora para os caminhos em que o modelo não conversa (handoff de pagamento): sem uma frase clara, devolve
 * `false` e a pessoa é tratada como quem está começando. Negações ("não fiz nenhum ciclo") nunca contam.
 */
export function pessoaDisseQueJaFezCiclo(mensagens: readonly string[]): boolean {
  return mensagens.some(mensagem => {
    const termos = normalizarTexto(mensagem).split(" ");
    if (!termos.some(termo => TERMOS_DE_CICLO.has(termo))) return false;
    return termos.some((termo, indice) => {
      const anteriores = termos.slice(Math.max(0, indice - 3), indice);
      if (anteriores.some(anterior => NEGACOES.has(anterior))) return false;
      if (VERBOS_DE_CICLO_FEITO.has(termo)) return true;
      return (termo === "aluno" || termo === "aluna") && (termos[indice - 1] === "sou" || termos[indice - 1] === "fui");
    });
  });
}

/** Curso legado em `videos.curso` usado quando não há vínculo em `video_eventos`. */
const CURSO_DO_VIDEO: Record<string, string> = {
  "ciclo-agua": "agua",
  "ciclo-fogo": "fogo",
  "ciclo-terra": "terra",
};

const PALAVRAS_DE_PERGUNTA = new Set([
  "que", "link", "quanto", "custa", "tem", "onde", "quando", "qual", "quais", "workshop", "formacao", "curso",
  "o", "a", "os", "as", "e", "eh", "do", "da", "de", "dos", "das", "no", "na", "em", "um", "uma", "sobre", "me",
  "fala", "falar", "mais", "evento", "eventos", "proximo", "proxima", "preco", "valor", "vaga", "vagas", "data",
  "datas", "inscricao", "inscrever", "quero", "saber", "como", "funciona", "pra", "para", "por", "favor", "video",
]);

const CURA_TITULO = /\b(?:cura|curar|cure|tratamento|ansiedade|depressao|doenca\w*|insonia)\b/;

const CIDADES_ABREVIADAS: Record<string, string> = {
  sp: "sao paulo",
  sampa: "sao paulo",
  rj: "rio de janeiro",
  bh: "belo horizonte",
  cj: "campos do jordao",
};

export function normalizarTexto(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "CICLO ÁGUA - Sound Healing Individual" → "ciclo-agua". */
export function eventoChave(nome: string): string {
  const [base] = nome.split(/\s+[-–—/|]\s+/);
  return normalizarTexto(base ?? nome).replace(/\s+/g, "-");
}

export function paraEdicao(item: OfficialEventCatalogItem): EdicaoEvento {
  const chave = eventoChave(item.name);
  const etapa = etapaDoCiclo(chave);
  return {
    id: item.eventId,
    evento_chave: chave,
    nome: ocultarValoresEmReais(item.name),
    tipo_evento: item.eventType,
    data_inicio: item.startDate,
    data_fim: item.endDate,
    local: ocultarValoresOpcional(item.location?.trim()) || null,
    descricao: ocultarValoresOpcional(item.description),
    url_evento: item.sourceUrl,
    horario: null,
    vagas: null,
    ...(etapa ? { etapa_da_formacao: etapa } : {}),
  };
}

/** Mesma chave na mesma data é o mesmo evento cadastrado duas vezes: fica a linha com link oficial. */
export function deduplicarEdicoes(edicoes: EdicaoEvento[]): EdicaoEvento[] {
  const escolhidas = new Map<string, EdicaoEvento>();
  for (const edicao of edicoes) {
    const chave = `${edicao.evento_chave}|${edicao.data_inicio}`;
    const atual = escolhidas.get(chave);
    if (!atual || (!atual.url_evento && edicao.url_evento)) escolhidas.set(chave, edicao);
  }
  return [...escolhidas.values()].sort((a, b) =>
    a.data_inicio.localeCompare(b.data_inicio)
    || Number(Boolean(b.url_evento)) - Number(Boolean(a.url_evento))
    || a.id - b.id);
}

export async function carregarAliases(): Promise<AliasEvento[]> {
  const mapa = new Map(ALIASES_PADRAO.map(item => [item.alias, item.evento_chave]));
  try {
    const linhas = await db
      .select({ alias: sofiaEventAliasesTable.alias, eventoChave: sofiaEventAliasesTable.eventoChave, ativo: sofiaEventAliasesTable.ativo })
      .from(sofiaEventAliasesTable);
    for (const linha of linhas) {
      const alias = normalizarTexto(linha.alias);
      if (!alias) continue;
      if (linha.ativo) mapa.set(alias, linha.eventoChave);
      else mapa.delete(alias);
    }
  } catch (err) {
    logger.warn({ err }, "Sofia: aliases de eventos indisponíveis; usando a lista padrão");
  }
  return [...mapa.entries()].map(([alias, evento_chave]) => ({ alias, evento_chave }));
}

/**
 * Chaves de evento citadas no texto: aliases (palavra inteira) e, para nomes
 * fora da lista, todos os termos restantes presentes no nome do evento.
 * "Curso de Sound Healing", "formação" e "ciclos", sem outro nome, falam da formação
 * inteira: devolvem os quatro ciclos, e não só os títulos que contêm essas palavras.
 */
export function resolverChaves(texto: string, edicoes: EdicaoEvento[], aliases: readonly AliasEvento[]): string[] {
  const normalizado = normalizarTexto(texto);
  if (!normalizado) return [];
  const chaves = new Set<string>();
  const comEspacos = ` ${normalizado} `;
  for (const { alias, evento_chave } of aliases) {
    if (alias && comEspacos.includes(` ${alias} `)) chaves.add(evento_chave);
  }
  if (chaves.size === 0 && falaDaFormacaoInteira(normalizado)) return CICLOS_DA_FORMACAO.map(ciclo => ciclo.evento_chave);
  const termos = normalizado.split(" ").filter(termo => !PALAVRAS_DE_PERGUNTA.has(termo));
  if (termos.length > 0) {
    for (const edicao of edicoes) {
      const nome = new Set(normalizarTexto(edicao.nome).split(" "));
      if (termos.every(termo => nome.has(termo))) chaves.add(edicao.evento_chave);
    }
  }
  return [...chaves];
}

export interface ProximoEventoResultado {
  evento: EdicaoEvento | null;
  outros_mesmo_dia: EdicaoEvento[];
}

export async function proximoEvento(now?: Date): Promise<ProximoEventoResultado> {
  const catalogo = await getOfficialEventCatalog({ now });
  const [evento = null, ...outros] = deduplicarEdicoes(catalogo.items.map(paraEdicao));
  return { evento, outros_mesmo_dia: outros };
}

export interface CicloDaFormacao {
  evento_chave: string;
  etapa: EtapaDaFormacao;
  proxima_edicao: EdicaoEvento | null;
}

export interface DetalhesEventoResultado {
  evento_chave: string | null;
  nome: string | null;
  descricao: string | null;
  proxima_edicao: EdicaoEvento | null;
  outras_edicoes: EdicaoEvento[];
  url_evento: string | null;
  candidatos: Array<{ evento_chave: string; nome: string; data_inicio: string }>;
  /** Quando a pessoa falou da formação em Sound Healing sem dizer qual ciclo. */
  formacao?: { total_de_cursos: number; ciclos: CicloDaFormacao[] };
  instrucao?: string;
}

const SEM_VALOR = "Valores e condições não são informados pela Sofia";

/** Como a Sofia apresenta a formação inteira: explica os 4 cursos e propõe só os de entrada. */
export const INSTRUCAO_FORMACAO =
  "A pessoa falou da formação em Sound Healing sem dizer qual curso. A formação tem 4 cursos (ciclos) e todos são de Sound Healing, " +
  "cada um com seu nome fantasia. Explique isso em poucas linhas e proponha só os ciclos de etapa \"entrada\" (Água ou Fogo), " +
  "que são o começo do caminho, perguntando qual dos dois chama mais a atenção dela. Não ofereça os ciclos de etapa \"depois\" " +
  "(Terra e Ar) como caminho nem envie link deles a quem está começando; só fale deles se ela perguntar ou disser que já fez algum " +
  `ciclo da Soundfulness. ${SEM_VALOR}: se ela quiser se inscrever ou perguntar o valor, chame enviar_interesse para o ciclo que ela escolher.`;

/** Detalhes de um ciclo que vem depois na formação: responde normalmente, mas orienta quem está começando. */
export const INSTRUCAO_CICLO_POSTERIOR =
  `${SEM_VALOR}: se a pessoa perguntar valor ou quiser se inscrever, o caminho é enviar_interesse. ` +
  "Este ciclo é uma etapa posterior da formação em Sound Healing, que tem 4 cursos e começa pelo Ciclo Água ou pelo Ciclo Fogo. " +
  "Responda normalmente o que ela perguntou. Se ela está começando (não disse que já fez algum ciclo da Soundfulness), conte com carinho " +
  "que este vem depois, diga que o começo é Água ou Fogo e pergunte se ela já fez algum ciclo antes de chamar enviar_interesse.";

/** Lista com ciclos da formação: lembra a etapa de cada um para não oferecer os de depois a quem está começando. */
export const INSTRUCAO_FORMACAO_NA_LISTA =
  "Os ciclos fazem parte da formação em Sound Healing, de 4 cursos: os de etapa_da_formacao \"entrada\" (Água e Fogo) são o começo do " +
  "caminho e os de etapa \"depois\" (Terra e Ar) vêm depois. A quem está começando, proponha só Água ou Fogo.";

function montarFormacao(edicoes: EdicaoEvento[]): CicloDaFormacao[] {
  return CICLOS_DA_FORMACAO.map(({ evento_chave, etapa }) => ({
    evento_chave,
    etapa,
    proxima_edicao: edicoes
      .filter(edicao => edicao.evento_chave === evento_chave)
      .sort((a, b) => a.data_inicio.localeCompare(b.data_inicio))[0] ?? null,
  }));
}

/** Núcleo puro de `detalhes_evento`. */
export function montarDetalhes(texto: string, edicoes: EdicaoEvento[], aliases: readonly AliasEvento[]): DetalhesEventoResultado {
  const vazio: DetalhesEventoResultado = {
    evento_chave: null, nome: null, descricao: null, proxima_edicao: null, outras_edicoes: [], url_evento: null, candidatos: [],
  };
  const chaves = resolverChaves(texto, edicoes, aliases);
  if (chaves.length === 0) {
    return { ...vazio, instrucao: "Nenhum evento futuro corresponde a esse nome. Use listar_eventos ou pergunte qual evento a pessoa procura." };
  }
  if (ehConjuntoDaFormacao(chaves)) {
    const ciclos = montarFormacao(edicoes);
    return { ...vazio, formacao: { total_de_cursos: ciclos.length, ciclos }, instrucao: INSTRUCAO_FORMACAO };
  }
  if (chaves.length > 1) {
    const candidatos = chaves
      .map(chave => edicoes.find(edicao => edicao.evento_chave === chave))
      .filter((edicao): edicao is EdicaoEvento => Boolean(edicao))
      .sort((a, b) => a.data_inicio.localeCompare(b.data_inicio))
      .slice(0, 3)
      .map(edicao => ({ evento_chave: edicao.evento_chave, nome: edicao.nome, data_inicio: edicao.data_inicio }));
    if (candidatos.length !== 1) {
      return { ...vazio, candidatos, instrucao: "Mais de um evento corresponde. Pergunte à pessoa qual deles ela quer." };
    }
    chaves.splice(0, chaves.length, candidatos[0]!.evento_chave);
  }
  const chave = chaves[0]!;
  const doEvento = edicoes.filter(edicao => edicao.evento_chave === chave);
  const [proxima, ...outras] = doEvento;
  if (!proxima) {
    return { ...vazio, evento_chave: chave, instrucao: "Esse evento não tem edição futura publicada. Diga isso e ofereça confirmar com o time interno." };
  }
  return {
    evento_chave: chave,
    nome: proxima.nome,
    descricao: proxima.descricao,
    proxima_edicao: proxima,
    outras_edicoes: outras.slice(0, 5),
    url_evento: proxima.url_evento,
    candidatos: [],
    instrucao: etapaDoCiclo(chave) === "depois"
      ? INSTRUCAO_CICLO_POSTERIOR
      : `${SEM_VALOR}: se a pessoa perguntar preço ou quiser se inscrever, chame enviar_interesse.`,
  };
}

async function edicoesFuturas(filtros: { location?: string; now?: Date } = {}): Promise<EdicaoEvento[]> {
  const catalogo = await getOfficialEventCatalog({ ...filtros, allDates: true });
  return deduplicarEdicoes(catalogo.items.map(paraEdicao));
}

export async function detalhesEvento(input: { nome: string }, now?: Date): Promise<DetalhesEventoResultado> {
  const [edicoes, aliases] = await Promise.all([edicoesFuturas({ now }), carregarAliases()]);
  return montarDetalhes(input.nome ?? "", edicoes, aliases);
}

export interface ListarEventosResultado {
  eventos: EdicaoEvento[];
  instrucao?: string;
}

export async function listarEventos(input: { cidade?: string | null; ciclo?: string | null }, now?: Date): Promise<ListarEventosResultado> {
  const cidadeNormalizada = input.cidade?.trim() ? normalizarTexto(input.cidade) : "";
  const location = CIDADES_ABREVIADAS[cidadeNormalizada] ?? (cidadeNormalizada || undefined);
  const [edicoes, aliases] = await Promise.all([edicoesFuturas({ location, now }), carregarAliases()]);
  let eventos = edicoes;
  if (input.ciclo?.trim()) {
    const chaves = new Set(resolverChaves(input.ciclo, edicoes, aliases));
    eventos = edicoes.filter(edicao => chaves.has(edicao.evento_chave));
  }
  const lista = eventos.slice(0, 12);
  return eventos.length > 0
    ? { eventos: lista, ...(lista.some(evento => etapaDoCiclo(evento.evento_chave)) ? { instrucao: INSTRUCAO_FORMACAO_NA_LISTA } : {}) }
    : { eventos: [], instrucao: "Não há evento futuro publicado com esse filtro. Diga isso com honestidade." };
}

export interface VideoEvento {
  codigo: string | null;
  titulo: string;
  link: string;
  texto: string;
}

interface LinhaVideo {
  id: number;
  codigo: string | null;
  titulo: string;
  tipo: string | null;
  link: string | null;
}

function linkValido(link: string | null): link is string {
  if (!link) return false;
  try {
    return new URL(link).protocol === "https:";
  } catch {
    return false;
  }
}

/** Núcleo puro: filtra títulos com linguagem de cura, prefere "Video SFS", no máximo 2. */
export function escolherVideos(linhas: LinhaVideo[]): VideoEvento[] {
  const vistos = new Set<number>();
  return linhas
    .filter(linha => linkValido(linha.link) && !CURA_TITULO.test(normalizarTexto(linha.titulo)))
    .filter(linha => (vistos.has(linha.id) ? false : (vistos.add(linha.id), true)))
    .map((linha, indice) => ({ linha, indice }))
    .sort((a, b) => Number(b.linha.tipo === "Video SFS") - Number(a.linha.tipo === "Video SFS") || a.indice - b.indice)
    .slice(0, 2)
    .map(({ linha }) => ({
      codigo: linha.codigo,
      titulo: linha.titulo,
      link: linha.link!.trim(),
      texto: `📹 *${linha.titulo}*\n${linha.link!.trim()}`,
    }));
}

async function videosDaChave(chave: string): Promise<LinhaVideo[]> {
  const aprovados = and(
    eq(videosTable.aprovadoParaSofia, true),
    eq(videosTable.temLinkReal, true),
    isNotNull(videosTable.link),
  );
  const colunas = {
    id: videosTable.id, codigo: videosTable.codigo, titulo: videosTable.titulo, tipo: videosTable.tipo, link: videosTable.link,
  };
  const vinculados = await db
    .select(colunas)
    .from(videoEventosTable)
    .innerJoin(videosTable, eq(videosTable.id, videoEventosTable.videoId))
    .where(and(eq(videoEventosTable.eventoChave, chave), aprovados))
    .orderBy(desc(videoEventosTable.principal), asc(videoEventosTable.ordem), asc(videosTable.id));
  if (vinculados.length > 0) return vinculados;
  const curso = CURSO_DO_VIDEO[chave];
  if (!curso) return [];
  return db
    .select(colunas)
    .from(videosTable)
    .where(and(
      aprovados,
      sql`TRANSLATE(LOWER(TRIM(${videosTable.curso})), 'áàâãéêíóôõúç', 'aaaaeeiooouc') = ${curso}`,
    ))
    .orderBy(asc(videosTable.id));
}

export async function videoDoEvento(input: { evento: string }, now?: Date): Promise<{ videos: VideoEvento[]; instrucao?: string }> {
  const [edicoes, aliases] = await Promise.all([edicoesFuturas({ now }), carregarAliases()]);
  const chaves = resolverChaves(input.evento ?? "", edicoes, aliases);
  if (chaves.length !== 1) {
    return { videos: [], instrucao: "Não identifiquei um único evento. Não mencione vídeo." };
  }
  const videos = escolherVideos(await videosDaChave(chaves[0]!));
  return videos.length > 0
    ? { videos }
    : { videos: [], instrucao: "Não há vídeo aprovado para este evento. Não mencione vídeo." };
}
