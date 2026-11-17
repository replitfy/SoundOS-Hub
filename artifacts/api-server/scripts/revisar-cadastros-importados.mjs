import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { pool } from "@workspace/db";

const sourceArg = process.argv.find((arg) => arg.startsWith("--source="));
const source = sourceArg?.slice("--source=".length);
if (!source) throw new Error("Informe --source=<arquivo-xlsx>.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workbook = XLSX.readFile(source, { cellDates: true });
const requiredSheets = ["ERROS", "REVISAR", "DUPLICATAS", "sys_pessoas"];
for (const sheet of requiredSheets) {
  if (!workbook.SheetNames.includes(sheet)) throw new Error(`Aba obrigatória ausente: ${sheet}`);
}

const rows = (sheet) => XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { defval: null, raw: true });
const clean = (value) => String(value ?? "").trim();
const normalized = (value) =>
  clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const splitCodes = (value) => clean(value).split(/[|;,\n]+/).map((item) => item.trim()).filter(Boolean);
const countBy = (items, key) =>
  Object.fromEntries([...items.reduce((map, item) => {
    const value = item[key];
    map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b)));

const sourcePeople = rows("sys_pessoas");
const sourceByCode = new Map(sourcePeople.map((person) => [clean(person.codigo), person]));
const databasePeople = await pool.query(`
  SELECT codigo, ativo, consent_status, arquivado_em
  FROM pessoas
  WHERE codigo IS NOT NULL
`);
const databaseByCode = new Map(databasePeople.rows.map((person) => [clean(person.codigo), person]));

const errorDecisions = rows("ERROS").map((item) => {
  const code = clean(item.codigo);
  const problem = normalized(item.problema);
  const person = sourceByCode.get(code);
  const databasePerson = databaseByCode.get(code);
  let classification = "pending_manual_correction";

  if (!person || !databasePerson) classification = "pending_missing_person";
  else if (problem.includes("pareceregistrodeteste")) {
    classification = databasePerson.arquivado_em ? "resolved_archived_test" : "pending_archive_test";
  } else if (item.correcao_sugerida && clean(person[item.campo]) === clean(item.correcao_sugerida)) {
    classification = "resolved_suggested_correction_applied";
  } else if (problem.includes("semnome")) {
    classification = "pending_missing_name";
  } else if (problem.includes("dataforadafaixaplausivel")) {
    classification = "pending_implausible_birth_date";
  } else if (clean(item.campo) === "celular") {
    classification = "pending_invalid_phone";
  } else if (clean(item.campo) === "email") {
    classification = "pending_invalid_email";
  }

  return { sheet: "ERROS", code, classification };
});

const reviewDecisions = rows("REVISAR").map((item) => {
  const code = clean(item.codigo);
  const personExists = sourceByCode.has(code) && databaseByCode.has(code);
  const hasExactKey = Boolean(clean(item.chave_email) || clean(item.chave_celular));
  return {
    sheet: "REVISAR",
    code,
    classification: personExists && hasExactKey
      ? "resolved_source_merge_has_exact_contact_key"
      : "pending_source_merge_evidence",
  };
});

const duplicateDecisions = rows("DUPLICATAS").map((item, index) => {
  const codes = splitCodes(item.codigos);
  const people = codes.map((code) => sourceByCode.get(code));
  const allPresent = people.every(Boolean);
  const names = new Set(people.map((person) => normalized(`${person?.nome ?? ""}${person?.sobrenome ?? ""}`)).filter(Boolean));
  const emails = new Set(people.map((person) => normalized(person?.email)).filter(Boolean));
  const phones = new Set(people.map((person) => clean(person?.celular_normalizado).replace(/\D/g, "")).filter(Boolean));
  const birthDates = new Set(people.map((person) => clean(person?.data_nascimento).slice(0, 10)).filter(Boolean));
  const strongEvidence =
    people.length >= 2 &&
    allPresent &&
    names.size === 1 &&
    emails.size === 1 &&
    phones.size === 1 &&
    emails.size > 0 &&
    phones.size > 0 &&
    birthDates.size <= 1;

  let classification = "resolved_keep_separate_insufficient_evidence";
  if (!allPresent) classification = "pending_missing_person";
  else if (strongEvidence) classification = "pending_safe_merge_workflow";

  return {
    sheet: "DUPLICATAS",
    case: index + 1,
    codes,
    classification,
  };
});

const removedStatus = await pool.query(`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE ativo = false AND lower(consent_status) = 'removido')::int AS protected
  FROM pessoas
  WHERE lower(consent_status) = 'removido'
`);
const removed = removedStatus.rows[0];
if (removed.total !== removed.protected) {
  throw new Error("Há contatos removidos ativos ou com consentimento incompatível; revisão interrompida.");
}

const allDecisions = [...errorDecisions, ...reviewDecisions, ...duplicateDecisions];
const summary = {
  generatedAt: new Date().toISOString(),
  containsPii: false,
  sourceRows: {
    erros: errorDecisions.length,
    revisar: reviewDecisions.length,
    duplicatas: duplicateDecisions.length,
  },
  classifications: {
    erros: countBy(errorDecisions, "classification"),
    revisar: countBy(reviewDecisions, "classification"),
    duplicatas: countBy(duplicateDecisions, "classification"),
  },
  totals: {
    resolved: allDecisions.filter((item) => item.classification.startsWith("resolved_")).length,
    pending: allDecisions.filter((item) => item.classification.startsWith("pending_")).length,
    mergesExecuted: 0,
  },
  removedContacts: {
    total: removed.total,
    inactiveAndWithoutConsent: removed.protected,
  },
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const privateDirectory = path.join(root, ".local/review-reports");
const privatePath = path.join(privateDirectory, `cadastros-${stamp}.json`);
await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
await writeFile(privatePath, JSON.stringify({ summary, decisions: allDecisions }, null, 2), { mode: 0o600 });
await chmod(privatePath, 0o600);

const aggregatePath = path.join(root, "docs/cadastros-importados-revisao.json");
await writeFile(aggregatePath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ success: true, privateReport: privatePath, aggregateReport: aggregatePath, summary }, null, 2));
await pool.end();