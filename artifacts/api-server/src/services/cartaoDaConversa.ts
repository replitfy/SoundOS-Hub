import { and, desc, eq, sql } from "drizzle-orm";
import { commercialOpportunities, commercialOpportunityEvents, db } from "@workspace/db";
import {
  appendEvent,
  buildOfferIdentity,
  createOpportunity,
  OpportunityRuleError,
  SOFIA_INTEREST_SOURCE,
} from "./commercialOpportunities.js";
import { CONVERSA_IDENTIDADE, CONVERSA_ROTULO } from "./cartaoDaConversaIdentidade.js";
import { identificarOuCriarPessoaDoWhatsapp } from "./sofiaPessoa.js";
import { carregarContextoConversa, limparTrecho, MAX_MENSAGENS_CONTEXTO } from "./sofiaTools/interesseContexto.js";
import { logger } from "../lib/logger.js";

/**
 * Cartão da conversa no WhatsApp: quando uma pessoa escreve para a Sofia, a equipe passa a ver um cartão
 * no CRM (nome e telefone vêm da ficha) e a Sofia vai anotando nele o que entende da conversa: intenção,
 * necessidades e informações úteis.
 *
 * Regras que não mudam:
 * - o cartão nasce sem responsável, na etapa "Novo interesse", pelo mesmo caminho do interesse da Sofia
 *   (origem SOFIA_INTERESSE, a única que o banco aceita sem responsável); a oferta "Conversa no WhatsApp"
 *   o separa dos cartões de evento;
 * - a Sofia só acrescenta ao histórico (evento UPDATED, sem subir `version`): nunca troca etapa, responsável,
 *   próxima ação nem escreve no campo "informações" que a equipe preenche;
 * - só entra o que a PESSOA disse, em poucas palavras. Nada que a Sofia disse, nada de preço, CPF, e-mail,
 *   telefone, link, saúde ou dados de terceiros: o servidor recusa esses itens, o modelo não decide;
 * - telefone é só sinal de busca: número de mais de uma ficha, ficha arquivada ou número estrangeiro não
 *   têm cartão.
 */

export { CONVERSA_IDENTIDADE, CONVERSA_ROTULO };
if (buildOfferIdentity({ nucleus: "EDUCATION", offerLabel: CONVERSA_ROTULO }) !== CONVERSA_IDENTIDADE) {
  throw new Error("CONVERSA_IDENTIDADE não bate com a identidade de oferta calculada.");
}
export const ACAO_ENTENDIMENTO = "SOFIA_ENTENDIMENTO";
const ORIGEM_ENTENDIMENTO = "SOFIA_CONVERSA";
const TEXTO_PROXIMA_ACAO = "Acompanhar a conversa da Sofia e dar o próximo passo";

export const MAX_ITENS = 12;
export const MAX_CARACTERES_ITEM = 160;
export const MAX_CARACTERES_INTENCAO = 200;

// ── Entendimento: regras puras ─────────────────────────────────────────────

export interface Entendimento {
  intencao: string | null;
  necessidades: string[];
  informacoes: string[];
}

export const ENTENDIMENTO_VAZIO: Entendimento = { intencao: null, necessidades: [], informacoes: [] };

export interface EntradaEntendimento {
  intencao?: unknown;
  necessidades?: unknown;
  informacoes?: unknown;
  remover?: unknown;
}

export type MotivoRejeicao = "vazio" | "contato_ou_numero" | "valor" | "saude" | "limite";

export interface ItemRejeitado {
  campo: "intencao" | "necessidades" | "informacoes";
  motivo: MotivoRejeicao;
}

export interface MudancasDoEntendimento {
  intencao: string | null;
  necessidades: string[];
  informacoes: string[];
  removidos: string[];
}

