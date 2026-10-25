import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeCodex, codexArguments } from '../electron/codex-bridge.mjs';

const probe = await probeCodex();
if (!probe.available) throw new Error(probe.error);
const directory = path.resolve('test-results', `codex-lean-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const prompt = 'Translate metabolism in this sentence into concise Chinese: Microbial metabolism converts nutrients into energy. Return only JSON {"gloss":"代谢"}. Do not use tools.';
const report = { probe, prompt, samples: [] };
for (let i = 0; i < 2; i++) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'readerd-lean-'));
  const instructions = path.join(cwd, 'translator.txt');
  await fs.writeFile(instructions, 'You are a concise scientific English-to-Chinese translator. Translate only the requested word in its supplied context. Return only the requested JSON object. Never call tools or read files.');
  const args = codexArguments();
  args.splice(-1, 0,
    '-c', `model_instructions_file=${JSON.stringify(instructions.replaceAll('\\', '/'))}`,
    '-c', 'project_doc_max_bytes=0',
    '-c', 'mcp_servers={}',
    '-c', 'web_search="disabled"',
    '-c', 'model_reasoning_effort="low"');
  const started = performance.now();
  const result = await new Promise(resolve => {
    const child = spawn(probe.executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', error => { clearTimeout(timer); resolve({ error: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
  });
  await fs.rm(cwd, { recursive: true, force: true });
  const events = (result.stdout || '').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const record = {
    elapsedMs: Math.round(performance.now() - started), code: result.code, timedOut: result.timedOut, error: result.error,
    messages: events.filter(event => event.item?.type === 'agent_message').map(event => event.item.text),
    usage: events.find(event => event.type === 'turn.completed')?.usage,
    errors: events.filter(event => ['error', 'turn.failed'].includes(event.type)),
    mcpWarningLines: (result.stderr || '').split(/\r?\n/).filter(line => /WARN.*mcp|MCP startup failed|initialize MCP/i.test(line)).map(line => line.slice(0, 1200)),
    stderrError: result.code !== 0 ? (result.stderr || '').slice(-2000) : undefined,
  };
  report.samples.push(record);
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(record));
  if (result.code !== 0 || result.timedOut || record.errors.some(event => event.type === 'turn.failed')) process.exit(1);
}
console.log(`Report: ${path.join(directory, 'result.json')}`);
