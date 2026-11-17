// Motor de decisão da Sofia (Documento 14A) — versão qualitativa.
//
// Implementa o trecho do fluxo cognitivo que já pode ser operacionalizado com
// os documentos disponíveis: elegibilidade por pré-requisito de módulo
// (sequência conhecida Água → Fogo → Ar → Terra) e classificação de Next Best
// Action nas categorias oficiais do Documento 14A. O scoring cognitivo
// quantitativo por dimensão (Documentos 03A/06B, ainda não entregues) fica
// fora de escopo — não inventamos pontuação numérica não documentada.

import { db, pessoaEvidencias, pessoasTable, decisionRuns, NBA_CATEGORIAS, type NbaCategoria, type ElegibilidadeStatus, type EvidenciaConsiderada } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { applyDecisionRunToOpportunities } from "./commercialOpportunities";

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// ── Módulos e pré-requisitos conhecidos ─────────────────────────
export const MODULOS = ["agua", "fogo", "ar", "terra"] as const;
export type Modulo = (typeof MODULOS)[number];

// Sequência de pré-requisitos já documentada: Fogo exige Água; Ar exige
// Água+Fogo; Terra exige Água+Fogo+Ar. "agua" não tem pré-requisito.
export const MODULE_PREREQUISITES: Record<Modulo, Modulo[]> = {
  agua: [],
  fogo: ["agua"],
  ar: ["agua", "fogo"],
  terra: ["agua", "fogo", "ar"],
};

export const MODULO_LABEL: Record<Modulo, string> = {
  agua: "Água", fogo: "Fogo", ar: "Ar", terra: "Terra",
};

// Os quatro nomes de módulo (água, fogo, ar, terra) são também palavras
// comuns do português — "ar condicionado", "regar a terra", "acender o
// fogo", "copo d'água" não têm nada a ver com o curso. Detectar só a palavra
// isolada gera falso positivo e bloqueia/desvia conversas legítimas sem
// relação com o produto (é o mesmo motivo pelo qual gatilhos que exigem
// julgamento não podem depender só de regex — ver decisão de handoff por
// escalonamento). Por isso exigimos que o nome do módulo apareça perto de um
// termo-âncora do domínio (módulo, curso, aula, vídeo, jornada etc.) para
// contar como menção real ao produto em texto livre.
const CONTEXT_ANCHORS = [
  "modulo", "curso", "aula", "aulas", "formacao", "trilha", "jornada", "turma",
  "vivencia", "retiro", "cerimonia", "video", "conteudo", "workshop",
  "encontro", "imersao", "propedeutico", "elemento", "presencial", "ciclo",
];
const CONTEXT_ANCHOR_PATTERN = new RegExp(`\\b(${CONTEXT_ANCHORS.join("|")})\\w*\\b`);

/**
 * Detecta menção a um módulo com pré-requisito conhecido em texto livre
 * (mensagem da pessoa, ou argumentos como `curso`/`textoAdicional` pedidos a
 * recommendVideos). Exige um termo-âncora do domínio perto do nome do
 * módulo — não confia em bater só a palavra isolada, que é ambígua em
 * português comum (ver nota acima). Para valores de campo estruturado (ex.:
 * `curso` já cadastrado em `pessoa_participacoes`), use `matchCursoCanonico`.
 */
export function detectModuloComPrerequisito(texto: string | null | undefined): Modulo | null {
  return detectTodosModulosComPrerequisito(texto)[0] ?? null;
}

/**
 * Detecta TODOS os módulos citados em `texto` por palavra isolada, SEM
 * exigir um termo-âncora de domínio (módulo/curso/aula/etc.). Isso é
 * arriscado para texto arbitrário de um usuário humano — "ar condicionado",
 * "regar a terra" são conversa comum e não devem bloquear nada — mas é o
 * detector correto para a RESPOSTA que a própria Sofia gera: seu system
 * prompt já a restringe ao domínio de cursos/jornada, então qualquer menção
 * a um desses quatro nomes ali é, na prática, sempre sobre o produto, mesmo
 * em frases sem um substantivo de domínio explícito ("Você pode fazer
 * Fogo", "Recomendo Fogo para você"). Usar SOMENTE no gate pós-geração,
 * nunca em texto de entrada do usuário (para isso, use a versão com âncora).
 */
