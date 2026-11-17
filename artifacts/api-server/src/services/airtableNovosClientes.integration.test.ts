// Carga de clientes novos do Airtable contra um banco descartável, com uma fonte falsa: nunca fala com o
// Airtable de verdade nem toca o banco compartilhado. Rode com `pnpm test:integration:airtable-carga`.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const disposableMarker = process.env.AIRTABLE_CARGA_DISPOSABLE;
const databaseUrl = process.env.DATABASE_URL;
let databaseName: string | undefined;
try {
  databaseName = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) : undefined;
} catch {
  databaseName = undefined;
}
if (
  !disposableMarker ||
  !/^airtable-carga-test-[0-9a-f]{32}$/.test(disposableMarker) ||
  databaseName !== disposableMarker
) {
  throw new Error(
    "Carga do Airtable: os testes exigem um banco descartável com nome único. " +
    "Use pnpm test:integration:airtable-carga; recusando o DATABASE_URL compartilhado.",
  );
}

const { pool } = await import("@workspace/db");
const service = await import("./airtableNovosClientes");
const { ORIGEM_AIRTABLE, AIRTABLE_BASE_ID } = await import("./airtableNovosClientesRules");
const { INSCRICOES_TABLE, EVENTOS_TABLES } = await import("./airtableNovosClientesMatriculasRules");
type AirtableRecordLike = import("./airtableNovosClientesRules").AirtableRecordLike;
type ClientesSource = import("./airtableNovosClientes").ClientesSource;

const { AirtableLoadError, getRun, listRuns, reapOrphanRuns, startRun } = service;
const USER = 4242;

function rec(id: string, fields: Record<string, unknown>): AirtableRecordLike {
  return { id, fields };
}

/** Onze registros: 4 que já existem, 4 para revisão e 3 clientes novos. */
function baseRecords(): AirtableRecordLike[] {
  return [
    rec("rec_exist_email", { Nome: "Ana Existente", Email: "ana@example.com" }),
    rec("rec_exist_phone", { Nome: "Beto Fone", Celular: "+55 11 97777-0002" }),
    rec("rec_exist_arquivada", { Nome: "Arquivada", Email: "arquivada@example.com" }),
    rec("rec_exist_mesclada", { Nome: "Mesclada", Email: "mesclada@example.com" }),
    rec("rec_ambigua", { Nome: "Ambígua", Celular: "21 96666-0003" }),
    rec("rec_nova_1", { Nome: "Nova Um", Email: "novaum@example.com", Celular: "+55 11 95555-0001", Cidade: "Santos", Estado: "SP" }),
    rec("rec_nova_2", { Nome: "Nova Dois Silva", Email: "novadois@example.com" }),
    rec("rec_nova_3", { Nome: "Nova Três", Celular: "(21) 94444-0003" }),
    rec("rec_dup_a", { Nome: "Dup A", Email: "dup@example.com" }),
    rec("rec_dup_b", { Nome: "Dup B", Email: "DUP@example.com" }),
    rec("rec_sem_contato", { Nome: "Sem Contato" }),
  ];
}

function evento(id: string, code: string, startDate: string): AirtableRecordLike {
  return rec(id, {
    Nome: `Formação ${code}`, Curso: "Formação", "Turma TAG": code, "Local do evento": "São Paulo",
    "Data início": startDate, "Data fim": startDate,
  });
}

/** Quatro eventos: dois com turma única no SoundOS, um com duas turmas iguais e um sem turma. */
function baseEventos(): AirtableRecordLike[] {
  return [
    evento("recEvA", "SH-01", "2026-03-10"),
    evento("recEvB", "SH-02", "2026-04-10"),
    evento("recEvAmb", "AMB-1", "2026-05-10"),
    evento("recEvAus", "AUS-1", "2026-06-10"),
  ];
}

function insc(id: string, people: string[], eventId: string, extra: Record<string, unknown> = {}): AirtableRecordLike {
  return rec(id, { "Nome Inscrito": people, "Inscrito para": [eventId], ...extra });
}

/**
 * Dez inscrições. Das 8 de clientes novos: 3 viram matrícula (nova_1 em A e B, nova_2 em A), 1 turma
 * ambígua, 1 turma ausente, 2 repetidas (nova_2 duas vezes em B) e 1 ligada a duas pessoas.
 * As outras 2 são de quem já existe ou de quem não é criado, e não entram.
 */
function baseInscricoes(): AirtableRecordLike[] {
  return [
    insc("recI1", ["rec_nova_1"], "recEvA", { "Contrato Assinado": true }),
    insc("recI2", ["rec_nova_1"], "recEvB"),
    insc("recI3", ["rec_nova_2"], "recEvA", { "Contrato Assinado": false }),
    insc("recI4", ["rec_nova_3"], "recEvAmb"),
    insc("recI5", ["rec_nova_3"], "recEvAus"),
    insc("recI6", ["rec_exist_email"], "recEvA"),
    insc("recI7", ["rec_nova_2"], "recEvB"),
    insc("recI8", ["rec_nova_2"], "recEvB"),
    insc("recI9", ["rec_dup_a"], "recEvA"),
    insc("recI10", ["rec_nova_1", "rec_nova_2"], "recEvA"),
  ];
}

