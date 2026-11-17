/**
 * Carga de clientes novos do Airtable, comandada pela tela de administração.
 *
 * - A PRÉVIA lê o Airtable ao vivo (somente leitura) e as fichas do SoundOS numa transação somente
 *   leitura; não grava nada em pessoas. Guarda só totais e um resumo (hash) do que seria criado.
 * - A CARGA relê o Airtable, trava as tabelas, recalcula tudo dentro de uma única transação e só segue
 *   se o resumo for idêntico ao da prévia confirmada. Cria somente fichas novas (mais as evidências de
 *   origem e o vínculo com o registro do Airtable) e as matrículas desses clientes novos em turmas que já
 *   existem (com o vínculo da inscrição). Nada é atualizado nem apagado: nenhuma ficha, matrícula, turma
 *   ou curso existente muda, e turma/curso nunca são criados. Uma conferência final desfaz tudo se algo
 *   não bater.
 * - O estado das execuções fica em `airtable_sync_runs`, para que qualquer instância do servidor e
 *   qualquer recarga da tela vejam o mesmo andamento. O banco impede duas execuções ao mesmo tempo.
 *
 * Nenhum nome, e-mail ou telefone vai para log, histórico ou resposta da API: só totais.
 */
import { randomInt } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  AIRTABLE_BASE_ID,
  CLIENTES_TABLE,
  ORIGEM_AIRTABLE,
  PESSOA_COLUMNS,
  PREVIEW_VALID_MINUTES,
  REFERENCE_RECORD_COUNT,
  MIN_READ_FRACTION,
  buildExistingIndex,
  creationDigest,
  emailKey,
  evidenceField,
  minimumExpectedRecords,
  planClientes,
  sha256,
  sourceDigest,
  valuesToWrite,
  type AirtableRecordLike,
  type ClientesPlan,
  type ExistingPessoa,
  type PlanTotals,
} from "./airtableNovosClientesRules";
import {
  EVENTOS_TABLES,
  INSCRICOES_TABLE,
  REFERENCE_EVENTOS_COUNT,
  REFERENCE_INSCRICOES_COUNT,
  buildClassIndex,
  enrollmentSourceSha,
  planEnrollments,
  type ClassLink,
  type ClassRow,
  type EnrollmentPlan,
  type EnrollmentTotals,
} from "./airtableNovosClientesMatriculasRules";

// `pool.connect` tem sobrecargas (com e sem callback); a função auxiliar fixa a que devolve Promise<PoolClient>.
const acquireClient = () => pool.connect();
type Client = Awaited<ReturnType<typeof acquireClient>>;

const SCOPE = "novos_clientes";
const HEARTBEAT_MS = 15_000;
/** Uma execução "em andamento" sem sinal de vida há este tempo é considerada interrompida. */
const ORPHAN_AFTER_SECONDS = 90;
const INSERT_CHUNK = 200;
const LIST_LIMIT = 20;

// ── Erros ────────────────────────────────────────────────────────────────────

export type LoadErrorCode =
  | "EXECUCAO_EM_ANDAMENTO"
  | "PREVIA_NAO_ENCONTRADA"
  | "PREVIA_INDISPONIVEL"
  | "PREVIA_EXPIRADA"
  | "PREVIA_JA_USADA"
  | "PREVIA_DESATUALIZADA"
  | "NADA_PARA_CRIAR"
  | "RESTAURACAO_NAO_CONFIRMADA"
  | "AIRTABLE_TABELA_DIFERENTE"
  | "AIRTABLE_LEITURA_VAZIA"
  | "AIRTABLE_LEITURA_INCOMPLETA"
  | "AIRTABLE_INSCRICOES_INCOMPLETA"
  | "AIRTABLE_INDISPONIVEL"
  | "BANCO_OCUPADO"
  | "RECONCILIACAO_FALHOU"
  | "INTERROMPIDA"
  | "ERRO_INTERNO";

export class AirtableLoadError extends Error {
  constructor(
    public readonly code: LoadErrorCode,
    message: string,
    public readonly httpStatus = 409,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AirtableLoadError";
  }
}

function pgCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record["code"] === "string") return record["code"];
    current = record["cause"];
  }
  return null;
}

function pgConstraint(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record["constraint"] === "string") return record["constraint"];
    current = record["cause"];
  }
  return "";
}

/** Só o que não identifica ninguém: o texto de erros do Postgres pode citar valores (e-mail, telefone). */
function safeErrorInfo(err: unknown): Record<string, unknown> {
  return {
    name: err instanceof Error ? err.name : typeof err,
    pgCode: pgCode(err),
    constraint: pgConstraint(err) || undefined,
    ...(err instanceof AirtableLoadError ? { code: err.code } : {}),
  };
}

// ── Fonte do Airtable ────────────────────────────────────────────────────────

/** Inscrições e eventos (as duas tabelas de eventos juntas) lidos do Airtable, somente leitura. */
export interface EnrollmentSource {
  inscricoes: AirtableRecordLike[];
  eventos: AirtableRecordLike[];
}

export interface ClientesSource {
  /** Lê a tabela CLIENTES inteira (somente leitura). */
  read(): Promise<AirtableRecordLike[]>;
  /** Lê CONTROLE DE INSCRIÇÕES e as tabelas de eventos inteiras (somente leitura). */
  readEnrollments(): Promise<EnrollmentSource>;
}

interface ConnectorsLike {
  proxy(connector: string, path: string): Promise<Response>;
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, 30_000)
    : Math.min(500 * 2 ** attempt, 30_000);
}

