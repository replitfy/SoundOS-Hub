// UI-only regression: response fixtures are intercepted in the browser.
// No database records, real credentials, or backend mutations are used.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseUrl = process.env.E2E_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
const rows = Array.from({ length: 45 }, (_, index) => {
  const id = index + 1;
  return {
    eventId: id, eventName: `Evento ${46 - id} — Formação com um nome longo para testar a largura`,
    eventType: "CURSO", active: id % 2 === 0,
    startDate: id === 45 ? null : `${2024 + id % 3}-${String(1 + id % 12).padStart(2, "0")}-15`,
    endDate: null, city: id % 3 === 0 ? null : id % 2 ? "São Paulo" : "Campos do Jordão",
    location: null, classId: id, classCode: id === 45 ? null : `ED-${46 - id}`,
    courseId: id % 2, courseName: id % 2 ? "Água" : "Fogo",
    capacity: 50, enrolled: id, available: id === 45 ? null : 50 - id,
    contracted: id * 1000, paid: id * 210.25, outstanding: id * 789.75,
    paidPercent: id === 45 ? null : id * 2,
  };
});
const response = {
  rows, totals: {},
  filters: { years: [2024, 2025, 2026], eventTypes: ["CURSO"], courses: ["Água", "Fogo"], cities: ["São Paulo", "Campos do Jordão"] },
};
const fields = ["event", "code", "year", "month", "startDate", "city", "enrolled", "available", "contracted", "paid", "outstanding", "paidPercent"];
function value(row, key) {
  if (key === "event") return row.eventName;
  if (key === "code") return row.classCode;
  if (key === "year") return row.startDate ? Number(row.startDate.slice(0, 4)) : null;
  if (key === "month") return row.startDate ? Number(row.startDate.slice(5, 7)) : null;
  if (key === "startDate") return row.startDate ? Date.parse(row.startDate) : null;
  return row[key];
}
function expectedIds(key, direction) {
  return [...rows].sort((a, b) => {
    const av = value(a, key), bv = value(b, key);
    if (av === null) return bv === null ? a.eventId - b.eventId : 1;
    if (bv === null) return -1;
    const comparison = typeof av === "number" ? av - bv : av.localeCompare(bv, "pt-BR", { numeric: true, sensitivity: "base" });
    return comparison * (direction === "asc" ? 1 : -1) || a.eventId - b.eventId;
  }).slice(0, 20).map(row => row.eventId);
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("soundos_lang")) localStorage.setItem("soundos_lang", "pt");
    sessionStorage.setItem("soundos_user_session", JSON.stringify({
      id: -1, name: "Teste de interface", email: "ui@example.test", role: "staff", sessionToken: "ui-fixture-not-a-real-token",
    }));
  });
  await context.route("**/api/**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/education/event-summary")) {
      await route.fulfill({ json: response });
    } else if (new URL(route.request().url()).pathname.endsWith("/detalhe")) {
      await route.fulfill({ json: { event: {}, matriculados: [], preinscritos: [], interessados: [] } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const eventRows = () => page.locator("tr[data-event-id]");
  const ids = () => eventRows().evaluateAll(nodes => nodes.map(node => Number(node.dataset.eventId)));
  const waitRows = count => page.waitForFunction(n => document.querySelectorAll("tr[data-event-id]").length === n, count);
  await page.goto(`${baseUrl}/education`, { waitUntil: "networkidle" });
  await waitRows(20);
  const first = await ids();
  const kpis = page.locator(".grid").filter({ has: page.getByText("Eventos", { exact: true }) }).first();
  const totalsBefore = await kpis.innerText();
  const totalText = await page.getByTestId("education-page-range").innerText();
  assert.match(totalText, /45/);
  await page.getByTestId("education-page-next").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="education-page-number"]').textContent.includes("2"));
  const second = await ids();
  await page.getByTestId("education-page-next").click();
  await waitRows(5);
  const third = await ids();
  assert.equal(await kpis.innerText(), totalsBefore, "KPIs must not change between pages");
  assert.equal(new Set([...first, ...second, ...third]).size, 45);
  assert.equal(await page.getByTestId("education-page-next").isDisabled(), true);
  assert.match(await page.getByTestId("education-page-range").innerText(), /41.*45.*45/);
  console.log("PASS pagination: 20 + 20 + 5, no missing or duplicate events");

  for (const key of fields) {
    const header = page.getByTestId(`education-sort-${key}`);
    const th = header.locator("..");
    const current = await th.getAttribute("aria-sort");
    await header.click();
    const direction = current === "ascending" ? "desc" : "asc";
    await page.waitForFunction(() => document.querySelector('[data-testid="education-page-number"]').textContent.includes("1"));
    assert.deepEqual(await ids(), expectedIds(key, direction), `${key} ${direction}`);
    await header.press("Enter");
    assert.deepEqual(await ids(), expectedIds(key, direction === "asc" ? "desc" : "asc"), `${key} toggled with keyboard`);
  }
  console.log("PASS all 12 typed sorts, both directions, keyboard, page reset");
  const search = page.locator('input[placeholder*="Buscar"]');
  await page.getByTestId("education-page-next").click();
  await search.fill("Evento 45 ");
  await waitRows(1);
  assert.match(await page.getByTestId("education-page-number").innerText(), /1.*1/);
  await search.fill("no-such-event");
  await waitRows(0);
  assert.equal(await page.getByTestId("education-page-next").count(), 0);
  await search.fill("");
  await waitRows(20);
  await page.locator("#group-course").click();
  await waitRows(20);
  const toggle = page.locator('[data-testid^="education-group-toggle-"]').first();
  await toggle.click();
  assert((await eventRows().count()) < 20);
  await toggle.click();
  await waitRows(20);
  await page.getByTestId("education-page-next").click();
  await waitRows(20);
  await page.getByTestId("education-page-next").click();
  await waitRows(5);
  console.log("PASS search, empty state, grouped pagination and expand/collapse");

  await page.goto(`${baseUrl}/education?sort=financials`, { waitUntil: "networkidle" });
  await waitRows(20);
  assert.deepEqual(await ids(), expectedIds("paid", "desc"));
  await page.reload({ waitUntil: "networkidle" });
  assert.deepEqual(await ids(), expectedIds("paid", "desc"));
  console.log("PASS legacy URL sorting and reload");

  const widths = await page.getByTestId("education-summary-table").evaluate(table => {
    const compact = table.scrollWidth;
    const style = document.createElement("style");
    style.textContent = '[data-testid="education-summary-table"] :is(th,td) { padding-left:12px !important; padding-right:12px !important; }';
    document.head.append(style);
    const priorPadding = table.scrollWidth;
    style.remove();
    return { compact, priorPadding };
  });
  assert(widths.compact < widths.priorPadding, JSON.stringify(widths));
  console.log("PASS measured width reduction against previous 12px spacing", JSON.stringify(widths));

  await mkdir("screenshots", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    if (width === 390) {
      await page.getByTestId("button-toggle-sidebar").click();
      await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().width < 60);
    }
    const geometry = await page.getByTestId("education-summary-table").evaluate(table => ({
      table: table.scrollWidth, container: table.parentElement.clientWidth,
      document: document.documentElement.scrollWidth, viewport: window.innerWidth,
      padding: getComputedStyle(table.querySelector("td")).paddingLeft,
      firstColumn: table.querySelector("td").getBoundingClientRect().width,
    }));
    assert(geometry.document <= width + 1, JSON.stringify(geometry));
    assert.equal(geometry.padding, "6px");
    assert(geometry.firstColumn <= 230, JSON.stringify(geometry));
    await page.screenshot({ path: `screenshots/education-${width}.jpg`, fullPage: true });
    console.log(`PASS layout ${width}px`, JSON.stringify(geometry));
  }
  await page.evaluate(() => localStorage.setItem("soundos_lang", "fr"));
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByTestId("education-page-next").innerText(), "Suivante");
  assert.match(await page.getByTestId("education-page-range").innerText(), /sur 45/);
  console.log("PASS French labels");
  await page.setViewportSize({ width: 1440, height: 1050 });
  const link = page.locator('[data-testid^="education-event-link-"]').first();
  const href = await link.getAttribute("href");
  await link.click();
  await page.waitForURL(url => `${url.pathname}${url.search}` === href);
  await page.waitForLoadState("networkidle");
  assert.deepEqual(errors, []);
  console.log("PASS event detail link and no browser runtime errors");
} finally {
  await browser.close();
}