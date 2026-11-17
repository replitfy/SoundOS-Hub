import { pool } from "@workspace/db";
import { cleanupUnnamedPeople } from "../src/services/unnamedPeopleCleanup";

try {
  const result = await cleanupUnnamedPeople();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}