async function airtableRequest(connectors: ConnectorsLike, pathName: string): Promise<unknown> {
  const attempts = 7;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await connectors.proxy("airtable", pathName);
    } catch {
      response = null;
    }
    if (response === null || response.status === 429 || response.status >= 500) {
      if (attempt === attempts - 1) {
        throw new AirtableLoadError("AIRTABLE_INDISPONIVEL", "O Airtable não respondeu a tempo.", 502);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
      continue;
    }
    if (!response.ok) {
      throw new AirtableLoadError("AIRTABLE_INDISPONIVEL", `O Airtable recusou a leitura (HTTP ${response.status}).`, 502);
    }
    return response.json();
  }
  throw new AirtableLoadError("AIRTABLE_INDISPONIVEL", "O Airtable não respondeu a tempo.", 502);
}

interface ExpectedTable { id: string; name: string }

/** Confere o identificador e o nome de cada tabela antes de ler qualquer registro dela. */
async function assertTables(connectors: ConnectorsLike, expected: readonly ExpectedTable[]): Promise<void> {
  const meta = await airtableRequest(connectors, `/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`) as { tables?: Array<{ id?: string; name?: string }> };
  const tables = Array.isArray(meta.tables) ? meta.tables : [];
  for (const wanted of expected) {
    const table = tables.find((candidate) => candidate.id === wanted.id);
    if (!table || table.name !== wanted.name) {
      throw new AirtableLoadError(
        "AIRTABLE_TABELA_DIFERENTE",
        "Uma das tabelas do Airtable não é a esperada (identificador ou nome diferente).",
        502,
      );
    }
  }
}

async function readTable(connectors: ConnectorsLike, tableId: string): Promise<AirtableRecordLike[]> {
  const records: AirtableRecordLike[] = [];
  let offset: string | null = null;
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (offset) query.set("offset", offset);
    const data = await airtableRequest(connectors, `/v0/${AIRTABLE_BASE_ID}/${tableId}?${query}`) as {
      records?: AirtableRecordLike[]; offset?: string;
    };
    if (!Array.isArray(data.records)) {
      throw new AirtableLoadError("AIRTABLE_INDISPONIVEL", "O Airtable devolveu uma resposta sem registros.", 502);
    }
    records.push(...data.records);
    offset = data.offset ?? null;
  } while (offset);
  return records;
}

async function createConnectors(): Promise<ConnectorsLike> {
  const { ReplitConnectors } = await import("@replit/connectors-sdk");
  return new ReplitConnectors() as unknown as ConnectorsLike;
}

/** Leitura real, pelo conector do Airtable do Replit. Confere o identificador das tabelas antes de ler. */
export function createAirtableClientesSource(): ClientesSource {
  return {
    async read() {
      const connectors = await createConnectors();
      await assertTables(connectors, [CLIENTES_TABLE]);
      return readTable(connectors, CLIENTES_TABLE.id);
    },
    async readEnrollments() {
      const connectors = await createConnectors();
      await assertTables(connectors, [INSCRICOES_TABLE, ...EVENTOS_TABLES]);
      const inscricoes = await readTable(connectors, INSCRICOES_TABLE.id);
      const eventos: AirtableRecordLike[] = [];
      for (const table of EVENTOS_TABLES) eventos.push(...await readTable(connectors, table.id));
      return { inscricoes, eventos };
    },
  };
}

// ── Estado das execuções ─────────────────────────────────────────────────────

export type RunKind = "preview" | "load";
export type RunStatus = "running" | "completed" | "failed";

export interface ReconciliationCheck { name: string; ok: boolean }

/** Totais de uma execução. `enrollments` falta em prévias antigas, de antes da carga das matrículas. */
export interface RunTotals extends PlanTotals {
  enrollments: EnrollmentTotals | null;
}

/** Totais calculados agora: sempre com as matrículas. */
export interface CargaTotals extends PlanTotals {
  enrollments: EnrollmentTotals;
}

export interface RunView {
  id: number;
  kind: RunKind;
  status: RunStatus;
  step: string | null;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: { id: number; name: string | null } | null;
  /** Prévia em que a carga se baseou. */
  previewRunId: number | null;
  errorCode: string | null;
  /** Registros lidos do Airtable (também preenchido quando a leitura foi barrada). */
  sourceRecordsRead: number | null;
  totals: RunTotals | null;
  minimumExpected: number | null;
  created: number | null;
  /** Matrículas criadas pela carga (dos clientes novos, em turmas que já existiam). */
  enrollmentsCreated: number | null;
  reconciliation: { passed: boolean; checks: ReconciliationCheck[] } | null;
  /** Prévia pronta para uma carga: concluída, com gente para criar, dentro da validade e ainda não usada. */
  usableForLoad: boolean;
  /** Até quando a prévia vale. */
  validUntil: string | null;
}

interface RunRow {
  id: string | number;
  mode: "dry-run" | "execute";
  status: RunStatus;
  step: string | null;
  started_at: Date;
  finished_at: Date | null;
  counts: Record<string, unknown> | null;
  error_code: string | null;
  preview_run_id: string | number | null;
  requested_by: number | null;
  requested_by_name: string | null;
  consumed: boolean;
  confirmation_digest: string | null;
}

