import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Roda os testes da carga de clientes novos do Airtable contra um banco descartável. O esquema é copiado do
// banco de origem com pg_dump --schema-only (e não com TEMPLATE, que exige zero sessões abertas e falha com o
// servidor de desenvolvimento ligado). Nenhum dado do banco de origem é copiado.
const sourceDatabaseUrl = process.env.DATABASE_URL;
if (!sourceDatabaseUrl) {
  throw new Error("DATABASE_URL must point to a provisioned PostgreSQL database.");
}

const sourceUrl = new URL(sourceDatabaseUrl);
const marker = `airtable-carga-test-${randomUUID().replaceAll("-", "")}`;
const disposableUrl = new URL(sourceUrl.toString());
disposableUrl.pathname = `/${encodeURIComponent(marker)}`;

function quoteIdentifier(value) {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

let databaseCreated = false;
let testStatus = 1;
try {
  run("psql", [sourceDatabaseUrl, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--command", `CREATE DATABASE ${quoteIdentifier(marker)};`]);
  databaseCreated = true;

  const dump = spawnSync(
    "pg_dump",
    [sourceDatabaseUrl, "--schema-only", "--no-owner", "--no-privileges"],
    { env: process.env, maxBuffer: 256 * 1024 * 1024 },
  );
  if (dump.error) throw dump.error;
  if (dump.status !== 0) throw new Error(`pg_dump exited with status ${dump.status ?? "unknown"}: ${dump.stderr}`);
  const restore = spawnSync(
    "psql",
    [disposableUrl.toString(), "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1"],
    { input: dump.stdout, env: process.env, stdio: ["pipe", "ignore", "inherit"], maxBuffer: 256 * 1024 * 1024 },
  );
  if (restore.error) throw restore.error;
  if (restore.status !== 0) throw new Error(`psql restore exited with status ${restore.status ?? "unknown"}`);

  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.airtable-carga.config.ts"],
    {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: disposableUrl.toString(), AIRTABLE_CARGA_DISPOSABLE: marker },
    },
  );
  if (result.error) throw result.error;
  testStatus = result.status ?? 1;
} finally {
  if (databaseCreated) {
    // FORCE só encerra sessões deste banco descartável, nunca as do DATABASE_URL de origem.
    run("psql", [sourceDatabaseUrl, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--command", `DROP DATABASE IF EXISTS ${quoteIdentifier(marker)} WITH (FORCE);`]);
  }
}

process.exitCode = testStatus;
