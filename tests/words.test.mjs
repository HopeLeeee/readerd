import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import core from "../src/words/readerc-core.js";
import {
  WordCompanion,
  sideButtonStatus,
  makeRange,
  loadLexicon,
} from "../src/words/companion.js";

test("mouse side mapping defaults upper 4 familiar, lower 3 unfamiliar and allows swap", () => {
  assert.equal(sideButtonStatus(4), "known");
  assert.equal(sideButtonStatus(3), "unknown");
  assert.equal(sideButtonStatus(0), null);
  assert.equal(
    sideButtonStatus(3, { familiarButton: 3, unfamiliarButton: 4 }),
    "known",
  );
  assert.equal(
    sideButtonStatus(4, { familiarButton: 3, unfamiliarButton: 3 }),
    null,
  );
  assert.equal(
    sideButtonStatus(4, { familiarButton: 7, unfamiliarButton: 3 }),
    null,
  );
});

test("readerc-compatible persisted states are restored and invalid values discarded", async () => {
  const companion = new WordCompanion({
    loadState: async () => ({
      version: 1,
      vocabulary: {
        enzyme: { state: "known", updatedAt: "2026-10-24" },
        pathway: { state: "unknown" },
        invalid: { state: "familiar" },
        "bad<script>": { state: "known" },
      },
    }),
  });
  await companion.initialize();
  assert.equal(companion.vocabulary.enzyme.state, "known");
  assert.equal(companion.vocabulary.pathway.state, "unknown");
  assert.equal(companion.vocabulary.invalid, undefined);
  assert.equal(companion.vocabulary["bad<script>"], undefined);
});

test("serialized writes preserve changes, and failed persistence does not alter state", async () => {
  let fail = true;
  const writes = [],
    events = [];
  const companion = new WordCompanion({
    saveState: async (state) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      writes.push(structuredClone(state));
    },
    onChange: (event) => events.push(event),
  });
  await assert.rejects(
    companion.setWordStatus("Enzyme", "familiar"),
    /disk full/,
  );
  assert.equal(companion.vocabulary.enzyme, undefined);
  await Promise.all([
    companion.setWordStatus("Enzyme", "familiar"),
    companion.setWordStatus("pathway", "unfamiliar"),
  ]);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].enzyme.state, "known");
  assert.equal(writes[1].pathway.state, "unknown");
  assert.equal(events.length, 2);
  await assert.rejects(companion.setWordStatus("<script>", "known"), /无效/);
});

test("canonical forms use only explicit lexicon mappings and preserve unknown forms", async () => {
  const companion = new WordCompanion({
    getSettings: () => ({
      lexicon: {
        entries: { enzyme: { rank: 5000 } },
        forms: { enzymes: "enzyme" },
      },
    }),
  });
  await companion.setWordStatus("Enzymes", "known");
  await companion.setWordStatus("unmappedwords", "unknown");
  assert.equal(companion.vocabulary.enzyme.state, "known");
  assert.equal(companion.vocabulary.enzymes, undefined);
  assert.equal(companion.vocabulary.unmappedwords.state, "unknown");
});

test("side buttons suppress navigation but never mark absent words or editable fields", async () => {
  const companion = new WordCompanion();
  let prevented = 0,
    stopped = 0;
  const event = {
    button: 4,
    target: { closest: () => null },
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  };
  companion.hitAt = () => null;
  assert.equal(companion.handleMouseSideButton(event), false);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  companion.hitAt = () => ({ candidate: { lemma: "enzyme" } });
  assert.equal(
    companion.handleMouseSideButton({
      ...event,
      target: { closest: () => ({}) },
    }),
    false,
  );
  assert.equal(Object.keys(companion.vocabulary).length, 0);
  assert.equal(companion.handleMouseSideButton(event), true);
  await companion.queue;
  assert.equal(companion.vocabulary.enzyme.state, "known");
  assert.equal(companion.handleMouseSideButton({ ...event, button: 3 }), true);
  await companion.queue;
  assert.equal(companion.vocabulary.enzyme.state, "unknown");
});

