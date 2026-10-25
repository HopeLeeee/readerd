import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createFixture } from "./fixture.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const run = path.resolve("test-results", `hybrid-hover-${Date.now()}`),
  profile = path.join(run, "profile"),
  file = path.join(run, "Hybrid reading.pdf");
await fs.mkdir(profile, { recursive: true });
await createFixture(file);
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
let requests = 0;
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw),
    system = body.messages[0].content,
    payload = JSON.parse(body.messages[1].content);
  let content;
  if (system.includes("Task: outline"))
    content = JSON.stringify({ outline: [] });
  else {
    requests++;
    await gate;
    if (res.destroyed) return;
    const items =
      payload.items || payload.words?.map((word, id) => ({ word, id }));
    content = items
      ? JSON.stringify(
          items.map((item) => ({
            id: item.id,
            word: item.word,
            gloss:
              item.word.toLowerCase() === "metabolism"
                ? "代谢作用"
                : "语境释义",
          })),
        )
      : JSON.stringify({ gloss: "代谢作用" });
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    provider: "api",
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "hybrid-test",
    onboardingComplete: true,
  }),
);
let app;
try {
  app = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: [...(process.env.READERD_EXECUTABLE ? [] : ["."]), file],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () =>
      window.readerdApp?.state.views[0]?.rendered &&
      document.querySelector(".textLayer")?.textContent.includes("metabolism"),
  );
  await page.bringToFront();
  const point = await page.evaluate(() => {
    const spans = [...document.querySelectorAll(".textLayer span")],
      span = spans.find((el) => el.textContent.includes("metabolism")),
      node = span.firstChild,
      start = node.textContent.indexOf("metabolism"),
      range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 10);
    const rect = range.getBoundingClientRect();
    window.dictionaryDelay = null;
    window.pointerTime = 0;
    document.addEventListener(
      "pointermove",
      () => (window.pointerTime = performance.now()),
      true,
    );
    const observer = new MutationObserver(() => {
      const card = document.querySelector('[data-readerd-word-owned="gloss"]');
      if (
        window.dictionaryDelay === null &&
        card?.textContent.startsWith("词典参考：")
      )
        window.dictionaryDelay = performance.now() - window.pointerTime;
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(20, 20);
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-readerd-word-owned="gloss"]')
      ?.textContent.startsWith("词典参考："),
  );
  const first = await page.evaluate(() => ({
    text: document.querySelector('[data-readerd-word-owned="gloss"]')
      .textContent,
    ms: window.dictionaryDelay,
  }));
  assert.match(first.text, /代谢/);
  assert.ok(first.ms < 50, `Dictionary fallback took ${first.ms}ms`);
  await page.screenshot({ path: path.join(run, "dictionary-first.png") });
  release();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-readerd-word-owned="gloss"]')
        ?.textContent === "上下文：代谢作用",
  );
  await page.screenshot({ path: path.join(run, "context-corrected.png") });
  const result = {
    status: "passed",
    coldNoAICache: true,
    dictionaryFirst: first,
    contextCorrection: "上下文：代谢作用",
    requests,
    run,
  };
  await fs.writeFile(
    path.join(run, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  release();
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
