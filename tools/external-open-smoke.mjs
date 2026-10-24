import { _electron as electron } from "playwright";
import electronPath from "electron";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { createFixture } from "./fixture.mjs";

const run = path.resolve("test-results", `external-open-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
await fs.mkdir(path.join(run, "profile"), { recursive: true });
await fs.writeFile(path.join(run, "profile", "settings.json"), JSON.stringify({ onboardingComplete: true }));
const first = path.join(run, "第一篇 文献 (测试).pdf");
const second = path.join(run, "第二篇 文献 (转交).pdf");
await createFixture(first);
await createFixture(second);
const env = { ...process.env, READERD_USER_DATA: path.join(run, "profile") };
// A shell would change quoting and would not reproduce Zotero's executable invocation.
const executablePath = process.env.READERD_EXECUTABLE || electronPath;
const argsFor = (file) =>
  process.env.READERD_EXECUTABLE ? [file] : [".", file];
const app = await electron.launch({
  executablePath,
  args: argsFor(first),
  env,
  timeout: 60000,
});
const children = new Set();
async function forward(file) {
  const child = spawn(executablePath, argsFor(file), {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  children.add(child);
  let timer;
  try {
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Forwarding process did not exit within 10 seconds"),
            ),
          10000,
        );
      }),
    ]);
    assert.equal(code, 0, "secondary launch should hand off and exit");
  } finally {
    clearTimeout(timer);
  }
}
try {
  const page = await app.firstWindow();
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  const waitDocument = async (file) => {
    await page.waitForFunction(
      (expected) =>
        window.readerdApp?.state.path === expected &&
        window.readerdApp.state.pdf?.numPages === 3 &&
        document.querySelectorAll(".page").length === 3,
      file,
      { timeout: 45000 },
    );
    assert.equal(await page.locator("#welcome").isVisible(), false);
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
  };
  await waitDocument(first);
  // Do not flush explicitly: switching documents must save pending annotations itself.
  await page.evaluate(() =>
    window.readerdApp.addAnnotation(
      "note",
      {
        text: "External open regression",
        groups: [
          {
            page: 1,
            rects: [{ x: 50, y: 740, width: 140, height: 15 }],
            anchor: { x: 190, y: 755 },
          },
        ],
      },
      "切换文献前尚未保存的批注",
    ),
  );
  await forward(second);
  await waitDocument(second);
  const saved = JSON.parse(
    await fs.readFile(`${first}.readerd-state.json`, "utf8"),
  );
  assert.equal(saved.annotations.length, 1);
  assert.equal(saved.annotations[0].text, "切换文献前尚未保存的批注");
  const savedPdf = await PDFDocument.load(await fs.readFile(first));
  assert.ok(
    savedPdf.getPages()[0].node.Annots()?.size() > 0,
    "pending note must also be written into the first PDF",
  );
  await page.evaluate(() => {
    document.getElementById("toast").hidden = true;
  });
  await forward(path.join(run, "不存在的 文献.pdf"));
  await page.waitForFunction(() => !document.getElementById("toast").hidden, {
    timeout: 10000,
  });
  assert.equal(await page.evaluate(() => window.readerdApp.state.path), second);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.deepEqual(rendererErrors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        executablePath,
        run,
        checks: [
          "cold argument open",
          "Chinese spaces parentheses",
          "single instance forwarding",
          "pending note PDF and sidecar persistence",
          "invalid path preserves document",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await app.close();
}