test("readerc candidate extraction keeps manually familiar terms out and uses phrase context", () => {
  const lexicon = { entries: {}, forms: {} };
  const text = "The enzyme acts in vivo. A pathway changes.";
  const words = core.candidates(text, lexicon, {
    enzyme: { state: "unknown" },
    pathway: { state: "known" },
  });
  assert.deepEqual(
    words.map((word) => word.lemma),
    ["enzyme", "in vivo"],
  );
  assert.equal(
    words[0].sentence.slice(words[0].targetStart, words[0].targetEnd),
    "enzyme",
  );
  assert.equal(words[0].sentence, "The enzyme acts in vivo.");
});

test("range mapping spans PDF text nodes without replacing or mutating them", () => {
  const nodes = [{ nodeValue: "enzyme" }, { nodeValue: " activity" }];
  let start, end;
  const doc = {
    createRange: () => ({
      setStart: (node, offset) => {
        start = [node, offset];
      },
      setEnd: (node, offset) => {
        end = [node, offset];
      },
    }),
  };
  const segments = [
    { node: nodes[0], start: 0, end: 6 },
    { node: nodes[1], start: 6, end: 15 },
  ];
  assert.ok(makeRange(doc, segments, 2, 12));
  assert.deepEqual(start, [nodes[0], 2]);
  assert.deepEqual(end, [nodes[1], 6]);
  assert.equal(nodes[0].nodeValue, "enzyme");
  assert.equal(makeRange(doc, segments, 40, 50), null);
});

test("active text selection prevents hovering from requesting a gloss", () => {
  const companion = new WordCompanion();
  let hitTests = 0;
  companion.hitAt = () => {
    hitTests++;
    return {};
  };
  companion.handlePointer({
    buttons: 0,
    target: {
      closest: () => null,
      ownerDocument: { getSelection: () => ({ isCollapsed: false }) },
    },
  });
  assert.equal(hitTests, 0);
  assert.equal(companion.hover, null);
  companion.destroy();
});

