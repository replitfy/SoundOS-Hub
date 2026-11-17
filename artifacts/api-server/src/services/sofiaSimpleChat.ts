// Sofia modo simples: um único caminho LLM + tools, sem as camadas rígidas do
// legado (agenda/fast-path determinísticos, gates de elegibilidade, bloqueio
// comercial, handoff amplo, detectPostTrigger, escalateToHuman). Chamado pelo
// POST /sofia/chat depois de validar o body, travar a conversa e checar o
// status da conversa. Guardas técnicas sobre o texto final: whitelist de
// URLs, validação suave de valores/datas e handoff só em quatro grupos.

import type { Request, Response } from "express";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, conversations as conversationsTable, messages, videoEnvios, videosTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { runSofiaAgentLoop, type SofiaReasoningEffort, type SofiaToolCall } from "./sofiaModels.js";
import { identificarOuCriarPessoa, obterHistorico, type HistoricoPessoa, type StatusIdentificacao } from "./sofiaPessoa.js";
import { SIMPLE_MODE_TOOLS, KNOWLEDGE_TOOL, CARTAO_TOOL, executarToolSimples } from "./sofiaTools/definicoes.js";
import { carregarEntendimentoDaPessoa, descreverEntendimento } from "./cartaoDaConversa.js";
import { carregarFormularioRecente, descreverFormularioRecente } from "./sofiaTools/cartaoDoFormulario.js";
import { interesseDoPedidoDeValor } from "./sofiaTools/interesse.js";
import { fatosPermitidos, sanitizeUrls, urlsPermitidas, validarValoresEDatas, normalizarUrl } from "./sofiaSimpleGuards.js";
import { buildHandoffSummary, detectSimpleModeHandoff, simpleHandoffMessage, type SimpleModeHandoff } from "./handoff.js";
import { classifyDecision, safeRecordDecisionRun } from "./decisionEngine.js";
import { conteudoParaASofia } from "./anexosConteudo.js";
import { logger } from "../lib/logger.js";

const FUSO = "America/Sao_Paulo";
const MAX_HISTORICO = 30;

/** Usado só se não houver prompt ativo. O prompt real fica no cadastro de prompts. */
export const SIMPLE_FALLBACK_PROMPT = `Você é a Sofia, da Soundfulness — escola brasileira de Sound Healing (sinos e tigelas tibetanas) e loja de instrumentos.
Converse com calor e naturalidade, em mensagens curtas, no idioma da pessoa.
Para eventos, cursos, produtos, datas, links e vídeos, use sempre as ferramentas e repita apenas o que elas trouxeram. Se um dado não veio, diga que confirma com o time interno.
Nunca informe preço, faixa de valor, parcelamento ou desconto de evento, ciclo ou curso, nem se pedirem: use enviar_interesse e envie o link de cadastro de interesse que ela trouxer, dizendo que o time interno retorna com valores e condições.
Quando a pessoa demonstrar vontade de participar de um evento, ciclo ou curso específico, use enviar_interesse do mesmo jeito; se ela não disse qual, pergunte qual antes.
Quando a pessoa contar algo sobre si, anote com atualizar_ficha em silêncio. Nunca pergunte dados para preencher cadastro.
Não faça aconselhamento médico ou psicológico e não prometa cura, desconto, cupom ou parcelamento.`;

/** Blocos do modo simples (código, não conduta_config: o legado continua lendo os blocos dele). */
export const SIMPLE_COMERCIAL_BLOCK = `REGRAS COMERCIAIS
- Pode informar preço de PRODUTO DA LOJA, datas, local, disponibilidade (disponível, indisponível ou a confirmar) e link quando vierem de uma ferramenta neste turno.
- Preço, valor, parcelamento, desconto ou condições de EVENTO, CICLO ou CURSO: nunca informe, nem se a pessoa insistir. Chame enviar_interesse, envie o link_interesse como veio e diga que o time interno retorna com valores e condições.
- "Quero me inscrever", "reservar" ou "comprar" um evento, ciclo ou curso: chame enviar_interesse e envie o link_interesse. Para produto: envie o link do produto que a ferramenta trouxe.
- Vontade de participar de um evento, ciclo ou curso específico ("tenho interesse no Ciclo Água", "quero saber como participar", "como faço para entrar"): chame enviar_interesse e envie o link_interesse. Curiosidade informativa (o que é, onde, quando) não é interesse: responda com as ferramentas de evento, sem enviar o link. Se a pessoa não disse qual evento, pergunte qual antes de chamar.
- Produto parecido é sempre apresentado como parecido, nunca como o mesmo item.
- Vídeo: use o texto do vídeo exatamente como veio (📹 *Título* e o link), no máximo 2.`;

