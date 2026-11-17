import { and, eq } from "drizzle-orm";
import {
  db,
  eventoFormularios,
  OPPORTUNITY_NUCLEI,
  type OpportunityNucleus,
} from "@workspace/db";
import { getOfficialEventCatalog, type OfficialEventCatalogItem } from "../sofiaEventCatalog.js";
import {
  createOpportunity,
  OpportunityRuleError,
  recordSofiaInterestMention,
  SOFIA_INTEREST_SOURCE,
} from "../commercialOpportunities.js";
import { identificarOuCriarPessoaDoCanal } from "../sofiaPessoa.js";
import { publicAppBaseUrl } from "../../lib/publicUrl.js";
import { logger } from "../../lib/logger.js";
import {
  carregarAliases,
  deduplicarEdicoes,
  ehConjuntoDaFormacao,
  etapaDoCiclo,
  paraEdicao,
  pessoaDisseQueJaFezCiclo,
  resolverChaves,
  type AliasEvento,
  type EdicaoEvento,
} from "./eventos.js";
import { carregarContextoConversa, contextoVazio, type ContextoConversa } from "./interesseContexto.js";

/**
 * `enviar_interesse`: Sofia nunca informa preço de evento, ciclo ou curso. Quem
 * pergunta valor, quer se inscrever ou demonstra vontade de participar de um
 * evento específico recebe o link do cadastro de interesse do evento e o time
 * interno retorna com valores e condições. Sem saber qual evento, a Sofia
 * pergunta antes: nenhuma edição é escolhida por conta própria.
 *
 * Quando a conversa tem ficha, a mesma chamada abre um cartão no Kanban do CRM
 * (etapa "Novo interesse", sem responsável, próxima ação "enviar valores e
 * condições") com o contexto da conversa no histórico. Se já existe cartão
 * ativo da mesma oferta, só registra o novo trecho da conversa. Conversa do
 * Instagram sem telefone não tem ficha ainda: `pessoaDoCanal` acha a ficha
 * segura (ou cria uma, ligada à conversa) e o cartão abre pelo mesmo caminho.
 * Sem ficha segura (usuário em várias fichas, ficha arquivada) não há cartão. O link vem
 * sempre desta tool, para passar pela lista de URLs permitidas; sem formulário
 * ativo ou sem endereço público conhecido não há link inventado.
 */

export type StatusCartao = "criado" | "ja_existia" | "sem_ficha" | "falhou";

export interface AbrirCartaoParams {
  pessoaId: number;
  nucleus: OpportunityNucleus;
  eventoId: number;
  rotulo: string;
  textoProximaAcao: string;
  agora: Date;
  conversationId: number | null;
  contexto: ContextoConversa;
}

export interface InteresseDeps {
  catalogo(now?: Date): Promise<OfficialEventCatalogItem[]>;
  aliases(): Promise<AliasEvento[]>;
  /** Slug do formulário INTERESSE ativo do evento, ou `null`. */
  formulario(eventoId: number): Promise<string | null>;
  baseUrl(): string | null;
  /** Trechos da pessoa e campos não sensíveis da ficha que acompanham o cartão. */
  contexto(pessoaId: number, conversationId: number | null, now: Date): Promise<ContextoConversa>;
  /**
   * Ficha de quem conversa por um canal externo (Instagram sem telefone; WhatsApp pelo número da conversa).
   * Só é chamada com um evento identificado e sem ficha na conversa; `pessoaId: null`
   * quando não há ficha segura.
   */
  pessoaDoCanal(conversationId: number): Promise<{ pessoaId: number | null }>;
  abrirCartao(params: AbrirCartaoParams): Promise<"criado" | "ja_existia">;
}

export interface InteresseInput {
  evento?: string | null;
  data?: string | null;
  pessoaId: number | null;
  conversationId: number | null;
  now?: Date;
  /**
   * Só no handoff de pagamento, em que a Sofia não conversa antes: a pessoa não disse que já fez um ciclo, então um ciclo de
   * etapa "depois" (Terra, Ar) não ganha link nem cartão; o time que assume orienta o caminho.
   */
  semCicloFeito?: boolean;
}