test("gloss lookup caches the same context and discards a late result after leaving a word", async () => {
  let calls = 0,
    release;
  const inserted = [];
  const doc = {
    defaultView: { innerWidth: 1000 },
    createElement: () => ({
      dataset: {},
      style: {},
      setAttribute() {},
      remove() {},
    }),
    body: { append: (node) => inserted.push(node) },
  };
  const candidate = {
    word: "enzyme",
    lemma: "enzyme",
    sentence: "The enzyme acts.",
    targetStart: 4,
    targetEnd: 10,
  };
  const hit = {
    candidate,
    range: { getBoundingClientRect: () => ({ left: 40, top: 100 }) },
    page: { container: { ownerDocument: doc } },
  };
  const companion = new WordCompanion({
    requestGloss: async () => {
      calls++;
      return { gloss: "酶" };
    },
  });
  companion.hover = hit;
  await companion.showGloss(hit);
  assert.equal(inserted[0].textContent, "酶");
  companion.closeGloss();
  companion.hover = hit;
  await companion.showGloss(hit);
  assert.equal(calls, 1);
  companion.destroy();

  const pending = new WordCompanion({
    getSettings: () => ({ endpoint: "https://example.test/v1", model: "test" }),
    requestGloss: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  pending.hover = hit;
  const lookup = pending.showGloss(hit);
  await Promise.resolve();
  assert.equal(inserted[2].textContent, "释义加载中…");
  pending.closeGloss();
  release("酶");
  await lookup;
  assert.equal(inserted.length, 3);
  assert.equal(inserted[2].textContent, "释义加载中…");
  pending.destroy();
});

test("hovering an unmarked word does not translate it, but side buttons can still mark it", async () => {
  let glossCalls = 0;
  const candidate = {
    word: "obscure",
    lemma: "obscure",
    sentence: "This obscure word has no dotted marker.",
    targetStart: 5,
    targetEnd: 12,
  };
  const hit = {
    candidate,
    glossable: false,
    range: { getBoundingClientRect: () => ({ left: 40, top: 100 }) },
    page: { container: { ownerDocument: {} } },
  };
  const companion = new WordCompanion({
    getSettings: () => ({
      endpoint: "https://example.test/v1",
      model: "test",
    }),
    requestGloss: async () => {
      glossCalls++;
      return { gloss: "不应出现" };
    },
  });
  companion.hitAt = () => hit;
  companion.handlePointer({
    buttons: 0,
    target: {
      closest: () => null,
      ownerDocument: { getSelection: () => ({ isCollapsed: true }) },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(glossCalls, 0);
  assert.equal(companion.timer, undefined);
  assert.ok(!companion.card);
  assert.equal(
    companion.handleMouseSideButton({
      button: 3,
      target: { closest: () => null },
    }),
    true,
  );
  await companion.queue;
  assert.equal(companion.vocabulary.obscure.state, "unknown");
  companion.destroy();
});

test("prefetch batches candidate words by sentence and serves hover from cache", async () => {
  const batches = [],
    inserted = [];
  let singleCalls = 0;
  const doc = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    createElement: () => ({
      dataset: {},
      style: {},
      setAttribute() {},
      remove() {},
    }),
    body: { append: (node) => inserted.push(node) },
  };
  const page = {
    pageNumber: 1,
    container: {
      ownerDocument: doc,
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 600,
        left: 0,
        right: 800,
      }),
    },
    hits: [],
    cleanup: [],
  };
  const sentence = "The enzyme acts on the substrate.";
  const candidates = [
    {
      word: "enzyme",
      lemma: "enzyme",
      sentence,
      targetStart: 4,
      targetEnd: 10,
    },
    {
      word: "substrate",
      lemma: "substrate",
      sentence,
      targetStart: 22,
      targetEnd: 31,
    },
  ];
  page.hits = candidates.map((candidate) => ({
    candidate,
    prefetch: true,
    page,
    range: { getBoundingClientRect: () => ({ left: 40, top: 100 }) },
  }));
  const companion = new WordCompanion({
    getSettings: () => ({
      endpoint: "https://example.test/v1",
      model: "test-model",
    }),
    requestGlossBatch: async (words) => {
      batches.push(words.map((word) => word.word));
      return JSON.stringify(
        words.map((word) => ({ word: word.word, gloss: "酶" })),
      );
    },
    requestGloss: async () => {
      singleCalls++;
      return { gloss: "单次" };
    },
  });
  companion.pages.set(1, page);
  await companion.prefetchPage(1);
  assert.deepEqual(batches, [["enzyme", "substrate"]]);
  assert.equal(singleCalls, 0);
  const hit = page.hits[0];
  companion.hover = hit;
  await companion.showGloss(hit);
  assert.equal(singleCalls, 0);
  assert.equal(inserted[0].textContent, "酶");
  companion.destroy();
});

test("failed prefetch stays silent and enables a direct hover retry", async () => {
  const events = [];
  let singleCalls = 0,
    batchCalls = 0,
    inserted;
  const doc = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    createElement: () => ({
      dataset: {},
      style: {},
      setAttribute() {},
      remove() {},
    }),
    body: {
      append: (node) => {
        inserted = node;
      },
    },
  };
  const candidate = {
    word: "enzyme",
    lemma: "enzyme",
    sentence: "The enzyme acts.",
    targetStart: 4,
    targetEnd: 10,
  };
  const page = {
    pageNumber: 1,
    container: {
      ownerDocument: doc,
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 600,
        left: 0,
        right: 800,
      }),
    },
    hits: [],
    cleanup: [],
  };
  page.hits = [
    {
      candidate,
      prefetch: true,
      page,
      range: { getBoundingClientRect: () => ({ left: 40, top: 100 }) },
    },
  ];
  const companion = new WordCompanion({
    getSettings: () => ({
      endpoint: "https://example.test/v1",
      model: "test-model",
    }),
    requestGlossBatch: async () => {
      batchCalls++;
      throw new Error("offline");
    },
    requestGloss: async () => {
      singleCalls++;
      return { gloss: "重试成功" };
    },
    onChange: (event) => events.push(event),
  });
  companion.pages.set(1, page);
  await companion.prefetchPage(1);
  assert.equal(batchCalls, 1);
  assert.deepEqual(events, []);
  const hit = page.hits[0];
  companion.hover = hit;
  await companion.showGloss(hit);
  assert.equal(singleCalls, 1);
  assert.equal(inserted.textContent, "重试成功");
  companion.destroy();
});

