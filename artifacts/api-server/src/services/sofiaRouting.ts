import { isTransactionAdvancementRequest } from "./commercialIntent";

export type SofiaIntentClass = "factual" | "advisory";
export type SofiaFactKind = "offer" | "instrument_family" | "event";
export type SofiaOfferingKind = "course" | "event";
export type SofiaOfferingField =
  | "name"
  | "date"
  | "location"
  | "link"
  | "modality"
  | "description"
  | "workload"
  | "price";
export type SofiaRoutingHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};
export type SofiaFactualOfferingIntent = {
  factual: boolean;
  repeated: boolean;
  specific?: boolean;
  lookupQuery?: string;
  kind?: SofiaOfferingKind;
  modality?: "presencial" | "online";
  location?: string;
  fields?: SofiaOfferingField[];
  reason: string;
};

const COMMERCIAL = /\b(pre[çc]o|valor|investimento|mensalidade|desconto|cupom|parcelamento|vagas?|disponibilidade|estoque|comprar|compra|inscri[çc][ãa]o|checkout|prix|r[ée]duction|coupon|paiement|places?|disponibilit[ée]|stock)\b/i;
const ADVISORY = /\b(recomenda|indica|qual .* melhor|serve para mim|devo|posso participar|quero participar|me inscrever|inscrever-me|conselho|orienta)\b/i;
const FACT = /\b(o que [ée]|como funciona|para que serve|conte[úu]do|formato|carga hor[áa]ria|pr[ée]-requisito|dura[çc][ãa]o|local|v[íi]deo|material|para quem|what is|comment fonctionne|contenu|format|dur[ée]e|pr[ée]requis)\b/i;
const CANONICAL_OFFER_ID = /\bOFR_[A-Z0-9_]+\b/i;
const OFFERING_SUBJECT = /\b(curso|cursos|turma|turmas|forma[çc][ãa]o|evento|eventos|ciclo|ciclos|retiro|viv[êe]ncia|imers[ãa]o|cerim[oô]nia|agenda|programa[çc][ãa]o)\b/i;
const NEXT_OFFERING = /\b(pr[oó]xim[oa](?:s|as)?|seguinte|futur[oa](?:s|as)?|agenda|calend[áa]rio)\b/i;
const OFFERING_FACT = /\b(qual|quais|quando|onde|data|datas|local|hor[áa]rio|informa[çc][ãa]o|detalhes?|o que [ée]|conte(?:[úu]do| mais)|como funciona|pre[çc]o|valor|quanto custa|link|site|p[áa]gina)\b/i;
const OFFERING_ADVISORY = /\b(recomenda(?:r|ria)?|indicad[oa]|ideal|adequad[oa]|serve para mim|para o meu perfil|combina comigo|qual devo escolher|qual seria melhor|melhor para mim|posso participar|quero participar|me inscrever|inscrever-me|procurando (?:uma? )?(?:formacao|curso)|ainda nao sei qual)\b/i;
const MODALITY = /\b(presencial|presenciais|online|on-line|a dist[âa]ncia|remoto)\b/i;
const BRAZILIAN_STATE = /(?:^|[\s,;()])((?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO))(?=$|[\s,;().!?])/i;

function normalizeRoutingText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").trim();
}

function offeringKindFor(text: string): SofiaOfferingKind | undefined {
  const normalized = normalizeRoutingText(text);
  if (/\b(evento|eventos|ciclo|retiro|vivencia|imersao|cerimoni|agenda|programacao|calendario)/i.test(normalized)) return "event";
  if (/\b(curso|cursos|turma|turmas|formacao)\b/i.test(normalized)) return "course";
  return undefined;
}

function modalityFor(text: string): SofiaFactualOfferingIntent["modality"] | undefined {
  const normalized = normalizeRoutingText(text);
  if (/\b(presencial|presenciais)\b/i.test(normalized)) return "presencial";
  if (/\b(online|on-line|a distancia|remoto)\b/i.test(normalized)) return "online";
  return undefined;
}

const LOCATION_STOPWORD = /^(presencial|presenciais|online|remoto|agora|hoje|amanhã|amanha|próximo|proximo|próxima|proxima|mês|mes|ano|semana|trimestre|semestre|janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|no|na|em|de)$/iu;
const LOCATION_NON_VALUE = /^(curso|cursos|evento|eventos|turma|turmas|formação|formacao|presencial|online)$/iu;

