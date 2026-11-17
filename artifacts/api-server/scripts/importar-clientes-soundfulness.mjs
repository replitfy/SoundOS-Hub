import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { pool } from "@workspace/db";

const REQUIRED_SHEETS = [
  "AUDITORIA",
  "ERROS",
  "sys_pessoas",
  "sys_matriculas",
  "sys_participacoes",
  "sys_servicos",
];
const EXPECTED = {
  workbookSha256: "6abe1a1a0a07b1eec480a5447ae376d7c907db2ab425baedd71e58b88095c368",
  pessoas: 31_671,
  matriculas: 3_562,
  participacoes: 3_562,
  servicos: 8_026,
  testFlags: 44,
  undatedEvents: 29,
  undatedEnrollmentRows: 938,
  deduplicatedEnrollments: 3_546,
  duplicateEnrollmentRows: 16,
};
const SHEET_HEADERS = {
  sys_pessoas: [
    "codigo_ref", "codigo", "ativo", "nome", "sobrenome", "cpf", "data_nascimento", "sexo",
    "email", "celular", "celular_normalizado", "instagram", "site", "profissao",
    "profissao_categoria", "endereco_rua", "cidade", "estado_uf", "cep", "servico_interesse",
    "como_ficou_sabendo", "qual_amigo_parceiro", "preferencia_contato", "contato_para",
    "adicionar_contato", "agua_presencial", "fogo_presencial", "workshop_agua", "cacau",
    "ayahuasca", "concerto", "zap_pierre", "id_aluno_cliente", "turma", "conectado_proposito",
    "busca_espiritual", "lugar_musica_som", "participou_trabalho_som", "qual_trabalho_som",
    "midia_input", "midia_input_outro", "terapeuta", "formacao_musica_terapia", "objetivo_curso",
    "curso_proposito", "curso_expectativas", "outro_curso", "sentido_participar",
    "experiencia_ayahuasca", "psicodelicos_drogas", "trauma_vida",
    "ansiolitico_antidepressivos", "problema_saude", "psicoterapia_psiquiatria", "sensacao",
    "sensacao_perseguido", "covid", "comprovante_covid", "perfil_principal",
    "objetivos_declarados", "macrojornada_principal_id", "intencao_principal", "temperatura",
    "estilo_cognitivo", "velocidade_evolucao", "preferred_language", "consent_status",
    "numero_ref", "data_registro",
  ],
  sys_matriculas: [
    "pessoa_codigo_novo", "pessoa_codigo", "pessoa_nome", "celular_normalizado",
    "id_matricula_origem", "evento_codigo", "curso", "turma", "data_estimada", "estado",
    "comercial", "dados_contrato_recebidos", "contrato_enviado", "contrato_enviado_em",
    "contrato_retornado_em", "certificado_enviado", "linha_origem_csv",
  ],
  sys_participacoes: [
    "pessoa_codigo_novo", "pessoa_codigo", "pessoa_nome", "curso", "data", "local", "valor", "obs",
  ],
  sys_servicos: [
    "pessoa_codigo_novo", "pessoa_codigo", "pessoa_nome", "servico_nome", "data_interesse", "obs",
  ],
};

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const sourceArg = process.argv.find((arg) => arg.startsWith("--source="));
const confirmArg = process.argv.find((arg) => arg.startsWith("--confirm-replace="));
const confirmManifestArg = process.argv.find((arg) => arg.startsWith("--confirm-existing-sha256="));
const source = sourceArg?.slice("--source=".length);
if (!source) throw new Error("Informe --source=<arquivo-ou-url>; a fonte com dados pessoais não fica gravada no código.");
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function clean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "sim", "yes"].includes(normalized);
}

function dateOnly(value) {
  const normalized = clean(value);
  if (normalized === null) return null;
  if (normalized instanceof Date) return normalized.toISOString().slice(0, 10);
  const text = String(normalized);
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return null;
}

function historicalLocation(eventCode) {
  const normalized = String(eventCode ?? "").trim();
  const suffix = normalized.match(/_(SP|SC|RJ|MG|PR|RS|BA|DF|GO|ES|MT|RN|AL|PB|PE|CE|SE|PI|EXTERIOR)$/i)?.[1];
  if (suffix) return suffix.toUpperCase();
  if (/garopaba/i.test(normalized)) return "Garopaba — SC";
  if (/sarapu[ií]/i.test(normalized)) return "Sarapuí — SP";
  return null;
}

