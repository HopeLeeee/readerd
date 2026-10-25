import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { createFixture } from "./fixture.mjs";

const version = process.env.READERD_BENCHMARK_VERSION || "0.2.4";
const trials = Number(process.env.READERD_BENCHMARK_TRIALS || 2);
const variants = (process.env.READERD_BENCHMARK_VARIANTS || "portable,unpacked").split(",");
assert.ok(variants.every(value => ["portable", "unpacked"].includes(value)));
const run = path.resolve("test-results", `startup-benchmark-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
const first = path.join(run, "第一篇 Zotero 外部打开.pdf");
const second = path.join(run, "第二篇 Zotero 转交.pdf");
await createFixture(first);
await createFixture(second);
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitDocument(page, file) {
  await page.waitForFunction(
    (expected) => {
      const state = window.readerdApp?.state;
      const view = state?.views?.[0];
      return (
        state?.path === expected &&
        state.pdf?.numPages === 3 &&
        view?.rendered &&
        !view.task &&
        view.canvas.width > 1 &&
        view.textLayer.textContent.length > 10
      );
    },
    file,
    { timeout: 60000, polling: 20 },
  );
}
for (let trial = 1; trial <= trials; trial++) {
  for (const variant of variants) {
    const exe = path.resolve(
      `release/${version}/${variant === "portable" ? `ReaderD-${version}.exe` : "win-unpacked/ReaderD.exe"}`,
    );
    const profile = path.join(run, `${variant}-${trial}`);
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({ onboardingComplete: true }),
    );
    const env = { ...process.env, READERD_USER_DATA: profile };
    const port = await reservePort();
    const started = performance.now();
    const child = spawn(
      exe,
      [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        first,
      ],
      {
        env,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    let browser, page, forwarded;
    try {
      for (;;) {
        if (performance.now() - started > 120000)
          throw new Error("Startup CDP timeout");
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}/json/version`,
            { signal: AbortSignal.timeout(300) },
          );
          if (response.ok) break;
        } catch {}
        await sleep(50);
      }
      const cdpReadyMs = performance.now() - started;
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (let i = 0; i < 100 && !browser.contexts()[0]?.pages().length; i++)
        await sleep(20);
      page = browser.contexts()[0].pages()[0];
      assert.ok(page, "ReaderD window must exist");
      await waitDocument(page, first);
      const firstPdfReadyMs = performance.now() - started;
      const applicationUrl = page.url();
      const forwardedAt = performance.now();
      forwarded = spawn(exe, [second], {
        env,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      const forwardExited = new Promise((resolve) =>
        forwarded.once("exit", (code) =>
          resolve({ code, ms: performance.now() - forwardedAt }),
        ),
      );
      await waitDocument(page, second);
      const forwardedPdfReadyMs = performance.now() - forwardedAt;
      let exitTimer;
      const secondaryExit = await Promise.race([
        forwardExited,
        new Promise((resolve) => {
          exitTimer = setTimeout(() => resolve({ timeout: true }), 60000);
        }),
      ]);
      clearTimeout(exitTimer);
      const result = {
        variant,
        trial,
        exe,
        executableBytes: (await fs.stat(exe)).size,
        applicationUrl,
        cdpReadyMs,
        firstPdfReadyMs,
        forwardedPdfReadyMs,
        secondaryExit,
      };
      results.push(result);
      console.log(JSON.stringify(result));
      await fs.writeFile(
        path.join(run, "result.json"),
        JSON.stringify({ version, fixturePages: 3, results }, null, 2),
      );
    } finally {
      // Only close processes started by this benchmark, never other ReaderD windows.
      if (page && !page.isClosed())
        await page
          .evaluate(() => window.readerd.windowAction("close"))
          .catch(() => {});
      if (browser) await browser.close().catch(() => {});
      await sleep(500);
      if (child.exitCode === null) child.kill();
      if (forwarded?.exitCode === null) forwarded.kill();
    }
  }
}
console.log(`Saved ${path.join(run, "result.json")}`);