function isTemporalLocationPhrase(value: string): boolean {
  const normalized = normalizeRoutingText(value);
  return /^(?:final|fim|inicio|comeco)\b/.test(normalized)
    || /^(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|\d+)\s+(?:dias?|semanas?|meses?|anos?)\b/.test(normalized)
    || /^(?:em\s+)?breve\b/.test(normalized)
    || /^(?:alguns?|algumas?)\s+(?:dias?|semanas?|meses?)\b/.test(normalized);
}

function cleanLocationCandidate(value: string): string | undefined {
  if (isTemporalLocationPhrase(value)) return undefined;
  const words = value.trim().split(/\s+/);
  const stopAt = words.findIndex(word => LOCATION_STOPWORD.test(word));
  const candidate = words.slice(0, stopAt === -1 ? words.length : stopAt).join(" ").trim();
  return candidate && !LOCATION_NON_VALUE.test(candidate) ? candidate : undefined;
}

function locationFor(text: string, allowStandalone = false): string | undefined {
  const explicit = text.match(/\b(?:em|na|no)\s+([\p{L}]+(?:\s+[\p{L}]+){0,4})/iu);
  const explicitCandidate = explicit?.[1] ? cleanLocationCandidate(explicit[1]) : undefined;
  if (explicitCandidate) {
    return explicitCandidate;
  }
  const standalone = text.trim();
  if (standalone.split(/\s+/).length <= 4) {
    const city = standalone.match(/^([\p{L}]+(?:\s+[\p{L}]+)*)$/u);
    const candidate = city?.[1] ? cleanLocationCandidate(city[1]) : undefined;
    if (candidate && allowStandalone) return candidate;
  }
  const state = text.match(BRAZILIAN_STATE);
  return state?.[1]?.toUpperCase();
}

function hasUpcomingOfferingQuestion(text: string): boolean {
  const normalized = normalizeRoutingText(text);
  return OFFERING_SUBJECT.test(normalized) && NEXT_OFFERING.test(normalized);
}

function hasExplicitNamedOffering(text: string): boolean {
  const normalized = normalizeRoutingText(text);
  const subject = /\b(?:evento|curso|formacao|turma|ciclo|retiro|vivencia|imersao|cerimonia|workshop)\b/i
    .exec(normalized);
  if (!subject) return false;
  let suffix = normalized.slice(subject.index + subject[0].length).trim();
  if (!suffix || /^(?:em|no|na)\b/.test(suffix)) return false;
  suffix = suffix.replace(/^(?:de|do|da|dos|das)\s+/, "");
  if (!suffix || isTemporalLocationPhrase(suffix)) return false;
  const firstToken = suffix.match(/^[a-z0-9-]+/)?.[0];
  if (!firstToken || firstToken.length < 3) return false;
  const genericSuffixTokens = new Set([
    "que", "vai", "sera", "acontece", "acontecer", "disponivel", "disponiveis",
    "agenda", "calendario", "programacao", "tem", "temos", "existe", "existem",
    "marcado", "marcada", "programado", "programada", "previsto", "prevista",
    "aberto", "aberta", "ativo", "ativa", "confirmado", "confirmada",
    "informacao", "informacoes", "detalhe", "detalhes",
  ]);
  return !LOCATION_STOPWORD.test(firstToken)
    && !genericSuffixTokens.has(firstToken)
    && !/^(?:futuro|futura|presencial|online|remoto)$/.test(firstToken);
}

function hasOfferingQuestion(text: string): boolean {
  const normalized = normalizeRoutingText(text);
  return OFFERING_SUBJECT.test(normalized) &&
    (NEXT_OFFERING.test(normalized) || OFFERING_FACT.test(normalized));
}

function isEllipticalNamedOffering(text: string): boolean {
  const normalized = normalizeRoutingText(text);
  return normalized.length <= 80
    && /^(?:e\s+)?(?:o|a|os|as)?\s*(?:ciclo|retiro|vivencia|imersao|cerimonia|workshop)\s+(?:d[oa]\s+)?[a-z0-9]/i.test(normalized);
}

function isShortEllipticalFactRequest(text: string): boolean {
  const normalized = normalizeRoutingText(text);
  return normalized.length <= 80
    && (OFFERING_FACT.test(normalized) || /\b(repita|nome)\b/.test(normalized))
    && !OFFERING_SUBJECT.test(normalized);
}