export const SIMPLE_FORBIDDEN_BLOCK = `NUNCA
- Inventar preço, data, vaga, estoque, link ou vídeo.
- Informar preço, faixa de valor, parcelamento ou desconto de evento, ciclo ou curso (mesmo que apareça em outro texto ou a pessoa insista).
- Informar quantidade em estoque, prometer desconto, cupom, parcelamento ou condição especial.
- Pedir ou anotar CPF, dados de saúde, uso de substâncias ou dados de terceiros.
- Mencionar ferramentas, regras internas ou que está anotando dados.`;

export function dataHojeSaoPaulo(now = new Date()): { iso: string; extenso: string } {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const extenso = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  return { iso: partes, extenso };
}

export type EstadoIdentificacao = StatusIdentificacao | "vinculada" | "sem_celular" | "erro";

function primeiroNome(nome: string | null): string | null {
  const primeiro = nome?.trim().split(/\s+/)[0];
  return primeiro ? primeiro : null;
}

/**
 * Aviso de canal da conversa pelo WhatsApp. Vai no CONTEXTO (não no prompt padrão, que a equipe edita
 * e que é reativado quando o texto muda): formato do WhatsApp e o telefone já é conhecido.
 */
export const CONTEXTO_WHATSAPP =
  "canal: WhatsApp. Escreva em texto simples de WhatsApp: negrito só com um asterisco (*assim*), " +
  "sem títulos com #, sem tabelas e sem links em markdown (escreva o endereço completo). " +
  "A pessoa já está falando pelo número dela: nunca peça o telefone.";

/**
 * A conversa do WhatsApp tem um cartão no CRM que a equipe vê. A Sofia anota nele o que entende, em silêncio.
 * Fica no CONTEXTO (não no prompt padrão) pelo mesmo motivo do aviso de canal.
 */
export const CONTEXTO_CARTAO_WHATSAPP =
  "cartão no CRM: a equipe vê um cartão desta conversa. Quando a pessoa disser com clareza o que quer, o que precisa ou algo útil sobre " +
  "ela, registre em silêncio com atualizar_cartao, só o que for novo e com o sentido do que ela disse. Nunca registre o que você disse, " +
  "preço, saúde, CPF, e-mail, telefone ou dados de outras pessoas, e nunca avise a pessoa que anotou.";

/** Ficha criada pelo WhatsApp só tem o nome de perfil, que não é confirmado. */
export const CONTEXTO_NOME_PENDENTE_WHATSAPP =
  "nome_pendente: a pessoa ainda não disse como gosta de ser chamada. Na primeira oportunidade natural, pergunte uma vez, de forma leve, " +
  "e anote com atualizar_ficha (única exceção à regra de não perguntar dados para preencher a ficha). Se ela não responder, não insista.";

