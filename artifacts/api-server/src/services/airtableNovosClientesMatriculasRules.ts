/**
 * Regras puras das matrículas dos clientes novos do Airtable (sem banco, sem rede).
 *
 * Cada inscrição da tabela CONTROLE DE INSCRIÇÕES de um cliente que a carga está criando vira uma
 * matrícula numa turma que JÁ EXISTE no SoundOS. Nunca se cria turma, curso nem link de inscrição:
 * inscrição cuja turma não é encontrada, ou que serve para mais de uma turma, só é contada para revisão.
 *
 * As regras de associação evento → turma espelham as do comando `data:sync-airtable` (só como referência;
 * aquele script não é importado aqui): primeiro o vínculo durável `class` em `airtable_source_links`, depois
 * a chave curso + código + nome + local + datas, aceita só quando identifica uma turma e um evento.
 * Diferente do comando, qualquer ambiguidade vira revisão em vez de escolher "a primeira".
 */
import {
  clean,
  field,
  normalizedText,
  sha256,
  type AirtableRecordLike,
} from "./airtableNovosClientesRules";

export const INSCRICOES_TABLE = { id: "tblyqCSPNXn0XqgrX", name: "CONTROLE DE INSCRIÇÕES" } as const;
export const EVENTOS_TABLES = [
  { id: "tblXVRrHRMxDt76sa", name: "EVENTOS 2026" },
  { id: "tblwYZpCXb7aBC7HU", name: "EVENTOS 2020 > 2022" },
] as const;

/** Tamanhos conhecidos (set/2026). Só servem de piso quando nunca houve uma leitura boa. */
export const REFERENCE_INSCRICOES_COUNT = 3712;
export const REFERENCE_EVENTOS_COUNT = 432;

export type EnrollmentReviewReason = "turma_ausente" | "turma_ambigua" | "duplicada" | "pessoa_ambigua";
export const ENROLLMENT_REVIEW_REASONS: readonly EnrollmentReviewReason[] = [
  "turma_ausente", "turma_ambigua", "duplicada", "pessoa_ambigua",
];

export type ContractStatus = "Assinado" | "pending";

// ── Leitura dos campos ───────────────────────────────────────────────────────

/** Data só quando a fonte traz o dia completo (AAAA-MM-DD); mês/ano soltos ficam nulos, sem inventar dia. */
export function exactDate(value: unknown): string | null {
  const result = clean(value);
  if (typeof result !== "string") return null;
  const match = result.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/);
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

/** Identificadores de registros ligados (campo de vínculo do Airtable), sem repetição. */
function linkedRecordIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((item): item is string => typeof item === "string" && /^rec[a-zA-Z0-9_]+$/.test(item)))];
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
}

export interface EventoCandidate {
  sourceRecordId: string;
  code: string;
  name: string;
  courseName: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
}

/** Evento sem nome é inválido (não vira turma candidata), como no comando de linha. */
export function mapEventoRecord(record: AirtableRecordLike): EventoCandidate | null {
  const name = field(record, ["nome", "nome do evento", "evento", "event", "name"]);
  if (!name) return null;
  const location = field(record, ["local do evento", "local do curso", "local", "location", "cidade"]);
  return {
    sourceRecordId: record.id,
    code: String(field(record, ["turma tag", "turma nb", "turma", "#", "código", "codigo", "code", "referência", "referencia"]) ?? record.id),
    name: String(name),
    courseName: String(field(record, ["curso", "course", "tipo de curso", "serviço", "servico"]) ?? name),
    location: location === null ? null : String(location),
    startDate: exactDate(field(record, ["data início", "data inicio", "início", "inicio", "data", "start date"])),
    endDate: exactDate(field(record, ["data fim", "data final", "fim", "end date"])),
  };
}

export interface InscricaoCandidate {
  sourceRecordId: string;
  personRecordIds: string[];
  eventRecordIds: string[];
  /** Texto do evento quando o campo não é um vínculo (nunca vai para log nem histórico). */
  eventText: string | null;
  eventCode: string | null;
  contractStatus: ContractStatus;
}

export function mapInscricaoRecord(record: AirtableRecordLike): InscricaoCandidate {
  const personLink = field(record, ["nome inscrito", "cliente", "pessoa", "aluno", "person", "inscrito"]);
  const eventLink = field(record, ["inscrito para", "evento", "event", "turma", "class"]);
  const eventRecordIds = linkedRecordIds(eventLink);
  const code = clean(field(record, ["código do evento", "codigo do evento", "event code"]));
  return {
    sourceRecordId: record.id,
    personRecordIds: linkedRecordIds(personLink),
    eventRecordIds,
    eventText: eventRecordIds.length === 0 ? asText(eventLink) : null,
    eventCode: code === null ? null : String(code),
    // Só o campo marcado como verdadeiro vira "Assinado"; falso ou ausente nunca significa assinado.
    contractStatus: field(record, ["contrato assinado"]) === true ? "Assinado" : "pending",
  };
}