function requestedOfferingFields(text: string): SofiaOfferingField[] {
  const normalized = normalizeRoutingText(text);
  const requested = new Set<SofiaOfferingField>();
  if (/\b(nome|chama|chamado|chamada)\b/.test(normalized)) requested.add("name");
  if (/\b(quando|data|datas|horario)\b/.test(normalized)) {
    requested.add("name");
    requested.add("date");
  }
  if (/\b(onde|local|endereco)\b/.test(normalized)) requested.add("location");
  if (/\b(link|site|pagina|url)\b/.test(normalized)) requested.add("link");
  if (
    /\b(formato|modalidade)\b/.test(normalized) ||
    /\b(?:e|eh|seria)\s+(?:online|presencial)\b/.test(normalized)
  ) requested.add("modality");
  if (/\b(o que e|como funciona|conteudo|inclui|detalhes|sobre)\b/.test(normalized)) {
    requested.add("name");
    requested.add("description");
  }
  if (/\b(carga horaria|duracao)\b/.test(normalized)) requested.add("workload");
  if (/\b(preco|valor|quanto custa)\b/.test(normalized)) {
    requested.add("name");
    requested.add("price");
  }
  return [...requested];
}

function latestNamedOfferingQuery(history: SofiaRoutingHistoryMessage[]): string | undefined {
  return [...history]
    .reverse()
    .filter(message => message.role === "user")
    .map(message => message.content.trim())
    .find(content => hasExplicitNamedOffering(content) || isEllipticalNamedOffering(content));
}

function latestOfficialOfferingQuery(history: SofiaRoutingHistoryMessage[]): string | undefined {
  for (const message of [...history].reverse()) {
    if (message.role !== "assistant") continue;
    const offeringLine = message.content.split("\n").find(line =>
      /^\s*(?:\d+\.\s*)?.+?\s+—\s+(?:Data|Local|Modalidade|Carga horária|Sobre|Valor):/i.test(line),
    );
    const name = offeringLine
      ?.replace(/^\s*\d+\.\s*/, "")
      .split(/\s+—\s+/, 1)[0]
      ?.trim();
    if (name) return name;
  }
  return undefined;
}

function hasUnresolvedOfferingRequest(history: SofiaRoutingHistoryMessage[]): boolean {
  let requested = false;
  let answered = false;
  for (const message of history.slice(-12)) {
    if (message.role === "user" && hasOfferingQuestion(message.content)) requested = true;
    if (message.role === "assistant" && requested) {
      const response = normalizeRoutingText(message.content);
      const asksClarification = /\?|qual tipo|qual cidade|qual modalidade|para que|por que|o que te trouxe|me diga|me conte/.test(response);
      const includesFactualDate = /\b\d{1,2}\s*(?:de\s+)?(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)|\b20\d{2}\b|\b\d{1,2}\/\d{1,2}\b/.test(response);
      if (!asksClarification && includesFactualDate) answered = true;
    }
  }
  return requested && !answered;
}

function lastAssistantRequestsLocation(history: SofiaRoutingHistoryMessage[]): boolean {
  const lastMessage = history.at(-1);
  if (lastMessage?.role !== "assistant") return false;
  const normalized = normalizeRoutingText(lastMessage.content);
  return /\b(?:qual|em qual|informe|diga|indique)\s+(?:a\s+)?(?:cidade|estado|regiao|local|localidade)\b/.test(normalized)
    || /\b(?:cidade|estado|regiao|local|localidade)\s+(?:voce|você)\b/.test(lastMessage.content);
}

/**
 * Detects a public offering fact request before triage. Short replies such as
 * "curso", "presencial" and "São Paulo" are only promoted when the recent
 * conversation contains an unresolved next-offering request.
 */