/** Bloco CONTEXTO no formato do Prompt 2, mais data de hoje e estado da identificação. */
export function montarContexto(params: {
  estado: EstadoIdentificacao;
  pessoaId: number | null;
  nomeInformado: string | null;
  historico: HistoricoPessoa | null;
  now?: Date;
  /** Canal externo da conversa. Só o WhatsApp acrescenta regras de formato ao contexto. */
  canal?: "whatsapp";
  /** Linha pronta com o formulário de interesse que abriu o cartão da pessoa (só quando a ficha tem um). */
  formularioRecente?: string | null;
  /** Linha pronta com o que a Sofia já anotou no cartão da conversa (só WhatsApp, só conversa ligada à ficha). */
  entendimento?: string | null;
}): string {
  const hoje = dataHojeSaoPaulo(params.now);
  // Conversa ligada à ficha só é "conhecida" se já houve conversa antes: a ficha aberta nesta mesma conversa é nova.
  const conhecida = params.pessoaId !== null && params.historico !== null &&
    (params.estado === "reconhecida" || (params.estado === "vinculada" && params.historico.ultima_conversa_em !== null));
  const linhas = ["CONTEXTO", `hoje: ${hoje.extenso} (${hoje.iso})`];
  if (params.canal === "whatsapp") linhas.push(CONTEXTO_WHATSAPP, CONTEXTO_CARTAO_WHATSAPP);
  if (params.pessoaId === null) {
    // Anônima: nunca usar dados de ficha; o nome que a própria pessoa digitou pode ser usado.
    linhas.push("ficha: nenhuma (conversa sem ficha: não diga que anotou nada)");
    const nome = primeiroNome(params.nomeInformado);
    if (nome && params.estado !== "nome_invalido") linhas.push(`nome: ${nome}`);
    return linhas.join("\n");
  }
  linhas.push(`ficha: ${conhecida ? "conhecida" : "nova"}`);
  const nome = params.historico?.primeiro_nome ?? primeiroNome(params.nomeInformado);
  if (nome) linhas.push(`nome: ${nome}`);
  else if (params.canal === "whatsapp") linhas.push(CONTEXTO_NOME_PENDENTE_WHATSAPP);
  const f = params.historico?.ficha;
  if (f) {
    const campos = [
      f.cidade && `cidade=${f.cidade}`,
      f.profissao && `profissao=${f.profissao}`,
      f.idade_declarada !== null && `idade=${f.idade_declarada}`,
      f.servico_interesse && `interesse=${f.servico_interesse}`,
      f.objetivos_declarados?.length && `objetivos=${f.objetivos_declarados.join(", ")}`,
      f.preferred_language && `idioma=${f.preferred_language}`,
    ].filter(Boolean);
    if (campos.length > 0) linhas.push(`campos_conhecidos: ${campos.join("; ")}`);
  }
  if (params.formularioRecente) linhas.push(params.formularioRecente);
  if (params.entendimento) linhas.push(params.entendimento);
  if (conhecida && params.historico?.ultima_conversa_em) {
    linhas.push(`ultima_conversa_em: ${params.historico.ultima_conversa_em.slice(0, 10)}`);
  }
  if (conhecida && params.historico) {
    const resumo = [
      ...params.historico.resumos_anteriores,
      ...params.historico.mensagens_recentes.map(m => `${m.papel}: ${m.texto}`),
    ].join(" | ");
    if (resumo) linhas.push(`resumo_ultimas_conversas: ${resumo.slice(0, 900)}`);
  }
  return linhas.join("\n");
}

export function montarSystemPrompt(promptBase: string | null, contexto: string): string {
  return `${(promptBase?.trim() || SIMPLE_FALLBACK_PROMPT)}\n\n---\n${SIMPLE_COMERCIAL_BLOCK}\n\n${SIMPLE_FORBIDDEN_BLOCK}\n\n---\n${contexto}`;
}

/** Aplica as guardas ao texto final. Exportado para teste. */
export function aplicarGuardas(texto: string, saidasDasTools: string[], hojeIso: string): {
  texto: string; urlsRemovidas: number; valoresTrocados: number; datasTrocadas: number;
} {
  const urls = sanitizeUrls(texto, urlsPermitidas(saidasDasTools));
  const fatos = validarValoresEDatas(urls.texto, fatosPermitidos(saidasDasTools, hojeIso));
  return { texto: fatos.texto, urlsRemovidas: urls.removidas, valoresTrocados: fatos.valoresTrocados, datasTrocadas: fatos.datasTrocadas };
}

const GRUPO_LABEL: Record<SimpleModeHandoff["group"], string> = {
  emergencia: "Possível emergência emocional",
  reclamacao: "Reclamação séria",
  pedido_humano: "Pediu para falar com uma pessoa",
  pagamento: "Dúvida de pagamento ou transação",
};

