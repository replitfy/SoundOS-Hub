import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chromium } from "playwright-core";
import { eq, inArray } from "drizzle-orm";
import {
  classesTable,
  commercialOpportunitiesTable,
  commercialOpportunityEventsTable,
  coursesTable,
  cursosInscricao,
  db,
  enrollmentsTable,
  pessoasTable,
  usersTable,
} from "@workspace/db";
import { transitionOpportunity } from "../src/services/commercialOpportunities.ts";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:80";
const browserExecutable = process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium";
const runId = `${Date.now()}-${process.pid}`;
const ids = {
  users: [],
  pessoas: [],
  opportunities: [],
  enrollments: [],
  offers: [],
  classes: [],
  courses: [],
};
let cleanupAdmin;

function sessionToken(userId) {
  const secret = process.env.SESSION_SECRET;
  assert(secret, "SESSION_SECRET is required for the authenticated CRM E2E test");
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function createUser(role, suffix) {
  const [user] = await db.insert(usersTable).values({
    name: `E2E CRM ${role} ${runId}`,
    email: `e2e-crm-${suffix}-${runId}@example.test`,
    role,
    active: true,
  }).returning();
  ids.users.push(user.id);
  return user;
}

async function createFixtures() {
  const [course] = await db.insert(coursesTable).values({
    name: `E2E CRM Course ${runId}`,
    cycle: "E2E",
    modality: "Online",
    workload: 1,
    price: "1.00",
  }).returning();
  ids.courses.push(course.id);

  const [classRecord] = await db.insert(classesTable).values({
    courseId: course.id,
    code: `E2E-CRM-${runId}`,
    startDate: "2026-10-10",
    endDate: "2026-10-11",
    teacher: "E2E",
  }).returning();
  ids.classes.push(classRecord.id);

  const [offer] = await db.insert(cursosInscricao).values({
    slug: `e2e-crm-${runId}`,
    nome: `E2E CRM Education ${runId}`,
    ativo: true,
    nucleo: "EDUCATION",
    tipoEvento: "CURSO",
    courseId: course.id,
    classId: classRecord.id,
    dataInicio: "2026-10-10",
    dataFim: "2026-10-11",
  }).returning();
  ids.offers.push(offer.id);

  const people = [];
  for (const [index, suffix] of ["staff", "admin", "lifecycle"].entries()) {
    const [person] = await db.insert(pessoasTable).values({
      codigo: `E2E-CRM-${suffix}-${runId}`,
      nome: `E2E CRM ${suffix} ${runId}`,
      email: `e2e-crm-${suffix}-${runId}@example.test`,
      celular: `+5511${runId.replace(/\D/g, "").slice(-8)}${index}`,
    }).returning();
    people.push(person);
    ids.pessoas.push(person.id);

    const [enrollment] = await db.insert(enrollmentsTable).values({
      pessoaId: person.id,
      classId: classRecord.id,
      price: "1.00",
      paymentStatus: "paid",
      contractStatus: "pending",
    }).returning();
    ids.enrollments.push(enrollment.id);
  }

  return { offer, people };
}

async function installSession(context, lang, user) {
  await context.addInitScript(({ lang, user, token }) => {
    localStorage.setItem("soundos_lang", lang);
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sessionToken: token,
    }));
  }, { lang, user, token: sessionToken(user.id) });
}