export function detectTodosModulosSemAncora(texto: string | null | undefined): Modulo[] {
  if (!texto?.trim()) return [];
  const normalized = stripAccents(texto.trim());
  const encontrados: Modulo[] = [];
  for (const modulo of MODULOS) {
    if (new RegExp(`\\b${modulo}\\b`).test(normalized)) encontrados.push(modulo);
  }
  return encontrados;
}

/**
 * Como `detectModuloComPrerequisito`, mas retorna TODOS os módulos
 * mencionados no texto, não só o primeiro. Necessário para checar a
 * resposta inteira que a Sofia gerou: uma frase pode citar vários módulos
 * juntos (ex.: "a sequência é Água → Fogo → Ar → Terra") — se checássemos só
 * o primeiro (Água, que nunca é bloqueado), passaríamos por cima de uma
 * oferta/promessa indevida de um módulo mais adiante na mesma frase.
 */
export function detectTodosModulosComPrerequisito(texto: string | null | undefined): Modulo[] {
  if (!texto?.trim()) return [];
  const normalized = stripAccents(texto.trim());
  if (!CONTEXT_ANCHOR_PATTERN.test(normalized)) return [];
  // Ordem importa: checar os termos mais específicos (terra/ar) evita que
  // "ar" case como substring de outra palavra comum — usamos \b para isolar.
  const encontrados: Modulo[] = [];
  for (const modulo of MODULOS) {
    if (new RegExp(`\\b${modulo}\\b`).test(normalized)) encontrados.push(modulo);
  }
  return encontrados;
}

/**
 * Casa o valor de um campo estruturado (ex.: `curso` já registrado em
 * `pessoa_participacoes`, vindo de import de planilha) contra os módulos
 * conhecidos. Diferente de `detectModuloComPrerequisito`, não exige
 * termo-âncora: aqui o valor já é um dado cadastral controlado, não uma
 * frase livre de conversa, então não tem a mesma ambiguidade.
 */
export function matchCursoCanonico(curso: string | null | undefined): Modulo | null {
  if (!curso?.trim()) return null;
  const normalized = stripAccents(curso.trim());
  for (const modulo of MODULOS) {
    if (new RegExp(`\\b${modulo}\\b`).test(normalized)) return modulo;
  }
  return null;
}

/**
 * Resolve qual módulo (com pré-requisito) está em jogo numa chamada da tool
 * recommendVideos, combinando TODOS os argumentos relevantes — não só o
 * `curso`. A Sofia pode nomear o módulo em `tipoConteudo` ou
 * `textoAdicional` em vez de `curso`; checar só um campo permite escapar do
 * gate por engano de argumento.
 *
 * `curso` é tratado como campo estruturado (`matchCursoCanonico`, sem exigir
 * termo-âncora): é o argumento canônico da tool para "qual curso/módulo",
 * então "Ar" sozinho já é uma menção real, igual ao dado cadastrado em
 * `pessoa_participacoes`. `tipoConteudo`/`textoAdicional` são texto livre
 * descritivo, então passam pelo detector com âncora de contexto
 * (`detectModuloComPrerequisito`) para evitar falso positivo em prosa comum.
 */
export function resolveOfertaModulo(args: {
  curso?: string | null;
  outrasFontes?: Array<string | null | undefined>;
}): Modulo | null {
  const doCurso = matchCursoCanonico(args.curso);
  if (doCurso) return doCurso;
  for (const fonte of args.outrasFontes ?? []) {
    const modulo = detectModuloComPrerequisito(fonte);
    if (modulo) return modulo;
  }
  return null;
}