let currentRecords: AirtableRecordLike[] = baseRecords();
let currentInscricoes: AirtableRecordLike[] = baseInscricoes();
let currentEventos: AirtableRecordLike[] = baseEventos();
const source: ClientesSource = {
  read: async () => currentRecords,
  readEnrollments: async () => ({ inscricoes: currentInscricoes, eventos: currentEventos }),
};

const BASE_ENROLLMENT_TOTALS = {
  sourceRecords: 10,
  eventRecords: 4,
  forNewClients: 8,
  toCreate: 3,
  clientsWithEnrollment: 2,
  review: { total: 5, byReason: { turma_ausente: 1, turma_ambigua: 1, duplicada: 2, pessoa_ambigua: 1 } },
};

async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0] ?? {})[0] as T;
}

async function count(table: string): Promise<number> {
  return Number(await scalar(`SELECT count(*) FROM ${table}`));
}

async function seedPeople(): Promise<void> {
  await pool.query(`INSERT INTO pessoas (codigo, nome, email, celular) VALUES ('T-E1', 'Ana Existente', 'Ana@Example.com', '(11) 98888-0001')`);
  await pool.query(`INSERT INTO pessoas (codigo, nome, celular) VALUES ('T-E2', 'Beto Fone', '11 97777-0002')`);
  await pool.query(`INSERT INTO pessoas (codigo, nome, email, arquivado_em) VALUES ('T-E3', 'Arquivada', 'arquivada@example.com', now())`);
  const target = await scalar<number>("SELECT id FROM pessoas WHERE codigo = 'T-E1'");
  await pool.query(
    `INSERT INTO pessoas (codigo, nome, email, merged_into_pessoa_id) VALUES ('T-E4', 'Mesclada', 'mesclada@example.com', $1)`,
    [target],
  );
  await pool.query(`INSERT INTO pessoas (codigo, nome, celular) VALUES ('T-E5', 'Compartilha A', '21 96666-0003')`);
  await pool.query(`INSERT INTO pessoas (codigo, nome, celular) VALUES ('T-E6', 'Compartilha B', '(21) 96666-0003')`);
}

async function peopleFingerprint(): Promise<string> {
  return scalar("SELECT coalesce(md5(string_agg(md5(p::text), '' ORDER BY p.id)), '') FROM pessoas p");
}

async function existingFingerprint(): Promise<string> {
  return scalar("SELECT coalesce(md5(string_agg(md5(p::text), '' ORDER BY p.id)), '') FROM pessoas p WHERE codigo LIKE 'T-%'");
}

/** Cursos, turmas e links de inscrição: a carga nunca cria nem altera. */
async function otherTablesFingerprint(): Promise<string> {
  return scalar(
    `SELECT (SELECT count(*) FROM courses) || '/' || (SELECT count(*) FROM classes) || '/' || (SELECT count(*) FROM cursos_inscricao) || '/' ||
            (SELECT coalesce(md5(string_agg(md5(c::text), '' ORDER BY c.id)), '') FROM classes c)`,
  );
}

/** Matrículas que já existiam antes da carga (as da fixture, de pessoas T-%). */
async function existingEnrollmentsFingerprint(): Promise<string> {
  return scalar(
    `SELECT coalesce(md5(string_agg(md5(e::text), '' ORDER BY e.id)), '') FROM enrollments e
      WHERE e.pessoa_id IN (SELECT id FROM pessoas WHERE codigo LIKE 'T-%')`,
  );
}

/** `enrollments: null` imita uma leitura boa de antes das matrículas (sem tamanho de inscrições conhecido). */
async function seedBaseline(
  sourceRecords = 5,
  enrollments: { sourceRecords: number; eventRecords: number } | null = { sourceRecords: 10, eventRecords: 4 },
): Promise<void> {
  await pool.query(
    `INSERT INTO airtable_sync_runs (base_id, mode, source_sha256, status, counts, finished_at, scope)
     VALUES ($1, 'dry-run', 'seed', 'completed', $2::jsonb, now(), 'novos_clientes')`,
    [AIRTABLE_BASE_ID, JSON.stringify(enrollments ? { sourceRecords, enrollments } : { sourceRecords })],
  );
}

interface SeededClasses { a: number; b: number; amb1: number; amb2: number }

