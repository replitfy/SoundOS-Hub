// Browser-only fixtures: no real sessions, database writes, or API mutations.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseline = process.argv.includes("--baseline");
const baseUrl = process.env.E2E_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
const output = "/tmp/education-table-layout";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];
try {
  for (const lang of baseline ? ["pt"] : ["pt", "fr"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(language => {
      localStorage.setItem("soundos_lang", language);
      sessionStorage.setItem("soundos_user_session", JSON.stringify({
        id: -1, name: "Teste", email: "ui@example.test", role: "staff", sessionToken: "ui-fixture",
      }));
    }, lang);
    let stress = false;
    await context.route("**/api/**", route => route.fulfill({ json:
      route.request().url().includes("/education/event-summary") ? {
        filters: { years: [2019], eventTypes: ["CURSO"], courses: ["Curso Água"], cities: ["SP"] },
        totals: {},
        rows: Array.from({ length: 25 }, (_, index) => ({
          eventId: index + 1, eventName: stress ? "Evento com nome muito longo ".repeat(12) : "Curso Água — AGUA",
          eventType: "CURSO", active: true, startDate: "2019-01-11", endDate: null,
          city: stress ? "Cidade com nome muito longo ".repeat(10) : "SP", location: null,
          classId: index + 1, classCode: stress ? "CODIGO-COMPRIDO-".repeat(10) : "AGUA_PRESEN",
          courseId: 1, courseName: stress ? "Nome de curso muito comprido ".repeat(12) : "Curso Água",
          capacity: 20, enrolled: 13, available: 7,
          contracted: stress ? 1234567.89 : 0, paid: stress ? 1234567.89 : 0,
          outstanding: stress ? 1234567.89 : 0, paidPercent: stress ? 100 : null,
        })),
      } : [],
    }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const content of baseline ? ["short"] : ["short", "long"]) {
      stress = content === "long";
      for (const grouped of [false, true]) {
        const sizes = [];
        for (const width of [1440, 1920, 2560]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(`${baseUrl}/education${grouped ? "?group=true" : ""}`, { waitUntil: "networkidle" });
          await page.waitForSelector("tr[data-event-id]");
          const geometry = await page.getByTestId("education-summary-table").evaluate(table => {
            const columns = Array.from(table.querySelectorAll("th")).map(th => th.getBoundingClientRect().width);
            const cells = Array.from(table.querySelectorAll("tbody tr")).flatMap(tr =>
              Array.from(tr.children).filter((td, i) => ![0, 1, 5].includes(i)));
            return {
              width: table.getBoundingClientRect().width, columns,
              overflowingValues: cells.filter(td => td.scrollWidth > td.clientWidth + 1).length,
              firstColumn: table.querySelector("td").getBoundingClientRect().width,
              eventTitle: table.querySelector("a")?.getAttribute("title"),
              documentWidth: document.documentElement.scrollWidth,
            };
          });
          sizes.push(geometry);
          results.push({ lang, content, grouped, viewport: width, ...geometry });
          if (!baseline) {
            assert(geometry.documentWidth <= width + 1);
            assert(geometry.firstColumn <= 221 && geometry.firstColumn >= 218, "Preserve readable event width");
            assert.equal(geometry.overflowingValues, 0, "Numbers and dates must not overlap");
            assert(geometry.eventTitle?.length > 0, "Full event name remains accessible");
          }
          if (width === 1920) {
            await page.screenshot({ path: `${output}/${baseline ? "before" : "after"}-${lang}-${content}-${grouped ? "grouped" : "normal"}.jpg` });
          }
        }
        console.log(`${lang} ${content} ${grouped ? "grouped" : "normal"}: ${sizes.map(s => s.width.toFixed(1)).join(" / ")}px`);
        if (!baseline) {
          sizes.slice(1).forEach(size => {
            size.columns.forEach((column, i) => assert(Math.abs(column - sizes[0].columns[i]) < 2,
              `Column ${i} expands with viewport: ${sizes[0].columns[i]} -> ${column}`));
          });
        }
      }
    }
    if (!baseline) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${baseUrl}/education`, { waitUntil: "networkidle" });
      await page.waitForSelector("tr[data-event-id]");
      const resizeHandle = page.getByTestId("education-resize-event");
      const handleBox = await resizeHandle.boundingBox();
      assert(handleBox, "Event column resize handle must be visible");
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2, { steps: 5 });
      await page.mouse.up();
      const resizedWidth = await page.locator("tbody td").first().evaluate(cell => cell.getBoundingClientRect().width);
      assert(resizedWidth >= 298 && resizedWidth <= 302, `Dragged event column should be 300px, received ${resizedWidth}`);
      await page.reload({ waitUntil: "networkidle" });
      const persistedWidth = await page.locator("tbody td").first().evaluate(cell => cell.getBoundingClientRect().width);
      assert(Math.abs(persistedWidth - resizedWidth) < 1, "Resized width must persist after reload");
      await resizeHandle.dblclick();
      const resetWidth = await page.locator("tbody td").first().evaluate(cell => cell.getBoundingClientRect().width);
      assert(resetWidth >= 218 && resetWidth <= 221, "Double-click must restore the default width");
      console.log(`PASS ${lang} resizing: drag, persistence and reset`);

      await page.setViewportSize({ width: 390, height: 1000 });
      await page.getByTestId("button-toggle-sidebar").click();
      await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().width < 60);
      const scroll = await page.getByTestId("education-summary-table").evaluate(table => {
        const wrapper = table.parentElement;
        const before = table.querySelector("td").getBoundingClientRect().left;
        wrapper.scrollLeft = 100;
        return {
          scrolled: wrapper.scrollLeft, before, after: table.querySelector("td").getBoundingClientRect().left,
          pageWidth: document.documentElement.scrollWidth,
        };
      });
      assert.equal(scroll.scrolled, 100);
      assert(Math.abs(scroll.before - scroll.after) < 1);
      assert(scroll.pageWidth <= 391);
      console.log(`PASS ${lang} mobile: local scrolling and sticky event column`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(`${output}/${baseline ? "before" : "after"}.json`, JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}