/**
 * Módulos que a pessoa já concluiu, a partir de sinais já existentes no CRM:
 * os campos legados `aguaPresencial`/`fogoPresencial` (import da planilha) e
 * o histórico de `pessoa_participacoes` (curso livre, casado por nome).
 * Fonte de dados ainda esparsa (Documentos 03A/06B não entregues) — quando
 * não houver sinal, o módulo é tratado como não concluído, nunca assumido.
 */
export async function getModulosConcluidos(pessoaId: number): Promise<Set<Modulo>> {
  const concluidos = new Set<Modulo>();

  // Única fonte de evidência estrutural de conclusão hoje: as colunas
  // curadas aguaPresencial/fogoPresencial, preenchidas por importação
  // controlada. `pessoa_participacoes.curso` é texto livre sem valores
  // canônicos definidos (import ainda não normalizado — ver task #123) e
  // NÃO é usado aqui: um match de palavra nesse campo poderia conceder
  // elegibilidade indevida a partir de um nome de curso não relacionado
  // que por acaso contém "ar"/"terra"/etc. Falso "bloqueado" é aceitável;
  // falso "elegível" não é — por isso preferimos nunca conceder nesse caso
  // até existir um identificador de módulo confiável nessa tabela.
  const [pessoa] = await db.select({
    aguaPresencial: pessoasTable.aguaPresencial,
    fogoPresencial: pessoasTable.fogoPresencial,
  }).from(pessoasTable).where(eq(pessoasTable.id, pessoaId)).limit(1);

  if (pessoa?.aguaPresencial?.trim()) concluidos.add("agua");
  if (pessoa?.fogoPresencial?.trim()) concluidos.add("fogo");

  return concluidos;
}

/**
 * Mensagem determinística usada quando um módulo bloqueado é identificado —
 * seja porque a própria pessoa o nomeou (gate de pré-geração) ou porque a
 * resposta que a Sofia gerou o mencionou/ofereceu por conta própria (gate
 * pós-geração). Em ambos os casos a resposta final que chega ao cliente é
 * esta, nunca o texto livre do modelo — não há como o modelo "escapar" da
 * regra descrevendo o módulo de outro jeito, porque o texto dele nunca sai
 * do servidor quando o gate bloqueia.
 */
export function deterministicBlockedMessage(modulo: Modulo, elegibilidade: EligibilityCheck): string {
  const faltandoLabels = elegibilidade.faltando.map((m) => MODULO_LABEL[m]).join(", ");
  return `Para ${MODULO_LABEL[modulo]}, o passo necessário antes é ${faltandoLabels}. ` +
    `Você já concluiu ${faltandoLabels}? Me conta quando e em qual formato (online ou presencial) que sigo te orientando a partir daí.`;
}

export interface EligibilityCheck {
  status: ElegibilidadeStatus;
  motivo: string;
  faltando: Modulo[];
}

/** Checa se a pessoa é elegível para um módulo, dado o que ela já concluiu. */
export function checkModuleEligibility(modulo: Modulo, concluidos: Set<Modulo>): EligibilityCheck {
  const prerequisitos = MODULE_PREREQUISITES[modulo];
  const faltando = prerequisitos.filter((p) => !concluidos.has(p));
  if (faltando.length === 0) {
    return { status: "elegivel", motivo: `Pré-requisitos para ${MODULO_LABEL[modulo]} atendidos.`, faltando: [] };
  }
  const faltandoLabels = faltando.map((m) => MODULO_LABEL[m]).join(", ");
  return {
    status: "bloqueado",
    motivo: `${MODULO_LABEL[modulo]} exige ${faltandoLabels} antes — pessoa ainda não tem esse pré-requisito registrado.`,
    faltando,
  };
}

/**
 * Captura somente uma negativa explícita de conclusão. A declaração serve para
 * orientar a conversa e registrar intenção, nunca como evidência positiva de
 * que um módulo foi concluído.
 */
