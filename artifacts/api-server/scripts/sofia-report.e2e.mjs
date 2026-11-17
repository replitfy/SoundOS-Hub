import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { and, eq } from "drizzle-orm";
import {
  conversations,
  db,
  pool,
  pessoasTable,
  usersTable,
  videosTable,
} from "@workspace/db";
import {
  formatPublicProductFacts,
  getPublicProductFacts,
  getPublishedCatalog,
} from "../src/services/wixCatalog.ts";

function devBaseUrl() {
  const configured = process.env.E2E_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const domain = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (!domain) return "http://localhost:80";
  return `${/^https?:\/\//i.test(domain) ? "" : "https://"}${domain}`.replace(/\/+$/, "");
}

const baseUrl = devBaseUrl();
const browserExecutable = process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium";
const runId = `${Date.now()}-${process.pid}`;
const onlyArg = process.argv.find(argument => argument.startsWith("--only="));
const only = onlyArg?.slice("--only=".length).trim().toLowerCase() || null;
const supportedPrefixes = new Set(["01", "02", "03", "04", "05", "06"]);
if (only && !supportedPrefixes.has(only)) {
  throw new Error(`Unsupported --only prefix "${only}". Use one of: ${[...supportedPrefixes].join(", ")}`);
}
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const screenshotPath = resolve(workspaceRoot, "screenshots/sofia-regression.jpg");
const createdUserIds = [];
const fixtureLabel = `E2E Sofia report ${runId}`;
const conversationIds = new Map();

