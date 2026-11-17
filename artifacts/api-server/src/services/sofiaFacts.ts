import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db, sofiaEntityRegistry, videosTable, videoEnvios, pessoasTable, type SofiaEntityType,
} from "@workspace/db";
import { getModulosConcluidos, checkModuleEligibility, matchCursoCanonico, safeRecordDecisionRun } from "./decisionEngine";

const COMMERCIAL_KEYS = new Set([
  "price", "preco", "preço", "discount", "desconto", "installments", "parcelamento",
  "availability", "disponibilidade", "capacity", "vagas", "estoque", "stock", "sku",
  "checkout", "checkouturl", "linkinscricao", "valor",
]);
const FACT_FIELDS: Record<SofiaEntityType, Set<string>> = {
  offer: new Set(["description", "audience", "transformation", "modality", "content", "competencies", "prerequisites", "workload", "cycle"]),
  instrument_family: new Set(["description", "use", "context", "recommendedLevel", "maturity"]),
  event: new Set(["description", "format", "duration", "location", "modality", "includes", "prerequisites", "requiresHumanScreening", "eventType"]),
};
const COMMERCIAL_TEXT = /(?:\b(investimento|mensalidade|pre[çc]o|valor|desconto|cupom|parcelamento|vagas?|disponibilidade|estoque|stock|checkout|checkouturl|linkinscri[çc][ãa]o|inscri[çc][ãa]o|prix|réduction|coupon|paiement|places?|disponibilit[ée])\b|(?:R\$|€|£|US\$)\s*\d|\b\d[\d.,]*\s*(?:reais|euros?|dollars?))/iu;
const normalizeKey = (key: string) => key.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const PUBLIC_FIELDS = ["id", "entityType", "stableKey", "name", "description", "facts", "sourceRefs", "sensitive"] as const;
const SHA256_RE = /^[a-f0-9]{64}$/i;
export const FACTUAL_PILOT_KEYS = [
  "OFR_EDU_CICLO_AGUA_PRESENCIAL",
  "OFR_EDU_CICLO_FOGO_PRESENCIAL",
] as const;
const FACTUAL_PILOT_KEY_SET = new Set<string>(FACTUAL_PILOT_KEYS);

const SourceRefBaseSchema = z.object({
  ref: z.string().min(1),
  url: z.string().min(1),
  checkedAt: z.string().datetime(),
}).strict();
const DocumentSourceRefSchema = SourceRefBaseSchema.extend({
  type: z.literal("controlled_document"),
  sourceType: z.literal("document"),
  version: z.string().min(1),
  status: z.enum(["candidate", "approved", "published"]),
  ingestedContentSha256: z.string().regex(SHA256_RE),
  manifestRef: z.string().min(1),
  manifestLinkageStatus: z.enum(["verified", "unavailable_in_summary"]),
  manifestSha256: z.string().regex(SHA256_RE).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.manifestLinkageStatus === "verified" && !value.manifestSha256) {
    ctx.addIssue({ code: "custom", path: ["manifestSha256"], message: "manifestSha256 is required when manifest linkage is verified" });
  }
  if (value.manifestLinkageStatus === "unavailable_in_summary" && value.manifestSha256) {
    ctx.addIssue({ code: "custom", path: ["manifestSha256"], message: "manifestSha256 must remain absent until verified" });
  }
});
const CommercialSourceRefSchema = SourceRefBaseSchema.extend({
  type: z.literal("official"),
  sourceType: z.literal("commercial"),
  validUntil: z.string().datetime(),
}).strict();
const SofiaSourceRefSchema = z.union([
  DocumentSourceRefSchema,
  CommercialSourceRefSchema,
]);

