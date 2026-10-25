import { _electron as electron } from "playwright";
import electronPath from "electron";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";

const run = path.resolve("test-results", `outline-${Date.now()}`);
const profile = path.join(run, "profile");
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({ onboardingComplete: true }),
);
const pdf = await PDFDocument.create();
const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
const italic = await pdf.embedFont(StandardFonts.TimesRomanBoldItalic);
const roman = await pdf.embedFont(StandardFonts.TimesRoman);
const sheet = pdf.addPage([595, 1200]);
function runs(y, parts) {
  let x = 40;
  for (const [text, font = bold] of parts) {
    sheet.drawText(text, { x, y, size: 12, font });
    x += font.widthOfTextAtSize(text, 12);
  }
}
runs(1150, [["Results"]]);
runs(700, [["Pnc"], ["A", italic], [" inhibitor PCN disrupts gut microbiome"]]);
runs(684, [["homeostasis and "], ["E. coli", italic], [" survival"]]);
runs(400, [["Escherichia coli", italic]]);
runs(384, [["overexpression in the liver by adeno-associated virus"]]);
for (const y of [650, 636, 350, 336])
  sheet.drawText(
    "A long ordinary body paragraph with evidence and experimental results.",
    { x: 40, y, size: 10, font: roman },
  );
runs(240, [["Discussion"]]);
const file = path.join(run, "mixed-font-headings.pdf");
const cachedFile = path.join(run, "cached-fragments.pdf");
const bytes = await pdf.save();
await fs.writeFile(file, bytes);
await fs.writeFile(cachedFile, bytes);
await fs.writeFile(
  `${cachedFile}.readerd-state.json`,
  JSON.stringify({
    outline: [
      { title: "Pnc", page: 1, y: 500, source: "AI", level: 2 },
      { title: "E. coli", page: 1, y: 516, source: "AI", level: 2 },
      { title: "Escherichia coli", page: 1, y: 800, source: "AI", level: 2 },
      {
        title: "overexpression in the liver by adeno-associated virus",
        page: 1,
        y: 816,
        source: "AI",
        level: 2,
      },
    ],
  }),
);
const expected = [
  "PncA inhibitor PCN disrupts gut microbiome homeostasis and E. coli survival",
  "Escherichia coli overexpression in the liver by adeno-associated virus",
];
let calls = 0;
const errors = [];
const server = http.createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    let content = [];
    if (body.messages[0].content.includes("Task: outline")) {
      calls++;
      const payload = JSON.parse(body.messages[1].content);
      content = {
        outline: expected.map((title) => {
          const candidate = payload.candidates.find(
            (candidate) => candidate.text === title,
          );
          assert.ok(candidate, `Missing complete heading candidate: ${title}`);
          return { title, page: candidate.page, y: candidate.y, level: 2 };
        }),
      };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
      }),
    );
  } catch (error) {
    errors.push(error.message);
    response.writeHead(500);
    response.end("failed");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app;
try {
  app = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: process.env.READERD_EXECUTABLE ? [] : ["."],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.readerdApp);
  await page.evaluate(async (endpoint) => {
    await window.readerd.saveSettings({
      endpoint,
      model: "outline-smoke",
      provider: "api",
    });
    window.readerdApp.state.settings = await window.readerd.getSettings();
  }, `http://127.0.0.1:${server.address().port}/v1`);
  async function open(file) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, file);
    await page.keyboard.press("Control+o");
    await page.waitForFunction(
      (file) =>
        window.readerdApp.state.path === file &&
        window.readerdApp.state.outline.length === 2 &&
        window.readerdApp.state.outline.every((entry) => entry.source === "AI"),
      file,
    );
    const titles = await page.locator("#outline a").allTextContents();
    assert.deepEqual(titles, expected);
  }
  await open(file);
  assert.equal(calls, 1);
  await page.locator("#outline a").first().click();
  await page.waitForFunction(
    () => document.querySelector("#reader").scrollTop > 100,
  );
  await page.screenshot({ path: path.join(run, "complete-headings.png") });
  await open(cachedFile);
  assert.equal(
    calls,
    1,
    "Old fragmented cache should be repaired without another AI request",
  );
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    titles: expected,
    cachedFragmentsRepaired: true,
    preciseJump: true,
    calls,
    run,
  };
  await fs.writeFile(
    path.join(run, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
