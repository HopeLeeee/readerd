import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const run = path.resolve("test-results", `portable-green-${Date.now()}`);
const appDir = path.join(run, "ReaderD");
const appData = path.join(run, "appdata");
await fs.mkdir(appDir, { recursive: true });
await fs.mkdir(appData, { recursive: true });
const { version } = JSON.parse(await fs.readFile("package.json", "utf8"));
const sourceExe = path.resolve(`release/${version}/ReaderD-${version}.exe`);
const exe = path.join(appDir, `ReaderD-${version}.exe`);
await fs.copyFile(sourceExe, exe);

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
const env = {
  ...process.env,
  APPDATA: appData,
  READERD_LEGACY_DATA_DIR: appData,
};
delete env.READERD_USER_DATA;
const child = spawn(
  exe,
  [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
  { windowsHide: true, shell: false, stdio: "ignore", env },
);
let browser,
  page,
  exited = false;
const dataDir = path.join(appDir, "ReaderD-data");
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
  assert.ok(available, "Portable app must expose the test CDP port");
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
  await page.locator("#ai-model").fill("portable-green-test");
  await page.keyboard.press("Control+Enter");
  await page
    .waitForFunction(
      () => !document.querySelector("#settings-dialog").open,
      null,
      {
        timeout: 30000,
      },
    )
    .catch(async (error) => {
      console.log(
        "setup status",
        await page
          .locator("#ai-status")
          .textContent()
          .catch(() => ""),
      );
      await page.screenshot({
        path: path.join(run, "portable-green-setup-timeout.png"),
      });
      throw error;
    });

  const settings = JSON.parse(
    await fs.readFile(path.join(dataDir, "settings.json"), "utf8"),
  );
  assert.equal(settings.onboardingComplete, true);
  assert.equal(
    settings.endpoint,
    `http://127.0.0.1:${server.address().port}/v1`,
  );
  assert.ok(
    (await fs.stat(path.join(dataDir, "reading-profile.md"))).isFile(),
    "The reading profile must live in ReaderD-data",
  );
  await assert.rejects(
    fs.stat(path.join(appData, "readerd", "settings.json")),
    /ENOENT/,
    "Green mode must not write settings into APPDATA",
  );
  await page.screenshot({
    path: path.join(run, "portable-green-first-launch.png"),
  });

  const exitedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Portable green app did not exit after Ctrl+Q")),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      exited = true;
      resolve();
    });
  });
  await page.keyboard.press("Control+q").catch((error) => {
    if (!error.message.includes("closed")) throw error;
  });
  await exitedPromise;
  console.log(
    JSON.stringify(
      {
        status: "passed",
        greenDataDirectory: true,
        settingsBesideExe: true,
        appDataUntouched: true,
        firstLaunchShortcuts: true,
        apiSetupCompleted: true,
        closedWithCtrlQ: true,
        exe,
        dataDir,
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
  if (!exited) child.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
