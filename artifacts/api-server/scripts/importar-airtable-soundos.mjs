import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ReplitConnectors } from "@replit/connectors-sdk";

export const AIRTABLE_BASE_ID = "app171Qk3J1tRyCj8";
export const AIRTABLE_TABLES = {
  clientes: { id: "tblcBb0zOgfApfDB4", name: "CLIENTES", count: 4829 },
  eventos2026: { id: "tblXVRrHRMxDt76sa", name: "EVENTOS 2026", count: 372 },
  inscricoes: { id: "tblyqCSPNXn0XqgrX", name: "CONTROLE DE INSCRIÇÕES", count: 3712 },
  services: { id: "tbldbHqwAcRsUqGSi", name: "Services (types)", count: 7 },
  eventosHistoricos: { id: "tblwYZpCXb7aBC7HU", name: "EVENTOS 2020 > 2022", count: 60 },
};

const ALL_TABLES = Object.values(AIRTABLE_TABLES);
const TABLE_BY_ID = new Map(ALL_TABLES.map((table) => [table.id, table]));
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WRITE_PLAN_VERSION = 2;

function clean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return value;
}

export function normalizedEmail(value) {
  const result = clean(value);
  if (typeof result !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result)) return null;
  return result.normalize("NFKC").toLowerCase();
}

export function normalizedPhone(value) {
  const result = clean(value);
  if (result === null) return null;
  const digits = String(result).replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function exactDate(value) {
  const result = clean(value);
  if (result instanceof Date && !Number.isNaN(result.valueOf())) return result.toISOString().slice(0, 10);
  if (typeof result !== "string") return null;
  const match = result.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/);
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === candidate ? candidate : null;
}

function uniqueById(values) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

/**
 * A phone is an identity key only when it identifies one person. In particular,
 * this deliberately does not pick the first row from a shared-phone list.
 */
export function resolveIdentity(emailMatches, phoneMatches) {
  const email = uniqueById(emailMatches);
  const phone = uniqueById(phoneMatches);
  if (email.length && phone.length) {
    const phoneIds = new Set(phone.map((person) => person.id));
    const intersection = email.filter((person) => phoneIds.has(person.id));
    if (intersection.length === 1) return { kind: "match", person: intersection[0], matchedBy: "both" };
    return { kind: "conflict", reason: intersection.length ? "ambiguous" : "contradictory" };
  }
  if (email.length === 1) return { kind: "match", person: email[0], matchedBy: "email" };
  if (phone.length === 1) return { kind: "match", person: phone[0], matchedBy: "phone" };
  if (email.length > 1 || phone.length > 1) return { kind: "conflict", reason: "ambiguous" };
  return { kind: "none" };
}

export function sufficientIdentity(person) {
  return Boolean(clean(person.nome) && (normalizedEmail(person.email) || normalizedPhone(person.phone)));
}

export function classStatus(startDate, endDate, today = new Date().toISOString().slice(0, 10)) {
  if (endDate && endDate < today) return "Encerrada";
  if (startDate && startDate <= today) return "Em Andamento";
  return "Planejada";
}

export function mappedContractStatus(value) {
  return value === true ? "Assinado" : null;
}

export function enrollmentStatusPlan(contractValue) {
  const contractStatus = mappedContractStatus(contractValue);
  return {
    insert: { paymentStatus: "pending", contractStatus: contractStatus ?? "pending" },
    update: contractStatus ? { contractStatus } : {},
  };
}

function fieldKey(value) {
  return normalizedText(value).replace(/\s/g, "");
}

function field(record, aliases) {
  const entries = Object.entries(record.fields ?? {});
  const wanted = aliases.map(fieldKey);
  for (const wantedKey of wanted) {
    const found = entries.find(([key]) => fieldKey(key) === wantedKey);
    if (found) return clean(found[1]);
  }
  return null;
}

function linkedRecordId(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.find((item) => typeof item === "string" && /^rec[a-zA-Z0-9]+$/.test(item)) ?? null;
}

function linkedRecordName(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return clean(value) === null ? null : String(value);
}

function asName(value) {
  const result = clean(value);
  if (result === null) return { nome: null, sobrenome: null };
  const parts = String(result).split(/\s+/).filter(Boolean);
  return { nome: parts[0] ?? null, sobrenome: parts.slice(1).join(" ") || null };
}

const PERSON_FIELDS = [
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
  ["consent_status", ["consentimento", "consent status", "status consentimento"]],
];