// ── Turmas do SoundOS ────────────────────────────────────────────────────────

export interface ClassRow {
  id: number;
  code: string;
  location: string | null;
  /** AAAA-MM-DD ou nulo. */
  startDate: string | null;
  endDate: string | null;
  courseName: string;
  /** Nome do link de inscrição da turma (cursos_inscricao.nome), se houver. */
  name: string | null;
}

export interface ClassLink {
  eventRecordId: string;
  classId: number;
}

export interface ClassIndex {
  classIds: ReadonlySet<number>;
  /** Vínculo durável de uma carga/importação anterior: registro do evento → turma. */
  linkedByEvent: ReadonlyMap<string, number>;
  /** Chave curso+código+nome+local+datas → turmas (sem repetir a mesma turma). */
  byKey: ReadonlyMap<string, readonly number[]>;
}

export function classMatchKey(item: {
  courseName: string; code: string; name: string | null; location: string | null;
  startDate: string | null; endDate: string | null;
}): string {
  return JSON.stringify([
    normalizedText(item.courseName), normalizedText(item.code), normalizedText(item.name),
    normalizedText(item.location), item.startDate, item.endDate,
  ]);
}

function pushUnique<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

export function buildClassIndex(rows: readonly ClassRow[], links: readonly ClassLink[]): ClassIndex {
  const byKey = new Map<string, number[]>();
  for (const row of rows) pushUnique(byKey, classMatchKey(row), row.id);
  return {
    classIds: new Set(rows.map((row) => row.id)),
    linkedByEvent: new Map(links.map((link) => [link.eventRecordId, link.classId])),
    byKey,
  };
}

// ── Planejamento ─────────────────────────────────────────────────────────────

export interface EnrollmentTotals {
  /** Inscrições lidas do Airtable (leitura inteira da tabela). */
  sourceRecords: number;
  /** Eventos lidos do Airtable (as duas tabelas). */
  eventRecords: number;
  /** Inscrições de clientes que esta carga cria. */
  forNewClients: number;
  toCreate: number;
  /** Clientes novos que recebem pelo menos uma matrícula. */
  clientsWithEnrollment: number;
  review: { total: number; byReason: Record<EnrollmentReviewReason, number> };
}

export interface PlannedEnrollment {
  sourceRecordId: string;
  personRecordId: string;
  eventRecordId: string;
  classId: number;
  contractStatus: ContractStatus;
}

export interface EnrollmentPlan {
  enrollments: PlannedEnrollment[];
  totals: EnrollmentTotals;
}

export interface EnrollmentPlanInput {
  inscricoes: readonly AirtableRecordLike[];
  eventos: readonly AirtableRecordLike[];
  /** Registros de CLIENTES que a carga vai criar: só as inscrições deles entram. */
  newPersonRecordIds: ReadonlySet<string>;
  classes: ClassIndex;
  /** Inscrições que já têm vínculo durável com uma matrícula do SoundOS. */
  alreadyLinkedInscricaoIds: ReadonlySet<string>;
}

type ClassResolution =
  | { kind: "resolved"; classId: number; eventRecordId: string }
  | { kind: "review"; reason: "turma_ausente" | "turma_ambigua" };

interface EventIndex {
  byRecordId: Map<string, EventoCandidate>;
  byCode: Map<string, EventoCandidate[]>;
  byName: Map<string, EventoCandidate[]>;
  keyCounts: Map<string, number>;
}

function buildEventIndex(events: readonly EventoCandidate[]): EventIndex {
  const index: EventIndex = { byRecordId: new Map(), byCode: new Map(), byName: new Map(), keyCounts: new Map() };
  for (const event of events) {
    index.byRecordId.set(event.sourceRecordId, event);
    pushUnique(index.byCode, event.code, event);
    pushUnique(index.byName, normalizedText(event.name), event);
    const key = classMatchKey(event);
    index.keyCounts.set(key, (index.keyCounts.get(key) ?? 0) + 1);
  }
  return index;
}

/** Qual evento a inscrição cita: pelo vínculo; sem vínculo, pelo código ou pelo nome, só se for único. */
function findEvent(
  inscricao: InscricaoCandidate,
  events: EventIndex,
): { kind: "event"; eventRecordId: string; event: EventoCandidate | null } | { kind: "review"; reason: "turma_ausente" | "turma_ambigua" } {
  if (inscricao.eventRecordIds.length > 1) return { kind: "review", reason: "turma_ambigua" };
  const linked = inscricao.eventRecordIds[0];
  if (linked) return { kind: "event", eventRecordId: linked, event: events.byRecordId.get(linked) ?? null };

  const byCode = inscricao.eventCode ? events.byCode.get(inscricao.eventCode) ?? [] : [];
  if (byCode.length > 1) return { kind: "review", reason: "turma_ambigua" };
  if (byCode.length === 1) return { kind: "event", eventRecordId: byCode[0]!.sourceRecordId, event: byCode[0]! };

  const nameKey = normalizedText(inscricao.eventText);
  const byName = nameKey ? events.byName.get(nameKey) ?? [] : [];
  if (byName.length > 1) return { kind: "review", reason: "turma_ambigua" };
  if (byName.length === 1) return { kind: "event", eventRecordId: byName[0]!.sourceRecordId, event: byName[0]! };
  return { kind: "review", reason: "turma_ausente" };
}