function writeSse(res: Response, payload: unknown): void {
  if (!res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(res: Response, text: string): void {
  for (let i = 0; i < text.length; i += 40) writeSse(res, { content: text.slice(i, i + 40) });
}

export interface SimpleChatParams {
  req: Request;
  res: Response;
  userMessage: string;
  /** A mensagem da pessoa já está gravada (arquivo com legenda): não grava outra e a deixa fora do histórico. */
  mensagemJaGravadaId?: number;
  /** Conversa existente (já travada e com status "ativa") ou undefined para nova. */
  conversationId: number | undefined;
  /** pessoa da conversa existente ou a enviada pela equipe ao abrir a partir da ficha. */
  directPessoaId: number | null;
  rawNome: string | null;
  rawCelular: string | null;
  /** Canal externo da conversa (WhatsApp); ausente no chat do SoundOS e no Instagram. */
  canal?: "whatsapp";
  activePrompt: { id: number; body: string; model: string } | null;
  model: string;
  searchKnowledge?: (query: string) => Promise<Array<{ title: string; contentPreview: string }>>;
  hasKnowledge: boolean;
  client?: Parameters<typeof runSofiaAgentLoop>[0]["client"];
  reasoningEffort?: SofiaReasoningEffort;
  now?: Date;
}

export const SIMPLE_REASONING_EFFORT: SofiaReasoningEffort = "low";

export async function handleSimpleSofiaChat(params: SimpleChatParams): Promise<void> {
  const { req, res, userMessage, model } = params;
  // pino-http injeta req.log no servidor; apps de teste montam o router sem ele.
  const log = req.log ?? logger;
  const now = params.now ?? new Date();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let conversationId = params.conversationId;
  try {
    // ── Identificação antes do LLM ─────────────────────────────
    let pessoaId = params.directPessoaId;
    let estado: EstadoIdentificacao = pessoaId !== null ? "vinculada" : "sem_celular";
    if (pessoaId === null && params.rawCelular) {
      try {
        const identificacao = await identificarOuCriarPessoa({
          nome: params.rawNome, celular: params.rawCelular, conversationId: conversationId ?? null,
        });
        estado = identificacao.status;
        pessoaId = identificacao.pessoaId;
      } catch (err) {
        // Estado explícito: sem ficha. A Sofia não pode dizer que anotou algo.
        estado = "erro";
        pessoaId = null;
        log.warn({ err, conversationId: conversationId ?? null, status: "erro" }, "sofia simples: identificação falhou");
      }
    }

    let isFirstExchange = false;
    if (!conversationId) {
      const [nova] = await db.insert(conversationsTable)
        .values({ title: userMessage.slice(0, 60).trim() || "Nova conversa", model, pessoaId })
        .returning({ id: conversationsTable.id });
      conversationId = nova!.id;
      isFirstExchange = true;
    } else if (pessoaId !== null) {
      await db.update(conversationsTable).set({ pessoaId })
        .where(and(eq(conversationsTable.id, conversationId), isNull(conversationsTable.pessoaId)));
    }
    const convId = conversationId;

    const historicoConversa = (await db.select({ role: messages.role, content: messages.content, kind: messages.kind })
      .from(messages)
      // Mensagens da equipe (role "staff") ficam fora: a Sofia não as lê como se fossem da pessoa nem as imita.
      .where(and(
        eq(messages.conversationId, convId),
        inArray(messages.role, ["user", "assistant"]),
        params.mensagemJaGravadaId !== undefined ? ne(messages.id, params.mensagemJaGravadaId) : undefined,
      ))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(MAX_HISTORICO)).reverse()
      // Arquivo vira só uma nota neutra: a Sofia não vê imagens, vídeos, áudios nem documentos.
      .map(m => ({ role: m.role, content: conteudoParaASofia(m) }));

    // A mensagem da pessoa é persistida antes do LLM: se a geração falhar, ela não se perde.
    const userMsg = params.mensagemJaGravadaId !== undefined
      ? { id: params.mensagemJaGravadaId }
      : (await db.insert(messages)
        .values({ conversationId: convId, role: "user", content: userMessage, conduta: null })
        .returning({ id: messages.id }))[0]!;

    // ── Handoff: só os quatro grupos ───────────────────────────
    const handoff = detectSimpleModeHandoff(userMessage);
    if (handoff) {
      let transicao = simpleHandoffMessage(handoff);
      if (handoff.reason === "fechamento_comercial") {
        // Preço, parcelamento e desconto de evento seguem o fluxo de interesse (link + cartão no CRM),
        // mesmo quando o handoff de pagamento responde antes do modelo.
        try {
          const interesse = await interesseDoPedidoDeValor({
            mensagem: userMessage,
            pessoaId,
            conversationId: convId,
            now,
            mensagensDaPessoa: historicoConversa.filter(m => m.role === "user").map(m => m.content),
          });
          if (interesse) transicao = `${transicao}\n\n${interesse}`;
        } catch (err) {
          log.warn({ err, conversationId: convId }, "sofia simples: fluxo de interesse no handoff falhou");
        }
      }
      const resumo = await buildHandoffSummary({
        reason: handoff.reason,
        userMessage,
        pessoaId,
        pessoaNome: pessoaId !== null ? primeiroNome(params.rawNome) : null,
        intencaoPrincipal: null,
        sensitiveContext: handoff.sensitiveContext,
        conversationMessages: historicoConversa,
      });
      resumo.intentoPercebido = `${GRUPO_LABEL[handoff.group]}. O time interno assume a partir da última mensagem da pessoa.`;
      await db.update(conversationsTable).set({
        status: "aguardando_humano",
        handoffReason: handoff.reason,
        handoffSummary: JSON.stringify(resumo),
        handoffTriggeredAt: new Date(),
      }).where(eq(conversationsTable.id, convId));
      const [assistantMsg] = await db.insert(messages)
        .values({ conversationId: convId, role: "assistant", content: transicao, conduta: null })
        .returning({ id: messages.id });
      streamText(res, transicao);
      writeSse(res, { done: true, conversationId: convId, handoffTriggered: true, handoffReason: handoff.reason, handoffSummary: resumo });
      log.info({ conversationId: convId, grupo: handoff.group }, "sofia simples: handoff");
      if (pessoaId !== null) {
        void safeRecordDecisionRun({
          pessoaId, conversationId: convId, messageId: assistantMsg?.id ?? null,
          conduta: null, promptId: params.activePrompt?.id ?? null, model,
          elegibilidadeStatus: "nao_avaliada", elegibilidadeMotivo: null,
          ofertaPrincipal: null, ofertaAlternativa: null,
          nbaCategoria: "conversar",
          nbaJustificativa: `Handoff do modo simples (${handoff.group}).`,
          nivelConfianca: "media",
          metadata: { sofiaMode: "simple", handoffGroup: handoff.group },
        }, log);
      }
      return;
    }

    // ── Prompt + loop multi-tool ───────────────────────────────
    const historico = pessoaId !== null ? await obterHistorico(pessoaId, convId).catch(() => null) : null;
    const formularioRecente = pessoaId !== null
      ? await carregarFormularioRecente(pessoaId).then(f => (f ? descreverFormularioRecente(f) : null)).catch(() => null)
      : null;
    // O que a Sofia já anotou só volta a ela quando a conversa é da ficha: pelo telefone, quem escreve pode ser outra pessoa.
    const entendimento = pessoaId !== null && params.canal === "whatsapp"
      ? await carregarEntendimentoDaPessoa(pessoaId).then(e => (e ? descreverEntendimento(e) : null)).catch(() => null)
      : null;
    const contexto = montarContexto({ estado, pessoaId, nomeInformado: params.rawNome, historico, now, canal: params.canal, formularioRecente, entendimento });
    const systemPrompt = montarSystemPrompt(params.activePrompt?.body ?? null, contexto);
    const tools = [
      ...SIMPLE_MODE_TOOLS,
      ...(params.canal === "whatsapp" ? [CARTAO_TOOL] : []),
      ...(params.hasKnowledge && params.searchKnowledge ? [KNOWLEDGE_TOOL] : []),
    ];
    const executeTool = (call: SofiaToolCall) => executarToolSimples(call, {
      pessoaId, conversationId: convId, searchKnowledge: params.searchKnowledge, now, canal: params.canal,
    });

    const inicio = Date.now();
    const resultado = await runSofiaAgentLoop({
      client: params.client ?? openai,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...historicoConversa.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
        { role: "user", content: userMessage },
      ],
      tools,
      executeTool,
      maxRounds: 4,
      // Medido com o Prompt 2 (10 mensagens do mini-roteiro, Sol): low teve p50
      // menor que medium e a mesma qualidade. Ver replit.md, "Sofia modo simples".
      reasoningEffort: params.reasoningEffort ?? SIMPLE_REASONING_EFFORT,
    });

    const saidas = resultado.toolResults.map(r => r.output);
    const guardado = aplicarGuardas(resultado.text.trim(), saidas, dataHojeSaoPaulo(now).iso);
    if (!guardado.texto) throw new Error("Sofia simples: resposta vazia");
    log.info({
      conversationId: convId,
      identificacao: estado,
      rounds: resultado.rounds,
      tools: resultado.toolResults.map(r => r.call.function.name),
      exhausted: resultado.exhausted,
      latencyMs: Date.now() - inicio,
      urlsRemovidas: guardado.urlsRemovidas,
      valoresTrocados: guardado.valoresTrocados,
      datasTrocadas: guardado.datasTrocadas,
    }, "sofia simples: resposta");

    const resposta = guardado.texto;
    streamText(res, resposta);
    const [assistantMsg] = await db.insert(messages)
      .values({ conversationId: convId, role: "assistant", content: resposta, conduta: null })
      .returning({ id: messages.id });

    await registrarVideosEnviados({
      resposta, saidas, conversationId: convId, messageId: assistantMsg?.id ?? null, pessoaId, log,
    });

    writeSse(res, { done: true, conversationId: convId });

    // ── Background: auditoria e título ─────────────────────────
    void (async () => {
      if (pessoaId === null) return;
      const classificacao = await classifyDecision({
        userMessage, assistantResponse: resposta, conduta: null, model: "gpt-5.4-mini",
      });
      await safeRecordDecisionRun({
        pessoaId, conversationId: convId, messageId: assistantMsg?.id ?? null,
        conduta: null, promptId: params.activePrompt?.id ?? null, model,
        ...classificacao,
        // Elegibilidade nunca vem do classificador de texto livre.
        elegibilidadeStatus: "nao_avaliada",
        elegibilidadeMotivo: null,
        metadata: { sofiaMode: "simple", userMessageId: userMsg?.id ?? null, tools: resultado.toolResults.map(r => r.call.function.name) },
      }, log);
    })().catch(err => log.warn({ err, conversationId: convId }, "sofia simples: auditoria em background falhou"));

    if (isFirstExchange) void gerarTitulo(convId, userMessage, resposta);
  } catch (err) {
    log.error({ err, model, conversationId: conversationId ?? null }, "Sofia simple chat failed");
    writeSse(res, {
      error: "Não consegui gerar a resposta agora. Tente novamente em alguns instantes.",
      code: "SOFIA_COMPLETION_FAILED",
      ...(conversationId ? { conversationId } : {}),
    });
  } finally {
    if (!res.destroyed) res.end();
  }
}

/** Grava em video_envios só os vídeos cujo link aparece de fato no texto final. */
async function registrarVideosEnviados(params: {
  resposta: string; saidas: string[]; conversationId: number; messageId: number | null; pessoaId: number | null;
  log: { warn: (obj: unknown, msg: string) => void };
}): Promise<void> {
  const linksNaResposta = new Set(
    (params.resposta.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []).map(normalizarUrl).filter((u): u is string => u !== null),
  );
  const candidatos = new Set<string>();
  for (const saida of params.saidas) {
    try {
      const parsed = JSON.parse(saida) as { videos?: Array<{ link?: unknown }> };
      for (const video of parsed.videos ?? []) {
        if (typeof video.link !== "string") continue;
        const normalizado = normalizarUrl(video.link);
        if (normalizado && linksNaResposta.has(normalizado)) candidatos.add(video.link);
      }
    } catch { /* saída não-JSON não tem vídeo */ }
  }
  if (candidatos.size === 0) return;
  try {
    const videos = await db.select({
      id: videosTable.id, codigo: videosTable.codigo, titulo: videosTable.titulo,
      link: videosTable.link, curso: videosTable.curso, tipo: videosTable.tipo,
    }).from(videosTable).where(inArray(videosTable.link, [...candidatos]));
    const vistos = new Set<string>();
    const linhas = videos.filter(v => v.link && !vistos.has(v.link) && (vistos.add(v.link), true)).map(v => ({
      conversationId: params.conversationId,
      messageId: params.messageId,
      pessoaId: params.pessoaId,
      videoId: v.id,
      codigo: v.codigo,
      titulo: v.titulo,
      link: v.link!,
      curso: v.curso,
      tipo: v.tipo,
    }));
    if (linhas.length > 0) await db.insert(videoEnvios).values(linhas);
  } catch (err) {
    params.log.warn({ err, conversationId: params.conversationId }, "sofia simples: falha ao registrar video_envios");
  }
}

async function gerarTitulo(conversationId: number, userMessage: string, resposta: string): Promise<void> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 30,
      messages: [
        { role: "system", content: "Você é um assistente que gera títulos curtos e descritivos. Responda APENAS com o título, sem pontuação final, sem aspas, sem explicação." },
        { role: "user", content: `Crie um título de no máximo 8 palavras que descreva o assunto desta conversa.\n\nPergunta do usuário: ${userMessage}\n\nResposta do assistente: ${resposta.slice(0, 300)}` },
      ],
    });
    const titulo = completion.choices[0]?.message?.content?.trim();
    if (titulo) await db.update(conversationsTable).set({ title: titulo }).where(eq(conversationsTable.id, conversationId));
  } catch {
    // Título é best-effort.
  }
}
