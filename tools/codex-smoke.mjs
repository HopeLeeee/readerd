import { _electron as electron } from "playwright";
import electronPath from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createFixture } from "./fixture.mjs";

const run = path.resolve("test-results", `codex-${Date.now()}`);
const profile = path.join(run, "profile");
const file = path.join(run, "Codex 首次启动.pdf");
const fake = path.join(run, "fake-codex.exe");
const promptFile = path.join(run, "fake-codex-prompt.txt");
const argsFile = path.join(run, "fake-codex-args.txt");
const sourceFile = path.join(run, "fake-codex.cs");
await fs.mkdir(run, { recursive: true });
await createFixture(file);

const compiler = [
  path.join(
    process.env.WINDIR || "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  ),
  path.join(
    process.env.WINDIR || "C:\\Windows",
    "Microsoft.NET",
    "Framework",
    "v4.0.30319",
    "csc.exe",
  ),
].find((candidate) => existsSync(candidate));
assert.ok(
  compiler,
  "A .NET Framework C# compiler is required for this smoke test",
);
await fs.writeFile(
  sourceFile,
  `using System;
using System.IO;
using System.Text;

static class FakeCodex
{
    static int Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        File.WriteAllText(Path.Combine(baseDir, "fake-codex-args.txt"), string.Join("\\n", args));
        Console.OutputEncoding = new UTF8Encoding(false);
        if (Array.IndexOf(args, "--version") >= 0)
        {
            Console.Out.WriteLine("codex-cli 0.0.0-fake");
            return 0;
        }
        string prompt = Console.In.ReadToEnd();
        File.WriteAllText(Path.Combine(baseDir, "fake-codex-prompt.txt"), prompt);
        Console.Out.WriteLine("{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"{\\\\\\"ok\\\\\\":true}\\"}}");
        Console.Out.WriteLine("{\\"type\\":\\"turn.completed\\"}");
        return 0;
    }
}
`,
);
const compiled = spawnSync(compiler, ["/nologo", `/out:${fake}`, sourceFile], {
  windowsHide: true,
  encoding: "utf8",
});
assert.equal(
  compiled.status,
  0,
  compiled.stderr || "fake Codex failed to compile",
);

const rendererErrors = [];
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
      () => reject(new Error("Codex smoke application did not exit")),
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
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => document.querySelector("#settings-dialog").open,
  );
  await page.locator("#ai-provider").selectOption("codex");
  assert.equal(await page.locator("#ai-endpoint").isVisible(), false);
  assert.equal(await page.locator("#codex-path").isVisible(), true);
  await page.locator("#codex-path").fill(path.join(run, "missing-codex.exe"));
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () =>
      /找不到指定的 Codex 程序/.test(
        document.querySelector("#ai-status").textContent,
      ),
    null,
    { timeout: 30000 },
  );
  assert.equal(
    await page.locator("#settings-dialog").evaluate((element) => element.open),
    true,
  );
  assert.notEqual((await settingsOnDisk()).onboardingComplete, true);
  await page.locator("#codex-path").fill(fake);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => !document.querySelector("#settings-dialog").open,
    null,
    { timeout: 30000 },
  );
  assert.equal((await settingsOnDisk()).provider, "codex");
  assert.equal((await settingsOnDisk()).codexPath, fake);
  assert.equal((await settingsOnDisk()).onboardingComplete, true);
  const args = (await fs.readFile(argsFile, "utf8")).split(/\r?\n/);
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--json"));
  assert.equal(args.at(-1), "-");
  assert.ok(!args.some((argument) => argument.includes("Connection test")));
  const prompt = await fs.readFile(promptFile, "utf8");
  assert.match(prompt, /Connection test/);
  assert.match(prompt, /Reply only JSON/);
  await page.waitForFunction(
    (expected) =>
      window.readerdApp.state.path === expected &&
      window.readerdApp.state.pdf?.numPages === 3,
    file,
    { timeout: 45000 },
  );
  await page.screenshot({ path: path.join(run, "codex-first-open.png") });
  await quit(page);
  page = await launch();
  assert.equal(
    await page.locator("#help").evaluate((element) => element.open),
    false,
  );
  assert.equal((await settingsOnDisk()).provider, "codex");
  assert.deepEqual(rendererErrors, []);
  await quit(page);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        codexPathAutofillAccepted: true,
        invalidPathRejected: true,
        codexFieldsOnly: true,
        stdinPrompt: true,
        isolatedReadOnlyArguments: true,
        queuedExternalPdfOpened: true,
        restartDoesNotRepeatGuide: true,
        rendererErrors,
        run,
      },
      null,
      2,
    ),
  );
} finally {
  if (application) await application.close().catch(() => {});
}