export function mapPersonRecord(record) {
  const fullName = field(record, ["nome completo", "nome", "name", "cliente", "aluno"]);
  const names = asName(fullName);
  const email = field(record, ["email", "e-mail", "email principal"]);
  const phone = field(record, ["celular", "telefone", "whatsapp", "phone", "telefone celular"]);
  const mapped = {
    sourceRecordId: record.id,
    nome: names.nome,
    sobrenome: clean(field(record, ["sobrenome", "last name"])) ?? names.sobrenome,
    email: normalizedEmail(email),
    celular: clean(phone) === null ? null : String(phone),
    celular_normalizado: normalizedPhone(phone),
  };
  for (const [column, aliases] of PERSON_FIELDS) {
    const value = field(record, aliases);
    if (value !== null) mapped[column] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const active = field(record, ["ativo", "active", "status"]);
  if (active !== null) mapped.ativo = !["inativo", "inactive", "arquivado", "archived", "false", "não", "nao"].includes(
    normalizedText(active),
  );
  return mapped;
}

function mapEventRecord(record) {
  const name = field(record, ["nome", "nome do evento", "evento", "event", "name"]);
  if (!name) return null;
  const startDate = exactDate(field(record, ["data início", "data inicio", "início", "inicio", "data", "start date"]));
  return {
    sourceRecordId: record.id,
    code: String(field(record, ["turma tag", "turma nb", "turma", "#", "código", "codigo", "code", "referência", "referencia"]) ?? record.id),
    name: String(name),
    courseName: String(field(record, ["curso", "course", "tipo de curso", "serviço", "servico"]) ?? name),
    location: clean(field(record, ["local do evento", "local do curso", "local", "location", "cidade"])),
    startDate,
    endDate: exactDate(field(record, ["data fim", "data final", "fim", "end date"])),
  };
}

function mapCourseRecord(record) {
  const name = field(record, ["nome", "name", "serviço", "servico", "tipo", "service type"]);
  return name ? { sourceRecordId: record.id, name: String(name) } : null;
}

function mapEnrollmentRecord(record) {
  const personLink = field(record, ["nome inscrito", "cliente", "pessoa", "aluno", "person", "inscrito"]);
  const eventLink = field(record, ["inscrito para", "evento", "event", "turma", "class"]);
  return {
    sourceRecordId: record.id,
    personRecordId: linkedRecordId(personLink),
    personName: linkedRecordName(personLink),
    eventRecordId: linkedRecordId(eventLink),
    eventName: linkedRecordName(eventLink),
    eventCode: clean(field(record, ["código do evento", "codigo do evento", "event code"])),
    contractStatus: clean(field(record, ["contrato assinado"])),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).sort().join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : Math.min(500 * 2 ** attempt, 30_000);
}

async function airtableRequest(connectors, pathName) {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await connectors.proxy("airtable", pathName);
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 6) {
        throw new Error(`Airtable transient HTTP ${response.status} persisted after 7 attempts.`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }
    if (!response.ok) throw new Error(`Airtable request failed: HTTP ${response.status} ${response.statusText}`);
    return response.json();
  }
  throw new Error("Airtable request retry loop exhausted.");
}

export async function fetchTable(connectors, table) {
  const records = [];
  let offset = null;
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (offset) query.set("offset", offset);
    const data = await airtableRequest(connectors, `/v0/${AIRTABLE_BASE_ID}/${table.id}?${query}`);
    if (!Array.isArray(data.records)) throw new Error(`Airtable table ${table.name} returned no records array.`);
    records.push(...data.records);
    offset = data.offset ?? null;
  } while (offset);
  if (records.length !== table.count) {
    throw new Error(`Unexpected Airtable count for ${table.name}: expected ${table.count}, got ${records.length}.`);
  }
  return records;
}

async function validateTableIdentities(connectors) {
  const data = await airtableRequest(connectors, `/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`);
  const tables = Array.isArray(data.tables) ? data.tables : [];
  for (const expected of ALL_TABLES) {
    const actual = tables.find((table) => table.id === expected.id);
    if (!actual || actual.name !== expected.name) {
      throw new Error(`Airtable table identity mismatch for ${expected.name} (${expected.id}).`);
    }
  }
}

async function loadSource(connectors) {
  await validateTableIdentities(connectors);
  const raw = {};
  for (const [key, table] of Object.entries(AIRTABLE_TABLES)) raw[key] = await fetchTable(connectors, table);
  return raw;
}

