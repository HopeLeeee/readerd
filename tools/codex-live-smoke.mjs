import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { probeCodex } from "../electron/codex-bridge.mjs";
const run = path.resolve("test-results", `codex-live-${Date.now()}`),
  profile = path.join(run, "profile");
await fs.mkdir(profile, { recursive: true });
const probe = await probeCodex();
const result = { status: "running", probe, checks: [], run };
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({ provider: "codex", onboardingComplete: true }),
);
let app;
const record = async () =>
  fs.writeFile(path.join(run, "result.json"), JSON.stringify(result, null, 2));
try {
  assert.equal(probe.available, true, probe.error);
  console.log(JSON.stringify({ stage: "installed-codex", ...probe }));
  app = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: process.env.READERD_EXECUTABLE ? [] : ["."],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.readerdApp);
  const check = async (name, fn) => {
    console.log(JSON.stringify({ stage: name, status: "starting" }));
    const start = Date.now();
    const output = await fn();
    result.checks.push({ name, elapsedMs: Date.now() - start, output });
    await record();
    console.log(JSON.stringify(result.checks.at(-1)));
    return output;
  };
  await check("ReaderD connection to real Codex", async () => {
    const answer = await page.evaluate(() =>
      window.readerd.testAI({ provider: "codex" }),
    );
    assert.equal(answer.ok, true);
    return answer;
  });
  await check("Chinese contextual gloss", async () => {
    const answer = await page.evaluate(() =>
      window.readerd.requestAI({
        kind: "gloss",
        payload: {
          word: "metabolism",
          lemma: "metabolism",
          sentence: "Microbial metabolism converts nutrients into energy.",
          targetStart: 10,
          targetEnd: 20,
        },
      }),
    );
    assert.match(answer.gloss, /[\u3400-\u9fff]/);
    return answer;
  });
  await check("Batch contextual gloss", async () => {
    const answer = await page.evaluate(() =>
      window.readerd.requestAI({
        kind: "glossBatch",
        payload: {
          candidates: [
            {
              word: "metabolism",
              lemma: "metabolism",
              sentence: "Microbial metabolism converts nutrients into energy.",
            },
            {
              word: "nutrients",
              lemma: "nutrient",
              sentence: "Microbial metabolism converts nutrients into energy.",
            },
          ],
        },
      }),
    );
    const parsed = JSON.parse(answer);
    assert.equal(parsed.length, 2);
    assert.ok(parsed.every((item) => /[\u3400-\u9fff]/.test(item.gloss)));
    return parsed;
  });
  await check("Real request cancellation", async () => {
    await page.evaluate(() => {
      window.liveCancel = window.readerd
        .requestAI({
          requestId: "live-cancel-test",
          kind: "gloss",
          payload: {
            word: "enzyme",
            sentence: "The enzyme catalyses the reaction.",
          },
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: error.message }),
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate(() => window.readerd.cancelAI("live-cancel-test"));
    const answer = await page.evaluate(() => window.liveCancel);
    assert.match(answer.error || "", /abort|取消/i);
    return answer;
  });
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await record();
  console.log(JSON.stringify(result, null, 2));
}
