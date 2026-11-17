// Handoff automático da Sofia para atendimento humano (Documento 14A, cap. 13).
//
// Escopo desta task: sinalização estruturada + resumo, usando sinais simples
// já disponíveis no chat (palavras-chave, ausência de dados suficientes,
// tópicos sensíveis predefinidos). Elegibilidade/scoring formal fica para o
// motor de decisão (task separada).

import { db, pessoaEvidencias } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import type { HandoffReason } from "@workspace/db";
import { isTransactionAdvancementRequest } from "./commercialIntent";

const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  pedido_explicito: "Pedido explícito da pessoa",
  confianca_baixa: "Confiança insuficiente para continuar sozinha",
  sinais_contraditorios: "Sinais contraditórios na conversa",
  tema_sensivel: "Situação sensível",
  duvida_financeira: "Dúvida financeira complexa",
  especialista_necessario: "Necessidade de especialista",
  elegibilidade_insuficiente: "Elegibilidade insuficiente para a oferta desejada",
  fechamento_comercial: "Pedido de fechamento fora do que a Sofia pode autorizar",
  informacao_comercial_bloqueada: "Informação comercial bloqueada por governança",
  oferta_sensivel: "Oferta sensível requer atendimento humano",
};

export function handoffReasonLabel(reason: HandoffReason): string {
  return HANDOFF_REASON_LABELS[reason];
}

// ── Gatilhos pré-resposta (checados sobre a mensagem da pessoa, antes de
// acionar a Sofia) ───────────────────────────────────────────────────────
const EXPLICIT_REQUEST_PATTERNS = [
  /\b(falar|conversar) com (um |uma )?(atendente|humano|pessoa (da equipe|de verdade|real)|alguém (da equipe|de verdade))\b/i,
  /\bquero (um |uma )?(atendente|humano)\b/i,
  /\bn[ãa]o quero falar com (um |uma )?(robô|bot|ia|intelig[êe]ncia artificial)\b/i,
  /\bpode chamar (um |uma )?(atendente|humano|pessoa)\b/i,
  /\btransfer(e|ir|ência)\b.*\b(atendente|humano|equipe)\b/i,
];

const EMOTIONAL_SAFETY_PATTERNS = [
  /\bsuic[íi]dio|\bme matar\b|\bn[ãa]o aguento mais viver\b|\bquero morrer\b/i,
  /\bcris[ei]s? (de )?(p[âa]nico|ansiedade) (grave|forte|intensa)\b/i,
  /\bsurto\b|\bepis[óo]dio psic[óo]tico\b/i,
  /\babuso (sexual|f[íi]sico)\b|\bviol[êe]ncia dom[ée]stica\b/i,
];
const OTHER_SENSITIVE_TOPIC_PATTERNS = [
  /\breclama[çc][ãa]o formal\b|\bboletim de ocorr[êe]ncia\b|\bden[úu]ncia\b|\bprocesso judicial\b|\badvogado\b/i,
];
const EMOTIONAL_DISTRESS_PATTERNS = [
  /\bmomento emocional (muito )?dif[íi]cil\b/i,
  /\bsofrimento emocional\b|\bcrise emocional\b/i,
  /\bme sinto (muito )?(desesperad[oa]|abalad[oa]|sem sa[íi]da)\b/i,
  /\bestou (muito )?(desesperad[oa]|abalad[oa])\b/i,
  /\bn[ãa]o (estou|me sinto) bem emocionalmente\b/i,
  /\bsitua[çc][ãa]o emocional (muito )?sens[íi]vel\b/i,
  /\bpreciso de orienta[çc][ãa]o terap[êe]utica agora\b/i,
];
const AUTONOMOUS_GUIDANCE_PATTERNS = [
  /\bpode continuar me orientando sozinha\b/i,
  /\bcontinue me orientando sozinha\b/i,
  /\bvoc[êe] pode continuar (me ajudando|me orientando) enquanto isso\b/i,
];