/** Turmas que já existem no SoundOS: A e B únicas, duas iguais (ambíguas) e nenhuma para AUS-1. */
async function seedClasses(): Promise<SeededClasses> {
  const course = await scalar<number>(
    "INSERT INTO courses (name, cycle, modality, workload, price) VALUES ('Formação', 'Água', 'Presencial', 40, 100) RETURNING id",
  );
  const insert = (code: string, start: string) => scalar<number>(
    `INSERT INTO classes (course_id, code, location, start_date, end_date, teacher)
     VALUES ($1, $2, 'São Paulo', $3, $3, 'Professor') RETURNING id`,
    [course, code, start],
  );
  const a = await insert("SH-01", "2026-03-10");
  const b = await insert("SH-02", "2026-04-10");
  const amb1 = await insert("AMB-1", "2026-05-10");
  const amb2 = await insert("AMB-1", "2026-05-10");
  for (const [id, code] of [[a, "SH-01"], [b, "SH-02"], [amb1, "AMB-1"], [amb2, "AMB-1"]] as const) {
    await pool.query(
      "INSERT INTO cursos_inscricao (slug, nome, class_id) VALUES ($1, $2, $3)",
      [`test-${id}`, `Formação ${code}`, id],
    );
  }
  return { a, b, amb1, amb2 };
}

async function preview(src: ClientesSource = source) {
  const { run, done } = await startRun({ kind: "preview", userId: USER, source: src });
  expect(run.status).toBe("running");
  await done;
  return (await getRun(run.id))!;
}

async function load(previewRunId: number, src: ClientesSource = source) {
  const { run, done } = await startRun({ kind: "load", userId: USER, previewRunId, restoreConfirmed: true, source: src });
  await done;
  return (await getRun(run.id))!;
}

async function dropTestTriggers(): Promise<void> {
  await pool.query("DROP TRIGGER IF EXISTS test_falha_evidencia ON pessoa_evidencias");
  await pool.query("DROP TRIGGER IF EXISTS test_toca_existente ON pessoas");
  await pool.query("DROP TRIGGER IF EXISTS test_falha_matricula ON enrollments");
  await pool.query("DROP TRIGGER IF EXISTS test_toca_matricula ON enrollments");
}

let classes: SeededClasses;

async function expectLoadError(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  const error = await promise.then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(AirtableLoadError);
  expect((error as InstanceType<typeof AirtableLoadError>).code).toBe(code);
  if (status !== undefined) expect((error as InstanceType<typeof AirtableLoadError>).httpStatus).toBe(status);
}

beforeEach(async () => {
  await pool.query(
    "TRUNCATE pessoas, pessoa_evidencias, airtable_source_links, airtable_sync_runs, enrollments, cursos_inscricao, classes, courses RESTART IDENTITY CASCADE",
  );
  await dropTestTriggers();
  currentRecords = baseRecords();
  currentInscricoes = baseInscricoes();
  currentEventos = baseEventos();
  await seedPeople();
  classes = await seedClasses();
  // Uma matrícula que já existia: a carga não pode alterá-la nem repeti-la.
  await pool.query(
    "INSERT INTO enrollments (pessoa_id, class_id, price, payment_status, contract_status) SELECT id, $1, 250, 'paid', 'Assinado' FROM pessoas WHERE codigo = 'T-E1'",
    [classes.a],
  );
  await seedBaseline();
});

afterEach(async () => {
  await dropTestTriggers();
});

afterAll(async () => {
  await pool.end();
});