export function detectFactualOfferingIntent(
  currentMessage: string,
  recentHistory: SofiaRoutingHistoryMessage[] = [],
): SofiaFactualOfferingIntent {
  const current = currentMessage.trim();
  const currentNormalized = normalizeRoutingText(current);
  const unresolved = hasUnresolvedOfferingRequest(recentHistory);
  const contextualNamedQuery = latestNamedOfferingQuery(recentHistory)
    ?? latestOfficialOfferingQuery(recentHistory);
  const ellipticalNamedOffering = isEllipticalNamedOffering(current);
  const ellipticalFactRequest = Boolean(contextualNamedQuery) && isShortEllipticalFactRequest(current);
  const answeringLocationQuestion = unresolved && lastAssistantRequestsLocation(recentHistory);
  const shortClarifier = currentNormalized.length <= 32 &&
    (offeringKindFor(current) !== undefined
      || modalityFor(current) !== undefined
      || locationFor(current, answeringLocationQuestion) !== undefined);
  const factualQuestion = hasOfferingQuestion(current);
  const explicitNamedOffering = hasExplicitNamedOffering(current);
  const startsNewNamedOffering = explicitNamedOffering || ellipticalNamedOffering;
  const specific = (factualQuestion &&
    (!hasUpcomingOfferingQuestion(current) || explicitNamedOffering))
    || ellipticalNamedOffering
    || ellipticalFactRequest;
  const advisory = OFFERING_ADVISORY.test(currentNormalized) || isTransactionAdvancementRequest(current);
  const factual = !advisory && (
    factualQuestion
    || ellipticalNamedOffering
    || ellipticalFactRequest
    || (unresolved && shortClarifier)
  );
  const priorOfferingRequests = recentHistory.filter(message =>
    message.role === "user" && hasOfferingQuestion(message.content),
  );
  const repeated = factual && (priorOfferingRequests.length > 0 || unresolved);
  const kind = offeringKindFor(current) ??
    (ellipticalFactRequest && contextualNamedQuery ? offeringKindFor(contextualNamedQuery) : undefined) ??
    [...recentHistory].reverse().map(message => offeringKindFor(message.content)).find(Boolean);
  const modality = modalityFor(current) ??
    (!startsNewNamedOffering
      ? [...recentHistory].reverse().map(message => modalityFor(message.content)).find(Boolean)
      : undefined);
  const location = locationFor(current, answeringLocationQuestion) ??
    (!startsNewNamedOffering
      ? [...recentHistory]
        .reverse()
        .filter(message => message.role === "user")
        .map(message => locationFor(message.content))
        .find(Boolean)
      : undefined);
  const fields = requestedOfferingFields(current);

  return {
    factual,
    repeated,
    ...(specific ? { specific: true } : {}),
    ...(specific ? {
      lookupQuery: explicitNamedOffering || ellipticalNamedOffering
        ? current
        : contextualNamedQuery ?? current,
    } : {}),
    ...(kind ? { kind } : {}),
    ...(modality ? { modality } : {}),
    ...(location ? { location } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    reason: advisory
      ? "suitability/advisory signal"
      : factualQuestion
        ? repeated ? "repeated offering fact request" : "offering fact request"
        : ellipticalNamedOffering
          ? "named offering continuation"
          : ellipticalFactRequest
            ? "fact continuation for named offering"
        : unresolved && shortClarifier
          ? "short clarification for unresolved offering request"
          : "not an offering fact request",
  };
}


export function factualFastPathEnvironmentAllowed(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

export async function persistFactualExchangeAfterAudit<TMessage>(operations: {
  persistUserMessage: () => Promise<void>;
  persistDecisionRun: () => Promise<number>;
  persistAssistantMessage: () => Promise<TMessage>;
  linkDecisionToAssistant: (decisionRunId: number, assistantMessage: TMessage) => Promise<void>;
}) {
  await operations.persistUserMessage();
  const decisionRunId = await operations.persistDecisionRun();
  const assistantMessage = await operations.persistAssistantMessage();
  await operations.linkDecisionToAssistant(decisionRunId, assistantMessage);
  return { decisionRunId, assistantMessage };
}

export function classifySofiaIntent(text: string): { kind: SofiaIntentClass; reason: string; factKind?: SofiaFactKind } {
  const normalized = text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const hasCommercial = COMMERCIAL.test(normalized) || COMMERCIAL.test(text);
  const hasAdvice = ADVISORY.test(normalized) || ADVISORY.test(text);
  const hasCanonicalOfferId = CANONICAL_OFFER_ID.test(text);
  const hasNamedCanonicalCycle = /\bciclo\s+(?:agua|fogo|ar|terra)\b/i.test(normalized);
  const hasFact = FACT.test(normalized) || FACT.test(text) || hasCanonicalOfferId || hasOfferingQuestion(text);
  if (hasFact && !hasCommercial && !hasAdvice) {
    const factKind = hasCanonicalOfferId ? "offer"
      : /\binstrument|tigela|tambor|gongo|som\b/i.test(normalized) ? "instrument_family"
      : hasNamedCanonicalCycle && !NEXT_OFFERING.test(normalized) ? "offer"
      : offeringKindFor(text) === "course" ? "offer"
      : offeringKindFor(text) === "event" ? "event" : /\bevento|retiro|cerimoni|turma|vivencia\b/i.test(normalized) ? "event" : "offer";
    return { kind: "factual", reason: "single descriptive fact without advisory signals", factKind };
  }
  return { kind: "advisory", reason: hasCommercial ? "commercial capability requested" : hasAdvice ? "suitability/advisory signal" : "mixed or uncertain" };
}
export function requestedCommercialCapability(text: string) {
  if (/\b(pre[çc]o|valor|investimento|mensalidade|desconto|cupom|parcelamento|prix|réduction|coupon)\b/i.test(text)) return "informPrice" as const;
  if (/\b(vaga|disponibilidade|estoque|stock|places?|disponibilit[ée])\b/i.test(text)) return "checkAvailability" as const;
  if (/\b(checkout|comprar|compra|inscri[çc][ãa]o|pagar|paiement)\b/i.test(text)) return "sendCheckout" as const;
  return null;
}
export function shouldExposeFactualTools(fastPathEnabled: boolean, entityCount: number, intent: ReturnType<typeof classifySofiaIntent>) {
  return fastPathEnabled && intent.kind === "factual" && entityCount === 1;
}
export function decidePreGenerationGovernance(input: {
  commercialCapability: string | null;
  commercialGate?: { allowed: boolean; reason: string } | null;
  sensitive: boolean;
  advancement: boolean;
}) {
  if (input.sensitive && input.advancement) return { reason: "oferta_sensivel" as const, gateReason: null };
  if (input.commercialCapability && input.commercialGate && !input.commercialGate.allowed) {
    return { reason: "informacao_comercial_bloqueada" as const, gateReason: input.commercialGate.reason };
  }
  return null;
}
export function factualDecisionShape(status: "found" | "not_found" | "ambiguous" | "pending", detail: unknown, error?: string) {
  if (status === "found") return {
    nbaCode: "ANSWER_FACT", justification: "Resposta factual aprovada para entidade canônica única.", confidence: "high" as const,
    result: "success", detail,
  };
  if (status === "ambiguous") return {
    nbaCode: "FACT_AMBIGUOUS", justification: "Mais de uma entidade corresponde; é necessária uma clarificação.", confidence: "low" as const,
    result: "ambiguous", detail,
  };
  if (status === "not_found") return {
    nbaCode: "FACT_NOT_FOUND", justification: "Entidade factual não encontrada ou não aprovada.", confidence: "low" as const,
    result: "not_found", detail,
  };
  return error
    ? { nbaCode: "FACT_LOOKUP_ERROR", justification: error, confidence: "low" as const, result: "lookup_error", detail }
    : { nbaCode: "FACT_PENDING", justification: "Material aprovado aguarda verificação do envio final.", confidence: "low" as const, result: "pending_send", detail };
}
export function factualToolNbaCode(toolName: string, status: "found" | "not_found" | "ambiguous" | "pending", shape: ReturnType<typeof factualDecisionShape>) {
  return toolName === "sendContentAsset" && status === "pending" && shape.result === "pending_send" ? "CONSUME_CONTENT" : shape.nbaCode;
}
export function buildDeterministicFactualResponse(entity: {
  name: string; description: unknown; facts: Record<string, unknown>;
}) {
  const parts = [`${entity.name}: ${typeof entity.description === "string" ? entity.description : "Informação factual aprovada."}`];
  for (const [key, value] of Object.entries(entity.facts)) {
    if (key === "description" || /price|preco|valor|desconto|cupom|parcel|checkout|estoque|vaga|disponib/i.test(key) || value === null || value === undefined) continue;
    const label = key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`);
    const text = Array.isArray(value) ? value.filter(v => typeof v === "string").join(", ") : String(value);
    if (text.trim()) parts.push(`${label}: ${text}`);
  }
  return parts.join("\n");
}
export function shouldReplaceCommercialLeakage(hasLeakage: boolean, validatedWixOutput: boolean) {
  return hasLeakage && !validatedWixOutput;
}