export function safeFacts(value: unknown, entityType?: SofiaEntityType): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !COMMERCIAL_KEYS.has(normalizeKey(key)) && (!entityType || FACT_FIELDS[entityType].has(key)))
    .map(([key, item]) => {
      if (typeof item === "string") return [key, COMMERCIAL_TEXT.test(item) ? undefined : item];
      if (Array.isArray(item)) return [key, item.filter(entry => typeof entry !== "string" || !COMMERCIAL_TEXT.test(entry))];
      return [key, item && typeof item === "object" ? undefined : item];
    }).filter(([, value]) => value !== undefined));
}
export function hasUsableFacts(value: unknown, entityType: SofiaEntityType): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, item]) => FACT_FIELDS[entityType].has(key) &&
    (typeof item === "string" || typeof item === "number" || typeof item === "boolean") &&
    String(item).trim().length > 0);
}
export function evaluateRegistryReadiness(rows: Array<{
  reviewStatus: string;
  sourceRefs: unknown;
  approvedFacts: unknown;
  entityType: SofiaEntityType;
  stableKey: string;
  supersededByStableKey?: string | null;
  sensitive?: boolean;
  capabilities?: unknown;
}>) {
  const pilotRows = new Map(rows
    .filter(row => FACTUAL_PILOT_KEY_SET.has(row.stableKey))
    .map(row => [row.stableKey, row]));
  const gaps = FACTUAL_PILOT_KEYS.filter(stableKey => {
    const row = pilotRows.get(stableKey);
    return !row || !isFactualPilotEntity(row) || row.reviewStatus !== "approved" || row.sensitive === true ||
      !commercialCapabilitiesExplicitlyDisabled(row.capabilities) || !validSourceRefs(row.sourceRefs) ||
      !hasUsableFacts(row.approvedFacts, row.entityType) || containsCommercialFacts(row.approvedFacts);
  });
  const approvedCount = FACTUAL_PILOT_KEYS.filter(key => pilotRows.get(key)?.reviewStatus === "approved").length;
  return { ready: gaps.length === 0, approvedCount, gaps };
}
export function containsCommercialFacts(value: unknown): boolean {
  if (typeof value === "string") return COMMERCIAL_TEXT.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCommercialFacts);
  return Object.entries(value).some(([key, item]) => COMMERCIAL_KEYS.has(normalizeKey(key)) || containsCommercialFacts(item));
}

function publicEntity(row: typeof sofiaEntityRegistry.$inferSelect) {
  return {
    id: row.id, entityType: row.entityType, stableKey: row.stableKey,
    name: row.displayName, description: safeFacts(row.approvedFacts, row.entityType).description ?? null,
    facts: safeFacts(row.approvedFacts, row.entityType), sourceRefs: row.sourceRefs, sensitive: row.sensitive,
  };
}
const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().trim();
export function isFactualPilotEntity(row: {
  stableKey: string;
  supersededByStableKey?: string | null;
}): boolean {
  return FACTUAL_PILOT_KEY_SET.has(row.stableKey) && !row.supersededByStableKey;
}
export function entityMatchesCurrentMessage(
  row: Pick<typeof sofiaEntityRegistry.$inferSelect, "stableKey" | "displayName" | "runtimeAliases">,
  message: string,
): boolean {
  const text = normalize(message);
  const stableKey = normalize(row.stableKey);
  if (text.includes(stableKey)) return true;

  const isPresencial = stableKey.includes("presencial");
  if (isPresencial && (!text.includes("presencial") || text.includes("online"))) return false;

  const aliases = Array.isArray(row.runtimeAliases) ? row.runtimeAliases : [];
  return [row.displayName, ...aliases]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 1)
    .map(normalize)
    .some(value => text.includes(value));
}
export async function resolveEntityCandidates(domain: SofiaEntityType, message: string) {
  const rows = await db.select().from(sofiaEntityRegistry).where(eq(sofiaEntityRegistry.entityType, domain));
  return rows
    .filter(row => isFactualPilotEntity(row) && row.reviewStatus === "approved" && validSourceRefs(row.sourceRefs))
    .filter(row => entityMatchesCurrentMessage(row, message))
    .map(publicEntity);
}

export type FactResult = { status: "found" | "not_found" | "ambiguous"; entity?: ReturnType<typeof publicEntity>; message?: string };