export function detectDeclaredModuleNonCompletion(texto: string | null | undefined): Modulo | null {
  if (!texto?.trim()) return null;
  const normalized = stripAccents(texto);
  for (const modulo of MODULOS) {
    const moduleLabel = `(?:o\\s+)?(?:(?:modulo|curso)(?:\\s+de)?\\s+)?${modulo}`;
    const deniedBeforeModule = new RegExp(
      `\\b(?:nunca|nao|ainda\\s+nao)\\s+(?:fiz|cursei|completei|conclui|terminei|participei)(?:\\s+${moduleLabel})\\b`,
    );
    const moduleBeforeDenied = new RegExp(
      `\\b${moduleLabel}(?:\\s+eu)?\\s+(?:nunca|nao|ainda\\s+nao)\\s+(?:fiz|cursei|completei|conclui|terminei|participei)\\b`,
    );
    if (deniedBeforeModule.test(normalized) || moduleBeforeDenied.test(normalized)) return modulo;
  }
  return null;
}

// ── Registro do decision_run (auditoria) ────────────────────────
export interface RecordDecisionRunParams {
  pessoaId: number | null;
  conversationId: number | null;
  messageId: number | null;
  conduta: "triagem" | "comercial" | null;
  promptId: number | null;
  model: string | null;
  elegibilidadeStatus: ElegibilidadeStatus;
  elegibilidadeMotivo: string | null;
  ofertaPrincipal: string | null;
  ofertaAlternativa: string | null;
  nbaCategoria: NbaCategoria;
  nbaJustificativa: string;
  nivelConfianca: "baixa" | "media" | "alta";
  metadata?: Record<string, unknown>;
}

// Campos cuja evidência mais recente vale a pena anexar ao decision_run —
// os mesmos que sustentam conduta/oferta (perfil, intenção, temperatura) mais
// o próprio campo de interesse declarado.
const CAMPOS_EVIDENCIA_DECISAO = ["perfilPrincipal", "intencaoPrincipal", "temperatura", "servicoInteresse"] as const;

async function snapshotEvidencias(pessoaId: number | null): Promise<EvidenciaConsiderada[]> {
  if (pessoaId === null) return [];
  const rows = await db.select({
    campo: pessoaEvidencias.campo,
    valor: pessoaEvidencias.valor,
    tipoEvidencia: pessoaEvidencias.tipoEvidencia,
    nivelConfianca: pessoaEvidencias.nivelConfianca,
    origem: pessoaEvidencias.origem,
    createdAt: pessoaEvidencias.createdAt,
  })
    .from(pessoaEvidencias)
    .where(and(
      eq(pessoaEvidencias.pessoaId, pessoaId),
      inArray(pessoaEvidencias.campo, [...CAMPOS_EVIDENCIA_DECISAO]),
    ))
    .orderBy(desc(pessoaEvidencias.createdAt))
    .limit(40);

  // Mantém só a evidência mais recente por campo (a query já vem ordenada
  // por data desc, então o primeiro encontro de cada campo é o mais atual).
  const maisRecentePorCampo = new Map<string, EvidenciaConsiderada>();
  for (const r of rows) {
    if (!maisRecentePorCampo.has(r.campo)) {
      maisRecentePorCampo.set(r.campo, {
        campo: r.campo, valor: r.valor, tipoEvidencia: r.tipoEvidencia,
        nivelConfianca: r.nivelConfianca, origem: r.origem,
      });
    }
  }

  // Snapshot das colunas curadas que `getModulosConcluidos` de fato usa para
  // decidir elegibilidade (Água/Fogo). Sem isso, um decision_run marcado
  // elegível/bloqueado não prova QUAL evidência estrutural sustentou a
  // decisão, e não sobrevive a uma edição posterior desses campos na ficha —
  // é uma cópia imutável no momento da decisão, igual às demais evidências
  // aqui. Estado ausente é registrado explicitamente (não omitido).
  const [pessoa] = await db.select({
    aguaPresencial: pessoasTable.aguaPresencial,
    fogoPresencial: pessoasTable.fogoPresencial,
  }).from(pessoasTable).where(eq(pessoasTable.id, pessoaId)).limit(1);

  const evidenciasCompletude: EvidenciaConsiderada[] = [
    {
      campo: "agua_presencial",
      valor: pessoa?.aguaPresencial?.trim() || null,
      tipoEvidencia: "completude_estruturada",
      nivelConfianca: "alta",
      origem: "coluna_curada_pessoas",
    },
    {
      campo: "fogo_presencial",
      valor: pessoa?.fogoPresencial?.trim() || null,
      tipoEvidencia: "completude_estruturada",
      nivelConfianca: "alta",
      origem: "coluna_curada_pessoas",
    },
  ];

  return [...maisRecentePorCampo.values(), ...evidenciasCompletude];
}