describe("prévia", () => {
  it("lê, conta e não grava nada em pessoas, evidências ou vínculos", async () => {
    const before = {
      people: await peopleFingerprint(),
      evidences: await count("pessoa_evidencias"),
      links: await count("airtable_source_links"),
      enrollments: await scalar("SELECT coalesce(md5(string_agg(md5(e::text), '' ORDER BY e.id)), '') FROM enrollments e"),
      others: await otherTablesFingerprint(),
    };

    const view = await preview();

    expect(view.status).toBe("completed");
    expect(view.kind).toBe("preview");
    expect(view.totals).toEqual({
      sourceRecords: 11,
      toCreate: 3,
      alreadyExist: 4,
      alreadyExistBy: { email: 3, phone: 1, both: 0, previousLoad: 0 },
      review: {
        total: 4,
        byReason: { duplicado_no_airtable: 2, ambiguo: 1, contraditorio: 0, dados_insuficientes: 1 },
      },
      enrollments: BASE_ENROLLMENT_TOTALS,
    });
    expect(view.usableForLoad).toBe(true);
    expect(view.validUntil).not.toBeNull();
    expect(await peopleFingerprint()).toBe(before.people);
    expect(await count("pessoa_evidencias")).toBe(before.evidences);
    expect(await count("airtable_source_links")).toBe(before.links);
    expect(await scalar("SELECT coalesce(md5(string_agg(md5(e::text), '' ORDER BY e.id)), '') FROM enrollments e")).toBe(before.enrollments);
    expect(await otherTablesFingerprint()).toBe(before.others);
  });

  it("usa o vínculo durável de uma turma quando ele existe, em vez de ficar ambíguo", async () => {
    await pool.query(
      `INSERT INTO airtable_source_links (base_id, source_table_id, source_record_id, entity_type, entity_id, source_fields_sha256)
       VALUES ($1, $2, 'recEvAmb', 'class', $3, 'x')`,
      [AIRTABLE_BASE_ID, EVENTOS_TABLES[0].id, classes.amb1],
    );
    const view = await preview();
    expect(view.totals?.enrollments).toMatchObject({
      toCreate: 4, clientsWithEnrollment: 3,
      review: { total: 4, byReason: { turma_ausente: 1, turma_ambigua: 0, duplicada: 2, pessoa_ambigua: 1 } },
    });
  });

  it("não deixa nome, e-mail nem telefone no histórico, nas respostas ou nas execuções gravadas", async () => {
    const view = await preview();
    const stored = await pool.query("SELECT counts::text AS counts, error_message, confirmation_digest FROM airtable_sync_runs");
    const everything = JSON.stringify([view, await listRuns(), stored.rows]);
    expect(everything).not.toMatch(/@example|Nova|Ana|Beto|Dup|Santos|9\d{4}-?\d{4}/);
  });

  it("não deixa dado de pessoa no histórico depois de uma carga com matrículas", async () => {
    const view = await preview();
    const loaded = await load(view.id);
    expect(loaded.status).toBe("completed");
    const stored = await pool.query("SELECT counts::text AS counts, error_message, confirmation_digest FROM airtable_sync_runs");
    const links = await pool.query("SELECT source_fields_sha256 FROM airtable_source_links WHERE entity_type = 'enrollment'");
    const everything = JSON.stringify([await listRuns(), stored.rows, links.rows]);
    expect(everything).not.toMatch(/@example|Nova|Ana|Beto|Dup|Santos|9\d{4}-?\d{4}/);
  });

  it("registra uma falha sem criar nada quando o Airtable devolve a tabela vazia ou incompleta", async () => {
    const empty = await preview({ ...source, read: async () => [] });
    expect(empty.status).toBe("failed");
    expect(empty.errorCode).toBe("AIRTABLE_LEITURA_VAZIA");
    expect(empty.usableForLoad).toBe(false);

    await pool.query("DELETE FROM airtable_sync_runs WHERE status = 'failed'");
    await pool.query("UPDATE airtable_sync_runs SET counts = '{\"sourceRecords\": 100}'::jsonb");
    const small = await preview();
    expect(small.status).toBe("failed");
    expect(small.errorCode).toBe("AIRTABLE_LEITURA_INCOMPLETA");
    // A leitura barrada mostra quantos registros vieram e qual era o mínimo, para a equipe entender o motivo.
    expect(small.sourceRecordsRead).toBe(11);
    expect(small.minimumExpected).toBe(90);
    expect(small.totals).toBeNull();
    expect(await count("airtable_source_links")).toBe(0);
  });

  it("sem nenhuma leitura boa anterior, uma leitura pequena é barrada pela referência de 4829 registros", async () => {
    await pool.query("DELETE FROM airtable_sync_runs");
    const view = await preview();
    expect(view.status).toBe("failed");
    expect(view.errorCode).toBe("AIRTABLE_LEITURA_INCOMPLETA");
  });

  it("falha do Airtable fica registrada como falha, sem texto de erro de terceiros", async () => {
    const view = await preview({ ...source, read: async () => { throw new AirtableLoadError("AIRTABLE_INDISPONIVEL", "O Airtable não respondeu a tempo.", 502); } });
    expect(view.status).toBe("failed");
    expect(view.errorCode).toBe("AIRTABLE_INDISPONIVEL");
    const unexpected = await preview({ ...source, read: async () => { throw new Error("falha com ana@example.com"); } });
    expect(unexpected.status).toBe("failed");
    expect(unexpected.errorCode).toBe("ERRO_INTERNO");
    expect(JSON.stringify(await pool.query("SELECT error_message FROM airtable_sync_runs"))).not.toContain("ana@example.com");
  });
});

describe("leitura das inscrições", () => {
  it("barra inscrições ou eventos vazios ou muito menores que a última leitura boa, sem criar nada", async () => {
    currentInscricoes = [];
    const empty = await preview();
    expect(empty.status).toBe("failed");
    expect(empty.errorCode).toBe("AIRTABLE_INSCRICOES_INCOMPLETA");
    expect(empty.usableForLoad).toBe(false);
    expect(empty.totals).toBeNull();

    currentInscricoes = baseInscricoes();
    currentEventos = [];
    const noEvents = await preview();
    expect(noEvents.errorCode).toBe("AIRTABLE_INSCRICOES_INCOMPLETA");

    currentEventos = baseEventos();
    currentInscricoes = baseInscricoes().slice(0, 5);
    const small = await preview();
    expect(small.errorCode).toBe("AIRTABLE_INSCRICOES_INCOMPLETA");
    expect(await count("airtable_source_links")).toBe(0);
    expect(await count("enrollments")).toBe(1);
  });

  it("sem nenhuma leitura boa de inscrições, a referência de tamanho barra uma leitura pequena", async () => {
    await pool.query("DELETE FROM airtable_sync_runs");
    await seedBaseline(5, null);
    const view = await preview();
    expect(view.status).toBe("failed");
    expect(view.errorCode).toBe("AIRTABLE_INSCRICOES_INCOMPLETA");
  });

  it("a falha da carga não guarda texto de pessoas nem das tabelas lidas", async () => {
    currentInscricoes = [];
    await preview();
    const stored = await pool.query("SELECT counts::text AS counts, error_message FROM airtable_sync_runs WHERE status = 'failed'");
    expect(JSON.stringify(stored.rows)).not.toMatch(/@example|Nova|rec_nova/);
  });

  it("uma prévia de antes das matrículas não serve para uma carga", async () => {
    const view = await preview();
    await pool.query(
      "UPDATE airtable_sync_runs SET counts = counts - 'enrollments' WHERE id = $1",
      [view.id],
    );
    const legacy = (await getRun(view.id))!;
    expect(legacy.totals?.enrollments).toBeNull();
    expect(legacy.usableForLoad).toBe(false);
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: view.id, restoreConfirmed: true, source }),
      "PREVIA_DESATUALIZADA",
    );
    expect(await count("enrollments")).toBe(1);
  });
});

