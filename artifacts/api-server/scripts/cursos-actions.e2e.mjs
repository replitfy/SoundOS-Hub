import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chromium } from "playwright-core";
import { and, count, eq } from "drizzle-orm";
import {
  classesTable,
  coursesTable,
  cursosInscricao,
  db,
  pessoaServicos,
  pessoasTable,
  usersTable,
} from "@workspace/db";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:80";
const browserExecutable = process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium";
const runId = `${Date.now()}-${process.pid}`;
const createdUserIds = [];
const createdPessoaIds = [];
const createdEventIds = [];
const createdClassIds = [];
const createdCourseIds = [];

function sessionToken(userId) {
  const secret = process.env.SESSION_SECRET;
  assert(secret, "SESSION_SECRET is required for the authenticated E2E test");
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function createUser(role, suffix) {
  const [user] = await db.insert(usersTable).values({
    name: `E2E ${role}`,
    email: `e2e-eventos-${suffix}-${runId}@example.test`,
    role,
    active: true,
  }).returning();
  createdUserIds.push(user.id);
  return user;
}

async function createFixtures(suffix) {
  const slug = `e2e-evento-${suffix}-${runId}`;
  const [event] = await db.insert(cursosInscricao).values({
    slug,
    nome: `E2E Evento ${suffix}`,
    descricao: "Descrição preservada",
    local: "Local preservado",
    observacoes: "Histórico preservado",
    ativo: true,
    nucleo: "EDUCATION",
    tipoEvento: "CURSO",
  }).returning();
  createdEventIds.push(event.id);

  const [course] = await db.insert(coursesTable).values({
    name: `E2E Curso ${suffix}`,
    cycle: "E2E",
    modality: "Presencial",
    workload: 1,
    price: "1.00",
  }).returning();
  createdCourseIds.push(course.id);

  const [classRecord] = await db.insert(classesTable).values({
    courseId: course.id,
    code: `E2E-${suffix}-${runId}`,
    startDate: "2026-10-10",
    endDate: "2026-10-11",
    teacher: "E2E",
  }).returning();
  createdClassIds.push(classRecord.id);

  const [managed] = await db.insert(cursosInscricao).values({
    slug: `e2e-turma-${suffix}-${runId}`,
    nome: `E2E Turma ${suffix}`,
    observacoes: "Gerido pela turma",
    ativo: true,
    nucleo: "EDUCATION",
    tipoEvento: "CURSO",
    courseId: course.id,
    classId: classRecord.id,
  }).returning();
  createdEventIds.push(managed.id);

  const [person] = await db.insert(pessoasTable).values({
    codigo: `E2E-${suffix}-${runId}`,
    nome: `Inscrito ${suffix}`,
    email: `inscrito-${suffix}-${runId}@example.test`,
  }).returning();
  createdPessoaIds.push(person.id);

  await db.insert(pessoaServicos).values({
    pessoaId: person.id,
    servicoNome: event.nome,
    cursosInscricaoId: event.id,
    obs: "Inscrição via formulário público",
  });

  return { event, managed, person };
}

async function readEvent(id) {
  const [event] = await db.select().from(cursosInscricao).where(eq(cursosInscricao.id, id)).limit(1);
  assert(event, `Event ${id} should still exist`);
  return event;
}

async function countRegistrations(eventId, personId) {
  const [row] = await db
    .select({ value: count() })
    .from(pessoaServicos)
    .where(and(
      eq(pessoaServicos.cursosInscricaoId, eventId),
      eq(pessoaServicos.pessoaId, personId),
    ));
  return Number(row?.value ?? 0);
}

async function installSession(context, lang, user, token) {
  await context.addInitScript(({ lang, user, token }) => {
    localStorage.setItem("soundos_lang", lang);
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sessionToken: token,
    }));
  }, { lang, user, token });
}

