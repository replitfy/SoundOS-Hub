import { and, eq, sql } from "drizzle-orm";
import { commercialOpportunities, commercialOpportunityEvents, interesseGeralSubmissoes } from "@workspace/db";
import type { EventTx } from "./eventIdentity";
import { textoDaProximaAcao, type ConferenciaDoCartao } from "./identidadeConferencia";
import { normalizeBrazilianPhone } from "./phone";

/**
 * Formulário de interesse genérico (Wix): um só formulário para todos os cursos.
 * O grupo (água, terra, fogo, ar...) vem da variável do código de embed. Os quatro
 * grupos conhecidos têm nome e cor das páginas do site; qualquer outro valor seguro
 * é aceito com a cor padrão, para nunca perder um lead por causa do embed.
 */
export interface InterestGroup {
  slug: string;
  label: string;
  /** Cor de rótulos e botão, no padrão da página do Wix daquele grupo. */
  cor: string;
  /** Cor do texto do botão sobre `cor`. */
  corTexto: string;
}

export const INTEREST_GROUPS: readonly InterestGroup[] = [
  { slug: "agua", label: "Água", cor: "#2BA8E0", corTexto: "#FFFFFF" },
  { slug: "terra", label: "Terra", cor: "#8CC63F", corTexto: "#FFFFFF" },
  { slug: "fogo", label: "Fogo", cor: "#D89B1F", corTexto: "#FFFFFF" },
  { slug: "ar", label: "Ar", cor: "#F8B84A", corTexto: "#4A2E0E" },
];

export const DEFAULT_INTEREST_STYLE = { cor: "#CBB98A", corTexto: "#2B2415" } as const;

const MAX_GROUP_LENGTH = 40;
const MAX_ORIGIN_LENGTH = 500;

/** Minúsculas, sem acento, só letras, números e hífen. Vazio ou inválido vira null. */
export function normalizeGrupo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw
    .slice(0, 200)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_GROUP_LENGTH)
    .replace(/-+$/g, "");
  return slug || null;
}

export function findInterestGroup(slug: string | null): InterestGroup | null {
  return INTEREST_GROUPS.find(group => group.slug === slug) ?? null;
}

export function interestGroupLabel(slug: string | null): string | null {
  if (!slug) return null;
  const known = findInterestGroup(slug);
  if (known) return known.label;
  const text = slug.replace(/-/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Título do cartão do CRM e do envio na ficha da pessoa. */
export function interestOfferLabel(slug: string | null): string {
  const label = interestGroupLabel(slug);
  return label ? `Lista de interesse — ${label}` : "Interesse geral";
}

export function interestOfferIdentity(slug: string | null, eventId: number | null = null): string {
  const groupIdentity = `interesse-geral:${slug ?? "geral"}`;
  return eventId === null ? groupIdentity : `${groupIdentity}:evento:${eventId}`;
}

export function interestOfferLabelForEvent(slug: string | null, eventName: string | null = null): string {
  const label = interestOfferLabel(slug);
  return eventName ? `${label} — ${eventName}` : label;
}

/** Identificador público opcional; inválido é distinto da ausência do parâmetro. */
export function parseInterestEventId(value: unknown): number | null | false {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : null;
  const id = typeof value === "number"
    ? value
    : text && /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : false;
}

/** Só URL http(s), sem credenciais nem âncora e de tamanho limitado. */
export function normalizePaginaOrigem(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 2000) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  const full = url.toString();
  return full.length <= MAX_ORIGIN_LENGTH ? full : (url.origin + url.pathname).slice(0, MAX_ORIGIN_LENGTH);
}

export const INTEREST_FIELDS = [
  { key: "nome", label: "Nome", type: "text", required: true },
  { key: "celular", label: "WhatsApp", type: "tel", required: true },
  { key: "instagram", label: "Instagram", type: "text", required: false },
  { key: "email", label: "Email", type: "email", required: true },
] as const;

const MAX_LENGTH: Record<string, number> = { nome: 200, celular: 40, instagram: 100, email: 254 };

/** Instagram é opcional: sem ele a resposta simplesmente não traz a chave. */
export type InterestAnswers = Record<"nome" | "celular" | "email", string> & { instagram?: string };

export function validateInterestAnswers(input: unknown): { ok: true; answers: InterestAnswers } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Respostas inválidas." };
  const values = input as Record<string, unknown>;
  const allowed = new Set<string>(INTEREST_FIELDS.map(field => field.key));
  const unknown = Object.keys(values).find(key => !allowed.has(key));
  if (unknown) return { ok: false, error: `Campo não permitido: ${unknown}` };
  const answers: Record<string, string> = {};
  for (const field of INTEREST_FIELDS) {
    const value = values[field.key];
    if (value !== undefined && value !== null && typeof value !== "string") return { ok: false, error: `${field.label} deve ser texto.` };
    const text = (value ?? "").trim();
    if (!text) {
      if (field.required) return { ok: false, error: `${field.label} é obrigatório.` };
      continue;
    }
    if (text.length > MAX_LENGTH[field.key]!) return { ok: false, error: `${field.label} excede o tamanho permitido.` };
    answers[field.key] = text;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.email!)) return { ok: false, error: "Informe um e-mail válido." };
  answers.email = answers.email!.toLowerCase();
  if (!normalizeBrazilianPhone(answers.celular).valid) return { ok: false, error: "Informe um WhatsApp válido com DDD." };
  return { ok: true, answers: answers as InterestAnswers };
}