interface EdicaoResumo {
  nome: string;
  data_inicio: string;
  data_fim: string | null;
  local: string | null;
}

export interface InteresseResultado {
  status: "ok" | "evento_nao_identificado" | "ambiguo" | "edicao_nao_encontrada" | "sem_evento" | "etapa_posterior";
  evento: EdicaoResumo | null;
  link_interesse: string | null;
  outras_edicoes: EdicaoResumo[];
  candidatos: Array<{ nome: string; data_inicio: string }>;
  instrucao: string;
}

const REGRA_SEM_PRECO = "NUNCA informe preço, faixa de valor, parcelamento ou desconto, nem se a pessoa insistir.";

const INSTRUCAO_INTERESSE_FORMACAO =
  "A pessoa falou da formação em Sound Healing sem dizer qual curso (são 4 cursos, todos de Sound Healing). Explique isso em poucas linhas " +
  "e pergunte qual dos candidatos ela quer (Água ou Fogo, o começo do caminho). Não ofereça Terra nem Ar a quem está começando. " +
  "Só chame de novo quando ela responder.";

const INSTRUCAO_ETAPA_POSTERIOR =
  "Este ciclo vem depois na formação em Sound Healing e a pessoa não disse que já fez um ciclo da Soundfulness. Não envie link nem " +
  "abra interesse; o time interno orienta o melhor caminho.";

function resumo(edicao: EdicaoEvento): EdicaoResumo {
  return { nome: edicao.nome, data_inicio: edicao.data_inicio, data_fim: edicao.data_fim, local: edicao.local };
}

function vazio(status: InteresseResultado["status"], instrucao: string, extra: Partial<InteresseResultado> = {}): InteresseResultado {
  return { status, evento: null, link_interesse: null, outras_edicoes: [], candidatos: [], instrucao, ...extra };
}

function dataBr(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : iso;
}

/** `AAAA-MM-DD` ou `AAAA-MM`; qualquer outro formato não filtra. */
function filtrarPorData(edicoes: EdicaoEvento[], data: string | null | undefined): EdicaoEvento[] | null {
  const texto = data?.trim();
  if (!texto) return null;
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(texto)) return null;
  return edicoes.filter(edicao => edicao.data_inicio.startsWith(texto));
}

type Escolha =
  | { tipo: "edicao"; edicao: EdicaoEvento; outras: EdicaoEvento[] }
  | { tipo: "resultado"; resultado: InteresseResultado };

