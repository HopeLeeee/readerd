import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGlossCacheStore } from "../electron/gloss-cache.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-gloss-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "nested", "glosses.json");
  return { file, store: createGlossCacheStore(file) };
}

test("persistent glosses preserve Chinese context keys and strip unrelated fields", async (t) => {
  const { file, store } = await fixture(t);
  const key = JSON.stringify(["context", "研究细菌的 metabolism", 4, 14]);
  await store.save([[key, { gloss: " 代谢 ", source: "prefetch", apiKey: "secret" }]]);
  assert.deepEqual(await createGlossCacheStore(file).load(), [[key, { gloss: "代谢", source: "prefetch" }]]);
  assert.equal((await fs.readFile(file, "utf8")).includes("secret"), false);
});

test("missing or damaged cache never blocks startup and can be replaced", async (t) => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.load(), []);
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const content of ['{"broken":', '{"gloss":"代谢"}', 'null']) {
    await fs.writeFile(file, content);
    assert.deepEqual(await store.load(), []);
  }
  await store.save([["working", { gloss: "代谢" }]]);
  assert.deepEqual(await store.load(), [["working", { gloss: "代谢", source: "persistent" }]]);
});

test("invalid results, reserved keys and oversized keys are discarded", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.save({ invalid: true }), TypeError);
  await store.save([
    ...["__proto__", "constructor", "prototype", "", "x".repeat(10001), 123].map(key => [key, { gloss: "代谢" }]),
    ["truncated", { gloss: '{"gloss":"代谢' }],
    ["inherited", Object.create({ gloss: "代谢" })],
    ["long", { gloss: "代".repeat(25) }],
    ["english", { gloss: "metabolism" }],
    ["valid", { gloss: "营养物质", source: "arbitrary", credentials: "secret" }],
  ]);
  assert.deepEqual(await store.load(), [["valid", { gloss: "营养物质", source: "persistent" }]]);
});

test("only the newest 5000 unique records are retained", async (t) => {
  const { store } = await fixture(t);
  const entries = Array.from({ length: 5002 }, (_, index) => [String(index), { gloss: "代谢", source: "context" }]);
  entries.push(["5001", { gloss: "营养", source: "prefetch" }]);
  await store.save(entries);
  const loaded = await store.load();
  assert.equal(loaded.length, 5000);
  assert.equal(loaded[0][0], "2");
  assert.deepEqual(loaded.at(-1), ["5001", { gloss: "营养", source: "prefetch" }]);
});

test("serialized file respects the 16 MiB UTF-8 budget", async (t) => {
  const { file, store } = await fixture(t);
  const entries = Array.from({ length: 1500 }, (_, index) => [`${index}:${"文".repeat(9990)}`, { gloss: "代谢" }]);
  await store.save(entries);
  assert.ok((await fs.stat(file)).size <= 16 * 1024 * 1024);
  const loaded = await store.load();
  assert.ok(loaded.length > 0 && loaded.length < entries.length);
  assert.deepEqual(loaded.at(-1)[0], entries.at(-1)[0]);
  await fs.writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.deepEqual(await store.load(), []);
});

test("concurrent saves serialize snapshots and the newest snapshot wins", async (t) => {
  const { file, store } = await fixture(t);
  const writes = [];
  for (let index = 0; index < 30; index++) {
    const entries = [[String(index), { gloss: "代谢", source: "context" }]];
    writes.push(store.save(entries));
    entries[0][1].gloss = "不应写入";
  }
  await Promise.all(writes);
  assert.deepEqual(await createGlossCacheStore(file).load(), [["29", { gloss: "代谢", source: "context" }]]);
  assert.deepEqual((await fs.readdir(path.dirname(file))), ["glosses.json"]);
});