async function getFact(entityType: SofiaEntityType, key: string): Promise<FactResult> {
  const rows = await db.select().from(sofiaEntityRegistry).where(and(
    eq(sofiaEntityRegistry.entityType, entityType),
    eq(sofiaEntityRegistry.reviewStatus, "approved"),
  ));
  const current = rows.filter(r => isFactualPilotEntity(r) && validSourceRefs(r.sourceRefs));
  const matches = current.filter(r => entityMatchesCurrentMessage(r, key));
  if (matches.length === 0) return { status: "not_found", message: `Nenhuma entidade ${entityType} aprovada encontrada para "${key}".` };
  if (matches.length > 1) return { status: "ambiguous", message: `Mais de uma entidade ${entityType} corresponde a "${key}".` };
  return { status: "found", entity: publicEntity(matches[0]) };
}

export function validSourceRefs(value: unknown): boolean {
  const parsed = z.array(SofiaSourceRefSchema).min(1).safeParse(value);
  if (!parsed.success) return false;
  return parsed.data.every(ref => {
    const checkedAt = new Date(ref.checkedAt).getTime();
    if (checkedAt > Date.now()) return false;
    return ref.sourceType === "document" || new Date(ref.validUntil).getTime() >= Date.now();
  });
}

export const getOfferInfo = (offerId: string) => getFact("offer", offerId);
export const getInstrumentFamilyInfo = (instrumentFamilyId: string) => getFact("instrument_family", instrumentFamilyId);
export const getEventInfo = (eventId: string) => getFact("event", eventId);

export const COMMERCIAL_CAPABILITIES = ["informPrice", "sendCheckout", "checkAvailability", "sendCheckoutLink"] as const;
export const SofiaEntityUpdateSchema = z.object({
  approvedFacts: z.record(z.string(), z.unknown()).optional(),
  sourceRefs: z.array(SofiaSourceRefSchema).optional(),
  sensitive: z.boolean().optional(),
  reviewStatus: z.enum(["draft", "approved", "rejected"]).optional(),
  capabilities: z.record(z.enum(COMMERCIAL_CAPABILITIES), z.boolean()).optional(),
}).strict();
export type CommercialCapability = typeof COMMERCIAL_CAPABILITIES[number];
export function commercialCapabilitiesExplicitlyDisabled(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  return COMMERCIAL_CAPABILITIES.every(capability => capabilities[capability] === false) &&
    !Object.values(capabilities).some(enabled => enabled === true);
}
export function evaluateCommercialGate(input: {
  capabilities: unknown; sourceRefs: unknown; requestedCapability: string;
}) {
  if (!COMMERCIAL_CAPABILITIES.includes(input.requestedCapability as CommercialCapability)) {
    return { allowed: false, reason: "capability_not_supported" };
  }
  const refs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];
  if (refs.length === 0) return { allowed: false, reason: "official_current_source_required" };
  const hasCurrentCommercialSource = refs.some(ref => {
    const parsed = CommercialSourceRefSchema.safeParse(ref);
    if (!parsed.success) return false;
    const checkedAt = new Date(parsed.data.checkedAt).getTime();
    const validUntil = new Date(parsed.data.validUntil).getTime();
    return checkedAt <= Date.now() && validUntil >= checkedAt && validUntil >= Date.now();
  });
  if (!hasCurrentCommercialSource) {
    return { allowed: false, reason: "source_stale_or_unofficial" };
  }
  const caps = input.capabilities && typeof input.capabilities === "object"
    ? input.capabilities as Record<string, unknown> : {};
  return caps[input.requestedCapability] === true
    ? { allowed: true, reason: "authorized" }
    : { allowed: false, reason: "capability_not_authorized" };
}

export async function checkCommercialGate(entityType: SofiaEntityType, entityId: string, requestedCapability: CommercialCapability) {
  const result = await getFact(entityType, entityId);
  if (result.status !== "found") return { allowed: false, reason: result.status };
  const row = await db.select({ capabilities: sofiaEntityRegistry.capabilities, sourceRefs: sofiaEntityRegistry.sourceRefs })
    .from(sofiaEntityRegistry).where(eq(sofiaEntityRegistry.id, result.entity!.id)).limit(1);
  const gate = evaluateCommercialGate({ capabilities: row[0]?.capabilities, sourceRefs: row[0]?.sourceRefs, requestedCapability });
  // No structured commercial-value adapter is deployed yet. Authorization
  // alone must never expose a value sourced from facts/RAG/catalog.
  return gate.allowed ? { allowed: false, reason: "commercial_value_adapter_unavailable" } : gate;
}

