import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createFixture } from "./fixture.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const run = path.resolve("test-results", `ai-run-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
await fs.mkdir(path.join(run, "profile"), { recursive: true });
await fs.writeFile(
  path.join(run, "profile", "settings.json"),
  JSON.stringify({ onboardingComplete: true }),
);
const file = path.join(run, "ai-reading-specimen.pdf");
await createFixture(file);
const calls = { outline: 0, gloss: 0, glossBatch: 0 };
const serverErrors = [],
  rendererErrors = [];
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 1_000_000)
        throw new Error("Unexpected oversized mock request");
    }
    const body = JSON.parse(text);
    assert.equal(body.model, "readerd-smoke-model");
    const system = body.messages.find(
      (message) => message.role === "system",
    ).content;
    let result;
    if (system.includes("Task: outline")) {
      calls.outline++;
      const payload = JSON.parse(
        body.messages.find((message) => message.role === "user").content,
      );
      const candidate = payload.candidates.find(
        (item) => item.text === "1 Introduction",
      );
      assert.ok(
        candidate,
        "The fixture heading must be an actual AI source candidate",
      );
      result = {
        outline: [
          {
            title: candidate.text,
            page: candidate.page,
            y: candidate.y,
            level: 1,
          },
          {
            title: "1 Introduction invented unsupported section",
            page: candidate.page,
            y: candidate.y,
            level: 1,
          },
        ],
      };
    } else if (system.includes("为每个目标词")) {
      calls.glossBatch++;
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.enable_thinking, false);
      assert.equal(body.temperature, 0);
      assert.ok(body.max_tokens >= 48);
      const payload = JSON.parse(
        body.messages.find((message) => message.role === "user").content,
      );
      result = payload.words.map((word) => ({ word, gloss: "代谢" }));
    } else if (system.includes("判断目标词")) {
      calls.gloss++;
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.enable_thinking, false);
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 64);
      result = { gloss: "代谢" };
    } else throw new Error(`Unexpected model task: ${system}`);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
    );
  } catch (error) {
    serverErrors.push(error.message);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let application;
try {
  application = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: process.env.READERD_EXECUTABLE ? [] : ["."],
    env: { ...process.env, READERD_USER_DATA: path.join(run, "profile") },
    timeout: 60000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  await page.waitForFunction(() => !!window.readerdApp, null, {
    timeout: 30000,
  });
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
  await page.evaluate(async (endpoint) => {
    await window.readerd.saveSettings({
      endpoint,
      model: "readerd-smoke-model",
    });
    window.readerdApp.state.settings = await window.readerd.getSettings();
  }, endpoint);
  await page.keyboard.press("Control+o");
  await page.waitForFunction(
    () => window.readerdApp.state.outline.some((item) => item.source === "AI"),
    null,
    { timeout: 30000 },
  );
  const outline = await page.evaluate(() => window.readerdApp.state.outline);
  assert.deepEqual(
    outline.map((item) => item.title),
    ["1 Introduction"],
  );
  assert.equal(outline[0].source, "AI");
  assert.equal(calls.outline, 1);
  for (let i = 0; i < 100 && !calls.glossBatch; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    calls.glossBatch >= 1,
    "The visible page should prefetch contextual glosses",
  );
  for (let i = 0; i < 100 && calls.glossBatch < 8; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const wordPoint = await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((node) => node.textContent.includes("Microbial metabolism and"));
    const index = span.textContent.indexOf("metabolism");
    const range = document.createRange();
    range.setStart(span.firstChild, index);
    range.setEnd(span.firstChild, index + "metabolism".length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(wordPoint.x, wordPoint.y);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-readerd-word-owned="gloss"]')
        ?.textContent === "代谢",
    null,
    { timeout: 10000 },
  );
  assert.equal(
    calls.gloss,
    0,
    "A prefetched hover must not send a single gloss request",
  );
  await page.screenshot({ path: path.join(run, "prefetched-gloss.png") });
  await page.mouse.move(20, 20);
  const plainPoint = await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((node) =>
      node.textContent.includes("Microbial metabolism connects"),
    );
    const index = span.textContent.indexOf("connects");
    const range = document.createRange();
    range.setStart(span.firstChild, index);
    range.setEnd(span.firstChild, index + "connects".length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(plainPoint.x, plainPoint.y);
  await page.waitForTimeout(600);
  assert.equal(
    await page.locator('[data-readerd-word-owned="gloss"]').count(),
    0,
    "An unmarked word must not start a gloss request",
  );
  await page.mouse.move(20, 20);
  await page.evaluate(() => window.readerdApp.flush());
  const previousDocument = await page.evaluate(
    () => window.readerdApp.state.documentId,
  );
  await page.keyboard.press("Control+o");
  await page.waitForFunction(
    (previous) =>
      window.readerdApp.state.documentId !== previous &&
      window.readerdApp.state.references.length === 4 &&
      window.readerdApp.state.outline.some((item) => item.source === "AI"),
    previousDocument,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.readerdApp.flush());
  assert.equal(
    calls.outline,
    1,
    "Opening an unchanged document must reuse the saved AI outline",
  );
  const gloss = await page.evaluate(() =>
    window.readerd.requestAI({
      kind: "gloss",
      payload: {
        word: "metabolism",
        sentence:
          "Microbial metabolism connects dietary nutrients to host physiology.",
      },
    }),
  );
  assert.deepEqual(gloss, { gloss: "代谢" });
  assert.equal(calls.gloss, 1);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(rendererErrors, []);
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("AI smoke application failed to close")),
      10000,
    );
    application.process().once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await page.keyboard.press("Control+q").catch((error) => {
    if (!error.message.includes("closed")) throw error;
  });
  await exit;
  console.log(
    JSON.stringify(
      {
        status: "passed",
        outlineCalls: calls.outline,
        glossCalls: calls.gloss,
        prefetchBatches: calls.glossBatch,
        inventedHeadingRejected: true,
        cachedOutlineReused: true,
        chineseGloss: gloss.gloss,
        rendererErrors,
        run,
      },
      null,
      2,
    ),
  );
} finally {
  if (application) await application.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
