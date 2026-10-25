import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const run = path.resolve("test-results", `portable-${Date.now()}`),
  profile = path.join(run, "profile");
await fs.mkdir(profile, { recursive: true });
const reserved = net.createServer();
await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
const port = reserved.address().port;
await new Promise((resolve) => reserved.close(resolve));
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) {
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        { message: { content: '{"gloss":"阅读"}' }, finish_reason: "stop" },
      ],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { version } = JSON.parse(await fs.readFile("package.json", "utf8"));
const exe = path.resolve(`release/${version}/ReaderD-${version}.exe`);
const child = spawn(
  exe,
  [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
  {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: { ...process.env, READERD_USER_DATA: profile },
  },
);
let browser, page;
try {
  let available = false;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        available = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(
    available,
    "Portable runtime must expose the explicitly requested test-only CDP port",
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.readerdApp);
  await page.bringToFront();
  assert.equal(await page.locator("#help").evaluate((el) => el.open), true);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => document.querySelector("#settings-dialog").open,
  );
  await page
    .locator("#ai-endpoint")
    .fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.locator("#ai-model").fill("portable-test");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => !document.querySelector("#settings-dialog").open,
  );
  const config = JSON.parse(
    await fs.readFile(path.join(profile, "settings.json"), "utf8"),
  );
  assert.equal(config.onboardingComplete, true);
  await page.screenshot({
    path: path.join(run, "portable-first-launch-passed.png"),
  });
  await page
    .evaluate(() => window.readerd.windowAction("close"))
    .catch(() => {});
  console.log(
    JSON.stringify(
      {
        status: "passed",
        actualSingleFilePortable: true,
        firstLaunchShortcuts: true,
        apiSetupCompleted: true,
        exe,
        run,
      },
      null,
      2,
    ),
  );
} finally {
  if (page && !page.isClosed())
    await page
      .evaluate(() => window.readerd?.windowAction("close"))
      .catch(() => {});
  if (browser) await browser.close().catch(() => {});
  child.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