async function openCrm(browser, user, lang, width) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  await installSession(context, lang, user);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/crm`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "CRM", exact: true }).waitFor();
  return { context, page };
}

function fieldContainer(scope, label) {
  return scope.locator("label", { hasText: label }).locator("..");
}

async function choose(scope, label, option) {
  const container = fieldContainer(scope, label);
  await container.getByRole("combobox").click();
  const search = scope.page().locator("[data-testid$='-search']:visible, [cmdk-input]:visible").last();
  if (await search.count()) {
    await search.fill(option);
    await scope.page().waitForTimeout(300);
  }
  const optionElement = scope.page().getByRole("option", { name: option, exact: true });
  await optionElement.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await optionElement.evaluate((element) => element.click());
}

async function createOpportunity(page, labels, person, offer, owner, taskText) {
  await page.getByRole("button", { name: labels.newOpportunity, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: labels.newOpportunity });
  await dialog.waitFor();
  const layout = await dialog.evaluate(element => {
    const dialogRect = element.getBoundingClientRect();
    const overflowingControls = Array.from(element.querySelectorAll("input, button"))
      .filter(control => {
        const rect = control.getBoundingClientRect();
        return rect.left < dialogRect.left - 1 || rect.right > dialogRect.right + 1;
      }).length;
    return { width: dialogRect.width, viewport: window.innerWidth, overflowingControls };
  });
  assert.equal(layout.overflowingControls, 0, "Opportunity controls must stay inside the dialog");
  if (layout.viewport >= 700) {
    assert(layout.width >= 620, `Opportunity dialog should use available desktop width, received ${layout.width}px`);
  }
  await choose(dialog, labels.person, person.nome);
  await choose(dialog, labels.owner, owner.name);
  await choose(dialog, labels.course, offer.nome);
  await fieldContainer(dialog, labels.description).getByRole("textbox").fill(taskText);

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/crm/opportunities") &&
    response.request().method() === "POST");
  await dialog.getByRole("button", { name: labels.create, exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201);
  assert.match(response.request().headers().authorization ?? "", /^Bearer /);
  const opportunity = await response.json();
  ids.opportunities.push(opportunity.id);
  await card(page, person.nome, labels.newInterest).waitFor();
  return opportunity;
}

async function createOpportunityViaBrowserApi(page, person, offer, owner, taskText) {
  const result = await page.evaluate(async ({ personId, offerId, ownerId, taskText }) => {
    const session = JSON.parse(sessionStorage.getItem("soundos_user_session") || "{}");
    const response = await fetch("/api/crm/opportunities", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
      },
      body: JSON.stringify({
        pessoaId: personId,
        nucleus: "EDUCATION",
        cursosInscricaoId: offerId,
        ownerUserId: ownerId,
        nextTaskType: "INTERNAL",
        nextTaskText: taskText,
        nextTaskAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    personId: person.id,
    offerId: offer.id,
    ownerId: owner.id,
    taskText,
  });
  assert.equal(result.status, 201);
  ids.opportunities.push(result.body.id);
  await page.reload({ waitUntil: "networkidle" });
  return result.body;
}

async function searchFor(page, placeholder, value) {
  const search = page.getByPlaceholder(placeholder);
  await search.fill(value);
  await page.waitForResponse((response) =>
    response.url().includes("/api/crm/opportunities") &&
    response.url().includes("search="));
}

function card(page, personName, stageLabel) {
  return page.getByRole("button", {
    name: `${personName} - ${stageLabel}`,
    exact: true,
  });
}

async function moveFromCard(page, personName, fromStage, toStage, moveLabel) {
  const currentCard = card(page, personName, fromStage);
  const wrapper = currentCard.locator("..");
  await wrapper.getByRole("button", { name: moveLabel, exact: true }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/crm/opportunities/") &&
    response.url().endsWith("/transition") &&
    response.request().method() === "POST");
  await page.getByRole("menuitem", { name: `${moveLabel} ${toStage}`, exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
}

async function openCardWithKeyboard(page, personName, stageLabel) {
  const opportunityCard = card(page, personName, stageLabel);
  await opportunityCard.focus();
  await opportunityCard.press("Enter");
  const drawer = page.getByRole("dialog");
  await drawer.getByText(personName, { exact: true }).waitFor();
  return drawer;
}

async function closeDrawer(drawer) {
  await drawer.press("Escape");
  await drawer.waitFor({ state: "hidden" });
}

async function openMoveDialog(page, personName, fromStage, toStage, moveLabel) {
  const wrapper = card(page, personName, fromStage).locator("..");
  await wrapper.getByRole("button", { name: moveLabel, exact: true }).click();
  await page.getByRole("menuitem", { name: `${moveLabel} ${toStage}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `${moveLabel} ${toStage}` });
  await dialog.waitFor();
  return dialog;
}

