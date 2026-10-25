import { _electron as electron } from "playwright";
import electronPath from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const run = path.resolve("test-results", `codex-cancel-${Date.now()}`);
const profile = path.join(run, "profile");
const fake = path.join(run, "fake-codex.exe");
const marker = path.join(run, "fake-codex-pid.txt");
const source = path.join(run, "fake-codex.cs");
await fs.mkdir(profile, { recursive: true });
const compiler = ["Framework64", "Framework"]
  .map((arch) =>
    path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      arch,
      "v4.0.30319",
      "csc.exe",
    ),
  )
  .find(existsSync);
assert.ok(compiler, "A .NET Framework C# compiler is required");
await fs.writeFile(
  source,
  `using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
static class FakeCodex {
  static void Main() {
    Console.In.ReadToEnd();
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake-codex-pid.txt"), Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(30000);
    Console.WriteLine("{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"late answer\\"}}");
    Console.WriteLine("{\\"type\\":\\"turn.completed\\"}");
  }
}
`,
);
const compiled = spawnSync(compiler, ["/nologo", `/out:${fake}`, source], {
  windowsHide: true,
  shell: false,
  encoding: "utf8",
});
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
await fs.writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    provider: "codex",
    codexPath: fake,
    onboardingComplete: true,
  }),
);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
async function waitUntil(check, message, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
let application, pid;
const rendererErrors = [];
try {
  application = await electron.launch({
    executablePath: process.env.READERD_EXECUTABLE || electronPath,
    args: process.env.READERD_EXECUTABLE ? [] : ["."],
    env: { ...process.env, READERD_USER_DATA: profile },
    timeout: 60000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.waitForFunction(() => !!window.readerdApp, null, {
    timeout: 30000,
  });
  await page.evaluate(() => {
    window.cancelSmoke = { status: "pending" };
    window.readerd
      .requestAI({
        requestId: "cancel-native-test",
        kind: "gloss",
        payload: {
          word: "native",
          sentence: "A native process can be cancelled.",
        },
      })
      .then(
        (result) => {
          window.cancelSmoke = { status: "resolved", result };
        },
        (error) => {
          window.cancelSmoke = { status: "rejected", error: error.message };
        },
      );
  });
  await waitUntil(
    () => existsSync(marker),
    "Native fake Codex never read stdin",
  );
  pid = Number((await fs.readFile(marker, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(
    alive(pid),
    true,
    "Native process should be running before cancellation",
  );
  const started = Date.now();
  assert.equal(
    await page.evaluate(() => window.readerd.cancelAI("cancel-native-test")),
    true,
  );
  await page.waitForFunction(
    () => window.cancelSmoke.status !== "pending",
    null,
    { timeout: 5000 },
  );
  const outcome = await page.evaluate(() => window.cancelSmoke);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error, /AbortError|取消|abort/i);
  await waitUntil(
    () => !alive(pid),
    "Cancelled native Codex process remains alive",
    5000,
  );
  const elapsedMs = Date.now() - started;
  assert.ok(
    elapsedMs < 5000,
    "Cancellation should not wait for the native process sleep",
  );
  assert.deepEqual(rendererErrors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        realElectronIPC: true,
        nativeProcessKilled: true,
        cancellationRejected: true,
        noNetworkOrAuthAccess: true,
        pid,
        elapsedMs,
        executable: process.env.READERD_EXECUTABLE || electronPath,
        run,
      },
      null,
      2,
    ),
  );
} finally {
  if (application) await application.close().catch(() => {});
  if (pid && alive(pid)) process.kill(pid);
}