function canonicalValue(value) {
  const normalized = clean(value);
  return normalized === null ? null : String(normalized);
}

function participationFingerprint(record) {
  return JSON.stringify([
    Number(record.pessoa_id),
    canonicalValue(record.curso),
    dateOnly(record.data),
    canonicalValue(record.local),
    canonicalValue(record.valor),
    canonicalValue(record.obs),
  ]);
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function assertSameMultiset(expected, actual, label) {
  if (expected.size !== actual.size) {
    throw new Error(`Reconciliação de ${label} falhou: quantidades diferentes (${expected.size}/${actual.size}).`);
  }
  const expectedCounts = multiset(expected);
  const actualCounts = multiset(actual);
  for (const [fingerprint, count] of expectedCounts) {
    if (actualCounts.get(fingerprint) !== count) {
      throw new Error(`Reconciliação de ${label} falhou: conteúdo ou multiplicidade divergente.`);
    }
  }
}

function textArray(value) {
  const normalized = clean(value);
  if (normalized === null) return null;
  if (Array.isArray(normalized)) return normalized.map(String);
  return String(normalized)
    .split(/[|;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function rows(workbook, sheetName) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: null,
    raw: true,
  });
}

function placeholders(rowsCount, columnsCount, start = 1) {
  let parameter = start;
  return Array.from({ length: rowsCount }, () =>
    `(${Array.from({ length: columnsCount }, () => `$${parameter++}`).join(",")})`
  ).join(",");
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`Identificador SQL inválido: ${identifier}`);
  return `"${identifier}"`;
}

async function insertBatches(client, table, columns, records, suffix = "", batchSize = 300) {
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier);
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const values = batch.flatMap((record) => columns.map((column) => record[column] ?? null));
    await client.query(
      `INSERT INTO ${quotedTable} (${quotedColumns.join(",")}) VALUES ${placeholders(batch.length, columns.length)} ${suffix}`,
      values,
    );
  }
}

