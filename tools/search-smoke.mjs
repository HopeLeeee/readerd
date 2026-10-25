import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createFixture } from "./fixture.mjs";

const run = path.resolve("test-results", `search-${Date.now()}`);
const profile = path.join(run, "profile");
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({ onboardingComplete: true }),
);
const file = path.join(run, "search-context.pdf");
await createFixture(file);
const app = await electron.launch({
  executablePath: process.env.READERD_EXECUTABLE || electronPath,
  args: process.env.READERD_EXECUTABLE ? [] : ["."],
  env: { ...process.env, READERD_USER_DATA: profile },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.readerdApp);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
  await page.keyboard.press("Control+o");
  await page.waitForFunction(() => window.readerdApp.state.pages.length === 3);
  await page.keyboard.press("Control+f");
  await page.waitForFunction(
    () => document.querySelector("#search-dialog").open,
  );
  const panel = await page.locator("#search-dialog").evaluate((el) => {
    const backdrop = getComputedStyle(el, "::backdrop");
    return {
      modal: el.matches(":modal"),
      background: backdrop.backgroundColor,
      blur: backdrop.backdropFilter,
      top: el.getBoundingClientRect().top,
    };
  });
  assert.equal(panel.modal, false);
  assert.equal(panel.background, "rgba(0, 0, 0, 0)");
  assert.equal(panel.blur, "none");
  assert.ok(
    panel.top < 30,
    "Search should be docked above the reading context",
  );
  await page.locator("#search-text").fill("microbial");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#search-status").textContent.startsWith("1 /"),
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#search-status").textContent.startsWith("2 /"),
  );
  assert.equal(await page.locator(".search-match").count(), 1);
  await page.waitForTimeout(500);
  const before = await page.locator("#reader").evaluate((el) => el.scrollTop);
  const reader = await page.locator("#reader").boundingBox();
  await page.mouse.move(
    reader.x + reader.width / 2,
    reader.y + reader.height / 2,
  );
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(
    (before) => document.querySelector("#reader").scrollTop > before + 100,
    before,
  );
  assert.equal(
    await page.locator("#search-dialog").evaluate((el) => el.open),
    true,
  );
  await page.screenshot({
    path: path.join(run, "search-readable-context.png"),
  });
  await page.mouse.click(
    reader.x + reader.width / 2,
    reader.y + reader.height / 2,
  );
  await page.keyboard.press("Control+f");
  assert.equal(
    await page
      .locator("#search-text")
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#search-dialog").evaluate((el) => el.open),
    false,
  );
  await page.keyboard.press("Control+,");
  await page.waitForFunction(() =>
    document.querySelector("#settings-dialog").matches(":modal"),
  );
  assert.equal(
    await page
      .locator("#settings-dialog")
      .evaluate((el) => getComputedStyle(el, "::backdrop").backdropFilter),
    "blur(5px)",
  );
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    noSearchMask: true,
    backgroundScrollable: true,
    enterCyclesMatches: true,
    escapeCloses: true,
    settingsStillModal: true,
    run,
  };
  await fs.writeFile(
    path.join(run, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await app.close().catch(() => {});
}