async function runScenario(browser, admin, regularUser, scenario) {
  const fixtures = await createFixtures(`${scenario.lang}-${scenario.width}`);
  const original = {
    slug: fixtures.event.slug,
    observacoes: fixtures.event.observacoes,
    registrationCount: await countRegistrations(fixtures.event.id, fixtures.person.id),
  };
  assert.equal(original.registrationCount, 1);

  const context = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.width < 600 ? 844 : 900 },
  });
  await installSession(context, scenario.lang, admin, sessionToken(admin.id));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/education/cursos`, { waitUntil: "networkidle" });
  await page.getByText(fixtures.event.nome, { exact: true }).waitFor();

  const managedRow = page.getByText(fixtures.managed.nome, { exact: true }).locator("xpath=ancestor::tr");
  await assert.doesNotReject(() => managedRow.waitFor());
  assert.equal(await managedRow.getByRole("button", { name: new RegExp(fixtures.managed.nome) }).count(), 0);

  const editLabel = scenario.lang === "fr" ? `Modifier ${fixtures.event.nome}` : `Editar ${fixtures.event.nome}`;
  await page.getByRole("button", { name: editLabel }).click();
  const inputIndex = await page.locator("input").evaluateAll((inputs, value) =>
    inputs.findIndex((input) => input.value === value), fixtures.event.nome);
  assert.notEqual(inputIndex, -1, "The edit form should open with the current event name");
  const editedName = `${fixtures.event.nome} editado`;
  await page.locator("input").nth(inputIndex).fill(editedName);

  const editResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/cursos-inscricao/${fixtures.event.id}`)
      && response.request().method() === "PATCH");
  await page.getByRole("button", { name: scenario.save, exact: true }).click();
  const editResponse = await editResponsePromise;
  assert.equal(editResponse.status(), 200);
  assert.match(editResponse.request().headers().authorization ?? "", /^Bearer /);
  await page.getByText(editedName, { exact: true }).waitFor();

  let persisted = await readEvent(fixtures.event.id);
  assert.equal(persisted.nome, editedName);
  assert.equal(persisted.slug, original.slug);
  assert.equal(persisted.observacoes, original.observacoes);

  const archiveLabel = scenario.lang === "fr" ? `Archiver ${editedName}` : `Arquivar ${editedName}`;
  await page.getByRole("button", { name: archiveLabel }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await assert.doesNotReject(() => dialog.getByText(scenario.preservationText, { exact: false }).waitFor());

  const archiveResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/cursos-inscricao/${fixtures.event.id}`)
      && response.request().method() === "PATCH");
  await dialog.getByRole("button", { name: scenario.archive, exact: true }).click();
  const archiveResponse = await archiveResponsePromise;
  assert.equal(archiveResponse.status(), 200);
  assert.match(archiveResponse.request().headers().authorization ?? "", /^Bearer /);
  const eventRow = page.getByText(editedName, { exact: true }).locator("xpath=ancestor::tr");
  await eventRow.getByText(scenario.archived, { exact: true }).waitFor();

  persisted = await readEvent(fixtures.event.id);
  assert.equal(persisted.ativo, false);
  assert.equal(persisted.slug, original.slug);
  assert.equal(persisted.observacoes, original.observacoes);
  assert.equal(await countRegistrations(fixtures.event.id, fixtures.person.id), original.registrationCount);

  const restoreLabel = scenario.lang === "fr" ? `Restaurer ${editedName}` : `Restaurar ${editedName}`;
  const restoreResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/cursos-inscricao/${fixtures.event.id}`)
      && response.request().method() === "PATCH");
  await page.getByRole("button", { name: restoreLabel }).click();
  const restoreResponse = await restoreResponsePromise;
  assert.equal(restoreResponse.status(), 200);
  assert.match(restoreResponse.request().headers().authorization ?? "", /^Bearer /);
  await eventRow.getByText(scenario.active, { exact: true }).waitFor();
  persisted = await readEvent(fixtures.event.id);
  assert.equal(persisted.ativo, true);

  await context.close();

  const regularContext = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.width < 600 ? 844 : 900 },
  });
  await installSession(regularContext, scenario.lang, regularUser, sessionToken(regularUser.id));
  const regularPage = await regularContext.newPage();
  await regularPage.goto(`${baseUrl}/education/cursos`, { waitUntil: "networkidle" });
  await regularPage.getByText(editedName, { exact: true }).waitFor();
  assert.equal(await regularPage.getByRole("button", { name: new RegExp(`(Editar|Modifier) ${editedName}`) }).count(), 0);
  assert.equal(await regularPage.getByRole("button", { name: new RegExp(`(Arquivar|Archiver|Restaurar|Restaurer) ${editedName}`) }).count(), 0);
  await regularContext.close();
}

async function cleanup() {
  if (createdPessoaIds.length > 0) {
    await db.delete(pessoasTable).where(eq(pessoasTable.id, createdPessoaIds[0]));
    for (const id of createdPessoaIds.slice(1)) await db.delete(pessoasTable).where(eq(pessoasTable.id, id));
  }
  if (createdEventIds.length > 0) {
    await db.delete(cursosInscricao).where(eq(cursosInscricao.id, createdEventIds[0]));
    for (const id of createdEventIds.slice(1)) await db.delete(cursosInscricao).where(eq(cursosInscricao.id, id));
  }
  if (createdClassIds.length > 0) {
    await db.delete(classesTable).where(eq(classesTable.id, createdClassIds[0]));
    for (const id of createdClassIds.slice(1)) await db.delete(classesTable).where(eq(classesTable.id, id));
  }
  if (createdCourseIds.length > 0) {
    await db.delete(coursesTable).where(eq(coursesTable.id, createdCourseIds[0]));
    for (const id of createdCourseIds.slice(1)) await db.delete(coursesTable).where(eq(coursesTable.id, id));
  }
  if (createdUserIds.length > 0) {
    await db.delete(usersTable).where(eq(usersTable.id, createdUserIds[0]));
    for (const id of createdUserIds.slice(1)) await db.delete(usersTable).where(eq(usersTable.id, id));
  }
}

let browser;
try {
  const admin = await createUser("admin", "admin");
  const regularUser = await createUser("usuario", "usuario");
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  const scenarios = [
    { lang: "pt", width: 1280, save: "Salvar", archive: "Arquivar", archived: "Arquivado", active: "Ativo", preservationText: "inscritos, histórico e link público serão preservados" },
    { lang: "pt", width: 390, save: "Salvar", archive: "Arquivar", archived: "Arquivado", active: "Ativo", preservationText: "inscritos, histórico e link público serão preservados" },
    { lang: "fr", width: 1280, save: "Enregistrer", archive: "Archiver", archived: "Archivé", active: "Actif", preservationText: "ses inscriptions, son historique et son lien public seront conservés" },
    { lang: "fr", width: 390, save: "Enregistrer", archive: "Archiver", archived: "Archivé", active: "Actif", preservationText: "ses inscriptions, son historique et son lien public seront conservés" },
  ];
  for (const scenario of scenarios) {
    await runScenario(browser, admin, regularUser, scenario);
    process.stdout.write(`✓ ${scenario.lang} ${scenario.width}px\n`);
  }
  process.stdout.write("Authenticated event actions E2E passed.\n");
} finally {
  await browser?.close();
  await cleanup();
}