const RUN_SELECT = `
  SELECT r.id, r.mode, r.status, r.step, r.started_at, r.finished_at, r.counts, r.error_code, r.preview_run_id,
         r.requested_by, u.name AS requested_by_name, r.confirmation_digest,
         EXISTS (
           SELECT 1 FROM airtable_sync_runs l
            WHERE l.scope = '${SCOPE}' AND l.mode = 'execute' AND l.preview_run_id = r.id AND l.status IN ('running', 'completed')
         ) AS consumed
    FROM airtable_sync_runs r
    LEFT JOIN soundos_users u ON u.id = r.requested_by
   WHERE r.scope = '${SCOPE}'`;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRunView(row: RunRow, now = new Date()): RunView {
  const counts = row.counts ?? {};
  const stored = numberOrNull(counts["toCreate"]) !== null ? (counts as unknown as PlanTotals & { enrollments?: EnrollmentTotals }) : null;
  const totals: RunTotals | null = stored ? {
    sourceRecords: stored.sourceRecords,
    toCreate: stored.toCreate,
    alreadyExist: stored.alreadyExist,
    alreadyExistBy: stored.alreadyExistBy,
    review: stored.review,
    enrollments: stored.enrollments ?? null,
  } : null;
  const reconciliation = counts["reconciliation"] as RunView["reconciliation"] | undefined;
  const kind: RunKind = row.mode === "execute" ? "load" : "preview";
  const validUntil = kind === "preview" && row.status === "completed" && row.finished_at
    ? new Date(row.finished_at.getTime() + PREVIEW_VALID_MINUTES * 60_000)
    : null;
  const usableForLoad = Boolean(
    validUntil && validUntil > now && !row.consumed && row.confirmation_digest
      // Prévia de antes das matrículas tem outro resumo de confirmação: não serve para uma carga.
      && totals !== null && totals.enrollments !== null && totals.toCreate > 0,
  );
  return {
    id: Number(row.id),
    kind,
    status: row.status,
    step: row.step,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    requestedBy: row.requested_by == null ? null : { id: row.requested_by, name: row.requested_by_name },
    previewRunId: row.preview_run_id == null ? null : Number(row.preview_run_id),
    errorCode: row.error_code,
    sourceRecordsRead: numberOrNull(counts["sourceRecords"]),
    totals,
    minimumExpected: numberOrNull(counts["minimumExpected"]),
    created: numberOrNull(counts["created"]),
    enrollmentsCreated: numberOrNull(counts["enrollmentsCreated"]),
    reconciliation: reconciliation ?? null,
    usableForLoad,
    validUntil: validUntil ? validUntil.toISOString() : null,
  };
}

/** Encerra como falha as execuções "em andamento" que perderam o servidor (reinício, queda). */
export async function reapOrphanRuns(): Promise<number> {
  const result = await pool.query(
    `UPDATE airtable_sync_runs
        SET status = 'failed', finished_at = now(), error_code = 'INTERROMPIDA',
            error_message = 'Execução interrompida: o servidor parou ou reiniciou durante o andamento. Nada ficou gravado pela metade.'
      WHERE scope = $1 AND status = 'running'
        AND coalesce(heartbeat_at, started_at) < now() - make_interval(secs => $2)`,
    [SCOPE, ORPHAN_AFTER_SECONDS],
  );
  const reaped = result.rowCount ?? 0;
  if (reaped > 0) logger.warn({ reaped }, "Carga do Airtable: execuções órfãs encerradas como falha");
  return reaped;
}

export async function listRuns(): Promise<RunView[]> {
  await reapOrphanRuns();
  const result = await pool.query<RunRow>(`${RUN_SELECT} ORDER BY r.id DESC LIMIT ${LIST_LIMIT}`);
  const now = new Date();
  return result.rows.map((row) => toRunView(row, now));
}

export async function getRun(id: number): Promise<RunView | null> {
  const result = await pool.query<RunRow>(`${RUN_SELECT} AND r.id = $1`, [id]);
  return result.rows[0] ? toRunView(result.rows[0]) : null;
}

async function setStep(runId: number, step: string): Promise<void> {
  await pool.query(
    "UPDATE airtable_sync_runs SET step = $2, heartbeat_at = now() WHERE id = $1 AND status = 'running'",
    [runId, step],
  );
}

async function finishRun(
  runId: number,
  outcome: {
    status: "completed" | "failed";
    counts: Record<string, unknown>;
    sourceSha?: string;
    digest?: string | null;
    errorCode?: LoadErrorCode;
    errorMessage?: string;
  },
): Promise<void> {
  await pool.query(
    `UPDATE airtable_sync_runs
        SET status = $2, finished_at = now(), step = NULL, counts = $3::jsonb,
            source_sha256 = coalesce($4, source_sha256), confirmation_digest = coalesce($5, confirmation_digest),
            error_code = $6, error_message = $7
      WHERE id = $1`,
    [
      runId, outcome.status, JSON.stringify(outcome.counts), outcome.sourceSha ?? null, outcome.digest ?? null,
      outcome.errorCode ?? null, outcome.errorMessage ?? null,
    ],
  );
}

// ── Leitura do SoundOS ───────────────────────────────────────────────────────

interface TargetState {
  existing: ExistingPessoa[];
  codigos: Set<string>;
  linkedRecordIds: Set<string>;
  classes: ClassRow[];
  classLinks: ClassLink[];
  /** Inscrições do Airtable que já têm vínculo durável com uma matrícula. */
  linkedInscricaoIds: Set<string>;
}

async function readTargetState(client: Client): Promise<TargetState> {
  const people = await client.query<{ id: number; email: string | null; celular_normalizado: string | null; codigo: string }>(
    "SELECT id, email, celular_normalizado, codigo FROM pessoas",
  );
  const links = await client.query<{ source_record_id: string }>(
    "SELECT source_record_id FROM airtable_source_links WHERE base_id = $1 AND source_table_id = $2 AND entity_type = 'pessoa'",
    [AIRTABLE_BASE_ID, CLIENTES_TABLE.id],
  );
  const classes = await client.query<{
    id: number; code: string; location: string | null; start_date: string | null; end_date: string | null;
    course_name: string; name: string | null;
  }>(
    `SELECT c.id, c.code, c.location, to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(c.end_date, 'YYYY-MM-DD') AS end_date, co.name AS course_name, ci.nome AS name
       FROM classes c
       JOIN courses co ON co.id = c.course_id
       LEFT JOIN cursos_inscricao ci ON ci.class_id = c.id`,
  );
  const classLinks = await client.query<{ source_record_id: string; entity_id: string }>(
    "SELECT source_record_id, entity_id FROM airtable_source_links WHERE base_id = $1 AND entity_type = 'class'",
    [AIRTABLE_BASE_ID],
  );
  const inscricaoLinks = await client.query<{ source_record_id: string }>(
    "SELECT source_record_id FROM airtable_source_links WHERE base_id = $1 AND source_table_id = $2 AND entity_type = 'enrollment'",
    [AIRTABLE_BASE_ID, INSCRICOES_TABLE.id],
  );
  return {
    existing: people.rows.map((row) => ({ id: row.id, email: row.email, celularNormalizado: row.celular_normalizado })),
    codigos: new Set(people.rows.map((row) => row.codigo)),
    linkedRecordIds: new Set(links.rows.map((row) => row.source_record_id)),
    classes: classes.rows.map((row) => ({
      id: row.id, code: row.code, location: row.location, startDate: row.start_date, endDate: row.end_date,
      courseName: row.course_name, name: row.name,
    })),
    classLinks: classLinks.rows.map((row) => ({ eventRecordId: row.source_record_id, classId: Number(row.entity_id) })),
    linkedInscricaoIds: new Set(inscricaoLinks.rows.map((row) => row.source_record_id)),
  };
}