async function confirmEducation(page, labels, person, enrollmentId) {
  const dialog = await openMoveDialog(
    page,
    person.nome,
    labels.contactStarted,
    labels.confirmed,
    labels.move,
  );
  await dialog.getByText(labels.confirmationType, { exact: true }).waitFor();
  const confSelect = dialog.getByRole("combobox");
  await confSelect.click();
  await page.getByRole("option", {
    name: `Matrícula Education #${enrollmentId}`,
    exact: true,
  }).waitFor();
  assert.equal(
    await page.getByRole("option", {
      name: "Confirmação autorizada por administrador",
      exact: true,
    }).count(),
    0,
    "Staff must not see human administrator confirmation",
  );
  await page.keyboard.press("Escape");

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/transition") &&
    response.request().method() === "POST");
  await dialog.getByRole("button", { name: labels.confirm, exact: true }).click();
  assert.equal((await responsePromise).status(), 200);
  await card(page, person.nome, labels.confirmed).waitFor();
}

async function runStaffScenario(browser, staff, fixtures) {
  const labels = {
    newOpportunity: "Nova Oportunidade",
    person: "Pessoa",
    owner: "Responsável",
    course: "Curso / Evento",
    description: "Descrição",
    create: "Criar Oportunidade",
    search: "Buscar",
    move: "Mover para...",
    newInterest: "Novo Interesse",
    contactStarted: "Contato Iniciado",
    confirmed: "Confirmado",
    confirmationType: "Tipo de Confirmação",
    confirm: "Confirmar",
  };
  const person = fixtures.people[0];
  const { context, page } = await openCrm(browser, staff, "pt", 1280);
  try {
    await createOpportunity(page, labels, person, fixtures.offer, staff, "Contato inicial E2E");
    await searchFor(page, labels.search, person.nome);
    await card(page, person.nome, labels.newInterest).waitFor();

    const drawer = await openCardWithKeyboard(page, person.nome, labels.newInterest);
    await choose(drawer, "Status de Contato", "Alcançado");
    const taskText = fieldContainer(drawer, labels.description).getByRole("textbox");
    await taskText.fill("Próxima ação atualizada E2E");
    const saveResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/crm/opportunities/") &&
      response.request().method() === "PATCH");
    await drawer.getByRole("button", { name: "Salvar", exact: true }).click();
    assert.equal((await saveResponsePromise).status(), 200);

    const completeResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/complete-task") &&
      response.request().method() === "POST");
    await drawer.getByRole("button", { name: "Concluir Ação", exact: true }).click();
    assert.equal((await completeResponsePromise).status(), 200);
    await drawer.getByText("Tarefa Concluída", { exact: true }).waitFor();
    await closeDrawer(drawer);

    await moveFromCard(
      page,
      person.nome,
      labels.newInterest,
      labels.contactStarted,
      labels.move,
    );
    await card(page, person.nome, labels.contactStarted).waitFor();
    await confirmEducation(page, labels, person, ids.enrollments[0]);

    const [persisted] = await db.select().from(commercialOpportunitiesTable)
      .where(eq(commercialOpportunitiesTable.id, ids.opportunities.at(-1))).limit(1);
    assert.equal(persisted.stage, "CONFIRMED");
    assert.equal(persisted.contactStatus, "REACHED");
    process.stdout.write("✓ staff PT desktop: create/filter/keyboard/update/complete/move/enrollment confirmation\n");
  } finally {
    await context.close();
  }
}

async function chooseHumanConfirmation(page, dialog, labels) {
  const confSelect = dialog.getByRole("combobox");
  await confSelect.click();
  await page.getByRole("option", {
    name: "Confirmation autorisée par un administrateur",
    exact: true,
  }).click();
  await dialog.getByRole("textbox").fill("Validation humaine E2E");
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/transition") &&
    response.request().method() === "POST");
  await dialog.getByRole("button", { name: labels.confirm, exact: true }).click();
  assert.equal((await responsePromise).status(), 200);
}

async function openActionMenu(drawer) {
  const trigger = drawer.locator("button.h-8.w-8");
  assert.equal(await trigger.count(), 1, "Expected one opportunity action menu trigger");
  await trigger.click();
}