function resolveClass(inscricao: InscricaoCandidate, events: EventIndex, classes: ClassIndex): ClassResolution {
  const found = findEvent(inscricao, events);
  if (found.kind === "review") return found;

  const linkedClass = classes.linkedByEvent.get(found.eventRecordId);
  if (linkedClass !== undefined) {
    // Vínculo para uma turma que não existe mais não é motivo para criar outra.
    return classes.classIds.has(linkedClass)
      ? { kind: "resolved", classId: linkedClass, eventRecordId: found.eventRecordId }
      : { kind: "review", reason: "turma_ausente" };
  }
  if (!found.event) return { kind: "review", reason: "turma_ausente" };

  const key = classMatchKey(found.event);
  // Dois eventos do Airtable com a mesma chave não dizem qual deles é a turma existente.
  if ((events.keyCounts.get(key) ?? 0) > 1) return { kind: "review", reason: "turma_ambigua" };
  const candidates = classes.byKey.get(key) ?? [];
  if (candidates.length === 0) return { kind: "review", reason: "turma_ausente" };
  if (candidates.length > 1) return { kind: "review", reason: "turma_ambigua" };
  return { kind: "resolved", classId: candidates[0]!, eventRecordId: found.eventRecordId };
}

export function planEnrollments(input: EnrollmentPlanInput): EnrollmentPlan {
  const events = buildEventIndex(input.eventos.map(mapEventoRecord).filter((event): event is EventoCandidate => event !== null));
  const byReason: Record<EnrollmentReviewReason, number> = { turma_ausente: 0, turma_ambigua: 0, duplicada: 0, pessoa_ambigua: 0 };
  const resolved: PlannedEnrollment[] = [];
  let forNewClients = 0;

  for (const record of input.inscricoes) {
    const inscricao = mapInscricaoRecord(record);
    if (!inscricao.personRecordIds.some((id) => input.newPersonRecordIds.has(id))) continue;
    forNewClients += 1;

    if (inscricao.personRecordIds.length > 1) {
      byReason.pessoa_ambigua += 1;
      continue;
    }
    if (input.alreadyLinkedInscricaoIds.has(inscricao.sourceRecordId)) {
      byReason.duplicada += 1;
      continue;
    }
    const resolution = resolveClass(inscricao, events, input.classes);
    if (resolution.kind === "review") {
      byReason[resolution.reason] += 1;
      continue;
    }
    resolved.push({
      sourceRecordId: inscricao.sourceRecordId,
      personRecordId: inscricao.personRecordIds[0]!,
      eventRecordId: resolution.eventRecordId,
      classId: resolution.classId,
      contractStatus: inscricao.contractStatus,
    });
  }

  // A mesma pessoa na mesma turma duas vezes: nenhuma das linhas é escolhida como a "certa".
  const pairCounts = new Map<string, number>();
  const pairKey = (item: PlannedEnrollment) => `${item.personRecordId}\u0000${item.classId}`;
  for (const item of resolved) pairCounts.set(pairKey(item), (pairCounts.get(pairKey(item)) ?? 0) + 1);
  const enrollments = resolved
    .filter((item) => {
      if ((pairCounts.get(pairKey(item)) ?? 0) > 1) {
        byReason.duplicada += 1;
        return false;
      }
      return true;
    })
    .sort((left, right) => left.sourceRecordId.localeCompare(right.sourceRecordId));

  const reviewTotal = Object.values(byReason).reduce((sum, value) => sum + value, 0);
  return {
    enrollments,
    totals: {
      sourceRecords: input.inscricoes.length,
      eventRecords: input.eventos.length,
      forNewClients,
      toCreate: enrollments.length,
      clientsWithEnrollment: new Set(enrollments.map((item) => item.personRecordId)).size,
      review: { total: reviewTotal, byReason },
    },
  };
}

/** Resumo (hash, sem dados pessoais) gravado no vínculo da matrícula com a inscrição do Airtable. */
export function enrollmentSourceSha(item: PlannedEnrollment): string {
  return sha256({ id: item.sourceRecordId, person: item.personRecordId, event: item.eventRecordId, classId: item.classId, contract: item.contractStatus });
}