const PADRAO_CONTATO = /[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/|www\./i;
/** Oito dígitos ou mais (mesmo separados por pontos, traços ou espaços): telefone, CPF, documento. */
const PADRAO_NUMERO_LONGO = /(?:\d[\s.\-()]*){8,}/;
/** Valor em reais: preço nunca vai para o cartão. */
const PADRAO_VALOR = /r\$|\d\s*(?:reais|real)\b/i;
const PADRAO_SAUDE = new RegExp(
  "\\b(?:diagn[óo]stic\\w*|depress[ãa]o|depressiv\\w*|ansiedade|transtorno\\w*|p[âa]nico|bipolar\\w*|esquizofreni\\w*|" +
    "tdah|autis\\w*|c[âa]ncer|doen[çc]a\\w*|medica[çc][ãa]o|medicament\\w*|rem[ée]dio\\w*|antidepressiv\\w*|suic[ií]d\\w*|" +
    "automutila\\w*|v[ií]cio\\w*|depend[êe]ncia\\s+qu[íi]mica|drogas?|[áa]lcool\\w*|maconha|ayahuasca|gestante|gr[áa]vida|" +
    "hiv|diabet\\w*|epilep\\w*|psiquiatr\\w*)\\b",
  "i",
);

function chaveParaComparar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Mesmo item dito de outro jeito curto ("quer aprender" ≈ "quer aprender sound healing"). */
function sinonimos(a: string, b: string): boolean {
  if (a === b) return true;
  const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
  return curto.length >= 12 && longo.includes(curto);
}

function motivoDeRecusa(texto: string): MotivoRejeicao | null {
  if (PADRAO_CONTATO.test(texto) || PADRAO_NUMERO_LONGO.test(texto)) return "contato_ou_numero";
  if (PADRAO_VALOR.test(texto)) return "valor";
  if (PADRAO_SAUDE.test(texto)) return "saude";
  return null;
}

function limpar(valor: unknown, maximo: number): string | null {
  if (typeof valor !== "string") return null;
  const texto = limparTrecho(valor, maximo);
  return texto.length > 0 ? texto : null;
}

function listaDe(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor.slice(0, 8) : [];
}

/**
 * Funde o que a Sofia entendeu agora com o entendimento atual: a intenção é substituída; necessidades e
 * informações só crescem (sem repetir) até o limite; `remover` tira o que deixou de valer. Nunca grava
 * texto recusado e nunca devolve o texto recusado.
 */
export function combinarEntendimento(atual: Entendimento, entrada: EntradaEntendimento): {
  proximo: Entendimento;
  mudou: boolean;
  mudancas: MudancasDoEntendimento;
  rejeitados: ItemRejeitado[];
} {
  const rejeitados: ItemRejeitado[] = [];
  const mudancas: MudancasDoEntendimento = { intencao: null, necessidades: [], informacoes: [], removidos: [] };
  const proximo: Entendimento = {
    intencao: atual.intencao,
    necessidades: [...atual.necessidades],
    informacoes: [...atual.informacoes],
  };

  if (entrada.intencao !== undefined && entrada.intencao !== null) {
    const texto = limpar(entrada.intencao, MAX_CARACTERES_INTENCAO);
    const motivo = texto === null ? "vazio" : motivoDeRecusa(texto);
    if (motivo) rejeitados.push({ campo: "intencao", motivo });
    else if (texto && (atual.intencao === null || chaveParaComparar(atual.intencao) !== chaveParaComparar(texto))) {
      proximo.intencao = texto;
      mudancas.intencao = texto;
    }
  }

  // Remoções antes das inclusões: "mudou de ideia" troca um item por outro no mesmo registro.
  for (const bruto of listaDe(entrada.remover)) {
    const alvo = limpar(bruto, MAX_CARACTERES_ITEM);
    if (!alvo) continue;
    const chave = chaveParaComparar(alvo);
    for (const campo of ["necessidades", "informacoes"] as const) {
      const restantes = proximo[campo].filter(item => !sinonimos(chaveParaComparar(item), chave));
      if (restantes.length !== proximo[campo].length) {
        mudancas.removidos.push(...proximo[campo].filter(item => !restantes.includes(item)));
        proximo[campo] = restantes;
      }
    }
  }

  for (const campo of ["necessidades", "informacoes"] as const) {
    for (const bruto of listaDe(entrada[campo])) {
      const texto = limpar(bruto, MAX_CARACTERES_ITEM);
      const motivo = texto === null ? "vazio" : motivoDeRecusa(texto);
      if (motivo) { rejeitados.push({ campo, motivo }); continue; }
      if (!texto) continue;
      const chave = chaveParaComparar(texto);
      if (proximo[campo].some(item => sinonimos(chaveParaComparar(item), chave))) continue;
      if (proximo[campo].length >= MAX_ITENS) { rejeitados.push({ campo, motivo: "limite" }); continue; }
      proximo[campo].push(texto);
      mudancas[campo].push(texto);
    }
  }

  const mudou = mudancas.intencao !== null || mudancas.necessidades.length > 0 ||
    mudancas.informacoes.length > 0 || mudancas.removidos.length > 0;
  return { proximo, mudou, mudancas, rejeitados };
}

/** Linha para o CONTEXTO da Sofia: o que ela já anotou, para só acrescentar o que for novo. */
export function descreverEntendimento(entendimento: Entendimento): string {
  const partes = [
    entendimento.intencao && `intencao=${entendimento.intencao}`,
    entendimento.necessidades.length > 0 && `necessidades=${entendimento.necessidades.join(" | ")}`,
    entendimento.informacoes.length > 0 && `informacoes=${entendimento.informacoes.join(" | ")}`,
  ].filter(Boolean);
  return `cartao_no_crm: ${partes.length > 0 ? partes.join("; ") : "ainda sem anotações"}`;
}

/** Lê o entendimento de um evento do cartão; metadados fora do formato valem como vazio. */
export function entendimentoDoEvento(metadata: unknown): Entendimento {
  const bruto = (metadata as { sofiaEntendimento?: Partial<Entendimento> } | null)?.sofiaEntendimento;
  const lista = (valor: unknown) => (Array.isArray(valor) ? valor.filter((v): v is string => typeof v === "string") : []);
  return {
    intencao: typeof bruto?.intencao === "string" && bruto.intencao.trim() ? bruto.intencao : null,
    necessidades: lista(bruto?.necessidades),
    informacoes: lista(bruto?.informacoes),
  };
}

// ── Cartão no banco ────────────────────────────────────────────────────────

type Executor = Pick<typeof db, "select">;

async function cartaoAtivoDaPessoa(pessoaId: number, executor: Executor = db): Promise<{ id: number } | null> {
  const [cartao] = await executor
    .select({ id: commercialOpportunities.id })
    .from(commercialOpportunities)
    .where(and(
      eq(commercialOpportunities.pessoaId, pessoaId),
      eq(commercialOpportunities.nucleus, "EDUCATION"),
      eq(commercialOpportunities.offerIdentity, CONVERSA_IDENTIDADE),
      sql`${commercialOpportunities.stage} <> 'CLOSED'`,
    ))
    .limit(1);
  return cartao ?? null;
}

async function ultimoEntendimento(opportunityId: number, executor: Executor = db): Promise<Entendimento> {
  const [evento] = await executor
    .select({ metadata: commercialOpportunityEvents.metadata })
    .from(commercialOpportunityEvents)
    .where(and(
      eq(commercialOpportunityEvents.opportunityId, opportunityId),
      eq(commercialOpportunityEvents.eventType, "UPDATED"),
      sql`${commercialOpportunityEvents.metadata} ->> 'action' = ${ACAO_ENTENDIMENTO}`,
    ))
    .orderBy(desc(commercialOpportunityEvents.id))
    .limit(1);
  return evento ? entendimentoDoEvento(evento.metadata) : ENTENDIMENTO_VAZIO;
}

/** O que a Sofia já anotou no cartão da conversa da pessoa; vazio quando não há cartão ativo. */
export async function carregarEntendimentoDaPessoa(pessoaId: number): Promise<Entendimento | null> {
  const cartao = await cartaoAtivoDaPessoa(pessoaId);
  return cartao ? ultimoEntendimento(cartao.id) : null;
}

export type StatusCartaoDaConversa = "criado" | "ja_existia";

/**
 * Garante UM cartão ativo "Conversa no WhatsApp" para a pessoa. Se o anterior foi encerrado, a próxima
 * mensagem abre um novo. `textoAtual` é a mensagem que acabou de chegar e ainda não foi gravada.
 */
export async function garantirCartaoDaConversa(input: {
  pessoaId: number;
  conversationId: number;
  textoAtual?: string;
  now?: Date;
}): Promise<StatusCartaoDaConversa> {
  if (await cartaoAtivoDaPessoa(input.pessoaId)) return "ja_existia";
  const now = input.now ?? new Date();
  const contexto = await carregarContextoConversa(input.pessoaId, input.conversationId, now);
  const atual = input.textoAtual ? limparTrecho(input.textoAtual) : "";
  if (atual && contexto.mensagens.at(-1) !== atual) {
    contexto.mensagens = [...contexto.mensagens, atual].slice(-MAX_MENSAGENS_CONTEXTO);
  }
  try {
    await createOpportunity({
      pessoaId: input.pessoaId,
      nucleus: "EDUCATION",
      offerLabel: CONVERSA_ROTULO,
      nextTaskType: "WHATSAPP",
      nextTaskText: TEXTO_PROXIMA_ACAO,
      nextTaskAt: now,
      source: SOFIA_INTEREST_SOURCE,
      actor: { kind: "SOFIA" },
      allowUnowned: true,
      // O índice único de oferta ativa impede duplicar; a chave só protege a gravação em si.
      idempotencyKey: `sofia-conversa:${input.conversationId}:${now.getTime()}`,
      eventMetadata: { sofiaConversation: contexto },
    });
    return "criado";
  } catch (erro) {
    // Outra chamada abriu o cartão no intervalo entre a checagem e a criação.
    if (erro instanceof OpportunityRuleError && erro.code === "ACTIVE_OPPORTUNITY_EXISTS") return "ja_existia";
    throw erro;
  }
}

export interface PreparoDaConversa {
  /** Ficha que a conversa deve usar; `null` quando não há ficha ligada a ela. */
  pessoaId: number | null;
  cartao: StatusCartaoDaConversa | "sem_ficha";
}

/**
 * Chamado antes de a Sofia responder no WhatsApp: abre a ficha (se o número for novo) e o cartão da
 * conversa. Uma ficha só achada pelo telefone ganha o cartão, mas NÃO é ligada à conversa: a Sofia não
 * revela o histórico de uma ficha só porque o telefone bate.
 */
export async function prepararConversaWhatsapp(input: {
  conversationId: number;
  texto: string;
  perfil: string | null;
  now?: Date;
}): Promise<PreparoDaConversa> {
  const identificacao = await identificarOuCriarPessoaDoWhatsapp({
    conversationId: input.conversationId,
    perfilWhatsapp: input.perfil,
  });
  if (identificacao.pessoaId === null) return { pessoaId: null, cartao: "sem_ficha" };
  const cartao = await garantirCartaoDaConversa({
    pessoaId: identificacao.pessoaId,
    conversationId: input.conversationId,
    textoAtual: input.texto,
    now: input.now,
  });
  const ligada = identificacao.status === "criada" || identificacao.status === "vinculada";
  return { pessoaId: ligada ? identificacao.pessoaId : null, cartao };
}

export interface ResultadoAtualizarCartao {
  status: "atualizado" | "sem_mudanca" | "sem_ficha" | "falhou";
  anotado?: { intencao: boolean; necessidades: number; informacoes: number; removidos: number };
  rejeitados: ItemRejeitado[];
  instrucao: string;
}

const INSTRUCAO_ATUALIZADO = "Anotado para a equipe. Não avise a pessoa nem diga que anotou algo.";
const INSTRUCAO_SEM_MUDANCA = "Nada novo para anotar. Continue a conversa normalmente.";
const INSTRUCAO_SEM_FICHA = "Esta conversa não tem cartão no CRM. Não diga que anotou nada.";
const INSTRUCAO_FALHOU = "Não consegui anotar agora. Não diga que anotou nada e continue a conversa.";
const INSTRUCAO_REJEITADOS =
  " Alguns itens não foram anotados (valor, contato, número ou assunto de saúde). Não comente isso com a pessoa; " +
  "se o assunto importa, registre de forma geral, sem o dado recusado.";

/**
 * `atualizar_cartao`: a Sofia registra o que entendeu da conversa. A ficha vem da conversa; o modelo nunca
 * informa pessoa nem cartão. O resultado não devolve o que já estava anotado (a ficha pode não ser da
 * pessoa que escreve) nem o texto recusado.
 */
export async function atualizarCartaoDaConversa(input: {
  conversationId: number;
  entrada: EntradaEntendimento;
  now?: Date;
}): Promise<ResultadoAtualizarCartao> {
  const now = input.now ?? new Date();
  try {
    const identificacao = await identificarOuCriarPessoaDoWhatsapp({ conversationId: input.conversationId });
    if (identificacao.pessoaId === null) return { status: "sem_ficha", rejeitados: [], instrucao: INSTRUCAO_SEM_FICHA };
    const pessoaId = identificacao.pessoaId;
    await garantirCartaoDaConversa({ pessoaId, conversationId: input.conversationId, now });

    const resultado = await db.transaction(async tx => {
      const [cartao] = await tx
        .select({ id: commercialOpportunities.id, stage: commercialOpportunities.stage })
        .from(commercialOpportunities)
        .where(and(
          eq(commercialOpportunities.pessoaId, pessoaId),
          eq(commercialOpportunities.nucleus, "EDUCATION"),
          eq(commercialOpportunities.offerIdentity, CONVERSA_IDENTIDADE),
          sql`${commercialOpportunities.stage} <> 'CLOSED'`,
        ))
        .limit(1)
        .for("update");
      if (!cartao) return null;

      const atual = await ultimoEntendimento(cartao.id, tx);
      const fundido = combinarEntendimento(atual, input.entrada);
      if (!fundido.mudou) return { fundido, anotou: false };

      // `version` não sobe de propósito: só `lastInteractionAt` muda, campo que nenhuma edição humana grava.
      await tx
        .update(commercialOpportunities)
        .set({ lastInteractionAt: now, updatedAt: now })
        .where(eq(commercialOpportunities.id, cartao.id));
      await appendEvent(tx, {
        opportunityId: cartao.id,
        actor: { kind: "SOFIA" },
        toStage: cartao.stage,
        eventType: "UPDATED",
        source: ORIGEM_ENTENDIMENTO,
        idempotencyKey: `sofia-entendimento:${cartao.id}:${input.conversationId}:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
        metadata: {
          action: ACAO_ENTENDIMENTO,
          conversationId: input.conversationId,
          sofiaEntendimento: fundido.proximo,
          mudancas: fundido.mudancas,
        },
      });
      return { fundido, anotou: true };
    });

    if (!resultado) return { status: "sem_ficha", rejeitados: [], instrucao: INSTRUCAO_SEM_FICHA };
    const { fundido, anotou } = resultado;
    const aviso = fundido.rejeitados.length > 0 ? INSTRUCAO_REJEITADOS : "";
    if (!anotou) return { status: "sem_mudanca", rejeitados: fundido.rejeitados, instrucao: INSTRUCAO_SEM_MUDANCA + aviso };
    logger.info(
      {
        conversationId: input.conversationId,
        intencao: fundido.mudancas.intencao !== null,
        necessidades: fundido.mudancas.necessidades.length,
        informacoes: fundido.mudancas.informacoes.length,
        removidos: fundido.mudancas.removidos.length,
        rejeitados: fundido.rejeitados.length,
      },
      "Sofia simples: atualizar_cartao",
    );
    return {
      status: "atualizado",
      anotado: {
        intencao: fundido.mudancas.intencao !== null,
        necessidades: fundido.mudancas.necessidades.length,
        informacoes: fundido.mudancas.informacoes.length,
        removidos: fundido.mudancas.removidos.length,
      },
      rejeitados: fundido.rejeitados,
      instrucao: INSTRUCAO_ATUALIZADO + aviso,
    };
  } catch (erro) {
    // Sem texto da pessoa nem telefone no log: só o tipo do erro.
    logger.warn({ conversationId: input.conversationId, erroTipo: (erro as { name?: string })?.name }, "Sofia simples: atualizar_cartao falhou");
    return { status: "falhou", rejeitados: [], instrucao: INSTRUCAO_FALHOU };
  }
}