// ── Classificação de NBA para respostas sem tool call ───────────
// A Sofia frequentemente resolve elegibilidade/recomendação em texto livre,
// sem chamar recommendVideos/escalateToHuman (ex.: pergunta "você já fez
// Água?" em vez de acionar uma tool). Para o decision_run cobrir TODA
// resposta relevante — não só as que passam por uma tool — classificamos a
// resposta já gerada com uma chamada estruturada e barata, em vez de tratar
// "chamou uma tool" como proxy de "tomou uma decisão".
export interface ClassifiedDecision {
  elegibilidadeStatus: ElegibilidadeStatus;
  elegibilidadeMotivo: string | null;
  ofertaPrincipal: string | null;
  ofertaAlternativa: string | null;
  nbaCategoria: NbaCategoria;
  nbaJustificativa: string;
  nivelConfianca: "baixa" | "media" | "alta";
}

const FALLBACK_CLASSIFICATION: ClassifiedDecision = {
  elegibilidadeStatus: "nao_avaliada",
  elegibilidadeMotivo: null,
  ofertaPrincipal: null,
  ofertaAlternativa: null,
  nbaCategoria: "conversar",
  nbaJustificativa: "Classificação automática indisponível nesta rodada — registro conservador para não perder o rastro de auditoria.",
  nivelConfianca: "baixa",
};

function isNbaCategoria(v: unknown): v is NbaCategoria {
  return typeof v === "string" && (NBA_CATEGORIAS as readonly string[]).includes(v);
}

/**
 * Classifica a rodada (mensagem da pessoa + resposta da Sofia) numa das 10
 * categorias oficiais de NBA (Documento 14A) e numa elegibilidade, mesmo
 * quando nenhuma tool foi chamada nesta rodada. Falha aberta para um registro
 * conservador (não bloqueia a resposta da Sofia, que já foi entregue).
 */