function personFieldsForDb(person) {
  const result = {};
  for (const [key, value] of Object.entries(person)) {
    if (key !== "sourceRecordId" && key !== "ativo" && value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

function confirmationField(column) {
  return column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function emptyCounts() {
  return {
    sourcePeople: 0, matchedPeople: 0, newPeople: 0, personConflicts: 0, skippedPeople: 0,
    sourceCourses: 0, sourceClasses: 0, sourceEnrollments: 0, plannedCourses: 0,
    plannedClasses: 0, plannedRegistrationLinks: 0, plannedEnrollments: 0,
    unresolvedEnrollments: 0, duplicateSourceEnrollments: 0, invalidClasses: 0, undatedClasses: 0,
    archivedMatches: 0, inactiveMatches: 0,
  };
}

function addIndex(index, key, value) {
  if (!key) return;
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

function uniqueLookup(index, key) {
  if (!key) return null;
  const values = index.get(key) ?? [];
  return values.length === 1 ? values[0] : null;
}

function classMatchKey(item) {
  return canonicalJson({
    course: normalizedText(item.courseName),
    code: normalizedText(item.code),
    name: normalizedText(item.name),
    location: normalizedText(item.location),
    startDate: item.startDate,
    endDate: item.endDate,
  });
}

/**
 * Builds a write plan without touching the database. `existingLinks` is the
 * durable source-link index from previous runs; its values are `{ entityId }`.
 */
export function buildPlan(source, existingPeople = [], existingLinks = new Map(), existingClasses = []) {
  const counts = emptyCounts();
  const people = source.clientes.map(mapPersonRecord);
  counts.sourcePeople = people.length;
  const emailIndex = new Map();
  const phoneIndex = new Map();
  const sourceEmailIndex = new Map();
  const sourcePhoneIndex = new Map();
  for (const person of people) {
    addIndex(sourceEmailIndex, person.email, person.sourceRecordId);
    addIndex(sourcePhoneIndex, person.celular_normalizado, person.sourceRecordId);
  }
  for (const person of existingPeople) {
    addIndex(emailIndex, normalizedEmail(person.email), person);
    addIndex(phoneIndex, normalizedPhone(person.celular_normalizado ?? person.celular), person);
  }
  const personPlans = [];
  const sourcePersonToEntity = new Map();
  const safePersonSourceIds = new Set();
  const claimedExistingTargets = new Map();
  for (const person of people) {
    if ((person.email && (sourceEmailIndex.get(person.email)?.length ?? 0) > 1) ||
        (person.celular_normalizado && (sourcePhoneIndex.get(person.celular_normalizado)?.length ?? 0) > 1)) {
      counts.personConflicts += 1;
      personPlans.push({ action: "conflict", person, reason: "duplicate_source_identity" });
      continue;
    }
    const linked = existingLinks.get(`pessoa:${person.sourceRecordId}`);
    if (linked) {
      const existing = existingPeople.find((item) => item.id === linked.entityId);
      if (!existing) throw new Error(`Dangling Airtable pessoa source link for ${person.sourceRecordId}.`);
      sourcePersonToEntity.set(person.sourceRecordId, existing.id);
      safePersonSourceIds.add(person.sourceRecordId);
      personPlans.push({ action: "update", person, existing, matchedBy: "source_link" });
      counts.matchedPeople += 1;
      if (existing.arquivado_em) counts.archivedMatches += 1;
      else if (existing.ativo === false) counts.inactiveMatches += 1;
      claimedExistingTargets.set(existing.id, { locked: true });
      continue;
    }
    const identity = resolveIdentity(
      emailIndex.get(person.email) ?? [],
      phoneIndex.get(person.celular_normalizado) ?? [],
    );
    if (identity.kind === "conflict") {
      counts.personConflicts += 1;
      personPlans.push({ action: "conflict", person, reason: identity.reason });
      continue;
    }
    if (identity.kind === "match" && typeof identity.person.id === "number") {
      const priorClaim = claimedExistingTargets.get(identity.person.id);
      if (priorClaim) {
        if (!priorClaim.locked && priorClaim.plan.action === "update") {
          priorClaim.plan.action = "conflict";
          priorClaim.plan.reason = "duplicate_target_identity";
          sourcePersonToEntity.delete(priorClaim.plan.person.sourceRecordId);
          safePersonSourceIds.delete(priorClaim.plan.person.sourceRecordId);
          counts.matchedPeople -= 1;
          counts.personConflicts += 1;
        }
        counts.personConflicts += 1;
        personPlans.push({ action: "conflict", person, reason: "duplicate_target_identity" });
        claimedExistingTargets.set(identity.person.id, { locked: true });
        continue;
      }
      sourcePersonToEntity.set(person.sourceRecordId, identity.person.id);
      safePersonSourceIds.add(person.sourceRecordId);
      const plan = { action: "update", person, existing: identity.person, matchedBy: identity.matchedBy };
      personPlans.push(plan);
      claimedExistingTargets.set(identity.person.id, { locked: false, plan });
      counts.matchedPeople += 1;
      if (identity.person.arquivado_em) counts.archivedMatches += 1;
      else if (identity.person.ativo === false) counts.inactiveMatches += 1;
      continue;
    }
    if (identity.kind === "match") {
      counts.personConflicts += 1;
      personPlans.push({ action: "conflict", person, reason: "duplicate_source_identity" });
      continue;
    }
    if (!sufficientIdentity({ nome: person.nome, email: person.email, phone: person.celular_normalizado })) {
      counts.skippedPeople += 1;
      personPlans.push({ action: "skip", person, reason: "insufficient_identity" });
      continue;
    }
    const planned = {
      // Keep planned records distinct in the in-memory identity index. A
      // duplicate source email/phone must become a conflict, never an
      // accidental second match to whichever row was iterated first.
      id: `AT-${person.sourceRecordId}`,
      codigo: `AT-${person.sourceRecordId}`,
      email: person.email,
      celular: person.celular,
      celular_normalizado: person.celular_normalizado,
      nome: person.nome,
      sobrenome: person.sobrenome,
      ativo: true,
      arquivado_em: null,
    };
    addIndex(emailIndex, person.email, planned);
    addIndex(phoneIndex, person.celular_normalizado, planned);
    personPlans.push({ action: "create", person });
    safePersonSourceIds.add(person.sourceRecordId);
    counts.newPeople += 1;
  }

  const rawEventRows = [
    ...source.eventos2026.map((record) => ({ mapped: mapEventRecord(record), sourceTableId: AIRTABLE_TABLES.eventos2026.id })),
    ...source.eventosHistoricos.map((record) => ({ mapped: mapEventRecord(record), sourceTableId: AIRTABLE_TABLES.eventosHistoricos.id })),
  ];
  const eventRows = rawEventRows.filter((row) => row.mapped).map((row) => ({ ...row.mapped, sourceTableId: row.sourceTableId }));
  const courseByName = new Map();
  for (const record of source.services.map(mapCourseRecord).filter(Boolean)) courseByName.set(normalizedText(record.name), record);
  for (const event of eventRows) {
    if (!courseByName.has(normalizedText(event.courseName))) {
      courseByName.set(normalizedText(event.courseName), { sourceRecordId: null, name: event.courseName });
    }
  }
  const courses = [...courseByName.values()];
  const existingClassesByKey = new Map();
  const sourceClassesByKey = new Map();
  for (const item of existingClasses) addIndex(existingClassesByKey, classMatchKey(item), item);
  for (const item of eventRows) addIndex(sourceClassesByKey, classMatchKey(item), item);
  const classes = eventRows.map((item) => {
    const key = classMatchKey(item);
    const sourceIsUnique = (sourceClassesByKey.get(key)?.length ?? 0) === 1;
    const existing = sourceIsUnique ? uniqueLookup(existingClassesByKey, key) : null;
    return { ...item, existingClassId: existing?.id ?? null };
  });
  counts.sourceCourses = source.services.length;
  counts.sourceClasses = rawEventRows.length;
  counts.invalidClasses = rawEventRows.length - eventRows.length;
  counts.plannedCourses = courses.length;
  counts.plannedClasses = classes.length;
  counts.undatedClasses = classes.filter((item) => !item.startDate).length;

  const eventByRecordId = new Map(eventRows.map((event) => [event.sourceRecordId, event]));
  const eventByCode = new Map();
  const eventByName = new Map();
  for (const event of eventRows) {
    addIndex(eventByCode, event.code, event);
    addIndex(eventByName, normalizedText(event.name), event);
  }
  const enrollmentCandidates = [];
  for (const sourceEnrollment of source.inscricoes.map(mapEnrollmentRecord)) {
    const event = eventByRecordId.get(sourceEnrollment.eventRecordId) ??
      uniqueLookup(eventByCode, String(sourceEnrollment.eventCode ?? "")) ??
      uniqueLookup(eventByName, normalizedText(sourceEnrollment.eventName));
    const personEntityId = sourcePersonToEntity.get(sourceEnrollment.personRecordId) ?? null;
    if (!event || !safePersonSourceIds.has(sourceEnrollment.personRecordId)) {
      counts.unresolvedEnrollments += 1;
      continue;
    }
    enrollmentCandidates.push({ ...sourceEnrollment, event, personEntityId });
  }
  const enrollmentsByPair = new Map();
  for (const enrollment of enrollmentCandidates) {
    addIndex(enrollmentsByPair, `${enrollment.personRecordId}:${enrollment.event.sourceRecordId}`, enrollment);
  }
  const enrollments = enrollmentCandidates.filter((enrollment) => {
    const duplicate = (enrollmentsByPair.get(
      `${enrollment.personRecordId}:${enrollment.event.sourceRecordId}`,
    )?.length ?? 0) > 1;
    if (duplicate) {
      counts.unresolvedEnrollments += 1;
      counts.duplicateSourceEnrollments += 1;
    }
    return !duplicate;
  });
  counts.sourceEnrollments = source.inscricoes.length;
  counts.plannedEnrollments = enrollments.length;
  counts.plannedRegistrationLinks = classes.length;
  return { counts, personPlans, courses, classes, enrollments, sourcePersonToEntity };
}

async function readPeople(client) {
  const result = await client.query(
    "SELECT id,codigo,nome,sobrenome,email,celular,celular_normalizado,ativo,arquivado_em FROM pessoas ORDER BY id",
  );
  return result.rows;
}

async function readClasses(client) {
  const result = await client.query(
    `SELECT c.id,c.code,c.location,c.start_date AS "startDate",c.end_date AS "endDate",
            c.status,c.updated_at AS "updatedAt",co.name AS "courseName",ci.nome AS name
       FROM classes c
       JOIN courses co ON co.id=c.course_id
       LEFT JOIN cursos_inscricao ci ON ci.class_id=c.id
      ORDER BY c.id`,
  );
  return result.rows;
}

async function readTargetState(client, existingPeople, existingClasses, existingLinks) {
  const people = await client.query("SELECT * FROM pessoas ORDER BY id");
  const courses = await client.query("SELECT * FROM courses ORDER BY id");
  const classes = await client.query("SELECT * FROM classes ORDER BY id");
  const registrations = await client.query("SELECT * FROM cursos_inscricao ORDER BY id");
  const enrollments = await client.query("SELECT * FROM enrollments ORDER BY id");
  const confirmations = await client.query("SELECT * FROM pessoa_campos_confirmados ORDER BY id");
  const evidence = await client.query("SELECT * FROM pessoa_evidencias ORDER BY id");
  return {
    people: people.rows,
    classes: classes.rows,
    sourceLinks: [...existingLinks.entries()].sort(([left], [right]) => left.localeCompare(right)),
    courses: courses.rows,
    registrations: registrations.rows,
    enrollments: enrollments.rows,
    confirmations: confirmations.rows,
    evidence: evidence.rows,
  };
}

async function readSourceLinks(client) {
  const result = await client.query(
    "SELECT source_table_id,source_record_id,entity_type,entity_id,source_fields_sha256 FROM airtable_source_links WHERE base_id=$1",
    [AIRTABLE_BASE_ID],
  );
  return new Map(result.rows.map((row) => [
    `${row.entity_type}:${row.source_record_id}`,
    { entityId: Number(row.entity_id), sourceTableId: row.source_table_id, sourceFieldsSha256: row.source_fields_sha256 },
  ]));
}

function manifestDigest(rows) {
  return sha256(rows.map((row) => ({
    id: row.id, codigo: row.codigo, email: normalizedEmail(row.email),
    phone: normalizedPhone(row.celular_normalizado ?? row.celular), ativo: row.ativo,
    archived: Boolean(row.arquivado_em),
  })));
}

function sourceDigest(source) {
  return sha256(Object.entries(source).map(([key, rows]) => ({
    table: AIRTABLE_TABLES[key].id,
    rows: [...rows].sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => ({ id: row.id, fields: row.fields })),
  })));
}

function resolvedCourseTarget(course, targetState, existingLinks) {
  const linked = course.sourceRecordId ? existingLinks.get(`course:${course.sourceRecordId}`)?.entityId : null;
  return linked ?? targetState.courses.find((row) => row.name === course.name)?.id ?? null;
}

function resolvedClassTarget(item, existingLinks) {
  return existingLinks.get(`class:${item.sourceRecordId}`)?.entityId ?? item.existingClassId ?? null;
}

function resolvedRegistrationTarget(item, targetState, existingLinks) {
  const linked = existingLinks.get(`curso_inscricao:${item.sourceRecordId}`)?.entityId;
  if (linked) return linked;
  const classId = resolvedClassTarget(item, existingLinks);
  const slug = `airtable-${item.sourceRecordId}`;
  return targetState.registrations
    .filter((row) => (classId && Number(row.class_id) === classId) || row.slug === slug)
    .sort((left, right) => {
      const leftClass = classId && Number(left.class_id) === classId ? 1 : 0;
      const rightClass = classId && Number(right.class_id) === classId ? 1 : 0;
      return rightClass - leftClass || Number(left.id) - Number(right.id);
    })[0]?.id ?? null;
}

function resolvedEnrollmentTarget(item, plan, targetState, existingLinks) {
  const linked = existingLinks.get(`enrollment:${item.sourceRecordId}`)?.entityId;
  if (linked) return linked;
  const pessoaId = item.personEntityId;
  const classItem = plan.classes.find((candidate) => candidate.sourceRecordId === item.event.sourceRecordId);
  const classId = classItem ? resolvedClassTarget(classItem, existingLinks) : null;
  if (!pessoaId || !classId) return null;
  return targetState.enrollments.find(
    (row) => Number(row.pessoa_id) === pessoaId && Number(row.class_id) === classId,
  )?.id ?? null;
}

function planManifest(plan, targetState, existingLinks) {
  return {
    version: WRITE_PLAN_VERSION,
    people: plan.personPlans.map((item) => ({
      sourceRecordId: item.person.sourceRecordId,
      action: item.action,
      targetId: item.existing?.id ?? null,
      matchedBy: item.matchedBy ?? null,
      reason: item.reason ?? null,
      values: personFieldsForDb(item.person),
    })),
    courses: plan.courses.map((item) => ({
      sourceRecordId: item.sourceRecordId,
      targetId: resolvedCourseTarget(item, targetState, existingLinks),
      values: item,
    })),
    classes: plan.classes.map((item) => ({
      sourceRecordId: item.sourceRecordId,
      sourceTableId: item.sourceTableId,
      targetId: resolvedClassTarget(item, existingLinks),
      registrationTargetId: resolvedRegistrationTarget(item, targetState, existingLinks),
      values: {
        courseName: item.courseName,
        code: item.code,
        name: item.name,
        location: item.location,
        startDate: item.startDate,
        endDate: item.endDate,
        status: classStatus(item.startDate, item.endDate),
      },
    })),
    enrollments: plan.enrollments.map((item) => ({
      sourceRecordId: item.sourceRecordId,
      personRecordId: item.personRecordId,
      personEntityId: item.personEntityId,
      eventRecordId: item.event.sourceRecordId,
      targetId: resolvedEnrollmentTarget(item, plan, targetState, existingLinks),
      statuses: enrollmentStatusPlan(item.contractStatus),
    })),
  };
}

function confirmationDigest(sourceHash, targetStateHash, writePlanHash, counts) {
  return sha256({
    base: AIRTABLE_BASE_ID,
    sourceHash,
    targetStateHash,
    writePlanHash,
    counts,
  });
}

async function lockSyncTargets(client) {
  await client.query(
    `LOCK TABLE pessoas,pessoa_campos_confirmados,pessoa_evidencias,courses,classes,
       cursos_inscricao,enrollments,airtable_source_links IN SHARE MODE`,
  );
}

async function buildDatabasePlan(client, source) {
  const existingPeople = await readPeople(client);
  const existingLinks = await readSourceLinks(client);
  const existingClasses = await readClasses(client);
  const plan = buildPlan(source, existingPeople, existingLinks, existingClasses);
  const targetState = await readTargetState(client, existingPeople, existingClasses, existingLinks);
  const writePlanHash = sha256(planManifest(plan, targetState, existingLinks));
  return {
    existingPeople,
    existingLinks,
    plan,
    manifestHash: manifestDigest(existingPeople),
    targetStateHash: sha256(targetState),
    writePlanHash,
  };
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return `"${value}"`;
}

async function runBackup() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for execute.");
  const directory = path.join(workspaceRoot, ".local/data-backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(directory, `soundos-airtable-pre-sync-${stamp}.dump`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const descriptor = openSync(backupPath, "wx", 0o600);
  closeSync(descriptor);
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const pgEnvironment = {
    ...process.env,
    PGHOST: databaseUrl.hostname,
    PGPORT: databaseUrl.port || "5432",
    PGUSER: decodeURIComponent(databaseUrl.username),
    PGPASSWORD: decodeURIComponent(databaseUrl.password),
    PGDATABASE: databaseUrl.pathname.replace(/^\//, ""),
  };
  const dump = spawnSync("pg_dump", ["--format=custom", `--file=${backupPath}`], { stdio: "ignore", env: pgEnvironment });
  if (dump.status !== 0) {
    unlinkSync(backupPath);
    throw new Error("pg_dump failed; Airtable sync cancelled.");
  }
  if ((statSync(backupPath).mode & 0o777) !== 0o600) throw new Error("Backup permissions are not owner-only.");
  const verify = spawnSync("pg_restore", ["--list", backupPath], { stdio: "ignore" });
  if (verify.status !== 0) throw new Error("Backup failed pg_restore validation.");
  return backupPath;
}

async function upsertSourceLink(client, tableId, recordId, entityType, entityId, fieldsHash) {
  await client.query(
    `INSERT INTO airtable_source_links
       (base_id,source_table_id,source_record_id,entity_type,entity_id,source_fields_sha256,last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (base_id,source_table_id,source_record_id,entity_type)
     DO UPDATE SET entity_id=EXCLUDED.entity_id,source_fields_sha256=EXCLUDED.source_fields_sha256,last_seen_at=now()`,
    [AIRTABLE_BASE_ID, tableId, recordId, entityType, entityId, fieldsHash],
  );
}

async function executePlan(client, source, plan, existingPeople, existingLinks) {
  const peopleBySource = new Map();
  for (const item of plan.personPlans) {
    if (item.action === "conflict" || item.action === "skip") continue;
    let pessoaId;
    const incomingHash = sha256(item.person);
    const priorLink = existingLinks.get(`pessoa:${item.person.sourceRecordId}`);
    if (item.action === "update" && priorLink?.sourceFieldsSha256 === incomingHash) {
      pessoaId = item.existing.id;
      peopleBySource.set(item.person.sourceRecordId, pessoaId);
      continue;
    }
    if (item.action === "create") {
      const values = personFieldsForDb(item.person);
      const columns = ["codigo", ...Object.keys(values), "ativo"];
      const params = [`AT-${item.person.sourceRecordId}`, ...Object.values(values), item.person.ativo !== false];
      const placeholders = params.map((_, index) => `$${index + 1}`).join(",");
      const inserted = await client.query(
        `INSERT INTO pessoas (${columns.map(quoteIdentifier).join(",")}) VALUES (${placeholders}) RETURNING id`,
        params,
      );
      pessoaId = inserted.rows[0].id;
    } else {
      pessoaId = item.existing.id;
      const confirmed = await client.query("SELECT campo FROM pessoa_campos_confirmados WHERE pessoa_id=$1", [pessoaId]);
      const confirmedFields = new Set(confirmed.rows.map((row) => row.campo));
      const values = personFieldsForDb(item.person);
      const updates = Object.entries(values).filter(([column]) => !confirmedFields.has(confirmationField(column)));
      if (updates.length) {
        await client.query(
          `UPDATE pessoas SET ${updates.map(([column], index) => `${quoteIdentifier(column)}=$${index + 2}`).join(",")},updated_at=now() WHERE id=$1`,
          [pessoaId, ...updates.map(([, value]) => value)],
        );
      }
    }
    peopleBySource.set(item.person.sourceRecordId, pessoaId);
    for (const [column, value] of Object.entries(personFieldsForDb(item.person))) {
      const confirmed = await client.query(
        "SELECT 1 FROM pessoa_campos_confirmados WHERE pessoa_id=$1 AND campo=$2",
        [pessoaId, confirmationField(column)],
      );
      await client.query(
        `INSERT INTO pessoa_evidencias
          (pessoa_id,campo,valor,tipo_evidencia,origem,nivel_confianca,aplicada)
         VALUES ($1,$2,$3,'inferida',$4,'baixa',$5)`,
        [pessoaId, confirmationField(column), Array.isArray(value) ? JSON.stringify(value) : String(value),
          `airtable:${AIRTABLE_BASE_ID}:${AIRTABLE_TABLES.clientes.id}`, confirmed.rowCount ? "nao" : "sim"],
      );
    }
    await upsertSourceLink(
      client, AIRTABLE_TABLES.clientes.id, item.person.sourceRecordId, "pessoa", pessoaId, incomingHash,
    );
  }

  const courseIds = new Map();
  for (const course of plan.courses) {
    const sourceTableId = course.sourceRecordId ? AIRTABLE_TABLES.services.id : null;
    const sourceLink = course.sourceRecordId ? existingLinks.get(`course:${course.sourceRecordId}`) : null;
    let courseId = sourceLink?.entityId;
    if (courseId) {
      const found = await client.query("SELECT id FROM courses WHERE id=$1", [courseId]);
      if (!found.rowCount) courseId = null;
    }
    if (!courseId) {
      const found = await client.query("SELECT id FROM courses WHERE name=$1 ORDER BY id LIMIT 1", [course.name]);
      courseId = found.rows[0]?.id;
    }
    if (!courseId) {
      const inserted = await client.query(
        `INSERT INTO courses (name,cycle,modality,workload,price,description,active)
         VALUES ($1,'Airtable','não informada',0,0,'Importado do Airtable; metadados não disponíveis.',true) RETURNING id`,
        [course.name],
      );
      courseId = inserted.rows[0].id;
    }
    await client.query("UPDATE courses SET name=$1,updated_at=now() WHERE id=$2", [course.name, courseId]);
    courseIds.set(normalizedText(course.name), courseId);
    if (sourceTableId) await upsertSourceLink(client, sourceTableId, course.sourceRecordId, "course", courseId, sha256(course));
  }

  const classIds = new Map();
  for (const item of plan.classes) {
    const link = existingLinks.get(`class:${item.sourceRecordId}`);
    let classId = link?.entityId ?? item.existingClassId;
    if (classId) {
      const check = await client.query("SELECT id FROM classes WHERE id=$1", [classId]);
      if (!check.rowCount) classId = null;
    }
    const courseId = courseIds.get(normalizedText(item.courseName));
    if (!courseId) throw new Error(`Missing course for Airtable event ${item.sourceRecordId}.`);
    if (!classId) {
      const inserted = await client.query(
        `INSERT INTO classes (course_id,code,location,start_date,end_date,capacity,teacher,status)
         VALUES ($1,$2,$3,$4,$5,20,'Não informado',$6) RETURNING id`,
        [courseId, item.code, item.location, item.startDate, item.endDate, classStatus(item.startDate, item.endDate)],
      );
      classId = inserted.rows[0].id;
    }
    await client.query(
      `UPDATE classes
       SET course_id=$2,code=$3,location=$4,start_date=$5,end_date=$6,status=$7,updated_at=now()
       WHERE id=$1`,
      [classId, courseId, item.code, item.location, item.startDate, item.endDate,
        classStatus(item.startDate, item.endDate)],
    );
    classIds.set(item.sourceRecordId, classId);
    const tableId = item.sourceTableId ?? AIRTABLE_TABLES.eventos2026.id;
    await upsertSourceLink(client, tableId, item.sourceRecordId, "class", classId, sha256(item));
    const slug = `airtable-${item.sourceRecordId}`;
    const courseLink = existingLinks.get(`curso_inscricao:${item.sourceRecordId}`);
    let registrationId = courseLink?.entityId;
    if (registrationId) {
      const found = await client.query("SELECT id FROM cursos_inscricao WHERE id=$1", [registrationId]);
      if (!found.rowCount) registrationId = null;
    }
    if (!registrationId) {
      const found = await client.query(
        "SELECT id FROM cursos_inscricao WHERE class_id=$1 OR slug=$2 ORDER BY (class_id=$1) DESC,id LIMIT 1",
        [classId, slug],
      );
      registrationId = found.rows[0]?.id;
    }
    if (!registrationId) {
      const inserted = await client.query(
        `INSERT INTO cursos_inscricao
          (slug,nome,descricao,local,data_inicio,data_fim,observacoes,ativo,nucleo,tipo_evento,course_id,class_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,'EDUCATION','CURSO',$8,$9) RETURNING id`,
        [slug, item.name, "Importado do Airtable.", item.location, item.startDate, item.endDate,
          `Airtable record ${item.sourceRecordId}`, courseId, classId],
      );
      registrationId = inserted.rows[0].id;
    }
    await client.query(
      `UPDATE cursos_inscricao
       SET nome=$2,local=$3,data_inicio=$4,data_fim=$5,course_id=$6,class_id=$7,updated_at=now()
       WHERE id=$1`,
      [registrationId, item.name, item.location, item.startDate, item.endDate, courseId, classId],
    );
    await upsertSourceLink(client, tableId, item.sourceRecordId, "curso_inscricao", registrationId, sha256(item));
  }

  for (const enrollment of plan.enrollments) {
    const classId = classIds.get(enrollment.event.sourceRecordId);
    const pessoaId = peopleBySource.get(enrollment.personRecordId) ?? plan.sourcePersonToEntity.get(enrollment.personRecordId);
    if (!classId || !pessoaId) throw new Error(`Unresolved enrollment ${enrollment.sourceRecordId}.`);
    const durable = existingLinks.get(`enrollment:${enrollment.sourceRecordId}`);
    let enrollmentId = durable?.entityId;
    const statuses = enrollmentStatusPlan(enrollment.contractStatus);
    if (!enrollmentId) {
      const found = await client.query("SELECT id FROM enrollments WHERE pessoa_id=$1 AND class_id=$2 LIMIT 1", [pessoaId, classId]);
      enrollmentId = found.rows[0]?.id;
    }
    if (!enrollmentId) {
      const inserted = await client.query(
        `INSERT INTO enrollments (pessoa_id,class_id,price,payment_status,contract_status)
         VALUES ($1,$2,0,$3,$4) RETURNING id`,
        [pessoaId, classId, statuses.insert.paymentStatus, statuses.insert.contractStatus],
      );
      enrollmentId = inserted.rows[0].id;
    }
    const statusUpdates = Object.entries(statuses.update).map(([column, value]) => [
      column === "contractStatus" ? "contract_status" : column,
      value,
    ]);
    if (statusUpdates.length) {
      await client.query(
        `UPDATE enrollments SET ${statusUpdates.map(([column], index) =>
          `${quoteIdentifier(column)}=$${index + 2}`).join(",")},updated_at=now() WHERE id=$1`,
        [enrollmentId, ...statusUpdates.map(([, value]) => value)],
      );
    }
    await upsertSourceLink(client, AIRTABLE_TABLES.inscricoes.id, enrollment.sourceRecordId, "enrollment", enrollmentId, sha256(enrollment));
  }
}

async function reconcile(client, plan) {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM (
          SELECT pessoa_id,class_id FROM enrollments GROUP BY pessoa_id,class_id HAVING count(*) > 1
        ) d) AS duplicate_enrollment_pairs,
       (SELECT count(*)::int FROM enrollments e
          LEFT JOIN pessoas p ON p.id=e.pessoa_id
          LEFT JOIN classes c ON c.id=e.class_id
         WHERE p.id IS NULL OR c.id IS NULL) AS orphan_enrollments,
       (SELECT count(*)::int FROM (
          SELECT class_id FROM cursos_inscricao WHERE class_id IS NOT NULL
          GROUP BY class_id HAVING count(*) > 1
        ) d) AS classes_with_multiple_registration_links,
       (SELECT count(*)::int FROM (
          SELECT entity_id FROM airtable_source_links
           WHERE base_id=$1 AND entity_type='pessoa'
           GROUP BY entity_id HAVING count(*) > 1
        ) d) AS multiply_linked_people,
       (SELECT count(*)::int FROM (
          SELECT entity_id FROM airtable_source_links
           WHERE base_id=$1 AND entity_type='class'
           GROUP BY entity_id HAVING count(*) > 1
        ) d) AS multiply_linked_classes,
       (SELECT count(*)::int FROM (
          SELECT entity_id FROM airtable_source_links
           WHERE base_id=$1 AND entity_type='course'
           GROUP BY entity_id HAVING count(*) > 1
        ) d) AS multiply_linked_courses,
       (SELECT count(*)::int FROM (
          SELECT entity_id FROM airtable_source_links
           WHERE base_id=$1 AND entity_type='enrollment'
           GROUP BY entity_id HAVING count(*) > 1
        ) d) AS multiply_linked_enrollments,
       (SELECT count(*)::int FROM airtable_source_links
         WHERE base_id=$1 AND entity_type='pessoa') AS linked_people,
       (SELECT count(*)::int FROM airtable_source_links
         WHERE base_id=$1 AND entity_type='class') AS linked_classes,
       (SELECT count(*)::int FROM airtable_source_links
         WHERE base_id=$1 AND entity_type='curso_inscricao') AS linked_registration_links,
       (SELECT count(*)::int FROM airtable_source_links
         WHERE base_id=$1 AND entity_type='enrollment') AS linked_enrollments`,
    [AIRTABLE_BASE_ID],
  );
  const checks = result.rows[0];
  const expected = {
    linkedPeople: plan.personPlans.filter((item) => item.action === "create" || item.action === "update").length,
    linkedClasses: plan.classes.length,
    linkedRegistrationLinks: plan.classes.length,
    linkedEnrollments: plan.enrollments.length,
  };
  const passed = checks.duplicate_enrollment_pairs === 0 &&
    checks.orphan_enrollments === 0 &&
    checks.classes_with_multiple_registration_links === 0 &&
    checks.multiply_linked_people === 0 &&
    checks.multiply_linked_classes === 0 &&
    checks.multiply_linked_courses === 0 &&
    checks.multiply_linked_enrollments === 0 &&
    checks.linked_people === expected.linkedPeople &&
    checks.linked_classes === expected.linkedClasses &&
    checks.linked_registration_links === expected.linkedRegistrationLinks &&
    checks.linked_enrollments === expected.linkedEnrollments;
  return { passed, checks, expected };
}

async function reportFile(report) {
  const directory = path.join(workspaceRoot, ".local/import-reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(directory, `airtable-soundos-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  return reportPath;
}

export async function main(argv = process.argv.slice(2)) {
  const execute = argv.includes("--execute");
  const confirm = argv.find((argument) => argument.startsWith("--confirm="))?.slice("--confirm=".length);
  const connectors = new ReplitConnectors();
  const source = await loadSource(connectors);
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  let report;
  try {
    let databasePlan = await buildDatabasePlan(client, source);
    let { existingPeople, existingLinks, plan, manifestHash, targetStateHash, writePlanHash } = databasePlan;
    const sourceHash = sourceDigest(source);
    let digest = confirmationDigest(sourceHash, targetStateHash, writePlanHash, plan.counts);
    report = {
      mode: execute ? "execute" : "dry-run",
      baseId: AIRTABLE_BASE_ID,
      tableCounts: Object.fromEntries(Object.entries(AIRTABLE_TABLES).map(([key, table]) => [key, table.count])),
      sourceSha256: sourceHash,
      existingPeopleManifestSha256: manifestHash,
      targetStateSha256: targetStateHash,
      writePlanSha256: writePlanHash,
      confirmationDigest: digest,
      counts: plan.counts,
      identityPolicy: "unique normalized email and/or unique phone; shared phones are never selected arbitrarily",
      datePolicy: "only complete YYYY-MM-DD values are imported; month/year values remain null",
    };
    if (!execute) {
      report.reportPath = await reportFile(report);
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    if (!confirm || confirm !== digest) {
      throw new Error(`Confirmation digest required. Review dry-run and rerun with --confirm=${digest}.`);
    }
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await lockSyncTargets(client);
      databasePlan = await buildDatabasePlan(client, source);
      ({ existingPeople, existingLinks, plan, manifestHash, targetStateHash, writePlanHash } = databasePlan);
      digest = confirmationDigest(sourceHash, targetStateHash, writePlanHash, plan.counts);
      if (confirm !== digest) {
        throw new Error("Database state changed after dry-run; generate and review a new dry-run.");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    report.existingPeopleManifestSha256 = manifestHash;
    report.targetStateSha256 = targetStateHash;
    report.writePlanSha256 = writePlanHash;
    report.confirmationDigest = digest;
    report.counts = plan.counts;
    report.reviewRequired = {
      personConflicts: plan.counts.personConflicts,
      skippedPeople: plan.counts.skippedPeople,
      unresolvedEnrollments: plan.counts.unresolvedEnrollments,
    };
    let syncRun;
    try {
      report.backupPath = await runBackup();
      syncRun = await pool.query(
        `INSERT INTO airtable_sync_runs
          (base_id,mode,source_sha256,confirmation_digest,status,counts,backup_path)
         VALUES ($1,'execute',$2,$3,'running',$4,$5) RETURNING id`,
        [AIRTABLE_BASE_ID, sourceHash, digest, JSON.stringify(plan.counts), report.backupPath],
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    try {
      await executePlan(client, source, plan, existingPeople, existingLinks);
      report.reconciliation = await reconcile(client, plan);
      if (!report.reconciliation.passed) throw new Error("Post-write reconciliation failed.");
      await client.query("COMMIT");
      await pool.query(
        "UPDATE airtable_sync_runs SET status='completed',finished_at=now() WHERE id=$1",
        [syncRun.rows[0].id],
      );
    } catch (error) {
      await client.query("ROLLBACK");
      await pool.query(
        "UPDATE airtable_sync_runs SET status='failed',finished_at=now(),error_message=$2 WHERE id=$1",
        [syncRun.rows[0].id, error instanceof Error ? error.message : String(error)],
      );
      throw error;
    }
    report.reconciled = report.reconciliation.passed;
    report.reportPath = await reportFile(report);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const report = { mode: process.argv.includes("--execute") ? "execute" : "dry-run", status: "failed", error: error.message };
    try { report.reportPath = await reportFile(report); } catch { /* preserve the original error */ }
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  });
}