/**
 * Chamado dentro da transação que resolve a pessoa: grava o envio e abre ou atualiza o
 * cartão do CRM. Há um cartão ativo por pessoa e grupo, pelo mesmo índice único parcial
 * usado nos cartões de evento. Nunca devolve um cartão pela metade.
 */
export async function recordGeneralInterest(tx: EventTx, input: {
  personId: number; answers: InterestAnswers; grupo: string | null; paginaOrigem: string | null;
  evento?: { id: number; nome: string } | null;
  /** Identidade não confirmada: o cartão novo nasce pedindo a conferência da equipe. */
  conferencia?: ConferenciaDoCartao | null;
  /** Caixa de consentimento do WhatsApp e o texto exato que estava na tela. */
  consentimento?: { aceito: boolean; texto: string };
}) {
  const { personId, grupo, paginaOrigem, evento = null } = input;
  const offerIdentity = interestOfferIdentity(grupo, evento?.id ?? null);
  const offerLabel = interestOfferLabelForEvent(grupo, evento?.nome ?? null);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${offerIdentity + ":" + personId}, 0))`);
  const [submission] = await tx.insert(interesseGeralSubmissoes).values({
    pessoaId: personId, grupo, paginaOrigem, respostas: input.answers,
    consentimentoWhatsapp: input.consentimento?.aceito ?? false,
    consentimentoTexto: input.consentimento?.aceito ? input.consentimento.texto : null,
  }).returning();
  let [opportunity] = await tx.insert(commercialOpportunities).values({
    pessoaId: personId, nucleus: "EDUCATION", cursosInscricaoId: evento?.id ?? null,
    offerLabel, offerIdentity, ownerSystem: "SOFIA", source: "SOFIA_INTERESSE",
    nextTaskType: "WHATSAPP", nextTaskText: textoDaProximaAcao(input.conferencia), nextTaskAt: new Date(),
    offerInterestStatus: "INTERESTED", ...(input.conferencia ? { informacoes: input.conferencia.resumo } : {}),
  }).onConflictDoNothing().returning();
  const created = Boolean(opportunity);
  if (!opportunity) {
    [opportunity] = await tx.select().from(commercialOpportunities).where(and(
      eq(commercialOpportunities.pessoaId, personId),
      eq(commercialOpportunities.nucleus, "EDUCATION"),
      eq(commercialOpportunities.offerIdentity, offerIdentity),
      sql`${commercialOpportunities.stage} <> 'CLOSED'`,
    )).for("update");
    if (!opportunity) throw new Error("Opportunity not found after conflict");
    [opportunity] = await tx.update(commercialOpportunities).set({
      // Não toma o cartão de quem já o assumiu nem reinicia etapa ou próxima ação.
      ...(opportunity.ownerUserId === null && opportunity.source === "SOFIA_INTERESSE" ? { ownerSystem: "SOFIA" as const } : {}),
      lastInteractionAt: new Date(), version: sql`${commercialOpportunities.version} + 1`, updatedAt: new Date(),
    }).where(eq(commercialOpportunities.id, opportunity.id)).returning();
  }
  await tx.insert(commercialOpportunityEvents).values({
    opportunityId: opportunity!.id, actorKind: "SYSTEM", eventType: created ? "CREATED" : "UPDATED",
    toStage: opportunity!.stage, source: "FORMULARIO_INTERESSE", idempotencyKey: `interesse-geral-submission:${submission!.id}`,
    metadata: {
      formSubmission: {
        submissionId: submission!.id,
        eventId: evento?.id ?? null,
        eventName: evento?.nome ?? offerLabel,
        offerLabel,
        answers: input.answers,
        grupo,
        paginaOrigem,
      },
      ...(input.conferencia ? { conferencia: input.conferencia.resumo } : {}),
    },
  });
  // `created`: este envio abriu o card (e não só atualizou um que já existia).
  return { submission: submission!, opportunity: opportunity!, created };
}
