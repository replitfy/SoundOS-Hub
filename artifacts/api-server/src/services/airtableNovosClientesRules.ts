/**
 * Regras puras da carga de clientes novos do Airtable (sem banco, sem rede).
 *
 * A carga só cria fichas de quem NÃO existe no SoundOS (e, em outro arquivo, as matrículas desses clientes
 * novos). Quem já existe é ignorado e casos duvidosos ficam só contados para revisão. O comando de linha
 * `data:sync-airtable` tem outras regras (atualiza existentes) e não passa por aqui.
 *
 * O telefone é comparado como o banco o guarda (ver `phone.ts`, espelho da função viva
 * `format_brazilian_phone`): o `55` de números com 12 ou 13 dígitos é removido. O normalizador do
 * script de linha mantém o 55 e geraria ficha duplicada.
 */
import { createHash } from "node:crypto";
import { normalizeBrazilianPhone } from "./phone";

export const AIRTABLE_BASE_ID = "app171Qk3J1tRyCj8";
export const CLIENTES_TABLE = { id: "tblcBb0zOgfApfDB4", name: "CLIENTES" } as const;
export const ORIGEM_AIRTABLE = `airtable:${AIRTABLE_BASE_ID}:${CLIENTES_TABLE.id}`;

/** Tamanho da tabela numa leitura completa conhecida (set/2026). Só serve de piso quando nunca houve leitura boa. */
export const REFERENCE_RECORD_COUNT = 4829;
/** Uma leitura abaixo desta fração da referência (ou da última leitura boa) é tratada como incompleta. */
export const MIN_READ_FRACTION = 0.9;
/** Quanto tempo uma prévia concluída vale para uma carga. */
export const PREVIEW_VALID_MINUTES = 60;

export interface AirtableRecordLike {
  id: string;
  fields?: Record<string, unknown>;
}

/** Limite mínimo de registros para aceitar uma leitura como completa. */
export function minimumExpectedRecords(lastGoodRead: number | null): number {
  const baseline = lastGoodRead !== null && lastGoodRead > 0 ? lastGoodRead : REFERENCE_RECORD_COUNT;
  return Math.floor(baseline * MIN_READ_FRACTION);
}

// ── Leitura dos campos ───────────────────────────────────────────────────────

export function clean(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return value;
}

export function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fieldKey(value: string): string {
  return normalizedText(value).replace(/\s/g, "");
}

export function field(record: AirtableRecordLike, aliases: readonly string[]): unknown {
  const entries = Object.entries(record.fields ?? {});
  for (const wanted of aliases.map(fieldKey)) {
    const found = entries.find(([key]) => fieldKey(key) === wanted);
    if (found) return clean(found[1]);
  }
  return null;
}

export function normalizeEmail(value: unknown): string | null {
  const result = clean(value);
  if (typeof result !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) return null;
  return result.normalize("NFKC").toLowerCase();
}

/** Mesma normalização aplicada ao e-mail das fichas existentes (que podem ter sido digitadas de qualquer jeito). */
export function emailKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.normalize("NFKC").trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function asName(value: unknown): { nome: string | null; sobrenome: string | null } {
  const result = clean(value);
  if (result === null) return { nome: null, sobrenome: null };
  const parts = String(result).split(/\s+/).filter(Boolean);
  return { nome: parts[0] ?? null, sobrenome: parts.slice(1).join(" ") || null };
}

/**
 * Campos de texto livre copiados para a ficha nova (coluna do banco → apelidos da coluna no Airtable).
 * O consentimento do Airtable NÃO é copiado: consentimento de contato nunca é inferido de dado importado.
 */
const EXTRA_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["cpf", ["cpf", "documento", "documento cpf"]],
  ["sexo", ["sexo", "gênero", "genero"]],
  ["instagram", ["instagram", "instagram url"]],
  ["site", ["site", "website"]],
  ["profissao", ["profissão", "profissao", "ocupação", "ocupacao"]],
  ["cidade", ["cidade"]],
  ["estado_uf", ["estado", "uf", "estado uf"]],
  ["cep", ["cep", "código postal", "codigo postal"]],
  ["servico_interesse", ["serviço de interesse", "servico de interesse", "serviço", "servico"]],
  ["preferencia_contato", ["preferência de contato", "preferencia de contato"]],
  ["id_aluno_cliente", ["id aluno", "id aluno cliente", "código", "codigo"]],
  ["turma", ["turma"]],
];

/** Colunas que a carga grava em `pessoas`, na ordem fixa usada no INSERT (nada além disso é gravado). */
export const PESSOA_COLUMNS = [
  "nome", "sobrenome", "email", "celular",
  ...EXTRA_FIELDS.map(([column]) => column),
] as const;
export type PessoaColumn = (typeof PESSOA_COLUMNS)[number];