describe("carga", () => {
  it("cria só os clientes novos, com origem e evidências, e não toca em nada que já existia", async () => {
    const view = await preview();
    const peopleBefore = await peopleFingerprint();
    const others = await otherTablesFingerprint();
    const countBefore = await count("pessoas");
    const existingBefore = await existingFingerprint();
    const enrollmentsBefore = await existingEnrollmentsFingerprint();
    const enrollmentCountBefore = await count("enrollments");

    const loaded = await load(view.id);

    expect(loaded.status).toBe("completed");
    expect(loaded.kind).toBe("load");
    expect(loaded.created).toBe(3);
    expect(loaded.enrollmentsCreated).toBe(3);
    expect(loaded.totals?.enrollments).toEqual(BASE_ENROLLMENT_TOTALS);
    expect(loaded.previewRunId).toBe(view.id);
    expect(loaded.reconciliation?.passed).toBe(true);
    expect(loaded.reconciliation?.checks.every((check) => check.ok)).toBe(true);
    expect(loaded.requestedBy?.id).toBe(USER);

    expect(await count("pessoas")).toBe(countBefore + 3);
    expect(await otherTablesFingerprint()).toBe(others);
    // As fichas que já existiam continuam byte a byte iguais.
    expect(await existingFingerprint()).toBe(existingBefore);
    expect(await peopleFingerprint()).not.toBe(peopleBefore);

    const created = await pool.query(
      "SELECT id, codigo, nome, sobrenome, email, celular, celular_normalizado, cidade, estado_uf, consent_status, ativo FROM pessoas WHERE codigo NOT LIKE 'T-%' ORDER BY email NULLS LAST, celular",
    );
    expect(created.rows).toHaveLength(3);
    for (const row of created.rows) expect(row.codigo).toMatch(/^PS-\d{6}$/);
    const novaUm = created.rows.find((row) => row.email === "novaum@example.com")!;
    expect(novaUm).toMatchObject({
      nome: "Nova", sobrenome: "Um", celular_normalizado: "11955550001", cidade: "Santos", estado_uf: "SP", ativo: true,
    });
    // Consentimento nunca é copiado do Airtable.
    expect(created.rows.every((row) => row.consent_status === null)).toBe(true);

    const links = await pool.query(
      "SELECT source_record_id, entity_type, entity_id FROM airtable_source_links ORDER BY source_record_id",
    );
    expect(links.rows.filter((row) => row.entity_type === "pessoa").map((row) => row.source_record_id))
      .toEqual(["rec_nova_1", "rec_nova_2", "rec_nova_3"]);
    expect(links.rows.filter((row) => row.entity_type === "enrollment").map((row) => row.source_record_id))
      .toEqual(["recI1", "recI2", "recI3"]);
    expect(links.rows).toHaveLength(6);

    // Matrículas: só dos clientes novos, em turmas que já existiam, com valores neutros.
    expect(await count("enrollments")).toBe(enrollmentCountBefore + 3);
    expect(await existingEnrollmentsFingerprint()).toBe(enrollmentsBefore);
    const enrolled = await pool.query(
      `SELECT l.source_record_id, e.pessoa_id, e.class_id, e.price::text AS price, e.payment_status, e.contract_status,
              e.hotmart_access_status, e.invoice_status
         FROM enrollments e
         JOIN airtable_source_links l ON l.entity_type = 'enrollment' AND l.entity_id = e.id
        ORDER BY l.source_record_id`,
    );
    const novaDois = created.rows.find((row) => row.email === "novadois@example.com")!;
    expect(enrolled.rows).toEqual([
      { source_record_id: "recI1", pessoa_id: novaUm.id, class_id: classes.a, price: "0.00", payment_status: "pending", contract_status: "Assinado", hotmart_access_status: null, invoice_status: null },
      { source_record_id: "recI2", pessoa_id: novaUm.id, class_id: classes.b, price: "0.00", payment_status: "pending", contract_status: "pending", hotmart_access_status: null, invoice_status: null },
      { source_record_id: "recI3", pessoa_id: novaDois.id, class_id: classes.a, price: "0.00", payment_status: "pending", contract_status: "pending", hotmart_access_status: null, invoice_status: null },
    ]);
    // Quem teve inscrição ambígua, ausente, repetida ou ligada a duas pessoas não ganha matrícula alguma.
    const novaTres = created.rows.find((row) => row.celular_normalizado === "21944440003")!;
    expect(await scalar("SELECT count(*) FROM enrollments WHERE pessoa_id = $1", [novaTres.id])).toBe("0");
    const checkNames = (loaded.reconciliation?.checks ?? []).map((check) => check.name);
    expect(checkNames).toEqual(expect.arrayContaining([
      "enrollments_equal_preview", "enrollments_count", "enrollment_links", "no_duplicate_enrollments", "existing_enrollments_untouched",
    ]));

    const evidences = await pool.query("SELECT pessoa_id, campo, tipo_evidencia, nivel_confianca, origem FROM pessoa_evidencias");
    expect(evidences.rows.length).toBeGreaterThanOrEqual(3 + 2);
    expect(evidences.rows.every((row) => row.origem === ORIGEM_AIRTABLE && row.tipo_evidencia === "inferida" && row.nivel_confianca === "baixa")).toBe(true);
    const createdIds = new Set(created.rows.map((row) => row.id));
    expect(evidences.rows.every((row) => createdIds.has(row.pessoa_id))).toBe(true);
    expect(evidences.rows.filter((row) => row.pessoa_id === novaUm.id).map((row) => row.campo).sort())
      .toEqual(["celular", "cidade", "email", "estadoUf", "nome", "sobrenome"]);
  });

  it("uma segunda prévia depois da carga não tem mais nada para criar, e a prévia usada não vale de novo", async () => {
    const first = await preview();
    await load(first.id);
    expect((await getRun(first.id))!.usableForLoad).toBe(false);
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: first.id, restoreConfirmed: true, source }),
      "PREVIA_JA_USADA",
    );

    const second = await preview();
    expect(second.totals?.toCreate).toBe(0);
    expect(second.totals?.alreadyExistBy.previousLoad).toBe(3);
    // Quem foi trazido por uma carga anterior não é "novo": nenhuma matrícula é planejada de novo.
    expect(second.totals?.enrollments).toMatchObject({ forNewClients: 0, toCreate: 0, review: { total: 0 } });
    expect(second.usableForLoad).toBe(false);
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: second.id, restoreConfirmed: true, source }),
      "NADA_PARA_CRIAR",
    );
    expect(await count("airtable_source_links")).toBe(6);
    expect(await count("enrollments")).toBe(4);
  });

  it("recusa a carga sem a confirmação de recuperação, sem prévia certa ou com prévia inutilizável", async () => {
    const view = await preview();
    const runsBefore = await count("airtable_sync_runs");

    await expectLoadError(startRun({ kind: "load", userId: USER, previewRunId: view.id, source }), "RESTAURACAO_NAO_CONFIRMADA", 400);
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: view.id, restoreConfirmed: false, source }),
      "RESTAURACAO_NAO_CONFIRMADA",
      400,
    );
    await expectLoadError(startRun({ kind: "load", userId: USER, restoreConfirmed: true, source }), "PREVIA_NAO_ENCONTRADA", 400);
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: 999999, restoreConfirmed: true, source }),
      "PREVIA_NAO_ENCONTRADA",
      404,
    );

    await pool.query("UPDATE airtable_sync_runs SET finished_at = now() - interval '61 minutes' WHERE id = $1", [view.id]);
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: view.id, restoreConfirmed: true, source }),
      "PREVIA_EXPIRADA",
    );

    const failedPreview = await preview({ ...source, read: async () => [] });
    await expectLoadError(
      startRun({ kind: "load", userId: USER, previewRunId: failedPreview.id, restoreConfirmed: true, source }),
      "PREVIA_INDISPONIVEL",
    );

    expect(await count("pessoas")).toBe(6);
    expect(await count("airtable_source_links")).toBe(0);
    expect(await count("enrollments")).toBe(1);
    // Nenhuma tentativa recusada abriu uma execução (só a prévia vazia, que foi registrada como falha).
    expect(await count("airtable_sync_runs")).toBe(runsBefore + 1);
  });

  it("recusa a carga quando o SoundOS ou o Airtable mudaram depois da prévia, e nada é criado", async () => {
    const view = await preview();
    // Alguém cadastra um dos clientes que seriam novos.
    await pool.query("INSERT INTO pessoas (codigo, nome, email) VALUES ('T-CHEGOU', 'Chegou', 'novaum@example.com')");
    const people = await count("pessoas");

    const failed = await load(view.id);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("PREVIA_DESATUALIZADA");
    expect(await count("pessoas")).toBe(people);
    expect(await count("airtable_source_links")).toBe(0);
    expect(await count("pessoa_evidencias")).toBe(0);
    expect(await count("enrollments")).toBe(1);
    // Uma carga que falhou libera a prévia (que continua inválida pelo resumo) em vez de queimá-la.
    expect((await getRun(view.id))!.usableForLoad).toBe(true);

    // Mudança no próprio Airtable depois da prévia também é pega.
    const fresh = await preview();
    currentRecords = [...baseRecords(), rec("rec_nova_4", { Nome: "Nova Quatro", Email: "novaquatro@example.com" })];
    const changed = await load(fresh.id);
    expect(changed.errorCode).toBe("PREVIA_DESATUALIZADA");
    expect(await count("airtable_source_links")).toBe(0);
  });

  it("recusa a carga quando só as matrículas mudaram depois da prévia (inscrição ou turma)", async () => {
    const view = await preview();
    // Uma inscrição passa para outra turma no Airtable.
    currentInscricoes = baseInscricoes().map((item) => (item.id === "recI3" ? insc("recI3", ["rec_nova_2"], "recEvB") : item));
    const movedEnrollment = await load(view.id);
    expect(movedEnrollment.errorCode).toBe("PREVIA_DESATUALIZADA");
    expect(await count("pessoas")).toBe(6);
    expect(await count("enrollments")).toBe(1);

    // Alguém cria no SoundOS uma segunda turma igual à A: a turma deixa de ser única.
    currentInscricoes = baseInscricoes();
    const fresh = await preview();
    const clone = await scalar<number>(
      `INSERT INTO classes (course_id, code, location, start_date, end_date, teacher)
       SELECT course_id, code, location, start_date, end_date, teacher FROM classes WHERE id = $1 RETURNING id`,
      [classes.a],
    );
    await pool.query("INSERT INTO cursos_inscricao (slug, nome, class_id) VALUES ('test-clone', 'Formação SH-01', $1)", [clone]);
    const ambiguous = await load(fresh.id);
    expect(ambiguous.errorCode).toBe("PREVIA_DESATUALIZADA");
    expect(await count("pessoas")).toBe(6);
    expect(await count("enrollments")).toBe(1);
    expect(await count("airtable_source_links")).toBe(0);
  });

  it("desfaz tudo quando a gravação falha no meio e deixa tentar de novo com a mesma prévia", async () => {
    const view = await preview();
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_falha_evidencia() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada para ana@example.com'; END $$`);
    await pool.query(
      "CREATE TRIGGER test_falha_evidencia BEFORE INSERT ON pessoa_evidencias FOR EACH ROW EXECUTE FUNCTION test_falha_evidencia()",
    );
    const fingerprint = await peopleFingerprint();

    const failed = await load(view.id);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("ERRO_INTERNO");
    expect(await peopleFingerprint()).toBe(fingerprint);
    expect(await count("airtable_source_links")).toBe(0);
    expect(await count("pessoa_evidencias")).toBe(0);
    const stored = await pool.query("SELECT error_message, counts::text AS counts FROM airtable_sync_runs WHERE id = $1", [failed.id]);
    expect(JSON.stringify(stored.rows)).not.toContain("ana@example.com");

    await pool.query("DROP TRIGGER test_falha_evidencia ON pessoa_evidencias");
    const retried = await load(view.id);
    expect(retried.status).toBe("completed");
    expect(retried.created).toBe(3);
    expect(retried.enrollmentsCreated).toBe(3);
    expect(await count("airtable_source_links")).toBe(6);
  });

  it("desfaz as fichas e tudo mais quando a gravação das matrículas falha", async () => {
    const view = await preview();
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_falha_matricula() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada para ana@example.com'; END $$`);
    await pool.query(
      "CREATE TRIGGER test_falha_matricula BEFORE INSERT ON enrollments FOR EACH ROW EXECUTE FUNCTION test_falha_matricula()",
    );
    const fingerprint = await peopleFingerprint();
    const enrollmentsBefore = await existingEnrollmentsFingerprint();

    const failed = await load(view.id);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("ERRO_INTERNO");
    expect(await peopleFingerprint()).toBe(fingerprint);
    expect(await count("enrollments")).toBe(1);
    expect(await existingEnrollmentsFingerprint()).toBe(enrollmentsBefore);
    expect(await count("airtable_source_links")).toBe(0);
    expect(await count("pessoa_evidencias")).toBe(0);
    const stored = await pool.query("SELECT error_message, counts::text AS counts FROM airtable_sync_runs WHERE id = $1", [failed.id]);
    expect(JSON.stringify(stored.rows)).not.toContain("ana@example.com");
  });

  it("a conferência final desfaz a carga se uma matrícula que já existia mudou", async () => {
    const view = await preview();
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_toca_matricula() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE enrollments SET price = 1 WHERE pessoa_id = (SELECT id FROM pessoas WHERE codigo = 'T-E1'); RETURN NEW; END $$`);
    await pool.query(
      "CREATE TRIGGER test_toca_matricula AFTER INSERT ON enrollments FOR EACH ROW EXECUTE FUNCTION test_toca_matricula()",
    );
    const fingerprint = await peopleFingerprint();
    const enrollmentsBefore = await existingEnrollmentsFingerprint();

    const failed = await load(view.id);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("RECONCILIACAO_FALHOU");
    expect(failed.reconciliation?.checks.find((check) => check.name === "existing_enrollments_untouched")?.ok).toBe(false);
    expect(await peopleFingerprint()).toBe(fingerprint);
    expect(await existingEnrollmentsFingerprint()).toBe(enrollmentsBefore);
    expect(await count("enrollments")).toBe(1);
    expect(await count("airtable_source_links")).toBe(0);
  });

  it("a conferência final desfaz a carga se alguma ficha existente mudou", async () => {
    const view = await preview();
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_toca_existente() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE pessoas SET cidade = 'tocada' WHERE codigo = 'T-E1'; RETURN NEW; END $$`);
    await pool.query(
      "CREATE TRIGGER test_toca_existente AFTER INSERT ON pessoas FOR EACH ROW WHEN (NEW.codigo LIKE 'PS-%') EXECUTE FUNCTION test_toca_existente()",
    );
    const fingerprint = await peopleFingerprint();

    const failed = await load(view.id);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("RECONCILIACAO_FALHOU");
    expect(failed.reconciliation?.passed).toBe(false);
    expect(failed.reconciliation?.checks.find((check) => check.name === "existing_people_untouched")?.ok).toBe(false);
    expect(await peopleFingerprint()).toBe(fingerprint);
    expect(await count("airtable_source_links")).toBe(0);
    expect(await count("pessoa_evidencias")).toBe(0);
  });
});

