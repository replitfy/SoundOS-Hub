import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chromium } from "playwright-core";
import { db, usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:80";
const browserExecutable = process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium";
const runId = `${Date.now()}-${process.pid}`;
const createdIds = [];

function sessionToken(userId) {
  const secret = process.env.SESSION_SECRET;
  assert(secret, "SESSION_SECRET is required for the authenticated users E2E test");
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function createUser(name, role) {
  const [user] = await db.insert(usersTable).values({
    name,
    email: `e2e-users-${createdIds.length}-${runId}@example.test`,
    role,
    active: true,
  }).returning();
  createdIds.push(user.id);
  return user;
}

let browser;
try {
  const actor = await createUser(`E2E Bulk Actor ${runId}`, "admin_master");
  const first = await createUser(`E2E Bulk First ${runId}`, "usuario");
  const second = await createUser(`E2E Bulk Second ${runId}`, "assistente");
  const atomicTarget = await createUser(`E2E Bulk Atomic ${runId}`, "admin");
  const token = sessionToken(actor.id);

  browser = await chromium.launch({
    executablePath: browserExecutable,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ actor, token }) => {
    localStorage.setItem("soundos_lang", "pt");
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: actor.id,
      name: actor.name,
      email: actor.email,
      role: actor.role,
      sessionToken: token,
    }));
  }, { actor, token });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseUrl}/admin/usuarios`, { waitUntil: "networkidle" });

  assert(await page.getByTestId(`checkbox-user-${actor.id}`).isDisabled(), "Current user must not be selectable");
  await page.getByTestId(`checkbox-user-${first.id}`).click();
  await page.getByTestId(`checkbox-user-${second.id}`).click();
  await page.getByTestId("button-bulk-delete-users").click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText(first.name, { exact: false }).waitFor();
  await dialog.getByText(second.name, { exact: false }).waitFor();

  const bulkResponse = page.waitForResponse(response =>
    response.url().endsWith("/api/admin/users/bulk-delete") &&
    response.request().method() === "POST");
  await page.getByTestId("button-confirm-bulk-delete-users").click();
  assert.equal((await bulkResponse).status(), 200);
  await page.getByText(first.name, { exact: true }).waitFor({ state: "detached" });

  const deactivated = await db.select({ id: usersTable.id, active: usersTable.active })
    .from(usersTable).where(inArray(usersTable.id, [first.id, second.id]));
  assert(deactivated.every(user => !user.active), "All selected users must be deactivated");

  const selfResponse = await fetch(`${baseUrl}/api/admin/users/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids: [actor.id] }),
  });
  assert.equal(selfResponse.status, 409);

  const atomicResponse = await fetch(`${baseUrl}/api/admin/users/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids: [atomicTarget.id, 2_000_000_000] }),
  });
  assert.equal(atomicResponse.status, 404);
  const [stillActive] = await db.select({ active: usersTable.active })
    .from(usersTable).where(eq(usersTable.id, atomicTarget.id));
  assert.equal(stillActive.active, true, "A failed batch must not partially deactivate users");
  assert.deepEqual(errors, []);
  console.log("PASS users bulk deletion: UI selection, self-protection and atomic rollback");
  await context.close();
} finally {
  if (browser) await browser.close();
  if (createdIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdIds));
  }
}