export async function checkFactualCommercialBoundary(
  entityType: SofiaEntityType,
  entityId: string,
  dependencies: {
    checker?: typeof checkCommercialGate;
    loadCapabilities?: () => Promise<unknown>;
  } = {},
) {
  const checker = dependencies.checker ?? checkCommercialGate;
  const loadCapabilities = dependencies.loadCapabilities ?? (async () => {
    const [row] = await db.select({ capabilities: sofiaEntityRegistry.capabilities })
      .from(sofiaEntityRegistry)
      .where(and(
        eq(sofiaEntityRegistry.entityType, entityType),
        eq(sofiaEntityRegistry.stableKey, entityId),
      ))
      .limit(1);
    return row?.capabilities;
  });
  const capabilitiesDisabled = commercialCapabilitiesExplicitlyDisabled(await loadCapabilities());
  const gates = await Promise.all(COMMERCIAL_CAPABILITIES.map(async capability => ({
    capability,
    ...await checker(entityType, entityId, capability),
  })));
  return {
    passed: capabilitiesDisabled && gates.length === COMMERCIAL_CAPABILITIES.length &&
      gates.every(gate => !gate.allowed && gate.reason !== "commercial_value_adapter_unavailable"),
    capabilitiesDisabled,
    gates,
  };
}

export async function checkEligibility(personId: number, offerId: string) {
  const modulo = matchCursoCanonico(offerId);
  const [person] = await db.select({ id: pessoasTable.id })
    .from(pessoasTable).where(eq(pessoasTable.id, personId)).limit(1);
  if (!person) return { status: "unknown" as const, reason: "pessoa não encontrada", offerId };
  if (!modulo) return { status: "unknown" as const, reason: "oferta sem regra de elegibilidade suportada", offerId };
  const result = checkModuleEligibility(modulo, await getModulosConcluidos(personId));
  return { status: result.status, reason: result.motivo, faltando: result.faltando, offerId };
}

export async function sendContentAsset(refId: string) {
  const rows = await db.select().from(videosTable).where(eq(videosTable.aprovadoParaSofia, true));
  const matches = rows.filter(v => v.ref === refId || v.codigo === refId || String(v.id) === refId);
  if (matches.length === 0) return { status: "not_found" as const, message: "Material não encontrado ou não aprovado editorialmente." };
  if (matches.length > 1) return { status: "ambiguous" as const, message: "Mais de um material corresponde à referência." };
  const video = matches[0];
  if (!video.temLinkReal || !video.link) return { status: "not_found" as const, message: "Material sem link real aprovado." };
  return {
    status: "pending" as const,
    asset: {
      id: video.id,
      ref: video.ref ?? video.codigo,
      title: video.titulo,
      url: video.link,
      course: video.curso,
      type: video.tipo,
    },
  };
}

export async function finalizeContentAsset(asset: { id: number; ref: string | null; title: string; url: string }, input: {
  conversationId: number; messageId: number | null; pessoaId: number | null; finalText: string;
}) {
  if (!input.finalText.includes(asset.url)) return false;
  await db.insert(videoEnvios).values({
    conversationId: input.conversationId, messageId: input.messageId, pessoaId: input.pessoaId,
    videoId: asset.id, codigo: asset.ref, titulo: asset.title, link: asset.url,
  });
  return true;
}

export async function logDecisionRun(input: {
  pessoaId: number; conversationId?: number | null; messageId?: number | null;
  conduta?: "triagem" | "comercial" | null; model?: string | null;
  metadata: Record<string, unknown>;
}) {
  return safeRecordDecisionRun({
    pessoaId: input.pessoaId, conversationId: input.conversationId ?? null, messageId: input.messageId ?? null,
    conduta: input.conduta ?? null, promptId: null, model: input.model ?? null,
    elegibilidadeStatus: "nao_avaliada", elegibilidadeMotivo: null, ofertaPrincipal: null,
    ofertaAlternativa: null, nbaCategoria: "conversar",
    nbaJustificativa: "Registro estruturado da rodada.", nivelConfianca: "alta",
    metadata: input.metadata,
  });
}

export { PUBLIC_FIELDS };