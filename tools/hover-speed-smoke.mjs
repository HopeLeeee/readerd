import { _electron as electron } from "playwright";
import electronPath from "electron";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const run = path.resolve("test-results", `hover-speed-${Date.now()}`),
  profile = path.join(run, "profile"),
  live = process.env.READERD_LIVE_CODEX === "1";
await fs.mkdir(profile, { recursive: true });
let server,
  requests = 0;
if (!live) {
  server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text),
      payload = JSON.parse(body.messages[1].content);
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const items =
      payload.items || payload.words.map((word, id) => ({ word, id }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(
                items.map((item) => ({
                  id: item.id,
                  word: item.word,
                  gloss: "代谢",
                })),
              ),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify(
    live
      ? { provider: "codex", onboardingComplete: true }
      : {
          provider: "api",
          endpoint: `http://127.0.0.1:${server.address().port}/v1`,
          model: "speed-test",
          onboardingComplete: true,
        },
  ),
);
let app;
async function launch() {
  app = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: process.env.READERD_EXECUTABLE ? [] : ["."],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.readerdApp);
  await page.bringToFront();
  return page;
}
async function install(page) {
  return page.evaluate(async () => {
    const { WordCompanion } = await import("./src/words/companion.js");
    const container = document.createElement("section");
    container.style.cssText =
      "position:fixed;left:450px;top:200px;width:500px;height:180px;background:white;color:black;z-index:200;font:18px/30px sans-serif";
    const textLayer = document.createElement("div");
    textLayer.textContent =
      "Microbial metabolism converts nutrients into energy. The enzyme catalyses this reaction.";
    container.append(textLayer);
    document.body.append(container);
    window.speedRequests = 0;
    const settings = await window.readerd.getSettings();
    const companion = new WordCompanion({
      getSettings: () => ({
        ...settings,
        lexicon: {
          entries: {
            metabolism: { rank: 9561 },
            nutrients: { rank: 9000 },
            enzyme: { rank: 7064 },
          },
          forms: {},
        },
      }),
      loadGlossCache: () => window.readerd.getGlossCache(),
      saveGlossCache: (entries) => window.readerd.saveGlossCache(entries),
      requestGlossBatch: async (candidates) => {
        window.speedRequests++;
        return window.readerd.requestAI({
          kind: "glossBatch",
          payload: { candidates },
        });
      },
      requestGloss: async (candidate) => {
        window.speedRequests++;
        return window.readerd.requestAI({ kind: "gloss", payload: candidate });
      },
    });
    await companion.initialize();
    await companion.attachPage({ pageNumber: 1, container, textLayer });
    window.speedCompanion = companion;
    window.speedMeasurements = [];
    container.addEventListener(
      "pointermove",
      () => {
        window.speedPointerStart = performance.now();
      },
      true,
    );
    const render = companion.renderGlossCard.bind(companion);
    companion.renderGlossCard = (...args) => {
      render(...args);
      if (
        companion.card &&
        !companion.card.textContent.includes("…") &&
        /[\u3400-\u9fff]/.test(companion.card.textContent)
      ) {
        const start = window.speedPointerStart,
          domMs = performance.now() - start;
        requestAnimationFrame(() =>
          window.speedMeasurements.push({
            domMs,
            nextFrameMs: performance.now() - start,
          }),
        );
      }
    };
    const start = performance.now();
    await companion.prefetchPage(1);
    await companion.flushGlossCache();
    const hit = companion.pages
      .get(1)
      .hits.find((hit) => hit.candidate.word === "metabolism");
    const rect = hit.range.getBoundingClientRect();
    return {
      prefetchMs: performance.now() - start,
      requests: window.speedRequests,
      cached: !!companion.cache.get(companion.glossKey(hit.candidate)),
      position: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      },
    };
  });
}
async function benchmark(page, position) {
  await page.mouse.move(30, 30);
  await page.evaluate(() => {
    window.speedMeasurements = [];
  });
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(30, 30);
    await page.mouse.move(position.x, position.y);
    await page.waitForFunction(
      (expected) => window.speedMeasurements.length >= expected,
      i + 1,
    );
  }
  const measurements = await page.evaluate(() => window.speedMeasurements);
  const dom = measurements.map((x) => x.domMs).sort((a, b) => a - b),
    frame = measurements.map((x) => x.nextFrameMs).sort((a, b) => a - b);
  assert.ok(dom[11] < 50, "Cached pointer-to-DOM response must be under 50ms");
  return {
    domP50Ms: dom[6],
    domP95Ms: dom[11],
    nextFrameP95Ms: frame[11],
    samples: measurements,
  };
}
try {
  let page = await launch();
  console.log(JSON.stringify({ stage: "cold-prefetch", live }));
  const cold = await install(page);
  assert.equal(cold.cached, true);
  assert.equal(
    cold.requests,
    1,
    "Three candidates with two sentence contexts should share one batch",
  );
  const warm = await benchmark(page, cold.position);
  assert.equal(await page.evaluate(() => window.speedRequests), 1);
  await app.close();
  app = null;
  page = await launch();
  const reopened = await install(page);
  assert.equal(reopened.cached, true);
  assert.equal(
    reopened.requests,
    0,
    "Reopening must reuse the on-disk context cache without another model request",
  );
  const reopenedWarm = await benchmark(page, reopened.position);
  const result = {
    status: "passed",
    liveCodex: live,
    coldPrefetchMs: cold.prefetchMs,
    modelRequests: cold.requests,
    warmHover: warm,
    persistentReloadRequests: reopened.requests,
    reopenedHover: reopenedWarm,
    run,
  };
  await fs.writeFile(
    path.join(run, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