/** Núcleo puro: escolhe a edição pedida ou devolve o resultado de esclarecimento. */
export function escolherEdicao(
  input: Pick<InteresseInput, "evento" | "data">,
  edicoes: EdicaoEvento[],
  aliases: readonly AliasEvento[],
): Escolha {
  if (edicoes.length === 0) {
    return { tipo: "resultado", resultado: vazio("sem_evento", "Não há evento futuro publicado. Diga isso com honestidade e que o time interno pode ajudar.") };
  }
  if (!input.evento?.trim()) {
    // Sem evento citado nenhuma edição é escolhida: abrir cartão ou mandar link
    // de um evento que a pessoa nunca mencionou seria inventar o interesse dela.
    const primeiraDeCadaEvento = new Map<string, EdicaoEvento>();
    for (const edicao of [...edicoes].sort((a, b) => a.data_inicio.localeCompare(b.data_inicio))) {
      if (!primeiraDeCadaEvento.has(edicao.evento_chave)) primeiraDeCadaEvento.set(edicao.evento_chave, edicao);
    }
    const candidatos = [...primeiraDeCadaEvento.values()]
      .slice(0, 3)
      .map(edicao => ({ nome: edicao.nome, data_inicio: edicao.data_inicio }));
    return {
      tipo: "resultado",
      resultado: vazio(
        "evento_nao_identificado",
        "A pessoa ainda não disse qual evento, ciclo ou curso quer. Pergunte qual, podendo oferecer as opções de candidatos, sem escolher por ela e sem inventar nenhum. Só chame de novo quando ela responder.",
        { candidatos },
      ),
    };
  }
  const citadas = resolverChaves(input.evento, edicoes, aliases);
  if (ehConjuntoDaFormacao(citadas)) {
    // Falou da formação em Sound Healing sem dizer qual curso: só o começo do caminho (etapa "entrada") vira candidato.
    const entrada = citadas
      .filter(chave => etapaDoCiclo(chave) === "entrada")
      .map(chave => edicoes.find(edicao => edicao.evento_chave === chave))
      .filter((edicao): edicao is EdicaoEvento => Boolean(edicao))
      .sort((a, b) => a.data_inicio.localeCompare(b.data_inicio))
      .map(edicao => ({ nome: edicao.nome, data_inicio: edicao.data_inicio }));
    if (entrada.length > 0) {
      return { tipo: "resultado", resultado: vazio("ambiguo", INSTRUCAO_INTERESSE_FORMACAO, { candidatos: entrada }) };
    }
  }
  const chaves = citadas.filter(chave => edicoes.some(edicao => edicao.evento_chave === chave));
  if (chaves.length === 0) {
    return {
      tipo: "resultado",
      resultado: vazio("evento_nao_identificado", "Nenhum evento futuro corresponde a esse nome. Pergunte qual evento a pessoa procura, sem inventar nenhum."),
    };
  }
  if (chaves.length > 1) {
    const candidatos = chaves
      .map(chave => edicoes.find(edicao => edicao.evento_chave === chave)!)
      .sort((a, b) => a.data_inicio.localeCompare(b.data_inicio))
      .slice(0, 3)
      .map(edicao => ({ nome: edicao.nome, data_inicio: edicao.data_inicio }));
    return { tipo: "resultado", resultado: vazio("ambiguo", "Mais de um evento corresponde. Pergunte à pessoa qual deles ela quer antes de chamar de novo.", { candidatos }) };
  }
  let candidatas = edicoes.filter(edicao => edicao.evento_chave === chaves[0]);
  const porData = filtrarPorData(candidatas, input.data);
  if (porData !== null) {
    if (porData.length === 0) {
      return {
        tipo: "resultado",
        resultado: vazio(
          "edicao_nao_encontrada",
          "Não há edição nessa data. Diga isso e ofereça as datas de outras_edicoes, sem inventar datas.",
          { outras_edicoes: candidatas.slice(0, 5).map(resumo) },
        ),
      };
    }
    candidatas = porData;
  }
  const [edicao, ...restantes] = candidatas;
  const outras = restantes.filter(outra => outra.evento_chave === edicao!.evento_chave);
  return { tipo: "edicao", edicao: edicao!, outras };
}

function montarInstrucao(link: string | null, acompanhado: boolean): string {
  if (link && acompanhado) {
    return `Envie o link_interesse exatamente como veio e diga que o time interno vai retornar com valores e condições. ${REGRA_SEM_PRECO} Não fale de cartão, CRM ou ferramentas.`;
  }
  if (link) {
    return `Envie o link_interesse exatamente como veio e explique que o cadastro de interesse é o caminho para receber valores e condições do time interno. ${REGRA_SEM_PRECO} Não fale de cartão, CRM ou ferramentas.`;
  }
  return `O link do cadastro de interesse não está disponível agora. Diga que o time interno envia o link, os valores e as condições; não invente link. ${REGRA_SEM_PRECO}`;
}