async function downloadWorkbook() {
  if (!source.startsWith("http://") && !source.startsWith("https://")) {
    return await import("node:fs/promises").then((fs) => fs.readFile(source));
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Falha ao baixar planilha: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function runBackup() {
  const directory = path.join(workspaceRoot, ".local/data-backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(directory, `soundfulness-preimport-${stamp}.dump`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const fileDescriptor = openSync(backupPath, "wx", 0o600);
  closeSync(fileDescriptor);
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const pgEnvironment = {
    ...process.env,
    PGHOST: databaseUrl.hostname,
    PGPORT: databaseUrl.port || "5432",
    PGUSER: decodeURIComponent(databaseUrl.username),
    PGPASSWORD: decodeURIComponent(databaseUrl.password),
    PGDATABASE: databaseUrl.pathname.replace(/^\//, ""),
  };
  const sslMode = databaseUrl.searchParams.get("sslmode");
  if (sslMode) pgEnvironment.PGSSLMODE = sslMode;
  const dump = spawnSync("pg_dump", ["--format=custom", `--file=${backupPath}`], {
    stdio: "inherit",
    env: pgEnvironment,
  });
  if (dump.status !== 0) {
    unlinkSync(backupPath);
    throw new Error("pg_dump falhou; carga cancelada.");
  }
  if ((statSync(backupPath).mode & 0o777) !== 0o600) {
    throw new Error("O backup não foi criado com permissão exclusiva do proprietário.");
  }
  const verify = spawnSync("pg_restore", ["--list", backupPath], { stdio: "ignore" });
  if (verify.status !== 0) throw new Error("O backup não passou na verificação do pg_restore.");
  return backupPath;
}

const buffer = await downloadWorkbook();
const digest = createHash("sha256").update(buffer).digest("hex");
if (digest !== EXPECTED.workbookSha256) {
  throw new Error(`Planilha inesperada: SHA-256 ${digest} não corresponde à fonte validada.`);
}
const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
for (const sheet of REQUIRED_SHEETS) {
  if (!workbook.SheetNames.includes(sheet)) throw new Error(`Aba obrigatória ausente: ${sheet}`);
}
for (const [sheet, expectedHeaders] of Object.entries(SHEET_HEADERS)) {
  const [actualHeaders] = XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, raw: true });
  if (JSON.stringify(actualHeaders) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`Cabeçalhos inesperados na aba ${sheet}; carga cancelada.`);
  }
}

const pessoasSource = rows(workbook, "sys_pessoas");
const matriculasSource = rows(workbook, "sys_matriculas");
const participacoesSource = rows(workbook, "sys_participacoes");
const servicosSource = rows(workbook, "sys_servicos");
const erros = rows(workbook, "ERROS");
const testRows = erros.filter((row) =>
  String(row.problema ?? "").toLowerCase().includes("parece registro de teste")
);
const testCodes = new Set(testRows.map((row) => String(row.codigo)));

const actual = {
  pessoas: pessoasSource.length,
  matriculas: matriculasSource.length,
  participacoes: participacoesSource.length,
  servicos: servicosSource.length,
  testFlags: testRows.length,
};
for (const key of ["pessoas", "matriculas", "participacoes", "servicos", "testFlags"]) {
  const expected = EXPECTED[key];
  if (actual[key] !== expected) {
    throw new Error(`Total inesperado em ${key}: esperado ${expected}, recebido ${actual[key]}`);
  }
}

const peopleCodes = new Set(pessoasSource.map((row) => String(row.codigo)));
if (peopleCodes.size !== pessoasSource.length) throw new Error("A aba sys_pessoas contém códigos duplicados.");
for (const code of testCodes) {
  if (!peopleCodes.has(code)) throw new Error("Um registro sinalizado como teste não existe em sys_pessoas.");
}

const missingPersonLinks = {
  matriculas: matriculasSource.filter((row) => !peopleCodes.has(String(row.pessoa_codigo_novo))).length,
  participacoes: participacoesSource.filter((row) => !peopleCodes.has(String(row.pessoa_codigo_novo))).length,
  servicos: servicosSource.filter((row) => !peopleCodes.has(String(row.pessoa_codigo_novo))).length,
};
if (Object.values(missingPersonLinks).some(Boolean)) {
  throw new Error(`Há vínculos sem pessoa correspondente: ${JSON.stringify(missingPersonLinks)}`);
}

const removed = pessoasSource.filter(
  (row) => !bool(row.ativo) && String(row.consent_status ?? "").toLowerCase() === "removido",
).length;
const eventsWithoutDate = new Set(
  matriculasSource
    .filter((row) => !dateOnly(row.data_estimada))
    .map((row) => String(row.evento_codigo ?? "")),
);
const datedEvents = new Set(
  matriculasSource
    .filter((row) => dateOnly(row.data_estimada))
    .map((row) => String(row.evento_codigo ?? "")),
);
for (const event of datedEvents) eventsWithoutDate.delete(event);
const unresolvedEnrollments = matriculasSource.filter((row) =>
  eventsWithoutDate.has(String(row.evento_codigo ?? ""))
).length;
const eventCourses = new Map();
const eventDates = new Map();
for (const row of matriculasSource) {
  const code = String(row.evento_codigo ?? "");
  const course = clean(row.curso);
  const date = dateOnly(row.data_estimada);
  const courses = eventCourses.get(code) ?? new Set();
  const dates = eventDates.get(code) ?? new Set();
  if (course) courses.add(String(course));
  if (date) dates.add(date);
  eventCourses.set(code, courses);
  eventDates.set(code, dates);
}
const ambiguousDatedEvents = [...datedEvents].filter(
  (code) => (eventCourses.get(code)?.size ?? 0) > 1 || (eventDates.get(code)?.size ?? 0) > 1,
);
if (ambiguousDatedEvents.length) {
  throw new Error(`Há códigos de evento com curso/data ambíguos: ${ambiguousDatedEvents.length}`);
}

const summary = {
  mode: execute ? "execute" : "dry-run",
  workbookSha256: digest,
  pessoas: pessoasSource.length,
  matriculasFonte: matriculasSource.length,
  participacoes: participacoesSource.length,
  servicos: servicosSource.length,
  marcacoesDeTeste: testRows.length,
  pessoasUnicasArquivadasComoTeste: testCodes.size,
  removidosDoMailing: removed,
  eventosSemData: eventsWithoutDate.size,
  matriculasSemDataDeEvento: unresolvedEnrollments,
  matriculasDeduplicadasEsperadas: new Set(
    matriculasSource.map((row) => `${String(row.pessoa_codigo_novo)}:${String(row.evento_codigo ?? "")}`),
  ).size,
};
if (
  eventsWithoutDate.size !== EXPECTED.undatedEvents ||
  unresolvedEnrollments !== EXPECTED.undatedEnrollmentRows ||
  summary.matriculasDeduplicadasEsperadas !== EXPECTED.deduplicatedEnrollments ||
  matriculasSource.length - summary.matriculasDeduplicadasEsperadas !== EXPECTED.duplicateEnrollmentRows
) {
  throw new Error(
    "Cardinalidades históricas divergentes: esperados 29 eventos sem data, 938 linhas sem data, " +
    "3.546 matrículas deduplicadas e 16 duplicatas.",
  );
}
const existingRowsForPlan = await pool.query("SELECT id, codigo FROM pessoas ORDER BY id");
const existingManifestSha256 = createHash("sha256")
  .update(JSON.stringify(existingRowsForPlan.rows))
  .digest("hex");
summary.existingPeople = existingRowsForPlan.rowCount;
summary.existingManifestSha256 = existingManifestSha256;
console.log(JSON.stringify(summary, null, 2));
if (!execute) {
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
const report = { ...summary, backupPath: null, deletedLegacyPeople: 0, importedEnrollments: 0 };

try {
  await client.query("BEGIN");
  // Enter a database-wide read-only maintenance window before taking the
  // backup. SHARE locks allow pg_dump to read while preventing any application
  // write from landing outside the backup snapshot during replacement.
  const publicTables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  if (publicTables.rowCount) {
    const tableList = publicTables.rows.map((row) => quoteIdentifier(row.tablename)).join(",");
    await client.query(`LOCK TABLE ${tableList} IN SHARE MODE`);
  }
  report.backupPath = runBackup();
  const sourceCodeCount = await client.query(
    "SELECT count(*)::int AS count FROM pessoas WHERE codigo = ANY($1::text[])",
    [[...peopleCodes]],
  );
  const firstImport = sourceCodeCount.rows[0].count === 0;
  const completeRerun = sourceCodeCount.rows[0].count === pessoasSource.length;
  if (!firstImport && !completeRerun) {
    throw new Error(
      `Carga parcial detectada (${sourceCodeCount.rows[0].count}/${pessoasSource.length} pessoas). ` +
      "A execução foi interrompida para não misturar estados.",
    );
  }

  if (firstImport) {
    const current = await client.query("SELECT id, codigo FROM pessoas ORDER BY id");
    const confirmedCount = Number(confirmArg?.slice("--confirm-replace=".length));
    if (!Number.isInteger(confirmedCount) || confirmedCount !== current.rowCount) {
      throw new Error(
        `Confirmação destrutiva ausente ou incorreta. Use --confirm-replace=${current.rowCount} após revisar a simulação.`,
      );
    }
    const currentManifestSha256 = createHash("sha256")
      .update(JSON.stringify(current.rows))
      .digest("hex");
    const confirmedManifest = confirmManifestArg?.slice("--confirm-existing-sha256=".length);
    if (!confirmedManifest || confirmedManifest !== currentManifestSha256) {
      throw new Error(
        "O manifesto exato das pessoas existentes não foi confirmado. " +
        `Revise a simulação e use --confirm-existing-sha256=${currentManifestSha256}.`,
      );
    }
    if (current.rowCount > 100) {
      throw new Error(`Proteção acionada: ${current.rowCount} pessoas existentes antes da primeira carga.`);
    }
    report.deletedLegacyPeople = current.rowCount;
    await client.query("CREATE TEMP TABLE legacy_people AS SELECT id FROM pessoas");
    await client.query("ALTER TABLE commercial_opportunity_events DISABLE TRIGGER commercial_opportunity_events_append_only");
    await client.query(`
      DELETE FROM commercial_opportunity_events
      WHERE opportunity_id IN (
        SELECT id FROM commercial_opportunities WHERE pessoa_id IN (SELECT id FROM legacy_people)
      )
    `);
    await client.query("ALTER TABLE commercial_opportunity_events ENABLE TRIGGER commercial_opportunity_events_append_only");
    await client.query("DELETE FROM commercial_opportunities WHERE pessoa_id IN (SELECT id FROM legacy_people)");
    await client.query("DELETE FROM evento_preinscricoes WHERE pessoa_id IN (SELECT id FROM legacy_people)");
    await client.query("DELETE FROM evento_formulario_submissoes WHERE pessoa_id IN (SELECT id FROM legacy_people)");
    await client.query("DELETE FROM enrollments WHERE pessoa_id IN (SELECT id FROM legacy_people)");
    await client.query("DELETE FROM video_envios WHERE pessoa_id IN (SELECT id FROM legacy_people)");
    await client.query("DELETE FROM conversations WHERE pessoa_id IN (SELECT id FROM legacy_people)");
    await client.query("SET LOCAL app.allow_evidencia_cascade_delete = 'on'");
    await client.query("DELETE FROM pessoas WHERE id IN (SELECT id FROM legacy_people)");
  }

  const sourceColumns = Object.keys(pessoasSource[0]).filter(
    (column) => !["codigo_ref", "celular_normalizado"].includes(column),
  );
  const peopleColumns = [...sourceColumns, "arquivado_em"];
  const peopleRecords = pessoasSource.map((sourceRow) => {
    const record = {};
    for (const column of sourceColumns) {
      const value = sourceRow[column];
      if (column === "ativo") record[column] = bool(value);
      else if (["data_nascimento", "data_registro"].includes(column)) record[column] = dateOnly(value);
      else if (column === "numero_ref") record[column] = clean(value) === null ? null : Number(value);
      else if (column === "objetivos_declarados") record[column] = textArray(value);
      else record[column] = clean(value);
    }
    record.arquivado_em = testCodes.has(String(sourceRow.codigo)) ? new Date() : null;
    return record;
  });
  if (firstImport) {
    await insertBatches(client, "pessoas", peopleColumns, peopleRecords, "", 250);
  }

  const codeRows = await client.query(
    "SELECT id, codigo FROM pessoas WHERE codigo = ANY($1::text[])",
    [[...peopleCodes]],
  );
  const pessoaIds = new Map(codeRows.rows.map((row) => [row.codigo, row.id]));

  const participationRecords = participacoesSource.map((row) => ({
    pessoa_id: pessoaIds.get(String(row.pessoa_codigo_novo)),
    curso: clean(row.curso) ?? "Não informado",
    data: dateOnly(row.data),
    local: clean(row.local),
    valor: clean(row.valor),
    obs: clean(row.obs),
  }));
  const serviceRecords = servicosSource.map((row) => ({
    pessoa_id: pessoaIds.get(String(row.pessoa_codigo_novo)),
    servico_nome: clean(row.servico_nome) ?? "Não informado",
    data_interesse: dateOnly(row.data_interesse),
    obs: clean(row.obs),
  }));

  if (firstImport) {
    await insertBatches(
      client,
      "pessoa_participacoes",
      ["pessoa_id", "curso", "data", "local", "valor", "obs"],
      participationRecords,
    );
    await insertBatches(
      client,
      "pessoa_servicos",
      ["pessoa_id", "servico_nome", "data_interesse", "obs"],
      serviceRecords,
    );
  }

  const courseNames = [...new Set(
    matriculasSource
      .map((row) => clean(row.curso) ?? "Não informado"),
  )];
  const courseIds = new Map();
  for (const name of courseNames) {
    let result = await client.query("SELECT id FROM courses WHERE name=$1 ORDER BY id LIMIT 1", [name]);
    if (!result.rowCount) {
      result = await client.query(
        `INSERT INTO courses (name,cycle,modality,workload,price,description,active)
         VALUES ($1,'histórico','não informada',0,0,'Importado da base histórica; metadados não disponíveis na origem.',false)
         RETURNING id`,
        [name],
      );
    }
    courseIds.set(name, result.rows[0].id);
  }

  const eventMeta = new Map();
  for (const row of matriculasSource) {
    const eventCode = String(row.evento_codigo ?? "");
    if (eventMeta.has(eventCode)) continue;
    const sameEvent = matriculasSource.filter((item) => String(item.evento_codigo ?? "") === eventCode);
    const dated = sameEvent.find((item) => dateOnly(item.data_estimada));
    eventMeta.set(eventCode, {
      course: clean(dated?.curso) ?? clean(row.curso) ?? "Não informado",
      date: dateOnly(dated?.data_estimada),
      // `estado` é o estado da pessoa, não o local da turma. Para as turmas
      // históricas, só usamos local quando ele está codificado no evento.
      location: historicalLocation(eventCode),
      capacity: Math.max(20, sameEvent.length),
    });
  }

  const classIds = new Map();
  for (const [code, meta] of eventMeta) {
    const courseId = courseIds.get(meta.course);
    let result = await client.query(
      "SELECT id FROM classes WHERE course_id=$1 AND code=$2 ORDER BY id LIMIT 1",
      [courseId, code],
    );
    if (!result.rowCount) {
      result = await client.query(
        `INSERT INTO classes (course_id,code,location,start_date,end_date,capacity,teacher,status)
         VALUES ($1,$2,$3,$4,$4,$5,'Não informado',$6) RETURNING id`,
        [
          courseId,
          code,
          meta.location,
          meta.date,
          meta.capacity,
          !meta.date || meta.date < new Date().toISOString().slice(0, 10) ? "Encerrada" : "Planejada",
        ],
      );
    }
    classIds.set(code, result.rows[0].id);
  }

  const seenEnrollment = new Set();
  const enrollmentRecords = [];
  for (const row of matriculasSource) {
    const code = String(row.evento_codigo ?? "");
    const classId = classIds.get(code);
    if (!classId) continue;
    const pessoaId = pessoaIds.get(String(row.pessoa_codigo_novo));
    const key = `${pessoaId}:${classId}`;
    if (seenEnrollment.has(key)) continue;
    seenEnrollment.add(key);
    enrollmentRecords.push({
      pessoa_id: pessoaId,
      class_id: classId,
      price: "0",
      payment_status: "pending",
      contract_status: clean(row.contrato_retornado_em)
        ? "Assinado"
        : "pending",
    });
  }
  const sourceClassIds = [...classIds.values()];
  const storedBefore = await client.query(
    `SELECT pessoa_id, class_id
     FROM enrollments
     WHERE pessoa_id = ANY($1::int[]) AND class_id = ANY($2::int[])`,
    [[...pessoaIds.values()], sourceClassIds],
  );
  const storedKeysBefore = new Set(
    storedBefore.rows.map((row) => `${row.pessoa_id}:${row.class_id}`),
  );
  const missingBefore = enrollmentRecords.filter(
    (record) => !storedKeysBefore.has(`${record.pessoa_id}:${record.class_id}`),
  ).length;
  let insertedEnrollments = 0;
  for (const record of enrollmentRecords) {
    const inserted = await client.query(
      `INSERT INTO enrollments (pessoa_id,class_id,price,payment_status,contract_status)
       SELECT $1,$2,$3,$4,$5
       WHERE NOT EXISTS (SELECT 1 FROM enrollments WHERE pessoa_id=$1 AND class_id=$2)`,
      [record.pessoa_id, record.class_id, record.price, record.payment_status, record.contract_status],
    );
    insertedEnrollments += inserted.rowCount ?? 0;
  }
  report.importedEnrollments = enrollmentRecords.length;
  report.insertedEnrollments = insertedEnrollments;

  if (enrollmentRecords.length !== EXPECTED.deduplicatedEnrollments) {
    throw new Error(
      `Reconciliação falhou: esperadas ${EXPECTED.deduplicatedEnrollments} matrículas deduplicadas, ` +
      `preparadas ${enrollmentRecords.length}.`,
    );
  }
  if (insertedEnrollments !== missingBefore) {
    throw new Error(
      `Reconciliação falhou: faltavam ${missingBefore} matrículas, mas ${insertedEnrollments} foram inseridas.`,
    );
  }
  const storedAfter = await client.query(
    `SELECT pessoa_id, class_id
     FROM enrollments
     WHERE pessoa_id = ANY($1::int[]) AND class_id = ANY($2::int[])`,
    [[...pessoaIds.values()], sourceClassIds],
  );
  assertSameMultiset(
    enrollmentRecords.map((record) => `${record.pessoa_id}:${record.class_id}`),
    storedAfter.rows.map((row) => `${row.pessoa_id}:${row.class_id}`),
    "matrículas",
  );

  const importedParticipations = await client.query(
    `SELECT pessoa_id, curso, data, local, valor, obs
     FROM pessoa_participacoes
     WHERE pessoa_id = ANY($1::int[])`,
    [[...pessoaIds.values()]],
  );
  assertSameMultiset(
    participationRecords.map(participationFingerprint),
    importedParticipations.rows.map(participationFingerprint),
    "participações",
  );
  report.reconciliation = {
    sourceParticipations: participacoesSource.length,
    storedParticipations: importedParticipations.rowCount,
    sourceEnrollments: matriculasSource.length,
    deduplicatedEnrollments: storedAfter.rowCount,
    duplicateEnrollmentRows: EXPECTED.duplicateEnrollmentRows,
    missingEnrollmentsBeforeImport: missingBefore,
  };

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

const reportDirectory = path.join(workspaceRoot, ".local/import-reports");
await mkdir(reportDirectory, { recursive: true });
const reportPath = path.join(
  reportDirectory,
  `soundfulness-clientes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ success: true, reportPath, ...report }, null, 2));