interface CargaPlan extends ClientesPlan {
  totals: CargaTotals;
  enrollments: EnrollmentPlan;
}

function planFor(records: AirtableRecordLike[], enrollmentSource: EnrollmentSource, state: TargetState): CargaPlan {
  const clientes = planClientes(records, buildExistingIndex(state.existing), state.linkedRecordIds);
  const enrollments = planEnrollments({
    inscricoes: enrollmentSource.inscricoes,
    eventos: enrollmentSource.eventos,
    newPersonRecordIds: new Set(clientes.creates.map((candidate) => candidate.sourceRecordId)),
    classes: buildClassIndex(state.classes, state.classLinks),
    alreadyLinkedInscricaoIds: state.linkedInscricaoIds,
  });
  return { ...clientes, enrollments, totals: { ...clientes.totals, enrollments: enrollments.totals } };
}

async function lastGoodReadCount(): Promise<number | null> {
  const result = await pool.query<{ total: string | null }>(
    `SELECT counts->>'sourceRecords' AS total FROM airtable_sync_runs
      WHERE scope = $1 AND status = 'completed' ORDER BY id DESC LIMIT 1`,
    [SCOPE],
  );
  const value = Number(result.rows[0]?.total);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Bloqueia só leitura vazia ou muito menor que o esperado; nenhuma contagem fixa de registros. */
function assertPlausibleRead(records: AirtableRecordLike[], minimumExpected: number): void {
  if (records.length === 0) {
    throw new AirtableLoadError("AIRTABLE_LEITURA_VAZIA", "O Airtable devolveu a tabela de clientes vazia.", 409, {
      sourceRecords: 0, minimumExpected,
    });
  }
  if (records.length < minimumExpected) {
    throw new AirtableLoadError(
      "AIRTABLE_LEITURA_INCOMPLETA",
      "A leitura do Airtable veio menor do que o esperado para uma leitura completa.",
      409,
      { sourceRecords: records.length, minimumExpected },
    );
  }
}

/** Últimas leituras boas de inscrições e eventos (a mesma ideia do piso de clientes, uma por tabela). */
async function lastGoodEnrollmentReads(): Promise<{ inscricoes: number | null; eventos: number | null }> {
  const result = await pool.query<{ inscricoes: string | null; eventos: string | null }>(
    `SELECT counts->'enrollments'->>'sourceRecords' AS inscricoes, counts->'enrollments'->>'eventRecords' AS eventos
       FROM airtable_sync_runs
      WHERE scope = $1 AND status = 'completed' AND counts->'enrollments' IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [SCOPE],
  );
  const positive = (value: string | null | undefined) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return { inscricoes: positive(result.rows[0]?.inscricoes), eventos: positive(result.rows[0]?.eventos) };
}

/**
 * Uma leitura de inscrições ou eventos vazia ou muito menor que a anterior seria tratada como "esses clientes
 * não têm matrícula" e as inscrições perdidas não voltariam em cargas futuras (os clientes já existiriam).
 */
async function readEnrollmentSource(source: ClientesSource): Promise<EnrollmentSource> {
  const last = await lastGoodEnrollmentReads();
  const minimumInscricoes = minimumExpectedFrom(last.inscricoes, REFERENCE_INSCRICOES_COUNT);
  const minimumEventos = minimumExpectedFrom(last.eventos, REFERENCE_EVENTOS_COUNT);
  const data = await source.readEnrollments();
  if (data.inscricoes.length < minimumInscricoes || data.eventos.length < minimumEventos) {
    throw new AirtableLoadError(
      "AIRTABLE_INSCRICOES_INCOMPLETA",
      "A leitura das inscrições ou dos eventos do Airtable veio vazia ou menor do que o esperado.",
      409,
      { enrollmentRead: { inscricoes: data.inscricoes.length, eventos: data.eventos.length, minimumInscricoes, minimumEventos } },
    );
  }
  return data;
}

function minimumExpectedFrom(lastGood: number | null, reference: number): number {
  return Math.max(1, Math.floor((lastGood ?? reference) * MIN_READ_FRACTION));
}

// ── Prévia ───────────────────────────────────────────────────────────────────

async function runPreview(runId: number, source: ClientesSource): Promise<void> {
  const minimumExpected = minimumExpectedRecords(await lastGoodReadCount());
  await setStep(runId, "reading_airtable");
  const records = await source.read();
  assertPlausibleRead(records, minimumExpected);
  const enrollmentSource = await readEnrollmentSource(source);

  await setStep(runId, "comparing");
  const client = await pool.connect();
  let plan: CargaPlan;
  try {
    // A prévia não grava nada em pessoas nem em matrículas: a transação é somente leitura, garantido pelo banco.
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      plan = planFor(records, enrollmentSource, await readTargetState(client));
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }

  await finishRun(runId, {
    status: "completed",
    counts: { ...plan.totals, minimumExpected },
    sourceSha: sourceDigest(records),
    digest: creationDigest(plan.creates, plan.enrollments.enrollments),
  });
  logger.info({ runId, ...flatTotals(plan.totals) }, "Carga do Airtable: prévia concluída");
}

function flatTotals(totals: CargaTotals): Record<string, number> {
  return {
    sourceRecords: totals.sourceRecords,
    toCreate: totals.toCreate,
    alreadyExist: totals.alreadyExist,
    review: totals.review.total,
    enrollmentsToCreate: totals.enrollments.toCreate,
    enrollmentsReview: totals.enrollments.review.total,
  };
}

// ── Carga ────────────────────────────────────────────────────────────────────

interface Snapshot {
  pessoas: number;
  courses: number;
  classes: number;
  cursosInscricao: number;
  enrollments: number;
  evidencias: number;
  links: number;
}

async function snapshot(client: Client): Promise<Snapshot> {
  const result = await client.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM pessoas) AS pessoas,
            (SELECT count(*) FROM courses) AS courses,
            (SELECT count(*) FROM classes) AS classes,
            (SELECT count(*) FROM cursos_inscricao) AS cursos_inscricao,
            (SELECT count(*) FROM enrollments) AS enrollments,
            (SELECT count(*) FROM pessoa_evidencias) AS evidencias,
            (SELECT count(*) FROM airtable_source_links) AS links`,
  );
  const row = result.rows[0]!;
  return {
    pessoas: Number(row["pessoas"]), courses: Number(row["courses"]), classes: Number(row["classes"]),
    cursosInscricao: Number(row["cursos_inscricao"]), enrollments: Number(row["enrollments"]),
    evidencias: Number(row["evidencias"]), links: Number(row["links"]),
  };
}

/** Resumo do conteúdo de todas as fichas fora das recém-criadas; igual antes e depois = ninguém foi tocado. */
async function existingPeopleHash(client: Client, excludeIds: number[]): Promise<string> {
  const result = await client.query<{ hash: string | null }>(
    "SELECT md5(string_agg(md5(p::text), '' ORDER BY p.id)) AS hash FROM pessoas p WHERE p.id <> ALL($1::int[])",
    [excludeIds],
  );
  return result.rows[0]?.hash ?? "";
}

/** Resumo de todas as matrículas fora das recém-criadas; igual antes e depois = nenhuma matrícula existente mudou. */
async function existingEnrollmentsHash(client: Client, excludeIds: number[]): Promise<string> {
  const result = await client.query<{ hash: string | null }>(
    "SELECT md5(string_agg(md5(e::text), '' ORDER BY e.id)) AS hash FROM enrollments e WHERE e.id <> ALL($1::int[])",
    [excludeIds],
  );
  return result.rows[0]?.hash ?? "";
}

function newCodigo(taken: Set<string>): string {
  for (;;) {
    const codigo = `PS-${randomInt(100000, 1000000)}`;
    if (!taken.has(codigo)) {
      taken.add(codigo);
      return codigo;
    }
  }
}

interface InsertedPerson {
  pessoaId: number;
  sourceRecordId: string;
  expectedPhoneKey: string | null;
  expectedEmail: string | null;
  evidences: Array<{ campo: string; valor: string }>;
  sourceFieldsSha: string;
}

async function insertPeople(client: Client, plan: ClientesPlan, taken: Set<string>): Promise<InsertedPerson[]> {
  const inserted: InsertedPerson[] = [];
  const columns = ["codigo", ...PESSOA_COLUMNS, "ativo"];
  const quoted = columns.map((column) => `"${column}"`).join(", ");

  for (let start = 0; start < plan.creates.length; start += INSERT_CHUNK) {
    const chunk = plan.creates.slice(start, start + INSERT_CHUNK);
    const params: unknown[] = [];
    const rows: string[] = [];
    const codigos: string[] = [];
    for (const candidate of chunk) {
      const codigo = newCodigo(taken);
      codigos.push(codigo);
      const rowValues: unknown[] = [codigo, ...PESSOA_COLUMNS.map((column) => candidate.values[column] ?? null), candidate.ativo];
      rows.push(`(${rowValues.map((value) => { params.push(value); return `$${params.length}`; }).join(", ")})`);
    }
    const result = await client.query<{ id: number; codigo: string }>(
      `INSERT INTO pessoas (${quoted}) VALUES ${rows.join(", ")} RETURNING id, codigo`,
      params,
    );
    const idByCodigo = new Map(result.rows.map((row) => [row.codigo, row.id]));
    chunk.forEach((candidate, index) => {
      const pessoaId = idByCodigo.get(codigos[index]!);
      if (pessoaId === undefined) throw new AirtableLoadError("RECONCILIACAO_FALHOU", "Ficha criada não encontrada.", 500);
      inserted.push({
        pessoaId,
        sourceRecordId: candidate.sourceRecordId,
        expectedPhoneKey: candidate.phoneKey,
        expectedEmail: candidate.email,
        evidences: PESSOA_COLUMNS
          .filter((column) => candidate.values[column] !== undefined)
          .map((column) => ({ campo: evidenceField(column), valor: candidate.values[column]! })),
        sourceFieldsSha: sha256(valuesToWrite(candidate)),
      });
    });
  }
  return inserted;
}

async function insertEvidencesAndLinks(client: Client, inserted: InsertedPerson[]): Promise<number> {
  const flat = inserted.flatMap((person) => person.evidences.map((evidence) => ({ pessoaId: person.pessoaId, ...evidence })));
  for (let start = 0; start < flat.length; start += 2000) {
    const part = flat.slice(start, start + 2000);
    await client.query(
      `INSERT INTO pessoa_evidencias (pessoa_id, campo, valor, tipo_evidencia, origem, nivel_confianca, aplicada)
       SELECT x.pessoa_id, x.campo, x.valor, 'inferida', $4, 'baixa', 'sim'
         FROM unnest($1::int[], $2::text[], $3::text[]) AS x(pessoa_id, campo, valor)`,
      [part.map((item) => item.pessoaId), part.map((item) => item.campo), part.map((item) => item.valor), ORIGEM_AIRTABLE],
    );
  }
  for (let start = 0; start < inserted.length; start += 2000) {
    const part = inserted.slice(start, start + 2000);
    await client.query(
      `INSERT INTO airtable_source_links (base_id, source_table_id, source_record_id, entity_type, entity_id, source_fields_sha256)
       SELECT $1, $2, x.record_id, 'pessoa', x.pessoa_id, x.sha
         FROM unnest($3::text[], $4::bigint[], $5::text[]) AS x(record_id, pessoa_id, sha)`,
      [
        AIRTABLE_BASE_ID, CLIENTES_TABLE.id,
        part.map((item) => item.sourceRecordId), part.map((item) => item.pessoaId), part.map((item) => item.sourceFieldsSha),
      ],
    );
  }
  return flat.length;
}

interface InsertedEnrollments {
  ids: number[];
}

/**
 * Cria as matrículas dos clientes novos em turmas que já existem. Valores neutros: preço 0 e pagamento
 * pendente (a carga não sabe o que o aluno pagou); o contrato só vira "Assinado" quando o Airtable marca.
 * Cada matrícula ganha o vínculo com a inscrição de origem, para uma carga futura nunca repeti-la.
 */
async function insertEnrollments(client: Client, plan: EnrollmentPlan, inserted: InsertedPerson[]): Promise<InsertedEnrollments> {
  const pessoaByRecord = new Map(inserted.map((person) => [person.sourceRecordId, person.pessoaId]));
  const rows = plan.enrollments.map((item) => {
    const pessoaId = pessoaByRecord.get(item.personRecordId);
    if (pessoaId === undefined) {
      throw new AirtableLoadError("RECONCILIACAO_FALHOU", "Matrícula sem a ficha criada correspondente.", 500);
    }
    return { item, pessoaId };
  });

  const ids: number[] = [];
  for (let start = 0; start < rows.length; start += 1000) {
    const part = rows.slice(start, start + 1000);
    const result = await client.query<{ id: number; pessoa_id: number; class_id: number }>(
      `INSERT INTO enrollments (pessoa_id, class_id, price, payment_status, contract_status)
       SELECT x.pessoa_id, x.class_id, 0, 'pending', x.contract_status
         FROM unnest($1::int[], $2::int[], $3::text[]) AS x(pessoa_id, class_id, contract_status)
       RETURNING id, pessoa_id, class_id`,
      [part.map((row) => row.pessoaId), part.map((row) => row.item.classId), part.map((row) => row.item.contractStatus)],
    );
    const idByPair = new Map(result.rows.map((row) => [`${row.pessoa_id}:${row.class_id}`, row.id]));
    const linkIds: number[] = [];
    for (const row of part) {
      const id = idByPair.get(`${row.pessoaId}:${row.item.classId}`);
      if (id === undefined) throw new AirtableLoadError("RECONCILIACAO_FALHOU", "Matrícula criada não encontrada.", 500);
      linkIds.push(id);
    }
    ids.push(...linkIds);
    await client.query(
      `INSERT INTO airtable_source_links (base_id, source_table_id, source_record_id, entity_type, entity_id, source_fields_sha256)
       SELECT $1, $2, x.record_id, 'enrollment', x.enrollment_id, x.sha
         FROM unnest($3::text[], $4::bigint[], $5::text[]) AS x(record_id, enrollment_id, sha)`,
      [
        AIRTABLE_BASE_ID, INSCRICOES_TABLE.id,
        part.map((row) => row.item.sourceRecordId), linkIds, part.map((row) => enrollmentSourceSha(row.item)),
      ],
    );
  }
  return { ids };
}

interface ReconcileInput {
  before: Snapshot;
  peopleHashBefore: string;
  enrollmentsHashBefore: string;
  people: InsertedPerson[];
  evidenceRows: number;
  expectedPeople: number;
  enrollments: InsertedEnrollments;
  expectedEnrollments: number;
}

async function reconcile(client: Client, input: ReconcileInput): Promise<ReconciliationCheck[]> {
  const { before, people: inserted, evidenceRows, enrollments } = input;
  const ids = inserted.map((person) => person.pessoaId);
  const after = await snapshot(client);
  const hashAfter = await existingPeopleHash(client, ids);
  const enrollmentsHashAfter = await existingEnrollmentsHash(client, enrollments.ids);

  const people = await client.query<{ id: number; email: string | null; celular_normalizado: string | null }>(
    "SELECT id, email, celular_normalizado FROM pessoas",
  );
  const index = buildExistingIndex(people.rows.map((row) => ({
    id: row.id, email: row.email, celularNormalizado: row.celular_normalizado,
  })));
  const storedById = new Map(people.rows.map((row) => [row.id, row]));
  let identityProblems = 0;
  for (const person of inserted) {
    const stored = storedById.get(person.pessoaId);
    const email = emailKey(stored?.email);
    const phone = stored?.celular_normalizado && stored.celular_normalizado !== "" ? stored.celular_normalizado : null;
    if (email !== person.expectedEmail) identityProblems += 1;
    // O telefone gravado pelo banco tem de ser exatamente a chave usada na comparação.
    else if (phone !== person.expectedPhoneKey) identityProblems += 1;
    else if (email && (index.byEmail.get(email)?.length ?? 0) !== 1) identityProblems += 1;
    else if (phone && (index.byPhone.get(phone)?.length ?? 0) !== 1) identityProblems += 1;
  }

  const origin = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM airtable_source_links
      WHERE base_id = $1 AND source_table_id = $2 AND entity_type = 'pessoa' AND entity_id = ANY($3::bigint[])`,
    [AIRTABLE_BASE_ID, CLIENTES_TABLE.id, ids],
  );
  const enrollmentLinks = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM airtable_source_links
      WHERE base_id = $1 AND source_table_id = $2 AND entity_type = 'enrollment' AND entity_id = ANY($3::bigint[])`,
    [AIRTABLE_BASE_ID, INSCRICOES_TABLE.id, enrollments.ids],
  );
  // Cada matrícula nova tem de ser a única da pessoa naquela turma (nunca duplicar o que já existia).
  const duplicates = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM enrollments e
      WHERE e.id = ANY($1::int[])
        AND EXISTS (SELECT 1 FROM enrollments o WHERE o.pessoa_id = e.pessoa_id AND o.class_id = e.class_id AND o.id <> e.id)`,
    [enrollments.ids],
  );
  const newLinks = inserted.length + enrollments.ids.length;

  return [
    { name: "created_equals_preview", ok: inserted.length === input.expectedPeople },
    { name: "people_count", ok: after.pessoas === before.pessoas + inserted.length },
    { name: "origin_links", ok: Number(origin.rows[0]?.n) === inserted.length && after.links === before.links + newLinks },
    { name: "origin_evidences", ok: after.evidencias === before.evidencias + evidenceRows },
    { name: "no_duplicate_identity", ok: identityProblems === 0 },
    { name: "existing_people_untouched", ok: hashAfter === input.peopleHashBefore },
    { name: "enrollments_equal_preview", ok: enrollments.ids.length === input.expectedEnrollments },
    { name: "enrollments_count", ok: after.enrollments === before.enrollments + enrollments.ids.length },
    { name: "enrollment_links", ok: Number(enrollmentLinks.rows[0]?.n) === enrollments.ids.length },
    { name: "no_duplicate_enrollments", ok: Number(duplicates.rows[0]?.n) === 0 },
    { name: "existing_enrollments_untouched", ok: enrollmentsHashAfter === input.enrollmentsHashBefore },
    {
      // Turmas e cursos nunca são criados nem alterados em contagem.
      name: "other_tables_unchanged",
      ok: after.courses === before.courses && after.classes === before.classes && after.cursosInscricao === before.cursosInscricao,
    },
  ];
}

async function runLoad(runId: number, previewRunId: number, source: ClientesSource): Promise<void> {
  const preview = await pool.query<{
    confirmation_digest: string | null;
    counts: { toCreate?: unknown; enrollments?: { toCreate?: unknown } | null } | null;
  }>(
    "SELECT confirmation_digest, counts FROM airtable_sync_runs WHERE id = $1 AND scope = $2",
    [previewRunId, SCOPE],
  );
  const previewDigest = preview.rows[0]?.confirmation_digest;
  const previewToCreate = preview.rows[0]?.counts?.toCreate;
  const previewEnrollments = preview.rows[0]?.counts?.enrollments?.toCreate;
  if (!previewDigest || typeof previewToCreate !== "number" || typeof previewEnrollments !== "number") {
    throw new AirtableLoadError("PREVIA_INDISPONIVEL", "A prévia escolhida não está disponível.");
  }

  const minimumExpected = minimumExpectedRecords(await lastGoodReadCount());
  await setStep(runId, "reading_airtable");
  const records = await source.read();
  assertPlausibleRead(records, minimumExpected);
  const enrollmentSource = await readEnrollmentSource(source);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await setStep(runId, "locking");
      await client.query("SET LOCAL lock_timeout = '20s'");
      await client.query("SET LOCAL statement_timeout = '180s'");
      // Ninguém grava em pessoas, matrículas nem vínculos enquanto a decisão é recalculada e aplicada, e
      // ninguém altera turmas ou cursos (a turma escolhida precisa continuar existindo até o fim).
      await client.query("LOCK TABLE pessoas, airtable_source_links, enrollments IN SHARE ROW EXCLUSIVE MODE");
      await client.query("LOCK TABLE classes, courses, cursos_inscricao IN SHARE MODE");

      await setStep(runId, "checking");
      const state = await readTargetState(client);
      const plan = planFor(records, enrollmentSource, state);
      if (
        creationDigest(plan.creates, plan.enrollments.enrollments) !== previewDigest
        || plan.creates.length !== previewToCreate
        || plan.enrollments.enrollments.length !== previewEnrollments
      ) {
        throw new AirtableLoadError(
          "PREVIA_DESATUALIZADA",
          "O Airtable ou o SoundOS mudaram desde a prévia. Nada foi criado; gere uma nova prévia.",
          409,
          { ...plan.totals, minimumExpected },
        );
      }
      if (plan.creates.length === 0) {
        throw new AirtableLoadError("NADA_PARA_CRIAR", "Não há clientes novos para criar.", 409, { ...plan.totals, minimumExpected });
      }

      const before = await snapshot(client);
      const peopleHashBefore = await existingPeopleHash(client, []);
      const enrollmentsHashBefore = await existingEnrollmentsHash(client, []);

      await setStep(runId, "writing");
      const inserted = await insertPeople(client, plan, state.codigos);
      const evidenceRows = await insertEvidencesAndLinks(client, inserted);
      const enrollments = await insertEnrollments(client, plan.enrollments, inserted);

      await setStep(runId, "reconciling");
      const checks = await reconcile(client, {
        before, peopleHashBefore, enrollmentsHashBefore, people: inserted, evidenceRows,
        expectedPeople: previewToCreate, enrollments, expectedEnrollments: previewEnrollments,
      });
      const passed = checks.every((check) => check.ok);
      if (!passed) {
        throw new AirtableLoadError(
          "RECONCILIACAO_FALHOU",
          "A conferência final não bateu. Tudo foi desfeito.",
          500,
          { ...plan.totals, minimumExpected, reconciliation: { passed: false, checks } },
        );
      }

      await client.query("COMMIT");
      await finishRun(runId, {
        status: "completed",
        counts: {
          ...plan.totals, minimumExpected, created: inserted.length, enrollmentsCreated: enrollments.ids.length,
          reconciliation: { passed: true, checks },
        },
        sourceSha: sourceDigest(records),
        digest: previewDigest,
      });
      logger.info(
        { runId, previewRunId, created: inserted.length, enrollmentsCreated: enrollments.ids.length },
        "Carga do Airtable: carga concluída",
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

// ── Início e acompanhamento ──────────────────────────────────────────────────

export interface StartRunInput {
  kind: RunKind;
  userId: number;
  previewRunId?: number;
  /** Quem pede a carga confirma que conferiu a recuperação do banco por ponto no tempo. */
  restoreConfirmed?: boolean;
  /** Troca da fonte do Airtable (testes). */
  source?: ClientesSource;
}

async function assertPreviewUsable(previewRunId: number): Promise<void> {
  const view = await getRun(previewRunId);
  if (!view || view.kind !== "preview") {
    throw new AirtableLoadError("PREVIA_NAO_ENCONTRADA", "Prévia não encontrada.", 404);
  }
  if (view.status !== "completed") {
    throw new AirtableLoadError("PREVIA_INDISPONIVEL", "Só uma prévia concluída pode ser usada na carga.");
  }
  if (view.totals && view.totals.toCreate === 0) {
    throw new AirtableLoadError("NADA_PARA_CRIAR", "A prévia não tem clientes novos para criar.");
  }
  if (view.totals && view.totals.enrollments === null) {
    throw new AirtableLoadError(
      "PREVIA_DESATUALIZADA",
      "Esta prévia é de antes da inclusão das matrículas. Gere uma nova prévia.",
    );
  }
  if (view.validUntil && new Date(view.validUntil) <= new Date()) {
    throw new AirtableLoadError("PREVIA_EXPIRADA", `A prévia tem mais de ${PREVIEW_VALID_MINUTES} minutos. Gere uma nova.`);
  }
  if (!view.usableForLoad) {
    throw new AirtableLoadError("PREVIA_JA_USADA", "Esta prévia já foi usada em uma carga. Gere uma nova.");
  }
}

/**
 * Registra a execução e a dispara em segundo plano. Devolve a execução (ainda em andamento) e `done`,
 * que só resolve quando o trabalho termina e nunca rejeita (a falha fica registrada na própria execução).
 */
export async function startRun(input: StartRunInput): Promise<{ run: RunView; done: Promise<void> }> {
  if (input.kind === "load") {
    if (input.restoreConfirmed !== true) {
      throw new AirtableLoadError(
        "RESTAURACAO_NAO_CONFIRMADA",
        "Confirme que a recuperação do banco por ponto no tempo está ativa antes de executar a carga.",
        400,
      );
    }
    if (input.previewRunId === undefined) {
      throw new AirtableLoadError("PREVIA_NAO_ENCONTRADA", "Informe a prévia a executar.", 400);
    }
  }
  await reapOrphanRuns();
  if (input.kind === "load") await assertPreviewUsable(input.previewRunId!);

  let runId: number;
  try {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO airtable_sync_runs
         (base_id, mode, source_sha256, status, counts, started_at, heartbeat_at, step, scope, requested_by, preview_run_id)
       VALUES ($1, $2, 'pending', 'running', '{}'::jsonb, now(), now(), 'starting', $3, $4, $5)
       RETURNING id`,
      [AIRTABLE_BASE_ID, input.kind === "load" ? "execute" : "dry-run", SCOPE, input.userId, input.previewRunId ?? null],
    );
    runId = Number(inserted.rows[0]!.id);
  } catch (err) {
    if (pgCode(err) === "23505") {
      if (pgConstraint(err).includes("previa_usada")) {
        throw new AirtableLoadError("PREVIA_JA_USADA", "Esta prévia já foi usada em uma carga. Gere uma nova.");
      }
      throw new AirtableLoadError("EXECUCAO_EM_ANDAMENTO", "Já existe uma prévia ou carga em andamento. Aguarde terminar.");
    }
    throw err;
  }

  const done = runInBackground(runId, input);
  const run = await getRun(runId);
  return { run: run!, done };
}

