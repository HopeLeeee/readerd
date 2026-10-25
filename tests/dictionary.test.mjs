import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadDictionary, dictionaryGloss } from "../src/words/dictionary.mjs";

const bytes = await readFile(new URL("../src/words/data/definitions.json", import.meta.url));
const dictionary = JSON.parse(bytes.toString("utf8"));

test("bundled definitions match pinned ECDICT source and reproducible output", () => {
  assert.equal(dictionary.meta.commit, "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b");
  assert.equal(dictionary.meta.sourceGitBlob, "c4ade63ea08cf39d9c3475e96929036d64d94c94");
  assert.equal(Object.keys(dictionary.entries).length, 363525);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "fa1899e2cd58ff169d6d9db3d0be76c5e22ee36f80f7649c4aa97b467b060076");
  assert.ok(bytes.length < 20000000);
  for (const value of Object.values(dictionary.entries)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length <= 400); // A supplementary Unicode character occupies two JS units.
    assert.match(value, /[\u3400-\u9fff]/u);
  }
});

test("real dictionary gives Chinese metabolism and enzyme senses, preserving multiple senses", () => {
  assert.equal(dictionaryGloss({ word: "Metabolism" }, dictionary), "n. 新陈代谢, 变态 [化] 新陈代谢; 代谢");
  assert.equal(dictionaryGloss({ word: "enzyme" }, dictionary), "n. 酶 [化] 酶");
  assert.equal(dictionaryGloss({ word: "metabo-\n lism" }, dictionary), dictionary.entries.metabolism);
  assert.equal(dictionaryGloss({ word: "metabo\u00adlism" }, dictionary), dictionary.entries.metabolism);
  assert.equal(dictionaryGloss({ word: "metabo\u00ad\r\nlism" }, dictionary), dictionary.entries.metabolism);
});

test("surface senses precede lemma fallback; phrases use exact dictionary entries only", () => {
  const small = { entries: { enzyme: dictionary.entries.enzyme, "in vitro": "体外" } };
  assert.equal(dictionaryGloss({ word: "enzymes", lemma: "enzyme" }, small), "n. 酶 [化] 酶");
  assert.equal(dictionaryGloss({ word: "enzymes", lemma: "enzyme" }, dictionary), dictionary.entries.enzymes);
  assert.equal(dictionaryGloss({ word: " IN  VITRO " }, small), "体外");
  assert.equal(dictionaryGloss({ word: "invented phrase" }, small), null);
});

test("missing, inherited, non-Chinese and malformed definitions never become a gloss", () => {
  const bad = { entries: Object.assign(Object.create({ inherited: "伪造" }), { nil: null, object: {}, english: "enzyme", empty: "", huge: "酶".repeat(201) }) };
  for (const word of ["missing", "inherited", "constructor", "toString", "__proto__", "nil", "object", "english", "empty", "huge"]) {
    assert.equal(dictionaryGloss({ word }, bad), null);
  }
  assert.equal(dictionaryGloss(null, dictionary), null);
  assert.equal(dictionaryGloss({}, { entries: [] }), null);
});

test("loader uses supplied URL and reports fetch, HTTP, JSON and container failures", async () => {
  const url = "file:///definitions.json";
  assert.equal(await loadDictionary({ url, fetchImpl: async (actual) => { assert.equal(actual, url); return { ok: true, json: async () => dictionary }; } }), dictionary);
  await assert.rejects(loadDictionary({ fetchImpl: null }), /fetch/);
  await assert.rejects(loadDictionary({ fetchImpl: async () => { throw new Error("unavailable"); } }), /unavailable/);
  await assert.rejects(loadDictionary({ fetchImpl: async () => ({ ok: false, status: 404 }) }), /404/);
  await assert.rejects(loadDictionary({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }) }), /invalid JSON/);
  for (const body of [null, {}, { entries: [] }, { entries: "bad" }]) {
    await assert.rejects(loadDictionary({ fetchImpl: async () => ({ ok: true, json: async () => body }) }), /格式/);
  }
});
