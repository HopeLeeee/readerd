import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUTPUT_LIMIT = 2 * 1024 * 1024;

export function codexArguments(model) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
  ];
  if (model) {
    if (
      typeof model !== "string" ||
      model.length > 200 ||
      /[\r\n\0]/.test(model)
    )
      throw new Error("Codex 模型名称无效。");
    args.push("--model", model);
  }
  args.push("-");
  return args;
}

export function parseCodexOutput(output) {
  let finalText = "";
  let completed = false;
  let turnFailed = false;
  let failure = "";
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    )
      finalText = event.item.text;
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed") {
      turnFailed = true;
      failure = event.error?.message || "Codex 请求失败。";
    }
    // Codex reports transient reconnects as "error" events and can still
    // finish the turn, so only use those messages when no answer arrives.
    if (event.type === "error")
      failure = event.message || event.error?.message || "Codex 请求失败。";
  }
  if (turnFailed) throw new Error(failure.slice(0, 1200));
  if (!completed || !finalText.trim())
    throw new Error(
      failure
        ? failure.slice(0, 1200)
        : "Codex 未返回完整回答，请检查登录状态和网络连接。",
    );
  return finalText.trim();
}

export function createCodexBridge({
  spawnProcess = spawn,
  environment = process.env,
  tempRoot = os.tmpdir(),
} = {}) {
  async function locate(executable) {
    if (executable) {
      if (
        typeof executable !== "string" ||
        !path.isAbsolute(executable) ||
        !/\.exe$/i.test(executable) ||
        /[\r\n\0]/.test(executable)
      )
        throw new Error("请选择本地 Codex 的绝对 .exe 路径。");
      if (!(await fs.stat(executable).catch(() => null))?.isFile())
        throw new Error("找不到指定的 Codex 程序。");
      return executable;
    }
    const appCandidates = [];
    if (environment.LOCALAPPDATA) {
      const bin = path.join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      appCandidates.push(path.join(bin, "codex.exe"));
      // Codex Desktop keeps versioned CLI binaries in bin/<hash>/codex.exe.
      // Prefer the newest copy over a stale top-level launcher.
      const versions = await fs
        .readdir(bin, { withFileTypes: true })
        .catch(() => []);
      for (const entry of versions)
        if (entry.isDirectory())
          appCandidates.push(path.join(bin, entry.name, "codex.exe"));
    }
    const pathCandidates = [];
    for (const entry of (environment.PATH || environment.Path || "").split(
      path.delimiter,
    )) {
      const directory = entry.trim().replace(/^"|"$/g, "");
      if (path.isAbsolute(directory))
        pathCandidates.push(path.join(directory, "codex.exe"));
    }
    const newest = async (candidates) => {
      const found = [];
      for (const candidate of candidates) {
        const stats = await fs.stat(candidate).catch(() => null);
        if (stats?.isFile()) found.push({ candidate, modified: stats.mtimeMs });
      }
      found.sort((a, b) => b.modified - a.modified);
      return found[0]?.candidate;
    };
    const installed =
      (await newest(appCandidates)) || (await newest(pathCandidates));
    if (installed) return installed;
    throw new Error(
      "未找到本地 Codex。请安装并登录 Codex，或填写 codex.exe 路径。",
    );
  }

  function abortError() {
    const error = new Error("Codex 请求已取消。");
    error.name = "AbortError";
    return error;
  }

  async function run(executable, args, input, timeoutMs, signal) {
    if (signal?.aborted) throw abortError();
    const cwd = await fs.mkdtemp(path.join(tempRoot, "readerd-codex-"));
    const cleanup = () =>
      fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 3 })
        .catch(() => {});
    if (signal?.aborted) {
      await cleanup();
      throw abortError();
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(executable, args, {
          cwd,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: environment,
        });
      } catch (error) {
        cleanup().then(() =>
          reject(new Error(`无法启动 Codex：${error.message}`)),
        );
        return;
      }
      let stdout = "",
        stderr = "",
        bytes = 0,
        finished = false;
      const dataListeners = [];
      const finish = (error, result, afterCleanup) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        for (const [stream, listener] of dataListeners)
          stream.removeListener("data", listener);
        const settle = () => (error ? reject(error) : resolve(result));
        if (afterCleanup) afterCleanup.then(settle);
        else settle();
      };
      const stop = (error) => {
        if (finished) return;
        // Reject promptly, but retain the close listener so the working
        // directory is removed only after the process has stopped using it.
        finish(error);
        child.kill();
      };
      const onAbort = () => stop(abortError());
      const timer = setTimeout(
        () => stop(new Error("Codex 请求超时，请检查网络连接后重试。")),
        timeoutMs,
      );
      for (const [stream, isOutput] of [
        [child.stdout, true],
        [child.stderr, false],
      ]) {
        stream.setEncoding("utf8");
        const listener = (chunk) => {
          if (finished) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > OUTPUT_LIMIT)
            return stop(new Error("Codex 输出超出限制。"));
          if (isOutput) stdout += chunk.toString();
          else stderr += chunk.toString();
        };
        dataListeners.push([stream, listener]);
        stream.on("data", listener);
      }
      const onError = (error) =>
        finish(new Error(`无法启动 Codex：${error.message}`));
      child.on("error", onError);
      child.once("close", (code) => {
        child.removeListener("error", onError);
        const cleaned = cleanup();
        if (finished) return;
        if (code !== 0) {
          let message = stderr.trim().slice(-1200);
          try {
            parseCodexOutput(stdout);
          } catch (error) {
            if (!message) message = error.message;
          }
          finish(
            new Error(
              `Codex 运行失败${code == null ? "" : ` (${code})`}：${message || "请检查登录状态。"}`,
            ),
            undefined,
            cleaned,
          );
        } else finish(null, { stdout, stderr }, cleaned);
      });
      child.stdin.on("error", () => {});
      signal?.addEventListener("abort", onAbort, { once: true });
      // Covers cancellation between the initial check and listener setup.
      if (signal?.aborted) onAbort();
      if (!finished) child.stdin.end(input);
    });
  }

  async function probeCodex({ executable } = {}) {
    try {
      const resolved = await locate(executable);
      const { stdout } = await run(resolved, ["--version"], "", 10000);
      const version = stdout.trim();
      if (!/^codex-cli\s+\S+/.test(version))
        throw new Error("该程序未返回有效的 Codex 版本。");
      return { available: true, executable: resolved, version };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  async function requestCodex({
    prompt,
    executable,
    model,
    timeoutMs = 120000,
    signal,
  } = {}) {
    if (signal?.aborted) throw abortError();
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      Buffer.byteLength(prompt) > 300000
    )
      throw new Error("Codex 请求内容为空或超出限制。");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error("Codex 超时设置无效。");
    const args = codexArguments(model);
    const resolved = await locate(executable);
    const { stdout } = await run(resolved, args, prompt, timeoutMs, signal);
    return parseCodexOutput(stdout);
  }
  return { probeCodex, requestCodex };
}

export const { probeCodex, requestCodex } = createCodexBridge();
