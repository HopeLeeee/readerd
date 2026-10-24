import { _electron as electron } from "playwright";
import electronPath from "electron";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createFixture } from "./fixture.mjs";

const run = path.resolve("test-results", `onboarding-${Date.now()}`);
const profile = path.join(run, "profile");
const file = path.join(run, "首次打开 文献.pdf");
await fs.mkdir(run, { recursive: true });
await createFixture(file);
const secret = "readerd-first-launch-test-secret";
const requests = [];
const serverErrors = [];
const rendererErrors = [];
let rejectConnection = true;
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "first-launch-test-model");
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    requests.push(body);
    response.writeHead(rejectConnection ? 500 : 200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify(
        rejectConnection
          ? { error: { message: "Deliberate first-launch connection failure" } }
          : { choices: [{ message: { content: '{"ok":true}' } }] },
      ),
    );
  } catch (error) {
    serverErrors.push(error.message);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let application;
const settingsOnDisk = async () => {
  try {
    return JSON.parse(
      await fs.readFile(path.join(profile, "settings.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};
async function launch(fileArgument) {
  application = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: [
      ...(process.env.READERD_EXECUTABLE ? [] : ["."]),
      ...(fileArgument ? [fileArgument] : []),
    ],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.waitForFunction(() => !!window.readerdApp, null, {
    timeout: 30000,
  });
  return page;
}
async function quit(page) {
  const child = application.process();
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Onboarding application did not exit")),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await page.keyboard.press("Control+q").catch((error) => {
    if (!error.message.includes("closed")) throw error;
  });
  await exit;
  application = undefined;
}
try {
  let page = await launch(file);
  await page.waitForFunction(() => document.querySelector("#help").open);
  await page.screenshot({ path: path.join(run, "first-launch-shortcuts.png") });
  assert.match(await page.locator("#shortcut-list").innerText(), /W/);
  assert.match(await page.locator("#shortcut-list").innerText(), /Ctrl/);
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#help").evaluate((element) => element.open),
    true,
    "First-launch shortcuts must not be bypassed using Escape",
  );
  assert.equal(
    await page.evaluate(() => !!window.readerdApp.state.pdf),
    false,
    "A command-line document must wait until first-launch setup completes",
  );
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => document.querySelector("#settings-dialog").open,
  );
  await page.screenshot({ path: path.join(run, "first-launch-ai-setup.png") });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#settings-dialog").evaluate((element) => element.open),
    true,
  );
  await page.locator("#ai-provider").selectOption("api");
  await page.locator("#ai-endpoint").fill(endpoint);
  await page.locator("#ai-model").fill("first-launch-test-model");
  await page.locator("#ai-key").fill(secret);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () =>
      /失败|500|failure/i.test(
        document.querySelector("#ai-status").textContent,
      ),
    null,
    { timeout: 30000 },
  );
  assert.equal(
    await page.locator("#settings-dialog").evaluate((element) => element.open),
    true,
  );
  assert.notEqual(
    (await settingsOnDisk()).onboardingComplete,
    true,
    "A failed API check must not mark onboarding complete",
  );
  rejectConnection = false;
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => !document.querySelector("#settings-dialog").open,
    null,
    { timeout: 30000 },
  );
  assert.equal((await settingsOnDisk()).onboardingComplete, true);
  const rawSettings = await fs.readFile(
    path.join(profile, "settings.json"),
    "utf8",
  );
  assert.equal(
    rawSettings.includes(secret),
    false,
    "API Key must not be stored in plaintext settings",
  );
  const encrypted = await fs.readFile(path.join(profile, "ai-key.bin"));
  assert.ok(encrypted.length > 0);
  assert.equal(encrypted.includes(Buffer.from(secret)), false);
  await page.waitForFunction(
    (expected) =>
      window.readerdApp.state.path === expected &&
      window.readerdApp.state.pdf?.numPages === 3,
    file,
    { timeout: 45000 },
  );
  await page.screenshot({ path: path.join(run, "configured-first-open.png") });
  await quit(page);
  page = await launch();
  assert.equal(
    await page.locator("#help").evaluate((element) => element.open),
    false,
    "Completed onboarding must not repeat on the next launch",
  );
  assert.equal(
    await page.locator("#settings-dialog").evaluate((element) => element.open),
    false,
  );
  assert.equal(
    await page.evaluate(() => window.readerdApp.state.settings.hasApiKey),
    true,
  );
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(rendererErrors, []);
  assert.ok(requests.length >= 2);
  await quit(page);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        freshProfileShortcuts: true,
        setupRequired: true,
        failedConnectionNotPersisted: true,
        encryptedKey: true,
        queuedExternalPdfOpened: true,
        restartDoesNotRepeatGuide: true,
        requests: requests.length,
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
