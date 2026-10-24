import { _electron as electron } from "playwright";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve("test-results");
const run = path.join(root, `navigation-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
await fs.mkdir(path.join(run, "profile"), { recursive: true });
await fs.writeFile(path.join(run, "profile", "settings.json"), JSON.stringify({ onboardingComplete: true }));
const fixture = path.join(run, "native-bookmarks.pdf");
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.TimesRoman);
const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
const pages = Array.from({ length: 3 }, () => pdf.addPage([595, 842]));
pages[0].drawText("Bookmark navigation specimen", { x: 55, y: 760, size: 23, font: bold });
pages[0].drawText("This document tests precise section positions.", { x: 55, y: 710, size: 11, font });
for (const [title, y] of [["Introduction", 740], ["Methods", 490], ["Discussion", 240]]) {
  pages[1].drawText(title, { x: 55, y, size: 16, font: bold });
  pages[1].drawText("Evidence and interpretation are described in this section.", { x: 55, y: y - 25, size: 11, font });
}
pages[2].drawText("Appendix", { x: 55, y: 760, size: 16, font: bold });
const ctx = pdf.context;
const outlines = ctx.obj({ Type: "Outlines", Count: 3 });
const outlineRef = ctx.register(outlines);
const definitions = [
  ["Introduction", ctx.obj([pages[1].ref, PDFName.of("XYZ"), 55, 740, null])],
  ["Methods", ctx.obj([pages[1].ref, PDFName.of("Fit")])],
  ["Discussion", PDFString.of("discussion")],
];
const nodes = definitions.map(([title, dest]) => ctx.obj({ Title: PDFString.of(title), Parent: outlineRef, Dest: dest }));
const refs = nodes.map((node) => ctx.register(node));
nodes.forEach((node, index) => {
  if (index) node.set(PDFName.of("Prev"), refs[index - 1]);
  if (index < refs.length - 1) node.set(PDFName.of("Next"), refs[index + 1]);
});
outlines.set(PDFName.of("First"), refs[0]);
outlines.set(PDFName.of("Last"), refs.at(-1));
pdf.catalog.set(PDFName.of("Outlines"), outlineRef);
pdf.catalog.set(PDFName.of("Dests"), ctx.obj({ discussion: { D: [pages[1].ref, PDFName.of("XYZ"), 55, 240, null] } }));
await fs.writeFile(fixture, await pdf.save());

const app = await electron.launch({
  ...(process.env.READERD_EXECUTABLE ? { executablePath: process.env.READERD_EXECUTABLE, args: [] } : { args: ["."] }),
  env: { ...process.env, READERD_USER_DATA: path.join(run, "profile") },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.waitForFunction(() => !!window.readerdApp, null, { timeout: 30000 });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, fixture);
  await page.keyboard.press("Control+o");
  await page.waitForFunction(() => document.querySelectorAll("#outline a").length === 3, null, { timeout: 30000 });
  async function navigate(title) {
    await page.locator("#outline a").filter({ hasText: new RegExp(`^${title}$`) }).click();
    await page.waitForFunction((title) => {
      const heading = [...document.querySelectorAll(".page:nth-child(2) .textLayer span")].find((span) => span.textContent.trim() === title);
      if (!heading) return false;
      const box = heading.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const now = performance.now();
      const last = heading.navigationSmokePosition;
      if (!last || Math.abs(last.y - y) > 0.25) {
        heading.navigationSmokePosition = { y, since: now };
        return false;
      }
      return box.top >= 0 && y >= 20 && y <= 80 && now - last.since > 120;
    }, title, { timeout: 15000, polling: "raf" });
    return page.evaluate(() => document.getElementById("reader").scrollTop);
  }
  const intro = await navigate("Introduction");
  const discussion = await navigate("Discussion");
  const methods = await navigate("Methods");
  assert.ok(discussion > methods && methods > intro, `Sections on the same page need distinct destinations: ${JSON.stringify({intro, discussion, methods})}`);
  const initialScale = await page.evaluate(() => window.readerdApp.state.scale);
  await page.keyboard.press("Control++");
  await page.waitForFunction((scale) => window.readerdApp.state.scale > scale, initialScale);
  await navigate("Discussion");
  await navigate("Introduction");
  await navigate("Methods");
  await page.screenshot({ path: path.join(root, "navigation.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", checks: ["direct XYZ destination", "named destination", "page-only title fallback", "distinct same-page headings", "zoomed navigation"], screenshot: path.join(root, "navigation.png"), run }, null, 2));
} finally {
  await app.close().catch(() => {});
}