async function runAdminMobileFrenchScenario(browser, admin, fixtures) {
  const labels = {
    newOpportunity: "Nouvelle Opportunité",
    person: "Personne",
    owner: "Responsable",
    course: "Cours / Événement",
    description: "Description",
    create: "Créer l’Opportunité",
    move: "Déplacer vers...",
    newInterest: "Nouvel Intérêt",
    contactStarted: "Contact Initié",
    confirmed: "Confirmé",
    confirm: "Confirmer",
  };
  const { context, page } = await openCrm(browser, admin, "fr", 390);
  try {
    assert.equal(await page.getByText("Gestion des flux et des interactions avec les personnes.").count(), 1);
    const board = page.locator(".overflow-x-auto");
    assert.ok((await board.evaluate((element) => element.scrollWidth)) > 390);

    const humanPerson = fixtures.people[1];
    await createOpportunityViaBrowserApi(page, humanPerson, fixtures.offer, admin, "Suivi humain E2E");
    await moveFromCard(page, humanPerson.nome, labels.newInterest, labels.contactStarted, labels.move);
    const confirmationDialog = await openMoveDialog(
      page,
      humanPerson.nome,
      labels.contactStarted,
      labels.confirmed,
      labels.move,
    );
    await chooseHumanConfirmation(page, confirmationDialog, labels);
    await card(page, humanPerson.nome, labels.confirmed).waitFor();

    const lifecyclePerson = fixtures.people[2];
    await createOpportunityViaBrowserApi(page, lifecyclePerson, fixtures.offer, admin, "Cycle E2E");
    let drawer = await openCardWithKeyboard(page, lifecyclePerson.nome, labels.newInterest);
    await openActionMenu(drawer);
    await page.getByRole("menuitem", { name: "Mettre en pause", exact: true }).click();
    let actionDialog = page.getByRole("dialog", { name: "Mettre en pause" });
    await actionDialog.getByRole("textbox").fill("Pause E2E");
    let responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/pause") && response.request().method() === "POST");
    await actionDialog.getByRole("button", { name: labels.confirm, exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await drawer.getByText("Incubation", { exact: true }).first().waitFor();

    await openActionMenu(drawer);
    responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/reactivate") && response.request().method() === "POST");
    await page.getByRole("menuitem", { name: "Réactiver", exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await drawer.getByText("Contact Initié", { exact: true }).first().waitFor();

    await openActionMenu(drawer);
    await page.getByRole("menuitem", { name: "Fermer", exact: true }).click();
    actionDialog = page.getByRole("dialog", { name: "Fermer" });
    await actionDialog.getByRole("textbox").fill("Clôture E2E");
    responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/transition") && response.request().method() === "POST");
    await actionDialog.getByRole("button", { name: labels.confirm, exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await drawer.getByText("Fermé", { exact: true }).first().waitFor();

    const [persisted] = await db.select().from(commercialOpportunitiesTable)
      .where(eq(commercialOpportunitiesTable.id, ids.opportunities.at(-1))).limit(1);
    const lifecycleEvents = await db.select().from(commercialOpportunityEventsTable)
      .where(eq(commercialOpportunityEventsTable.opportunityId, persisted.id));
    assert.equal(persisted.stage, "CLOSED");
    assert.ok(lifecycleEvents.some((event) =>
      event.eventType === "PAUSED" && event.reason === "Pause E2E"));
    assert.equal(persisted.closeReason, "Clôture E2E");
    process.stdout.write("✓ admin FR mobile: human confirmation/pause/reactivate/close/responsive\n");
  } finally {
    await context.close();
  }
}

async function cleanup() {
  if (ids.opportunities.length) {
    const opportunities = await db.select().from(commercialOpportunitiesTable)
      .where(inArray(commercialOpportunitiesTable.id, ids.opportunities));
    for (const opportunity of opportunities) {
      if (opportunity.stage === "CLOSED") continue;
      await transitionOpportunity({
        opportunityId: opportunity.id,
        toStage: "CLOSED",
        actor: { kind: "HUMAN", id: cleanupAdmin.id, role: cleanupAdmin.role },
        reason: "Automated E2E cleanup",
        source: "E2E",
        idempotencyKey: `e2e-cleanup-${runId}-${opportunity.id}`,
        expectedVersion: opportunity.version,
      });
    }
  }
}

let browser;
try {
  const [admin, staff] = await Promise.all([
    createUser("admin", "admin"),
    createUser("assistente", "staff"),
  ]);
  cleanupAdmin = admin;
  const fixtures = await createFixtures();
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  await runStaffScenario(browser, staff, fixtures);
  await runAdminMobileFrenchScenario(browser, admin, fixtures);
  process.stdout.write("Authenticated CRM critical flows E2E passed.\n");
} finally {
  await browser?.close();
  await cleanup();
}