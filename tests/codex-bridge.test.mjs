import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  codexArguments,
  parseCodexOutput,
  createCodexBridge,
} from "../electron/codex-bridge.mjs";

const result = (text) =>
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  }) + '\n{"type":"turn.completed"}\n';

test("Codex command isolates configuration, rules and session and sends prompt through stdin", () => {
  const args = codexArguments("gpt-example");
  for (const flag of [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
  ])
    assert.ok(args.includes(flag));
  assert.deepEqual(
    args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2),
    ["--sandbox", "read-only"],
  );
  assert.deepEqual(args.slice(-3), ["--model", "gpt-example", "-"]);
  assert.throws(() => codexArguments("bad\nmodel"));
});

test("Codex parser requires completed turn and rejects failure even after a message", () => {
  assert.equal(
    parseCodexOutput("ignored log\n" + result("中文回答")),
    "中文回答",
  );
  assert.throws(
    () =>
      parseCodexOutput(
        '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
      ),
    /完整回答/,
  );
  assert.throws(
    () =>
      parseCodexOutput(
        result("partial") +
          '{"type":"turn.failed","error":{"message":"Login required"}}',
      ),
    /Login required/,
  );
  assert.throws(
    () => parseCodexOutput('{"type":"turn.completed"}'),
    /完整回答/,
  );
});

test("Codex parser ignores transient reconnect errors once a complete answer arrives", () => {
  assert.equal(
    parseCodexOutput(
      '{"type":"error","message":"Reconnecting... 2/5"}\n' + result("最终回答"),
    ),
    "最终回答",
  );
  assert.throws(
    () =>
      parseCodexOutput(
        '{"type":"error","message":"workspace routing discovery timed out"}\n',
      ),
    /workspace routing discovery timed out/,
  );
});

test("Codex locator prefers the newest versioned CLI installed by Codex Desktop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-codex-bin-"));
  const bin = path.join(root, "OpenAI", "Codex", "bin");
  const oldExe = path.join(bin, "old", "codex.exe");
  const newExe = path.join(bin, "new", "codex.exe");
  await fs.mkdir(path.dirname(oldExe), { recursive: true });
  await fs.mkdir(path.dirname(newExe), { recursive: true });
  await fs.writeFile(oldExe, "old");
  await fs.writeFile(newExe, "new");
  await fs.utimes(oldExe, new Date("2026-01-01"), new Date("2026-01-01"));
  await fs.utimes(newExe, new Date("2026-06-01"), new Date("2026-06-01"));
  let launched;
  const bridge = createCodexBridge({
    tempRoot: root,
    environment: { LOCALAPPDATA: root, PATH: "" },
    spawnProcess: (file, args) => {
      launched = { file, args };
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.write("codex-cli 9.9.9\n");
        child.emit("close", 0);
      });
      return child;
    },
  });
  try {
    const probe = await bridge.probeCodex();
    assert.equal(probe.available, true);
    assert.equal(probe.executable, newExe);
    assert.equal(launched.file, newExe);
    assert.deepEqual(launched.args, ["--version"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex launcher uses exact executable without shell, isolated cwd, bounded output and timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-codex-test-"));
  const exe = path.join(root, "Codex test.exe");
  await fs.writeFile(exe, "test fixture");
  let behavior = "success",
    captured;
  const bridge = createCodexBridge({
    tempRoot: root,
    spawnProcess: (file, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let input = "";
      child.stdin.on("data", (chunk) => (input += chunk));
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit("close", null));
      };
      captured = {
        file,
        args,
        options,
        child,
        get input() {
          return input;
        },
      };
      setImmediate(() => {
        if (behavior === "timeout") return;
        if (behavior === "overflow") {
          child.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
          return;
        }
        child.stdout.write(
          args[0] === "--version" ? "codex-cli 1.0.0" : result("成功"),
        );
        child.emit("close", 0);
      });
      return child;
    },
  });
  try {
    assert.equal(
      (await bridge.probeCodex({ executable: exe })).available,
      true,
    );
    const prompt = "Do not execute $(command); `literal` 中文";
    assert.equal(
      await bridge.requestCodex({ executable: exe, prompt }),
      "成功",
    );
    assert.equal(captured.file, exe);
    assert.equal(captured.input, prompt);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.windowsHide, true);
    assert.ok(captured.options.cwd.startsWith(root + path.sep));
    assert.equal(await fs.stat(captured.options.cwd).catch(() => null), null);
    assert.ok(!captured.args.includes(prompt));
    behavior = "overflow";
    await assert.rejects(
      bridge.requestCodex({ executable: exe, prompt }),
      /输出超出限制/,
    );
    assert.equal(captured.child.killed, true);
    behavior = "timeout";
    await assert.rejects(
      bridge.requestCodex({ executable: exe, prompt, timeoutMs: 5 }),
      /请求超时/,
    );
    assert.equal(captured.child.killed, true);
    assert.equal(
      (await bridge.probeCodex({ executable: "relative.exe" })).available,
      false,
    );
    await assert.rejects(
      bridge.requestCodex({ executable: exe, prompt: "" }),
      /为空/,
    );
    await assert.rejects(
      bridge.requestCodex({ executable: exe, prompt, timeoutMs: Infinity }),
      /超时设置无效/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex cancellation rejects before spawn and kills active process without accepting late output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-codex-abort-"));
  const exe = path.join(root, "codex.exe");
  await fs.writeFile(exe, "fixture");
  let captured;
  let spawned;
  const ready = new Promise((resolve) => {
    spawned = resolve;
  });
  const bridge = createCodexBridge({
    tempRoot: root,
    spawnProcess: (file, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.killed = true;
      };
      captured = { child, cwd: options.cwd };
      spawned();
      return child;
    },
  });
  try {
    const alreadyAborted = AbortSignal.abort();
    await assert.rejects(
      bridge.requestCodex({
        executable: exe,
        prompt: "test",
        signal: alreadyAborted,
      }),
      { name: "AbortError" },
    );
    assert.equal(captured, undefined);
    assert.deepEqual(await fs.readdir(root), ["codex.exe"]);
    const controller = new AbortController();
    const pending = bridge.requestCodex({
      executable: exe,
      prompt: "test",
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(captured.child.killed, true);
    assert.ok(
      (await fs.stat(captured.cwd)).isDirectory(),
      "cleanup waits for child close",
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(captured.child.stdout.listenerCount("data"), 0);
    captured.child.stdout.write(result("late answer must not succeed"));
    captured.child.emit("close", 0);
    for (
      let i = 0;
      i < 100 && (await fs.stat(captured.cwd).catch(() => null));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await fs.stat(captured.cwd).catch(() => null), null);
    assert.equal(captured.child.listenerCount("error"), 0);
    assert.equal(captured.child.listenerCount("close"), 0);
  } finally {
    captured?.child.emit("close", null);
    await fs.rm(root, { recursive: true, force: true });
  }
});
