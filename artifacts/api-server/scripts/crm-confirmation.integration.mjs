import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const sourceDatabaseUrl = process.env.DATABASE_URL;
if (!sourceDatabaseUrl) {
  throw new Error("DATABASE_URL must point to a provisioned PostgreSQL database.");
}

const sourceUrl = new URL(sourceDatabaseUrl);
const sourceDatabaseName = decodeURIComponent(sourceUrl.pathname.slice(1));
if (!sourceDatabaseName) {
  throw new Error("DATABASE_URL must include a source database name.");
}

const marker = `crm-confirmation-test-${randomUUID().replaceAll("-", "")}`;
const disposableUrl = new URL(sourceUrl.toString());
disposableUrl.pathname = `/${encodeURIComponent(marker)}`;

function quoteIdentifier(value) {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll(`'`, `''`)}'`;
}

function runPsql(url, sql) {
  const result = spawnSync(
    "psql",
    [url, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--command", sql],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`psql exited with status ${result.status ?? "unknown"}`);
  }
}

let databaseCreated = false;
let testStatus = 1;
try {
  // PostgreSQL TEMPLATE cloning copies the already-applied application schema,
  // including the append-only event trigger. The source database is never used
  // by the test process itself.
  runPsql(
    sourceDatabaseUrl,
    `CREATE DATABASE ${quoteIdentifier(marker)} TEMPLATE ${quoteIdentifier(sourceDatabaseName)};`,
  );
  databaseCreated = true;

  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.crm-integration.config.ts",
    ],
    {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: disposableUrl.toString(),
        CRM_CONFIRMATION_DISPOSABLE: marker,
      },
    },
  );
  if (result.error) throw result.error;
  testStatus = result.status ?? 1;
} finally {
  if (databaseCreated) {
    // FORCE also handles a test process that exits while a pool connection is
    // still draining. It only terminates sessions connected to this disposable
    // database, never sessions using the source DATABASE_URL.
    runPsql(
      sourceDatabaseUrl,
      `DROP DATABASE IF EXISTS ${quoteIdentifier(marker)} WITH (FORCE);`,
    );
  }
}

process.exitCode = testStatus;