export async function enviarInteresseCom(input: InteresseInput, deps: InteresseDeps): Promise<InteresseResultado> {
  const [itens, aliases] = await Promise.all([deps.catalogo(input.now), deps.aliases()]);
  const porId = new Map(itens.map(item => [item.eventId, item]));
  const edicoes = deduplicarEdicoes(itens.map(paraEdicao));
  const escolha = escolherEdicao(input, edicoes, aliases);
  if (escolha.tipo === "resultado") return escolha.resultado;

  const { edicao, outras } = escolha;
  if (input.semCicloFeito && etapaDoCiclo(edicao.evento_chave) === "depois") {
    return vazio("etapa_posterior", INSTRUCAO_ETAPA_POSTERIOR);
  }
  const item = porId.get(edicao.id);
  const slug = await deps.formulario(edicao.id);
  const base = deps.baseUrl();
  const link = slug && base ? `${base}/interesse/${slug}` : null;

  let cartao: StatusCartao = "sem_ficha";
  const nucleus = item?.nucleus?.toUpperCase() as OpportunityNucleus | undefined;
  const nucleusValido = Boolean(item && nucleus && OPPORTUNITY_NUCLEI.includes(nucleus));

  let pessoaId = input.pessoaId;
  if (pessoaId === null && input.conversationId !== null && nucleusValido) {
    // Instagram sem telefone: a ficha só é criada aqui, com evento específico e núcleo válido.
    try {
      pessoaId = (await deps.pessoaDoCanal(input.conversationId)).pessoaId;
    } catch (err) {
      // O link segue na resposta; sem ficha segura o cartão não abre.
      logger.error({ err, conversationId: input.conversationId }, "Sofia: falha ao identificar a pessoa da conversa para o cartão de interesse");
    }
  }

  if (pessoaId !== null) {
    if (!item || !nucleus || !nucleusValido) {
      logger.warn({ eventoId: edicao.id, nucleo: item?.nucleus }, "Sofia: evento sem núcleo válido; cartão de interesse não aberto");
      cartao = "falhou";
    } else {
      const agora = input.now ?? new Date();
      const contexto = await deps.contexto(pessoaId, input.conversationId, agora).catch((err: unknown) => {
        // O contexto é um complemento: sem ele o cartão abre do mesmo jeito.
        logger.warn({ err, conversationId: input.conversationId }, "Sofia: contexto da conversa indisponível para o cartão de interesse");
        return contextoVazio(input.conversationId, agora);
      });
      try {
        cartao = await deps.abrirCartao({
          pessoaId,
          nucleus,
          eventoId: edicao.id,
          rotulo: `${edicao.nome} (${dataBr(edicao.data_inicio)})`,
          textoProximaAcao: link
            ? "Enviar valores e condições (interesse recebido pela Sofia)"
            : "Enviar o link de cadastro de interesse, valores e condições (a Sofia não conseguiu enviar o link)",
          agora,
          conversationId: input.conversationId,
          contexto,
        });
      } catch (err) {
        logger.error({ err, eventoId: edicao.id, conversationId: input.conversationId }, "Sofia: falha ao abrir o cartão de interesse no CRM");
        cartao = "falhou";
      }
    }
  }

  return {
    status: "ok",
    evento: resumo(edicao),
    link_interesse: link,
    outras_edicoes: outras.slice(0, 3).map(resumo),
    candidatos: [],
    instrucao: montarInstrucao(link, cartao === "criado" || cartao === "ja_existia"),
  };
}

