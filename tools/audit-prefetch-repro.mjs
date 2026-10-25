import assert from "node:assert/strict";
import { WordCompanion } from "../src/words/companion.js";

// Offline regression: old document transports must not retain any slots.
// No Electron instance, files, credentials or network service are involved.
const calls = [];
const pending = [];
const companion = new WordCompanion({
  getSettings: () => ({ provider: "codex" }),
  requestGlossBatch: (candidates, { signal }) => {
    calls.push(candidates[0].word);
    assert.equal(signal.aborted, false);
    return new Promise((resolve) => pending.push(resolve));
  },
});
companion.isPageVisible = () => true;
const settle = () => new Promise((resolve) => setImmediate(resolve));
function makePage(prefix, count) {
  return {
    pageNumber: 1,
    cleanup: [],
    hits: Array.from({ length: count }, (_, index) => ({
      prefetch: true,
      candidate: {
        word: `${prefix}${index}`,
        lemma: `${prefix}${index}`,
        sentence: `${prefix} sentence ${index}`,
        targetStart: 0,
        targetEnd: 2,
      },
    })),
  };
}

companion.pages.set(1, makePage("old", 72));
const oldJob = companion.prefetchPage(1);
await settle();
assert.equal(calls.length, 6);

companion.detachPage(1);
assert.equal(companion.prefetchActive, 0);
const newPage = makePage("new", 1);
companion.pages.set(1, newPage);
const newJob = companion.prefetchPage(1);
await settle();

assert.equal(companion.pages.get(1), newPage);
assert.equal(companion.prefetchActive, 1);
assert.equal(companion.prefetchWaiting.length, 0);
assert.deepEqual(calls, [
  "old0",
  "old12",
  "old24",
  "old36",
  "old48",
  "old60",
  "new0",
]);
console.log(
  JSON.stringify({
    phase: "new-document-started-before-old-transports-finish",
    calls,
    active: companion.prefetchActive,
    waiting: companion.prefetchWaiting.length,
  }),
);

for (const resolve of pending.splice(0)) resolve("[]");
await settle();
assert.equal(calls.at(-1), "new0");
console.log(JSON.stringify({ phase: "all-transports-complete", calls }));
for (const resolve of pending.splice(0)) resolve("[]");
await Promise.all([oldJob, newJob]);
companion.destroy();
console.log(
  "Passed: new-document prefetch starts immediately; stale transports cannot block it.",
);
