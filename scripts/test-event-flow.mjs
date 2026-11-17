// Isolated, schema-only clone: no production access, no copied personal data.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
const source = process.env.DATABASE_URL;
if (!source) throw new Error("DATABASE_URL required");
const name = `event-flow-test-${randomBytes(16).toString("hex")}`;
const target = new URL(source); target.pathname = `/${name}`;
const file = `/tmp/${name}.sql`;
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr ?? "").replaceAll(source, "[database]").replaceAll(target.toString(), "[disposable]")}`);
  return result.stdout;
}
try {
  run("psql", [source, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${name}"`]);
  writeFileSync(file, run("pg_dump", [source, "--schema-only", "--no-owner", "--no-privileges"]));
  run("psql", [target.toString(), "-v", "ON_ERROR_STOP=1", "-f", file]);
  const result = spawnSync("pnpm", ["--filter", "@workspace/api-server", "exec", "vitest", "run", "--config", "vitest.event-flow.config.ts"], {
    env: { ...process.env, DATABASE_URL: target.toString(), EVENT_FLOW_DISPOSABLE: name }, stdio: "inherit",
  });
  if (result.status !== 0) process.exitCode = 1;
} finally {
  run("psql", [source, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
  rmSync(file, { force: true });
}