const FINANCIAL_COMPLEX_PATTERNS = [
  /\breembolso\b/i,
  /\bcobran[çc]a indevida\b|\bcobraram (duas vezes|errado)\b/i,
  /\bcancelar (o )?(pagamento|matr[íi]cula|contrato|assinatura)\b/i,
  /\bnota fiscal\b/i,
  /\bdisputa\b.*\bpagamento\b/i,
  /\bparcelamento especial\b|\brenegociar\b/i,
];
const COMMERCIAL_BLOCKED_PATTERNS = [
  /\b(desconto|cupom|parcelar|parcelamento|formas? de pagamento|condi[çc][oõ]es? especiais)\b/i,
  /\b(checkout|link (de|para) pagamento|pagar|paiement)\b/i,
  /\b(fazer|realizar|finalizar|concluir|confirmar|efetivar) (a |minha )?inscri[çc][ãa]o\b/i,
  /\b(réduction|coupon)\b/i,
];
const SENSITIVE_OFFER_ADVANCEMENT = (text: string) =>
  /\b(ayahuasca|cerimoni|retiro|forma[çc][ãa]o completa)\b/i.test(text) &&
  /\b(participar|inscrever|pre[çc]o|valor|vaga|condi[çc][ãa]o|comprar)\b/i.test(text);