function sessionToken(userId) {
  const secret = process.env.SESSION_SECRET;
  assert(secret, "SESSION_SECRET is required for the authenticated E2E test");
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function authHeaders(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function normalized(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function answerLog(scenario, answer, personName) {
  const safeAnswer = answer
    .replaceAll(personName, "[TEST_PERSON]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  process.stdout.write(`ANSWER ${scenario}: ${safeAnswer}\n`);
}

function pass(scenario) {
  process.stdout.write(`PASS ${scenario}\n`);
}

async function createAdmin() {
  const [user] = await db.insert(usersTable).values({
    name: "E2E Sofia Admin",
    email: `e2e-sofia-report-${runId}@example.test`,
    role: "admin",
    active: true,
  }).returning();
  createdUserIds.push(user.id);
  return user;
}

async function createPerson(scenario) {
  const [person] = await db.insert(pessoasTable).values({
    codigo: `E2E-SOFIA-${scenario}-${runId}`,
    nome: `Pessoa Fictícia ${scenario} ${runId}`,
    email: `e2e-sofia-${scenario}-${runId}@example.test`,
    aguaPresencial: null,
    fogoPresencial: null,
    servicoInteresse: fixtureLabel,
  }).returning();
  return person;
}

async function completionSnapshot(personId) {
  const [row] = await db.select({
    aguaPresencial: pessoasTable.aguaPresencial,
    fogoPresencial: pessoasTable.fogoPresencial,
  }).from(pessoasTable).where(eq(pessoasTable.id, personId)).limit(1);
  assert(row, "The scenario person must still exist");
  return row;
}

function parseSse(body) {
  const events = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

async function chat(token, person, scenario, message, conversationId) {
  const before = await completionSnapshot(person.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/sofia/chat`, {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify({
        message,
        pessoaId: person.id,
        pessoaNome: person.nome,
        ...(conversationId ? { conversationId } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const rawBody = await response.text();
  assert.equal(response.status, 200, `${scenario}: chat returned HTTP ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i);
  const events = parseSse(rawBody);
  const error = events.find(event => event.error);
  assert(!error, `${scenario}: SSE returned ${error?.code ?? error?.error}`);
  const done = events.findLast(event => event.done);
  assert(Number.isInteger(done?.conversationId), `${scenario}: SSE must return its conversation ID`);
  if (conversationId) {
    assert.equal(done.conversationId, conversationId, `${scenario}: follow-up changed conversation`);
  }
  const answer = events.map(event => event.content ?? "").join("").trim();
  assert(answer, `${scenario}: Sofia returned an empty answer`);
  const after = await completionSnapshot(person.id);
  assert.deepEqual(after, before, `${scenario}: chat must not mutate structured module completion`);
  conversationIds.set(scenario, done.conversationId);
  answerLog(scenario, answer, person.nome);
  return { answer, conversationId: done.conversationId, done, events };
}

async function auditRuns(token, conversationId) {
  const response = await fetch(
    `${baseUrl}/api/sofia/conversations/${conversationId}/decision-runs`,
    { headers: authHeaders(token) },
  );
  assert.equal(response.status, 200, `Decision audit returned HTTP ${response.status}`);
  return response.json();
}

async function assertAuditIntent(token, conversationId, intent, expectedTurns = 1) {
  const runs = await auditRuns(token, conversationId);
  assert(runs.length >= expectedTurns, `Expected at least ${expectedTurns} decision audit rows`);
  const matching = runs.filter(run => run.metadata?.intent === intent);
  assert(
    matching.length >= expectedTurns,
    `Expected ${expectedTurns} audit row(s) with intent ${intent}; got ${matching.length}`,
  );
  return runs;
}

function urlsIn(text) {
  return [...text.matchAll(/https?:\/\/[^\s<>()]+/g)]
    .map(match => match[0].replace(/[.,;:!?]+$/, ""));
}

function moneyPattern(text) {
  return /(?:R\$\s*)?\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|R\$\s*\d+/i.test(text);
}

async function scenarioUpcoming(token) {
  const person = await createPerson("01-evento");
  const first = await chat(
    token,
    person,
    "01 próximo presencial",
    "Qual é o próximo evento presencial?",
  );
  const firstNormalized = normalized(first.answer);
  assert.match(firstNormalized, /ciclo\s+ar/);
  assert.match(first.answer, /07\/10/);
  assert.match(firstNormalized, /campos/);

  const followup = await chat(
    token,
    person,
    "01 preço retiro",
    "Quanto custa esse retiro?",
    first.conversationId,
  );
  assert.match(followup.answer, /(?:R\$\s*)?1[.\s]?800(?:,00)?/i);
  await assertAuditIntent(token, first.conversationId, "upcoming_offering", 2);
  pass("01 evento presencial e preço contextual");
}

async function scenarioMarimba(token, marimba, expectedMarimbaAnswer) {
  const person = await createPerson("02-marimba");
  const result = await chat(
    token,
    person,
    "02 Marimba Vidro",
    "Qual é o preço e o link da Marimba Vidro?",
  );
  assert(
    normalized(result.answer).includes(normalized(marimba.name)),
    "Marimba answer must name the catalog product",
  );
  const expectedPriceLine = expectedMarimbaAnswer.split("\n").find(line => line.startsWith("Preço:"));
  const expectedLinkLine = expectedMarimbaAnswer.split("\n").find(line => line.startsWith("Link:"));
  assert(expectedPriceLine, "The live Marimba catalog row must have a price");
  assert(expectedLinkLine, "The live Marimba catalog row must have a public link");
  assert(result.answer.includes(expectedPriceLine), "Marimba price must match the catalog read beforehand");
  assert(result.answer.includes(expectedLinkLine), "Marimba link must match the catalog read beforehand");
  await assertAuditIntent(token, result.conversationId, "product_fact");
  pass("02 Marimba Vidro usa preço e link reais");
}

async function scenarioMissingProduct(token, knownProduct) {
  const person = await createPerson("03-ausente");
  const real = await chat(
    token,
    person,
    "03 produto real",
    `Qual é o preço e o link de ${knownProduct.name}?`,
  );
  assert(
    normalized(real.answer).includes(normalized(knownProduct.name)),
    "The setup turn must resolve a real product",
  );

  const missing = await chat(
    token,
    person,
    "03 Cajon ausente",
    "E o Cajon Elétrico Bluetooth, qual é o preço e o link?",
    real.conversationId,
  );
  const missingNormalized = normalized(missing.answer);
  assert.match(
    missingNormalized,
    /nao encontrei.*catalogo publicado|catalogo publicado.*nao encontrei|nao existe.*catalogo publicado/,
  );
  assert.equal(urlsIn(missing.answer).length, 0, "Missing product must not return a URL");
  assert(!moneyPattern(missing.answer), "Missing product must not return a price");
  assert(
    !normalized(missing.answer).includes(normalized(knownProduct.name)),
    "Missing product must not substitute the prior real product",
  );
  const runs = await assertAuditIntent(token, real.conversationId, "product_fact", 2);
  const latestProductRun = runs.filter(run => run.metadata?.intent === "product_fact").at(-1);
  assert.equal(latestProductRun?.metadata?.result, "not_found");
  assert.deepEqual(latestProductRun?.metadata?.candidate_set, []);
  pass("03 produto ausente sem substituição");
  return { person, conversationId: real.conversationId, missingAnswer: missing.answer };
}

async function scenarioEligibility(token) {
  const person = await createPerson("04-eligibilidade");
  const first = await chat(
    token,
    person,
    "04 Fogo sem ciclos",
    "Quero fazer o módulo Fogo, mas nunca fiz nenhum ciclo.",
  );

  const second = await chat(
    token,
    person,
    "04 Água não concluída",
    "Nunca fiz o módulo Água.",
    first.conversationId,
  );

  const third = await chat(
    token,
    person,
    "04 primeiro passo",
    "Ainda não fiz Água, o que preciso fazer primeiro?",
    first.conversationId,
  );

  assert.match(normalized(first.answer), /agua/);
  assert.match(normalized(first.answer), /bloque|primeiro|comec|passo necessario antes/);
  assert.match(normalized(second.answer), /agua ainda nao foi concluido|agua.*nao.*conclu/);
  assert.notEqual(normalized(second.answer), normalized(first.answer), "Sofia must not repeat an identical answer");
  assert.match(normalized(third.answer), /primeiro passo.*modulo agua|comec.*modulo agua/);
  assert.notEqual(normalized(third.answer), normalized(second.answer), "First-step answer must add useful guidance");
  assert(!third.answer.includes("?"), "First-step answer must not repeat the same question");

  const runs = await auditRuns(token, first.conversationId);
  assert(runs.length >= 3, "Every eligibility turn must have a decision audit");
  assert(
    runs.some(run => run.elegibilidadeStatus === "bloqueado" && normalized(run.ofertaPrincipal).includes("fogo")),
    "Fogo prerequisite block must be audited",
  );
  assert(
    runs.filter(run => run.metadata?.declared_non_completion === "agua").length >= 2,
    "Declared Água non-completion must be audited on both turns",
  );
  assert.deepEqual(await completionSnapshot(person.id), { aguaPresencial: null, fogoPresencial: null });
  pass("04 pré-requisito auditado sem conceder conclusão");
}

function relevantVideos(videos, keywords) {
  return videos.filter(video => {
    const haystack = normalized([
      video.titulo,
      video.descricao,
      video.tipo,
      video.curso,
      video.ref,
    ].filter(Boolean).join(" "));
    return keywords.some(keyword => haystack.includes(normalized(keyword)));
  });
}

async function validateVideoRequest(token, person, scenario, request, allApproved, relevant) {
  const result = await chat(token, person, scenario, request);
  const answerUrls = urlsIn(result.answer);
  const approvedUrls = new Set(allApproved.map(video => video.link));
  const relevantUrls = new Set(relevant.map(video => video.link));
  if (answerUrls.length > 0) {
    for (const url of answerUrls) {
      assert(approvedUrls.has(url), `${scenario}: returned URL is not an approved real catalog row`);
    }
    assert(
      answerUrls.some(url => relevantUrls.has(url)),
      `${scenario}: returned video is not compatible with the requested practice`,
    );
  } else {
    assert.match(
      normalized(result.answer),
      /nao (?:encontrei|ha|tenho)|nenhum.*(?:video|conteudo)|sem.*(?:video|conteudo)|nao consegui localizar/,
      `${scenario}: no URL requires a transparent no-match answer`,
    );
  }
  const runs = await auditRuns(token, result.conversationId);
  assert(runs.length > 0, `${scenario}: video decision must be audited`);
  const answerNormalized = normalized(result.answer);
  assert(
    !/\b(?:elegivel|elegibilidade|pre-requisito|modulo fogo|modulo agua)\b/.test(answerNormalized),
    `${scenario}: practice video request must not leak Fogo/Água eligibility`,
  );
}

async function scenarioVideos(token, approvedVideos) {
  const person = await createPerson("05-videos");
  const failures = [];
  const requests = [
    ["05 vídeo respiração", "Quero um vídeo de prática de respiração.", ["respira"]],
    ["05 vídeo meditação", "Quero um vídeo de meditação.", ["medita"]],
    ["05 vídeo gong", "Quero um vídeo de prática com gong.", ["gong"]],
  ];
  for (const [scenario, request, keywords] of requests) {
    try {
      await validateVideoRequest(
        token,
        person,
        scenario,
        request,
        approvedVideos,
        relevantVideos(approvedVideos, keywords),
      );
    } catch (error) {
      failures.push(`${scenario}: ${error.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join(" | "));
  pass("05 vídeos aprovados compatíveis ou ausência transparente");
}

async function scenarioHandoff(token) {
  const person = await createPerson("06-handoff");
  const first = await chat(
    token,
    person,
    "06 situação emocional",
    "Estou passando por um momento emocional muito difícil e me sinto desesperada. Preciso falar com uma pessoa da equipe.",
  );
  const [conversation] = await db.select().from(conversations)
    .where(eq(conversations.id, first.conversationId)).limit(1);

  const followup = await chat(
    token,
    person,
    "06 follow-up bloqueado",
    "Você pode continuar me orientando automaticamente?",
    first.conversationId,
  );
  assert.equal(first.done.handoffTriggered, true, "Sensitive situation must trigger handoff");
  assert.equal(conversation?.status, "aguardando_humano");
  assert.equal(conversation?.handoffReason, "tema_sensivel");
  assert.equal(followup.done.handoffActive, true);
  assert.equal(followup.done.handoffStatus, "aguardando_humano");
  assert.match(
    normalized(followup.answer),
    /atendimento humano|equipe.*(?:assum|continu|responder)|resposta.*suspens/,
  );
  const [stillWaiting] = await db.select().from(conversations)
    .where(and(
      eq(conversations.id, first.conversationId),
      eq(conversations.status, "aguardando_humano"),
    )).limit(1);
  assert(stillWaiting, "Follow-up must remain blocked in aguardando_humano");
  const runs = await auditRuns(token, first.conversationId);
  assert(runs.length > 0, "Handoff must leave a decision audit");
  pass("06 handoff emocional bloqueia follow-up");
}

async function installSession(context, admin, token) {
  await context.addInitScript(({ admin, token }) => {
    localStorage.setItem("soundos_lang", "pt");
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      sessionToken: token,
    }));
  }, { admin, token });
}

async function browserValidation(admin, token, missingFixture) {
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await installSession(context, admin, token);
    const page = await context.newPage();
    await page.goto(
      `${baseUrl}/sofia?pessoa=${missingFixture.person.id}&conv=${missingFixture.conversationId}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByRole("heading", { name: "Sofia" }).waitFor();
    await page.getByTestId("sofia-message-input").waitFor();
    await page.getByText(missingFixture.missingAnswer, { exact: true }).waitFor();
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true, type: "jpeg" });

    await page.getByTestId("button-new-conversation").click();
    await assert.doesNotReject(() => page.getByText("Olá! Sou a Sofia", { exact: true }).waitFor());
    assert.equal(
      await page.getByText(missingFixture.missingAnswer, { exact: true }).count(),
      0,
      "New chat must not reuse the missing-product conversation context",
    );
    assert.equal(new URL(page.url()).searchParams.has("conv"), false);
    await context.close();
    pass("UI /sofia renderiza turno e limpa novo chat");
  } finally {
    await browser.close();
  }
}

async function cleanup() {
  // Pessoas, conversas, mensagens, evidências e decision_runs deste teste formam
  // uma trilha auditável. Eles ficam preservados com código/serviço E2E explícito
  // em vez de violar fixtures append-only ou deixar referências órfãs.
  for (const id of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
}

try {
  const admin = await createAdmin();
  const token = sessionToken(admin.id);
  const failures = [];
  const runScenario = async (name, callback) => {
    try {
      return await callback();
    } catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) });
      process.stdout.write(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  };

  let marimba = null;
  let expectedMarimbaAnswer = null;
  if (!only || only === "02" || only === "03") {
    // Product scenarios read the real catalog before making chat assertions.
    // Focused runs for unrelated prefixes intentionally skip this network call.
    const catalog = await getPublishedCatalog(true);
    const marimbaMatches = catalog.products.filter(product => {
      const productName = normalized(product.name);
      return product.visible && productName.includes("marimba") && productName.includes("vidro");
    });
    assert.equal(marimbaMatches.length, 1, "Expected exactly one published Marimba Vidro product");
    marimba = marimbaMatches[0];
    expectedMarimbaAnswer = formatPublicProductFacts(
      getPublicProductFacts(marimba),
      "preço link",
    );
  }

  let usableApprovedVideos = [];
  if (!only || only === "05") {
    const approvedVideos = await db.select().from(videosTable).where(and(
      eq(videosTable.aprovadoParaSofia, true),
      eq(videosTable.temLinkReal, true),
    ));
    usableApprovedVideos = approvedVideos.filter(video => Boolean(video.link));
  }

  if (!only || only === "01") {
    await runScenario("01 evento presencial", () => scenarioUpcoming(token));
  }
  if (!only || only === "02") {
    await runScenario("02 Marimba Vidro", () =>
      scenarioMarimba(token, marimba, expectedMarimbaAnswer));
  }
  let missingFixture = null;
  if (!only || only === "03") {
    missingFixture = await runScenario("03 produto ausente", () =>
      scenarioMissingProduct(token, marimba));
  }
  if (!only || only === "04") {
    await runScenario("04 elegibilidade", () => scenarioEligibility(token));
  }
  if (!only || only === "05") {
    await runScenario("05 vídeos", () => scenarioVideos(token, usableApprovedVideos));
  }
  if (!only || only === "06") {
    await runScenario("06 handoff", () => scenarioHandoff(token));
  }
  if (!only || only === "03") {
    if (missingFixture) {
      await runScenario("UI /sofia", () => browserValidation(admin, token, missingFixture));
    } else {
      failures.push({ name: "UI /sofia", message: "missing-product fixture was unavailable" });
      process.stdout.write("FAIL UI /sofia: missing-product fixture was unavailable\n");
    }
  }
  assert.equal(
    failures.length,
    0,
    failures.map(failure => `${failure.name}: ${failure.message}`).join(" | "),
  );
  process.stdout.write("PASS Sofia report live E2E\n");
} finally {
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
}