export async function classifyDecision(params: {
  userMessage: string;
  assistantResponse: string;
  conduta: "triagem" | "comercial" | null;
  model: string;
}): Promise<ClassifiedDecision> {
  try {
    const completion = await openai.chat.completions.create({
      model: params.model,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Você audita, não conversa. Classifique a rodada abaixo (mensagem da pessoa + resposta já enviada pela Sofia) " +
            "para fins de auditoria do motor de decisão (Documento 14A). Responda APENAS com um JSON no formato:\n" +
            '{"elegibilidadeStatus": "elegivel"|"bloqueado"|"nao_avaliada", "elegibilidadeMotivo": string|null, ' +
            '"ofertaPrincipal": string|null, "ofertaAlternativa": string|null, ' +
            `"nbaCategoria": um de [${NBA_CATEGORIAS.join(", ")}], "nbaJustificativa": string curta, ` +
            '"nivelConfianca": "baixa"|"media"|"alta"}\n' +
            "Categorias oficiais (não invente outras): aprender (orientar sobre um caminho/pré-requisito antes de uma oferta), " +
            "consumir_conteudo (compartilhar material/vídeo), explorar (ajudar a pessoa a entender opções sem compromisso), " +
            "participar (convidar para um evento/vivência aberta), aprofundar (indicar uma formação mais avançada), " +
            "experimentar (sugerir uma experiência inicial/teste), conversar (apenas dialogar, sem oferta/handoff), " +
            "comunidade (conectar a um grupo/comunidade), comprar (fechamento/oferta comercial direta), " +
            "pausar (nenhuma ação recomendada agora).\n" +
            `Conduta ativa nesta rodada: ${params.conduta ?? "desconhecida"}.`,
        },
        { role: "user", content: `Mensagem da pessoa: ${params.userMessage}\n\nResposta da Sofia: ${params.assistantResponse}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return FALLBACK_CLASSIFICATION;
    const parsed = JSON.parse(raw) as Partial<ClassifiedDecision>;
    return {
      elegibilidadeStatus: (["elegivel", "bloqueado", "nao_avaliada"] as const).includes(parsed.elegibilidadeStatus as ElegibilidadeStatus)
        ? parsed.elegibilidadeStatus as ElegibilidadeStatus : "nao_avaliada",
      elegibilidadeMotivo: typeof parsed.elegibilidadeMotivo === "string" ? parsed.elegibilidadeMotivo : null,
      ofertaPrincipal: typeof parsed.ofertaPrincipal === "string" ? parsed.ofertaPrincipal : null,
      ofertaAlternativa: typeof parsed.ofertaAlternativa === "string" ? parsed.ofertaAlternativa : null,
      nbaCategoria: isNbaCategoria(parsed.nbaCategoria) ? parsed.nbaCategoria : "conversar",
      nbaJustificativa: typeof parsed.nbaJustificativa === "string" && parsed.nbaJustificativa.trim()
        ? parsed.nbaJustificativa : FALLBACK_CLASSIFICATION.nbaJustificativa,
      nivelConfianca: (["baixa", "media", "alta"] as const).includes(parsed.nivelConfianca as "baixa")
        ? parsed.nivelConfianca as "baixa" | "media" | "alta" : "baixa",
    };
  } catch {
    return FALLBACK_CLASSIFICATION;
  }
}

/**
 * Grava um decision_run — chamado toda vez que a Sofia toma uma decisão
 * relevante (recomenda algo, decide não recomendar por elegibilidade, ou
 * aciona handoff). Sempre inclui um snapshot das evidências consideradas
 * naquele momento, já que pessoa_evidencias é append-only e pode mudar depois.
 */
/**
 * Wrapper best-effort de recordDecisionRun: a resposta da Sofia já foi
 * gerada e (na maioria dos casos) já entregue ao cliente por SSE quando isso
 * roda. Uma falha aqui (tabela de auditoria fora do ar, race de migração
 * etc.) nunca pode virar um erro visível pro usuário nem interromper o fluxo
 * — só perdemos o registro de auditoria desta rodada, que fica logado.
 */
export async function safeRecordDecisionRun(
  params: RecordDecisionRunParams,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<number | null> {
  try {
    return await recordDecisionRun(params);
  } catch (err) {
    log?.warn({ err, pessoaId: params.pessoaId, conversationId: params.conversationId }, "decision_run recording failed (non-fatal)");
    return null;
  }
}

export async function recordDecisionRun(params: RecordDecisionRunParams): Promise<number> {
  const evidenciasConsideradas = await snapshotEvidencias(params.pessoaId);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(decisionRuns).values({
      pessoaId: params.pessoaId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      conduta: params.conduta,
      promptId: params.promptId,
      model: params.model,
      evidenciasConsideradas,
      elegibilidadeStatus: params.elegibilidadeStatus,
      elegibilidadeMotivo: params.elegibilidadeMotivo,
      ofertaPrincipal: params.ofertaPrincipal,
      ofertaAlternativa: params.ofertaAlternativa,
      nbaCategoria: params.nbaCategoria,
      nbaJustificativa: params.nbaJustificativa,
      nivelConfianca: params.nivelConfianca,
      metadata: params.metadata ?? {},
    }).returning({ id: decisionRuns.id });
    if (!row) throw new Error("decision_run insert returned no row");
    if (params.pessoaId !== null) {
      await applyDecisionRunToOpportunities(tx, {
        pessoaId: params.pessoaId,
        decisionRunId: row.id,
        elegibilidadeStatus: params.elegibilidadeStatus,
        nbaCategoria: params.nbaCategoria,
        metadata: params.metadata,
      });
    }
    return row.id;
  });
}