const SPECIALIST_NEEDED_PATTERNS = [
  /\bpsic[óo]log[ao]\b|\bpsiquiatra\b|\bpsicoter[ãa]pia\b/i,
  /\bterapeuta\b.*\b(indica[çc][ãa]o|preciso|recomenda[çc][ãa]o)\b/i,
  /\bproblema de sa[úu]de grave\b|\bcondi[çc][ãa]o m[ée]dica\b/i,
  /\bquest[ãa]o jur[íi]dica\b/i,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

export interface PreTriggerResult {
  reason: HandoffReason;
  sensitiveContext: string | null;
  emergencyGuidance?: boolean;
}

/**
 * Checa a mensagem recém-chegada da pessoa ANTES de a Sofia gerar qualquer
 * resposta. Se um gatilho disparar aqui, a Sofia nunca chega a tentar
 * recomendar/fechar/avançar sozinha — a mensagem vai direto para o handoff.
 */
export function detectPreTrigger(
  userMessage: string,
  priorUserMessages: string[] = [],
): PreTriggerResult | null {
  const explicitRequest = matchesAny(EXPLICIT_REQUEST_PATTERNS, userMessage);
  const currentEmotionalSafety = matchesAny(EMOTIONAL_SAFETY_PATTERNS, userMessage);
  const currentOtherSensitive = matchesAny(OTHER_SENSITIVE_TOPIC_PATTERNS, userMessage);
  const currentEmotionalDistress = matchesAny(EMOTIONAL_DISTRESS_PATTERNS, userMessage);
  const requestsAutonomousGuidance = matchesAny(AUTONOMOUS_GUIDANCE_PATTERNS, userMessage);
  const recentEmergencyMessages = priorUserMessages
    .slice(-6)
    .filter(message =>
      matchesAny(EMOTIONAL_SAFETY_PATTERNS, message) ||
      matchesAny(EMOTIONAL_DISTRESS_PATTERNS, message)
    );

  if (
    currentEmotionalSafety ||
    ((explicitRequest || requestsAutonomousGuidance) &&
      (currentEmotionalDistress || recentEmergencyMessages.length > 0))
  ) {
    const sensitiveContext = [
      ...recentEmergencyMessages,
      userMessage,
    ]
      .map(message => message.slice(0, 300))
      .join("\n")
      .slice(0, 1_000);
    return { reason: "tema_sensivel", sensitiveContext, emergencyGuidance: true };
  }
  if (currentOtherSensitive) {
    return {
      reason: "tema_sensivel",
      sensitiveContext: userMessage.slice(0, 300),
      emergencyGuidance: false,
    };
  }
  if (explicitRequest) {
    return { reason: "pedido_explicito", sensitiveContext: null };
  }
  if (matchesAny(FINANCIAL_COMPLEX_PATTERNS, userMessage)) {
    return { reason: "duvida_financeira", sensitiveContext: null };
  }
  if (SENSITIVE_OFFER_ADVANCEMENT(userMessage)) {
    return { reason: "oferta_sensivel", sensitiveContext: userMessage.slice(0, 300) };
  }
  if (isTransactionAdvancementRequest(userMessage)) {
    return { reason: "informacao_comercial_bloqueada", sensitiveContext: null };
  }
  if (matchesAny(COMMERCIAL_BLOCKED_PATTERNS, userMessage)) {
    return { reason: "informacao_comercial_bloqueada", sensitiveContext: null };
  }
  if (matchesAny(SPECIALIST_NEEDED_PATTERNS, userMessage)) {
    return { reason: "especialista_necessario", sensitiveContext: null };
  }
  return null;
}

// ── Modo simples: handoff somente em quatro grupos ───────────────────────
// "Quero me inscrever" e "quero comprar" NÃO são handoff no modo simples: a
// Sofia envia o link do evento ou do produto. Preço, vaga e retiro também não.
const SIMPLE_HUMAN_REQUEST_PATTERNS = [
  ...EXPLICIT_REQUEST_PATTERNS,
  /\b(falar|conversar) com (um |uma )?(pessoa|humano|ser humano|atendente|algu[ée]m da equipe)\b/i,
  /\b(me )?(passa|transfere|coloca|encaminha) (para|pra|com) (um |uma )?(pessoa|humano|atendente|algu[ée]m)\b/i,
];
const SIMPLE_PAYMENT_PATTERNS = [
  /\b(pagar|pago|pagamento|pagamentos|paiement)\b/i,
  /\b(parcela|parcelas|parcelar|parcelo|parcelado|parcelamento)\b/i,
  /\b(desconto|descontos|cupom|cupons|coupon|r[ée]duction)\b/i,
  /\b(checkout|pix|boleto|cart[ãa]o de cr[ée]dito)\b/i,
];
const SIMPLE_REFUND_PATTERNS = [
  /\breembolso\b|\bestorno\b|\bdevolu[çc][ãa]o do (dinheiro|valor)\b/i,
  /\bcancelar (o |meu |minha )?(pagamento|cobran[çc]a|compra|pedido)\b/i,
  /\bcobran[çc]a indevida\b|\bcobraram (duas vezes|errado)\b/i,
];

export type SimpleHandoffGroup = "emergencia" | "reclamacao" | "pedido_humano" | "pagamento";

export interface SimpleModeHandoff {
  group: SimpleHandoffGroup;
  reason: HandoffReason;
  emergencyGuidance: boolean;
  sensitiveContext: string | null;
}

/**
 * Único gatilho de handoff do modo simples: emergência emocional, reclamação
 * grave, pedido explícito de pessoa humana e transação de pagamento.
 */
export function detectSimpleModeHandoff(userMessage: string): SimpleModeHandoff | null {
  if (matchesAny(EMOTIONAL_SAFETY_PATTERNS, userMessage)) {
    return { group: "emergencia", reason: "tema_sensivel", emergencyGuidance: true, sensitiveContext: userMessage.slice(0, 300) };
  }
  if (matchesAny(OTHER_SENSITIVE_TOPIC_PATTERNS, userMessage)) {
    return { group: "reclamacao", reason: "tema_sensivel", emergencyGuidance: false, sensitiveContext: userMessage.slice(0, 300) };
  }
  if (matchesAny(SIMPLE_HUMAN_REQUEST_PATTERNS, userMessage)) {
    return { group: "pedido_humano", reason: "pedido_explicito", emergencyGuidance: false, sensitiveContext: null };
  }
  if (matchesAny(SIMPLE_REFUND_PATTERNS, userMessage)) {
    return { group: "pagamento", reason: "duvida_financeira", emergencyGuidance: false, sensitiveContext: null };
  }
  if (matchesAny(SIMPLE_PAYMENT_PATTERNS, userMessage)) {
    return { group: "pagamento", reason: "fechamento_comercial", emergencyGuidance: false, sensitiveContext: null };
  }
  return null;
}

/** Mensagens acolhedoras do modo simples, uma por grupo. */
export function simpleHandoffMessage(handoff: SimpleModeHandoff): string {
  if (handoff.group === "emergencia" || handoff.group === "reclamacao") {
    return handoffTransitionMessage("tema_sensivel", handoff.emergencyGuidance);
  }
  if (handoff.group === "pedido_humano") return handoffTransitionMessage("pedido_explicito");
  return "Claro! Pagamento, parcelamento e condições ficam com o nosso time, que vai te responder por aqui em breve. Já deixei registrado o que conversamos.";
}

// ── Gatilho pós-resposta (checado sobre a resposta gerada + histórico) ────
const LOW_CONFIDENCE_PATTERNS = [
  /\bn[ãa]o tenho (essa|essa informa[çc][ãa]o|certeza)\b/i,
  /\bn[ãa]o consigo (te ajudar|responder) com isso\b/i,
  /\bn[ãa]o sei (te )?(informar|dizer|responder)\b/i,
  /\bn[ãa]o encontrei (essa )?informa[çc][ãa]o\b/i,
];

/**
 * Checado depois que a Sofia já respondeu nesta rodada. Dispara handoff por
 * "confiança baixa persistente" quando a resposta atual repete um padrão de
 * baixa confiança que já apareceu antes na mesma conversa — um único "não sei"
 * isolado não é motivo de handoff, mas o padrão se repetindo é.
 */
export function detectPostTrigger(
  fullResponse: string,
  priorAssistantMessages: string[],
): HandoffReason | null {
  if (!matchesAny(LOW_CONFIDENCE_PATTERNS, fullResponse)) return null;
  const priorLowConfidenceCount = priorAssistantMessages.filter((m) => matchesAny(LOW_CONFIDENCE_PATTERNS, m)).length;
  return priorLowConfidenceCount >= 1 ? "confianca_baixa" : null;
}

// ── Resumo estruturado anexado ao handoff ─────────────────────────────────
export interface HandoffSummary {
  motivo: HandoffReason;
  motivoLabel: string;
  geradoEm: string;
  pessoa: { id: number | null; nome: string | null };
  intentoPercebido: string;
  evidenciasRelevantes: string[];
  nivelConfianca: "baixa" | "media" | "alta";
  contextoSensivel: string | null;
  proximosPassosSugeridos: string[];
  mensagemDisparadora: string;
}

const NEXT_STEPS_BY_REASON: Record<HandoffReason, string[]> = {
  pedido_explicito: ["Confirmar com a pessoa o que ela precisa resolver diretamente com a equipe."],
  confianca_baixa: ["Revisar a base de conhecimento sobre o assunto perguntado.", "Responder diretamente à dúvida que a Sofia não conseguiu esclarecer."],
  sinais_contraditorios: ["Revisar o histórico da conversa para entender a contradição antes de responder."],
  tema_sensivel: ["Tratar com cuidado e prioridade — envolve um tema sensível.", "Se necessário, acionar apoio especializado."],
  duvida_financeira: ["Verificar o caso no financeiro/Omie antes de responder."],
  especialista_necessario: ["Encaminhar para quem tem formação/autoridade para orientar sobre este tema."],
  elegibilidade_insuficiente: ["Avaliar com a pessoa qual caminho preparatório faz sentido antes da oferta desejada."],
  fechamento_comercial: ["Confirmar preço, condições e disponibilidade com a pessoa e conduzir o fechamento."],
  informacao_comercial_bloqueada: ["Confirmar condições comerciais diretamente com a equipe autorizada."],
  oferta_sensivel: ["Revisar a oferta sensível e conduzir o próximo passo com atendimento humano."],
};

/**
 * Monta o resumo estruturado (pessoa, intenção, evidências, confiança,
 * contexto sensível, próximos passos) que fica anexado à conversa quando o
 * handoff é disparado.
 */
export async function buildHandoffSummary(params: {
  reason: HandoffReason;
  userMessage: string;
  pessoaId: number | null;
  pessoaNome: string | null;
  intencaoPrincipal: string | null;
  sensitiveContext: string | null;
  conversationMessages?: Array<{ role: string; content: string }>;
}): Promise<HandoffSummary> {
  let evidenciasRelevantes: string[] = [];
  if (params.reason === "tema_sensivel") {
    const conversationEvidence = [
      ...(params.conversationMessages ?? [])
        .filter(message => message.role === "user")
        .slice(-6)
        .map(message => message.content),
      params.userMessage,
    ];
    evidenciasRelevantes = [...new Set(conversationEvidence)]
      .map(content => `Pessoa: ${content.slice(0, 300)}`);
  } else if (params.pessoaId) {
    const recentes = await db.select({ campo: pessoaEvidencias.campo, valor: pessoaEvidencias.valor, nivelConfianca: pessoaEvidencias.nivelConfianca })
      .from(pessoaEvidencias)
      .where(eq(pessoaEvidencias.pessoaId, params.pessoaId))
      .orderBy(desc(pessoaEvidencias.createdAt))
      .limit(5);
    evidenciasRelevantes = recentes.map((e) => `${e.campo}: ${e.valor ?? "(vazio)"} [confiança ${e.nivelConfianca}]`);
  }

  const nivelConfianca: HandoffSummary["nivelConfianca"] =
    params.reason === "confianca_baixa" || params.reason === "sinais_contraditorios" ? "baixa" : "media";

  return {
    motivo: params.reason,
    motivoLabel: handoffReasonLabel(params.reason),
    geradoEm: new Date().toISOString(),
    pessoa: { id: params.pessoaId, nome: params.pessoaNome },
    intentoPercebido: params.reason === "tema_sensivel"
      ? params.userMessage.slice(0, 200)
      : params.intencaoPrincipal ?? params.userMessage.slice(0, 200),
    evidenciasRelevantes,
    nivelConfianca,
    contextoSensivel: params.sensitiveContext,
    proximosPassosSugeridos: NEXT_STEPS_BY_REASON[params.reason],
    mensagemDisparadora: params.userMessage.slice(0, 500),
  };
}

/** Mensagem transparente da Sofia quando aciona o handoff — nunca finge que vai resolver sozinha. */
export function handoffTransitionMessage(
  reason: HandoffReason,
  emergencyGuidance = false,
): string {
  if (reason === "tema_sensivel") {
    const transition =
      "Entendo, e isso é importante. Vou te conectar agora com alguém da nossa equipe para te dar a atenção que essa situação merece. Já registrei o que conversamos.";
    if (!emergencyGuidance) return transition;
    return `${transition} Se houver risco imediato, procure o serviço de emergência local — no Brasil, ligue para o SAMU 192 ou para a Polícia 190. Em uma crise emocional ou se houver pensamentos de se machucar, o CVV atende gratuitamente pelo 188. Essas orientações não substituem atendimento profissional.`;
  }
  if (reason === "pedido_explicito") {
    return "Claro, vou te conectar com alguém da nossa equipe. Já deixei registrado o que conversamos até aqui para agilizar o atendimento.";
  }
  return "Para te ajudar melhor com isso, vou te conectar com alguém da nossa equipe — já registrei o contexto da nossa conversa para eles.";
}

/** Mensagem enviada quando a pessoa manda uma nova mensagem numa conversa que já está em handoff. */
export const HANDOFF_ALREADY_ACTIVE_MESSAGE =
  "Já te conectei com a nossa equipe e alguém vai te responder em breve. Recebi sua mensagem e ela já está registrada aqui.";
