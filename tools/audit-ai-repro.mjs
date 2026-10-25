import { _electron as electron } from "playwright";
import electronPath from "electron";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const run = path.resolve("test-results", `ai-regression-${Date.now()}`),
  profile = path.join(run, "profile");
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({ onboardingComplete: true }),
);
let mode = "strict",
  cancelled = false,
  holdStarted;
const held = new Promise((resolve) => {
  holdStarted = resolve;
});
const requests = [];
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const part of req) text += part;
  const body = JSON.parse(text);
  requests.push(Object.keys(body));
  if (mode === "cancel") {
    res.on("close", () => {
      cancelled = true;
    });
    holdStarted();
    return;
  }
  const field =
    mode === "strict" &&
    ["enable_thinking", "reasoning_effort", "temperature"].find((name) =>
      Object.hasOwn(body, name),
    );
  res.writeHead(field ? 400 : 200, { "Content-Type": "application/json" });
  const content =
    mode === "broken"
      ? '{"gloss":"截断'
      : mode === "english"
        ? '{"gloss":"English explanation"}'
        : '{"gloss":"代谢"}';
  res.end(
    JSON.stringify(
      field
        ? {
            error: {
              message: `Unsupported parameter: ${field}`,
              param: field,
              code: "unsupported_parameter",
            },
          }
        : {
            choices: [
              {
                finish_reason: mode === "broken" ? "length" : "stop",
                message: { content },
              },
            ],
          },
    ),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const configuration = {
  provider: "api",
  endpoint: `http://127.0.0.1:${server.address().port}/v1`,
  model: "audit-model",
};
let app;
try {
  app = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: process.env.READERD_EXECUTABLE ? [] : ["."],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.readerdApp);
  const connection = await page.evaluate(
    (config) => window.readerd.testAI(config),
    configuration,
  );
  assert.equal(connection.ok, true);
  assert.equal(requests.length, 4);
  await page.evaluate(
    (config) =>
      window.readerd.saveSettings({ ...config, onboardingComplete: true }),
    configuration,
  );
  const gloss = () =>
    page.evaluate(() =>
      window.readerd.requestAI({
        kind: "gloss",
        payload: {
          word: "metabolism",
          sentence: "Microbial metabolism changes.",
        },
      }),
    );
  assert.equal((await gloss()).gloss, "代谢");
  assert.equal(requests.length, 5);
  mode = "broken";
  await assert.rejects(gloss(), /截断/);
  mode = "english";
  await assert.rejects(gloss(), /简短中文释义/);
  mode = "strict";
  assert.equal((await gloss()).gloss, "代谢");
  mode = "cancel";
  await page.evaluate(() => {
    window.cancelResult = window.readerd
      .requestAI({
        requestId: "cancel-test",
        kind: "gloss",
        payload: {
          word: "metabolism",
          sentence: "Microbial metabolism changes.",
        },
      })
      .then(
        () => ({ accepted: true }),
        (error) => ({ error: error.message }),
      );
  });
  await held;
  await page.evaluate(() => window.readerd.cancelAI("cancel-test"));
  const cancelResult = await page.evaluate(() => window.cancelResult);
  assert.ok(cancelResult.error);
  for (let i = 0; i < 50 && !cancelled; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    cancelled,
    true,
    "Cancellation must close the actual HTTP response stream",
  );
  const result = {
    status: "passed",
    unsupportedFieldsLearned: true,
    connectionTestsRealGloss: true,
    truncatedAndEnglishRejected: true,
    retrySucceeds: true,
    cancelledHttpStream: true,
    run,
  };
  await fs.writeFile(
    path.join(run, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