async function runInBackground(runId: number, input: StartRunInput): Promise<void> {
  const heartbeat = setInterval(() => {
    pool.query(
      "UPDATE airtable_sync_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'",
      [runId],
    ).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const source = input.source ?? createAirtableClientesSource();
  try {
    if (input.kind === "preview") await runPreview(runId, source);
    else await runLoad(runId, input.previewRunId!, source);
  } catch (err) {
    const known = err instanceof AirtableLoadError ? err : null;
    const code: LoadErrorCode = known
      ? known.code
      : pgCode(err) === "55P03" || pgCode(err) === "57014" ? "BANCO_OCUPADO" : "ERRO_INTERNO";
    const message = known
      ? known.message
      : code === "BANCO_OCUPADO"
        ? "O banco estava ocupado e a execução foi cancelada. Nada foi gravado."
        : "Falha inesperada. Nada foi gravado.";
    logger.error({ runId, ...safeErrorInfo(err) }, "Carga do Airtable: execução falhou");
    try {
      await finishRun(runId, {
        status: "failed",
        counts: known ? sanitizeFailureCounts(known.details) : {},
        errorCode: code,
        errorMessage: message,
      });
    } catch (finishErr) {
      logger.error({ runId, ...safeErrorInfo(finishErr) }, "Carga do Airtable: não foi possível registrar a falha");
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** Mantém no histórico da falha só totais e limites, nunca dados de pessoas. */
function sanitizeFailureCounts(details: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  const allowed = [
    "sourceRecords", "toCreate", "alreadyExist", "alreadyExistBy", "review", "enrollments", "enrollmentRead",
    "minimumExpected", "reconciliation",
  ];
  for (const key of allowed) {
    if (details[key] !== undefined) keep[key] = details[key];
  }
  return keep;
}

export const AIRTABLE_CARGA_SETTINGS = {
  previewValidMinutes: PREVIEW_VALID_MINUTES,
  referenceRecords: REFERENCE_RECORD_COUNT,
  minimumFraction: MIN_READ_FRACTION,
} as const;