export interface ClienteCandidate {
  sourceRecordId: string;
  nome: string | null;
  email: string | null;
  /** Chave comparável do telefone (igual a `pessoas.celular_normalizado`), ou null se não houver telefone utilizável. */
  phoneKey: string | null;
  /** Valores a gravar, só colunas de PESSOA_COLUMNS e só quando existe valor. */
  values: Partial<Record<PessoaColumn, string>>;
  /** Falso quando o Airtable marca o cliente como inativo. */
  ativo: boolean;
}

export function mapClienteRecord(record: AirtableRecordLike): ClienteCandidate {
  const fullName = field(record, ["nome completo", "nome", "name", "cliente", "aluno"]);
  const names = asName(fullName);
  const sobrenome = clean(field(record, ["sobrenome", "last name"])) ?? names.sobrenome;
  const email = normalizeEmail(field(record, ["email", "e-mail", "email principal"]));
  const rawPhone = field(record, ["celular", "telefone", "whatsapp", "phone", "telefone celular"]);
  const phone = rawPhone === null ? null : normalizeBrazilianPhone(String(rawPhone));
  const phoneKey = phone?.key && phone.key.length >= 8 ? phone.key : null;

  const values: Partial<Record<PessoaColumn, string>> = {};
  if (names.nome) values.nome = names.nome;
  if (typeof sobrenome === "string" && sobrenome) values.sobrenome = sobrenome;
  if (email) values.email = email;
  if (phoneKey && rawPhone !== null) values.celular = String(rawPhone).trim();
  for (const [column, aliases] of EXTRA_FIELDS) {
    const value = field(record, aliases);
    if (value !== null) values[column as PessoaColumn] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const active = field(record, ["ativo", "active", "status"]);
  const ativo = active === null
    ? true
    : !["inativo", "inactive", "arquivado", "archived", "false", "não", "nao"].includes(normalizedText(active));
  return { sourceRecordId: record.id, nome: names.nome, email, phoneKey, values, ativo };
}

// ── Decisão ──────────────────────────────────────────────────────────────────

export interface ExistingPessoa {
  id: number;
  email: string | null;
  celularNormalizado: string | null;
}

export interface ExistingIndex {
  byEmail: Map<string, number[]>;
  byPhone: Map<string, number[]>;
}

/** Indexa TODAS as fichas (ativas, inativas, arquivadas e unidas a outras): a identidade delas continua ocupada. */
export function buildExistingIndex(people: readonly ExistingPessoa[]): ExistingIndex {
  const byEmail = new Map<string, number[]>();
  const byPhone = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string | null, id: number) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const person of people) {
    push(byEmail, emailKey(person.email), person.id);
    push(byPhone, person.celularNormalizado && person.celularNormalizado !== "" ? person.celularNormalizado : null, person.id);
  }
  return { byEmail, byPhone };
}

export type ReviewReason = "duplicado_no_airtable" | "ambiguo" | "contraditorio" | "dados_insuficientes";
export const REVIEW_REASONS: readonly ReviewReason[] = [
  "duplicado_no_airtable", "ambiguo", "contraditorio", "dados_insuficientes",
];
export type ExistsVia = "email" | "phone" | "both" | "previousLoad";

export type Decision =
  | { kind: "create"; candidate: ClienteCandidate }
  | { kind: "exists"; via: ExistsVia }
  | { kind: "review"; reason: ReviewReason };

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/** Cruza e-mail e telefone com as fichas existentes. Telefone compartilhado nunca escolhe "a primeira" ficha. */
function matchExisting(candidate: ClienteCandidate, index: ExistingIndex):
  | { kind: "none" }
  | { kind: "match"; via: "email" | "phone" | "both" }
  | { kind: "conflict"; reason: "ambiguo" | "contraditorio" } {
  const email = candidate.email ? unique(index.byEmail.get(candidate.email) ?? []) : [];
  const phone = candidate.phoneKey ? unique(index.byPhone.get(candidate.phoneKey) ?? []) : [];
  if (email.length && phone.length) {
    const phoneIds = new Set(phone);
    const both = email.filter((id) => phoneIds.has(id));
    if (both.length === 1) return { kind: "match", via: "both" };
    return { kind: "conflict", reason: both.length ? "ambiguo" : "contraditorio" };
  }
  if (email.length === 1) return { kind: "match", via: "email" };
  if (phone.length === 1) return { kind: "match", via: "phone" };
  if (email.length > 1 || phone.length > 1) return { kind: "conflict", reason: "ambiguo" };
  return { kind: "none" };
}