test("prefetch starts sentence groups concurrently and respects its concurrency limit", async () => {
  const started = [],
    resolvers = [],
    inserted = [];
  const doc = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    createElement: () => ({
      dataset: {},
      style: {},
      setAttribute() {},
      remove() {},
    }),
    body: { append: (node) => inserted.push(node) },
  };
  const page = {
    pageNumber: 1,
    container: {
      ownerDocument: doc,
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 600,
        left: 0,
        right: 800,
      }),
    },
    hits: [],
    cleanup: [],
  };
  for (let i = 0; i < 8; i++) {
    const word = `term${i}`;
    const candidate = {
      word,
      lemma: word,
      sentence: `This sentence contains ${word} and more context.`,
      targetStart: 20,
      targetEnd: 20 + word.length,
    };
    page.hits.push({
      candidate,
      prefetch: true,
      page,
      range: { getBoundingClientRect: () => ({ left: 40, top: 100 }) },
    });
  }
  const companion = new WordCompanion({
    getSettings: () => ({ endpoint: "https://example.test/v1", model: "test" }),
    requestGlossBatch: (words) =>
      new Promise((resolve) => {
        started.push(words.map((word) => word.word));
        resolvers.push(() =>
          resolve(
            JSON.stringify(
              words.map((word) => ({ word: word.word, gloss: "释义" })),
            ),
          ),
        );
      }),
  });
  companion.pages.set(1, page);
  const job = companion.prefetchPage(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    started.length,
    6,
    "six batches should start without waiting for each other",
  );
  for (const resolve of resolvers.splice(0)) resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 8, "queued batches should start as slots free");
  for (const resolve of resolvers.splice(0)) resolve();
  await job;
  assert.equal(companion.cache.size, 8);
  companion.destroy();
});

test("bundled ReaderC index matches original, resolves actual inflections and enables rank selection", async () => {
  const bytes = await readFile(
    new URL("../src/words/data/lexicon.json", import.meta.url),
  );
  assert.equal(bytes.length, 9933972);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "c481e1ae54893a54d4b9cbba568c19e37b8d21e3239a6f39c97479474340263a",
  );
  let fetchedURL;
  const lexicon = await loadLexicon({
    fetchImpl: async (url) => {
      fetchedURL = url;
      return { ok: true, json: async () => JSON.parse(bytes.toString("utf8")) };
    },
  });
  assert.equal(fetchedURL.pathname.endsWith("/words/data/lexicon.json"), true);
  assert.equal(Object.keys(lexicon.entries).length, 363525);
  assert.equal(Object.keys(lexicon.forms).length, 55084);
  assert.equal(core.canonical("mice", lexicon), "mouse");
  assert.equal(core.canonical("children", lexicon), "child");
  assert.equal(core.canonical("enzymes", lexicon), "enzyme");
  assert.equal(core.canonical("studies", lexicon), "study");
  const words = core.candidates(
    "The enzyme catalyzes the reaction.",
    lexicon,
    {},
    { threshold: 3000 },
  );
  assert.ok(words.some((candidate) => candidate.lemma === "enzyme"));
  assert.ok(!words.some((candidate) => candidate.lemma === "the"));
  assert.equal(lexicon.entries.biological.rank, 2564);
  assert.equal(Object.hasOwn(lexicon.entries.biological, "translation"), false);
});

test("local lexicon loader reports missing or invalid assets rather than using false vocabulary", async () => {
  await assert.rejects(
    loadLexicon({ fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /404/,
  );
  await assert.rejects(
    loadLexicon({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ entries: [], forms: {} }),
      }),
    }),
    /格式无效/,
  );
});
