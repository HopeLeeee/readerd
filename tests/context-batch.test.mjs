import test from "node:test";
import assert from "node:assert/strict";
import core from "../src/words/readerc-core.js";

test("mixed contexts keep repeated words attached to their own source sentence", () => {
  const candidates = [
    { word: "cell", sentence: "The cell divides." },
    { word: "cell", sentence: "The battery cell is charged." },
  ];
  const reply = (items) => ({
    choices: [{ message: { content: JSON.stringify(items) } }],
  });
  const parsed = core.parseBatchGloss(
    reply([
      { id: 1, word: "cell", gloss: "电池单元" },
      { id: 0, word: "cell", gloss: "细胞" },
    ]),
    candidates,
  );
  assert.equal(parsed.get(candidates[0]), "细胞");
  assert.equal(parsed.get(candidates[1]), "电池单元");
  assert.equal(
    core.parseBatchGloss(reply([{ word: "cell", gloss: "细胞" }]), candidates)
      .size,
    0,
  );
  assert.equal(
    core.parseBatchGloss(
      reply([
        { id: 0, word: "cell", gloss: "细胞" },
        { id: 0, word: "cell", gloss: "电池单元" },
      ]),
      candidates,
    ).size,
    0,
  );
  assert.equal(
    core.parseBatchGloss(
      reply([{ id: 0, word: "battery", gloss: "电池" }]),
      candidates,
    ).size,
    0,
  );
});