function countKeys(candidates: readonly ClienteCandidate[], pick: (c: ClienteCandidate) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = pick(candidate);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface ClientesPlan {
  decisions: Decision[];
  creates: ClienteCandidate[];
  totals: PlanTotals;
}

export interface PlanTotals {
  sourceRecords: number;
  toCreate: number;
  alreadyExist: number;
  alreadyExistBy: Record<ExistsVia, number>;
  review: { total: number; byReason: Record<ReviewReason, number> };
}

/**
 * Decide o destino de cada cliente do Airtable. A ordem importa: quem já tem vínculo de uma carga
 * anterior ou casa com uma ficha existente é "já existe" (ignorado, mesmo que o registro seja
 * repetido ou incompleto); só o que não casa com ninguém é avaliado para criação.
 */
export function planClientes(
  records: readonly AirtableRecordLike[],
  index: ExistingIndex,
  alreadyLinkedRecordIds: ReadonlySet<string>,
): ClientesPlan {
  const candidates = records.map(mapClienteRecord);
  const emailCounts = countKeys(candidates, (c) => c.email);
  const phoneCounts = countKeys(candidates, (c) => c.phoneKey);

  const decisions: Decision[] = candidates.map((candidate): Decision => {
    if (alreadyLinkedRecordIds.has(candidate.sourceRecordId)) return { kind: "exists", via: "previousLoad" };
    const match = matchExisting(candidate, index);
    if (match.kind === "match") return { kind: "exists", via: match.via };
    if (match.kind === "conflict") return { kind: "review", reason: match.reason };
    if (!candidate.nome || (!candidate.email && !candidate.phoneKey)) {
      return { kind: "review", reason: "dados_insuficientes" };
    }
    const repeated = (candidate.email !== null && (emailCounts.get(candidate.email) ?? 0) > 1)
      || (candidate.phoneKey !== null && (phoneCounts.get(candidate.phoneKey) ?? 0) > 1);
    if (repeated) return { kind: "review", reason: "duplicado_no_airtable" };
    return { kind: "create", candidate };
  });

  const alreadyExistBy: Record<ExistsVia, number> = { email: 0, phone: 0, both: 0, previousLoad: 0 };
  const byReason: Record<ReviewReason, number> = {
    duplicado_no_airtable: 0, ambiguo: 0, contraditorio: 0, dados_insuficientes: 0,
  };
  const creates: ClienteCandidate[] = [];
  for (const decision of decisions) {
    if (decision.kind === "create") creates.push(decision.candidate);
    else if (decision.kind === "exists") alreadyExistBy[decision.via] += 1;
    else byReason[decision.reason] += 1;
  }
  const alreadyExist = alreadyExistBy.email + alreadyExistBy.phone + alreadyExistBy.both + alreadyExistBy.previousLoad;
  const reviewTotal = Object.values(byReason).reduce((sum, value) => sum + value, 0);
  return {
    decisions,
    creates,
    totals: {
      sourceRecords: records.length,
      toCreate: creates.length,
      alreadyExist,
      alreadyExistBy,
      review: { total: reviewTotal, byReason },
    },
  };
}

// ── Resumo da prévia ─────────────────────────────────────────────────────────

/** Valores que serão gravados para um cliente novo (a ordem das chaves não importa para o resumo). */
export function valuesToWrite(candidate: ClienteCandidate): Record<string, string | boolean> {
  return { ...candidate.values, ativo: candidate.ativo };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

const DIGEST_VERSION = 2;

/** O que o resumo precisa saber de uma matrícula planejada (estruturalmente igual a `PlannedEnrollment`). */
export interface EnrollmentForDigest {
  sourceRecordId: string;
  personRecordId: string;
  classId: number;
  contractStatus: string;
}

/**
 * Resumo do que a carga gravaria: quem seria criado (registro de origem) e exatamente com quais
 * valores, e quais matrículas (inscrição → cliente novo → turma existente, com a situação do contrato).
 * A carga só segue se, recalculado dentro da transação, ficar idêntico ao da prévia confirmada.
 * Mudanças em clientes que seriam ignorados não alteram o resumo porque nada é gravado neles.
 * O resumo não contém dados pessoais (é um hash).
 */
export function creationDigest(creates: readonly ClienteCandidate[], enrollments: readonly EnrollmentForDigest[]): string {
  const items = creates
    .map((candidate) => ({ id: candidate.sourceRecordId, values: valuesToWrite(candidate) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const matriculas = enrollments
    .map((item) => ({ id: item.sourceRecordId, person: item.personRecordId, classId: item.classId, contract: item.contractStatus }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256({ version: DIGEST_VERSION, items, enrollments: matriculas });
}

/** Resumo da leitura inteira da tabela, guardado só para auditoria. */
export function sourceDigest(records: readonly AirtableRecordLike[]): string {
  const items = records
    .map((record) => ({ id: record.id, fields: record.fields ?? {} }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256({ items });
}

/** Nome da coluna no formato camelCase usado em `pessoa_evidencias.campo`. */
export function evidenceField(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