export async function abrirCartaoPadrao(params: AbrirCartaoParams): Promise<"criado" | "ja_existia"> {
  const metadata = { sofiaConversation: params.contexto };
  const registrarInteresseRepetido = () => recordSofiaInterestMention({
    pessoaId: params.pessoaId,
    nucleus: params.nucleus,
    cursosInscricaoId: params.eventoId,
    conversationId: params.conversationId,
    metadata,
    idempotencyKey: `sofia-interesse-repetido:${params.conversationId ?? "sem-conversa"}:${params.eventoId}:${params.agora.getTime()}`,
    now: params.agora,
  });
  // Já existe cartão ativo da oferta (da Sofia ou de um humano): não duplica,
  // só registra o novo trecho da conversa no histórico dele.
  if (await registrarInteresseRepetido()) return "ja_existia";
  try {
    await createOpportunity({
      pessoaId: params.pessoaId,
      nucleus: params.nucleus,
      cursosInscricaoId: params.eventoId,
      offerLabel: params.rotulo,
      nextTaskType: "WHATSAPP",
      nextTaskText: params.textoProximaAcao,
      nextTaskAt: params.agora,
      source: SOFIA_INTEREST_SOURCE,
      actor: { kind: "SOFIA" },
      allowUnowned: true,
      // Cada tentativa tem a sua chave: a checagem acima e o índice único de
      // oferta ativa impedem duplicar; a chave só protege a gravação em si.
      idempotencyKey: `sofia-interesse:${params.conversationId ?? "sem-conversa"}:${params.eventoId}:${params.agora.getTime()}`,
      eventMetadata: metadata,
    });
    return "criado";
  } catch (err) {
    if (err instanceof OpportunityRuleError && err.code === "ACTIVE_OPPORTUNITY_EXISTS") {
      // Outra chamada abriu o cartão no intervalo entre a checagem e a criação.
      await registrarInteresseRepetido();
      return "ja_existia";
    }
    throw err;
  }
}

const depsPadrao: InteresseDeps = {
  async catalogo(now) {
    return (await getOfficialEventCatalog({ now, allDates: true })).items;
  },
  aliases: carregarAliases,
  async formulario(eventoId) {
    const [form] = await db
      .select({ slug: eventoFormularios.slug })
      .from(eventoFormularios)
      .where(and(
        eq(eventoFormularios.eventoId, eventoId),
        eq(eventoFormularios.tipo, "INTERESSE"),
        eq(eventoFormularios.ativo, true),
      ))
      .limit(1);
    return form?.slug ?? null;
  },
  baseUrl: () => publicAppBaseUrl(),
  contexto: carregarContextoConversa,
  pessoaDoCanal: conversationId => identificarOuCriarPessoaDoCanal({ conversationId }),
  abrirCartao: abrirCartaoPadrao,
};

export function enviarInteresse(input: InteresseInput): Promise<InteresseResultado> {
  return enviarInteresseCom(input, depsPadrao);
}

/** Quem já pagou ou reclama de cobrança não está pedindo valores: segue só o handoff. */
const JA_PAGOU = /\b(paguei|j[áa] (est[áa] )?pag[oa]|j[áa] fiz o pagamento|comprovante|n[ãa]o (recebi|chegou|consigo acessar))\b/i;

/**
 * Mensagens de preço/parcelamento/desconto caem no handoff de pagamento antes
 * de o modelo rodar. Quando a pessoa cita um evento, esta função faz o mesmo
 * que `enviar_interesse` (abre o cartão no CRM) e devolve a frase com o link
 * para acompanhar a transição. Sem evento claro, sem link ou sem cadastro
 * ativo devolve `null` e vale só o handoff.
 *
 * Terra e Ar vêm depois na formação: sem uma frase da pessoa dizendo que já fez um ciclo (nesta mensagem ou em
 * `mensagensDaPessoa`, as anteriores da conversa), não há link nem cartão e vale só o handoff.
 */
export async function interesseDoPedidoDeValor(
  input: { mensagem: string; pessoaId: number | null; conversationId: number | null; now?: Date; mensagensDaPessoa?: readonly string[] },
  deps: InteresseDeps = depsPadrao,
): Promise<string | null> {
  if (!input.mensagem.trim() || JA_PAGOU.test(input.mensagem)) return null;
  const resultado = await enviarInteresseCom({
    evento: input.mensagem,
    pessoaId: input.pessoaId,
    conversationId: input.conversationId,
    now: input.now,
    semCicloFeito: !pessoaDisseQueJaFezCiclo([input.mensagem, ...(input.mensagensDaPessoa ?? [])]),
  }, deps);
  if (resultado.status !== "ok" || !resultado.link_interesse || !resultado.evento) return null;
  return `Para agilizar, deixe seu interesse no cadastro da edição de ${dataBr(resultado.evento.data_inicio)}: ${resultado.link_interesse}`;
}