describe("execuções", () => {
  it("só uma execução por vez, garantido pelo banco", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: ClientesSource = { ...source, read: async () => { await gate; return currentRecords; } };

    const first = await startRun({ kind: "preview", userId: USER, source: slow });
    expect(first.run.status).toBe("running");
    await expectLoadError(startRun({ kind: "preview", userId: USER, source }), "EXECUCAO_EM_ANDAMENTO");
    expect((await listRuns()).filter((run) => run.status === "running")).toHaveLength(1);

    release();
    await first.done;
    expect((await getRun(first.run.id))!.status).toBe("completed");
    const next = await preview();
    expect(next.status).toBe("completed");
  });

  it("duas cargas simultâneas da mesma prévia: só uma passa", async () => {
    const view = await preview();
    const results = await Promise.allSettled([
      startRun({ kind: "load", userId: USER, previewRunId: view.id, restoreConfirmed: true, source }),
      startRun({ kind: "load", userId: USER, previewRunId: view.id, restoreConfirmed: true, source }),
    ]);
    const started = results.filter((result) => result.status === "fulfilled");
    expect(started).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(["EXECUCAO_EM_ANDAMENTO", "PREVIA_JA_USADA"]).toContain((rejected.reason as InstanceType<typeof AirtableLoadError>).code);
    await (started[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startRun>>>).value.done;
    expect(await count("airtable_source_links")).toBe(6);
    expect(await count("enrollments")).toBe(4);
  });

  it("encerra como falha a execução que perdeu o servidor e libera a próxima", async () => {
    await pool.query(
      `INSERT INTO airtable_sync_runs (base_id, mode, source_sha256, status, counts, started_at, heartbeat_at, step, scope)
       VALUES ($1, 'dry-run', 'pending', 'running', '{}'::jsonb, now() - interval '10 minutes', now() - interval '5 minutes', 'reading_airtable', 'novos_clientes')`,
      [AIRTABLE_BASE_ID],
    );
    // Uma execução recente, com sinal de vida, não é tocada.
    expect(await reapOrphanRuns()).toBe(1);
    const orphan = (await listRuns()).find((run) => run.status === "failed" && run.errorCode === "INTERROMPIDA");
    expect(orphan).toBeDefined();
    expect(orphan!.finishedAt).not.toBeNull();

    const next = await preview();
    expect(next.status).toBe("completed");
  });

  it("não encerra uma execução que ainda dá sinal de vida", async () => {
    await pool.query(
      `INSERT INTO airtable_sync_runs (base_id, mode, source_sha256, status, counts, started_at, heartbeat_at, step, scope)
       VALUES ($1, 'dry-run', 'pending', 'running', '{}'::jsonb, now() - interval '10 minutes', now() - interval '5 seconds', 'reading_airtable', 'novos_clientes')`,
      [AIRTABLE_BASE_ID],
    );
    expect(await reapOrphanRuns()).toBe(0);
    await expectLoadError(startRun({ kind: "preview", userId: USER, source }), "EXECUCAO_EM_ANDAMENTO");
  });

  it("não mistura as execuções do comando de linha com as da tela", async () => {
    await pool.query(
      `INSERT INTO airtable_sync_runs (base_id, mode, source_sha256, status, counts, started_at, scope)
       VALUES ($1, 'execute', 'cli', 'running', '{}'::jsonb, now() - interval '3 hours', NULL)`,
      [AIRTABLE_BASE_ID],
    );
    expect(await reapOrphanRuns()).toBe(0);
    expect((await listRuns()).every((run) => run.id !== undefined)).toBe(true);
    const view = await preview();
    expect(view.status).toBe("completed");
  });
});
